/**
 * The Change Store: the single source of truth for "what changed since the last
 * accepted checkpoint", shared by the MCP path (staged proposals) and the FS path
 * (observed direct writes). Persists under ~/.review-hub/workspaces/<hash>/.
 *
 * No `vscode` import so the hub server, the MCP server, and tests can all use it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  ChangeSet,
  ChangeSummary,
  ChangeStatus,
  CheckpointInfo,
  DecideResult,
  Hunk,
} from "./types";
import { computeHunks, diffStats, rebaseDecisions, resolveLines, splitContent, joinContent } from "./hunk-diff";
import { hashContent, readFileSafe, resolveInside, toPosix, writeFileAtomic, deleteFileSafe } from "./file-snapshot";
import { readGitBaseline } from "./git-baseline";

export interface SnapshotOptions {
  maxFileSize: number;
  excludeGlobs: string[];
  /** Only snapshot these extensions (lowercase, with dot). Empty = all text files. */
  includeExtensions?: string[];
  /** Hard cap on files snapshotted in one checkpoint. Prevents pathological walks. */
  maxFiles?: number;
  /** Hard cap on directory entries scanned in one checkpoint walk. */
  maxScanned?: number;
  /** Hard time budget in ms for one checkpoint walk. */
  maxDurationMs?: number;
  /** Progress callback, invoked periodically during a walk. */
  onProgress?: (scanned: number, kept: number) => void;
}

/** Source/text extensions worth tracking. Anything else is skipped by the walk. */
export const DEFAULT_INCLUDE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".swift", ".m", ".mm",
  ".rb", ".php", ".lua", ".pl", ".r", ".jl", ".dart", ".ex", ".exs",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".sql", ".graphql", ".proto",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
  ".md", ".mdx", ".txt", ".rst", ".tex", ".xml", ".csv",
];

/** Directories/files that are almost never source and are expensive to walk. */
export const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/out/**",
  "**/build/**",
  // Build output the test runner writes (this project's own `scripts/test.mjs`): without
  // this, running the test suite inside the reviewed workspace floods the review list
  // with thousands of generated-bundle changes.
  "**/.test-dist/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/.mypy_cache/**",
  "**/.ruff_cache/**",
  "**/*.lock",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  // ML / data-heavy artifacts
  "**/checkpoints/**",
  "**/datasets/**",
  "**/dataset/**",
  "**/data/**",
  "**/pre-trained/**",
  "**/pretrained/**",
  "**/outputs/**",
  "**/logs/**",
  "**/wandb/**",
  "**/.cache/**",
  "**/colab_upload/**",
  "**/*.pt",
  "**/*.pth",
  "**/*.ckpt",
  "**/*.safetensors",
  "**/*.bin",
  "**/*.onnx",
  "**/*.h5",
  "**/*.pkl",
  "**/*.npz",
  "**/*.npy",
  "**/*.parquet",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.pdf",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.mp4",
  "**/*.mov",
];

export interface StoreOptions {
  baseDir?: string;
  maxFileSize?: number;
  excludeGlobs?: string[];
}

interface CheckpointFile {
  workspace: string;
  setAt: number;
  files: Record<string, string>; // relPath -> content hash
  /** True when the walk hit maxFiles/maxDurationMs and did not see the whole tree. */
  truncated?: boolean;
}

const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024;

function workspaceKey(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
}

function changeIdFor(workspace: string, relPath: string): string {
  return createHash("sha256").update(`${workspace}\u0000${relPath}`).digest("hex").slice(0, 16);
}

/**
 * Translate a glob into a RegExp. Shared by the ChangeStore and the watcher, so a fix
 * here cannot land in only one of them (the watcher used to carry its own broken copy).
 * Compiled patterns are cached: `isExcluded` runs per path in a hot scan loop.
 */
const globCache = new Map<string, RegExp>();
export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) {
    return cached;
  }
  // Minimal glob support: ** -> any path (including none), * -> any non-slash run,
  // ? -> one char.
  //
  // `**/` and `/**` are handled as whole tokens so that `**/node_modules/**` matches the
  // bare directory `node_modules` too — not just `node_modules/foo`. Without this the
  // walker fails to skip the excluded directory itself and descends into the entire
  // tree (node_modules, .git, dist, …), which is exactly the disk/CPU blow-up.
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?"; // `**/` — zero or more leading path segments
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
      continue;
    }
    if (c === "/" && glob[i + 1] === "*" && glob[i + 2] === "*") {
      re += "(?:/.*)?"; // trailing `/**` — optional remainder
      i += 3;
      continue;
    }
    if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
    i++;
  }
  const rx = new RegExp(`^${re}$`);
  globCache.set(glob, rx);
  return rx;
}

export class ChangeStore {
  private baseDir: string;
  private maxFileSize: number;
  private excludeGlobs: string[];
  private excludeRes: RegExp[];

  constructor(opts: StoreOptions = {}) {
    this.baseDir = opts.baseDir ?? path.join(os.homedir(), ".review-hub");
    this.maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.excludeGlobs = opts.excludeGlobs ?? [];
    this.excludeRes = this.excludeGlobs.map(globToRegExp);
  }

  // ---- paths ----

  private wsDir(workspace: string): string {
    return path.join(this.baseDir, "workspaces", workspaceKey(workspace));
  }

  private checkpointPath(workspace: string): string {
    return path.join(this.wsDir(workspace), "checkpoint.json");
  }

  private changesDir(workspace: string): string {
    return path.join(this.wsDir(workspace), "changes");
  }

  private baselinesDir(workspace: string): string {
    return path.join(this.wsDir(workspace), "baselines");
  }

  private baselineFile(workspace: string, hash: string): string {
    return path.join(this.baselinesDir(workspace), hash);
  }

  private isExcluded(relPath: string): boolean {
    const p = toPosix(relPath);
    return this.excludeRes.some((re) => re.test(p));
  }

  // ---- baseline storage ----

  private putBaseline(workspace: string, content: string): string {
    const hash = hashContent(content);
    const file = this.baselineFile(workspace, hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, content);
    }
    return hash;
  }

  private getBaseline(workspace: string, hash: string): string {
    try {
      return fs.readFileSync(this.baselineFile(workspace, hash), "utf8");
    } catch {
      return "";
    }
  }

  // ---- checkpoint ----

  readCheckpoint(workspace: string): CheckpointFile | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.checkpointPath(workspace), "utf8")) as CheckpointFile;
      if (parsed && typeof parsed === "object" && parsed.files) {
        return parsed;
      }
    } catch {
      // none yet
    }
    return undefined;
  }

  checkpointInfo(workspace: string): CheckpointInfo | undefined {
    const cp = this.readCheckpoint(workspace);
    if (!cp) {
      return undefined;
    }
    return { workspace, setAt: cp.setAt, files: Object.keys(cp.files).length };
  }

  private writeCheckpoint(workspace: string, cp: CheckpointFile): void {
    fs.mkdirSync(this.wsDir(workspace), { recursive: true });
    writeFileAtomic(this.checkpointPath(workspace), `${JSON.stringify(cp, null, 2)}\n`);
  }

  /**
   * Snapshot the current disk state as the new baseline ("accept current state").
   *
   * Walks the tree **asynchronously** and yields to the event loop regularly, so it
   * never blocks the extension host (a synchronous walk of a large project on a
   * slow/9p filesystem is what caused the CPU + disk thrash). Bounded by
   * `maxFiles` and `maxDurationMs` so a pathological tree cannot run forever.
   */
  async setCheckpoint(workspace: string, opts: SnapshotOptions): Promise<CheckpointInfo> {
    const files: Record<string, string> = {};
    const maxFiles = opts.maxFiles ?? 5000;
    const maxScanned = opts.maxScanned ?? 200_000;
    const maxDurationMs = opts.maxDurationMs ?? 20_000;
    const deadline = Date.now() + maxDurationMs;
    let scanned = 0;
    let truncated = false;
    const budgetExceeded = () =>
      truncated || Object.keys(files).length >= maxFiles || scanned >= maxScanned || Date.now() > deadline;

    const walk = async (dir: string): Promise<void> => {
      if (budgetExceeded()) {
        truncated = true;
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (budgetExceeded()) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, entry.name);
        const rel = toPosix(path.relative(workspace, abs));
        if (this.isExcluded(rel)) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        scanned++;
        if (scanned % 200 === 0) {
          opts.onProgress?.(scanned, Object.keys(files).length);
          // Yield so the extension host stays responsive.
          await new Promise((resolve) => setImmediate(resolve));
        }
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(abs);
        } catch {
          continue;
        }
        if (stat.size > opts.maxFileSize) {
          continue;
        }
        // Extension allowlist: skip binaries and data/model artifacts by name, so the
        // walk never reads a 2 GB checkpoint file just to discard it.
        const ext = path.extname(entry.name).toLowerCase();
        if (opts.includeExtensions && opts.includeExtensions.length > 0 && !opts.includeExtensions.includes(ext)) {
          continue;
        }
        const read = readFileSafe(abs);
        if (read.binary || !read.exists) {
          continue;
        }
        files[rel] = this.putBaseline(workspace, read.content);
      }
    };

    await walk(workspace);
    const cp: CheckpointFile = { workspace, setAt: Date.now(), files, truncated };
    this.writeCheckpoint(workspace, cp);
    // A fresh checkpoint supersedes all outstanding change sets.
    this.clearChanges(workspace);
    return { workspace, setAt: cp.setAt, files: Object.keys(files).length };
  }

  /** Ensure a checkpoint exists; create one from the current disk state if not. */
  async ensureCheckpoint(workspace: string, opts: SnapshotOptions): Promise<CheckpointInfo> {
    const existing = this.checkpointInfo(workspace);
    if (existing) {
      return existing;
    }
    return this.setCheckpoint(workspace, opts);
  }

  clearCheckpoint(workspace: string): void {
    deleteFileSafe(this.checkpointPath(workspace));
    this.clearChanges(workspace);
  }

  // ---- change sets ----

  private changePath(workspace: string, id: string): string {
    return path.join(this.changesDir(workspace), `${id}.json`);
  }

  private writeChange(cs: ChangeSet): void {
    fs.mkdirSync(this.changesDir(cs.workspace), { recursive: true });
    writeFileAtomic(this.changePath(cs.workspace, cs.id), `${JSON.stringify(cs, null, 2)}\n`);
    this.invalidate(cs.workspace);
  }

  getChange(workspace: string, id: string): ChangeSet | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.changePath(workspace, id), "utf8")) as ChangeSet;
      return parsed && parsed.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined {
    const p = toPosix(relPath);
    return this.listChangesRaw(workspace).find((cs) => cs.path === p);
  }

  /**
   * In-memory cache of change sets per workspace. CodeLens and the tree call the list
   * methods on every keystroke / render, so re-reading every JSON from disk each time
   * is wasteful.
   *
   * The cache is revalidated against the changes directory's mtime, because the store
   * is file-backed and shared: another VS Code window (or the hub process) may write
   * changes we must see. A cheap `stat` per read is far less work than re-parsing every
   * JSON.
   */
  private cache = new Map<string, { at: number; items: ChangeSet[] }>();

  private invalidate(workspace: string): void {
    this.cache.delete(workspace);
  }

  private changesDirMtime(workspace: string): number {
    try {
      return fs.statSync(this.changesDir(workspace)).mtimeMs;
    } catch {
      return 0;
    }
  }

  private listChangesRaw(workspace: string): ChangeSet[] {
    const mtime = this.changesDirMtime(workspace);
    const cached = this.cache.get(workspace);
    if (cached && cached.at === mtime) {
      return cached.items;
    }
    const dir = this.changesDir(workspace);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
    } catch {
      this.cache.set(workspace, { at: mtime, items: [] });
      return [];
    }
    const out: ChangeSet[] = [];
    for (const name of names) {
      try {
        const cs = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as ChangeSet;
        // Resolved sets are kept only so an open review tab can render its final state;
        // they are not "changes awaiting review" any more.
        if (cs && cs.id && cs.status !== "resolved") {
          out.push(cs);
        }
      } catch {
        // skip corrupt
      }
    }
    // One row per file, always the latest edit. A file can accumulate several change sets
    // (an older build wrote a fresh one per observation), and showing them all both
    // duplicates the file in the tree and makes `findChangeByPath` pick an arbitrary one.
    // Keeping the most recently updated set means the review always shows the final state.
    const latest = new Map<string, ChangeSet>();
    for (const cs of out) {
      const prev = latest.get(cs.path);
      if (!prev || (cs.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
        latest.set(cs.path, cs);
      }
    }
    const items = [...latest.values()].sort((a, b) => a.path.localeCompare(b.path));
    this.cache.set(workspace, { at: mtime, items });
    return items;
  }

  listChanges(workspace: string): ChangeSummary[] {
    return this.listChangesRaw(workspace).map((cs) => summarize(cs));
  }

  /**
   * Every workspace that has persisted state (a checkpoint or a change set). Lets a
   * window show projects other windows are working in, since the store is shared.
   */
  listKnownWorkspaces(): string[] {
    const root = path.join(this.baseDir, "workspaces");
    let keys: string[];
    try {
      keys = fs.readdirSync(root);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const key of keys) {
      const dir = path.join(root, key);
      // Prefer the workspace path recorded in the checkpoint; fall back to change sets.
      try {
        const cp = JSON.parse(fs.readFileSync(path.join(dir, "checkpoint.json"), "utf8")) as { workspace?: string };
        if (cp?.workspace) {
          out.push(cp.workspace);
          continue;
        }
      } catch {
        // no checkpoint
      }
      try {
        const names = fs.readdirSync(path.join(dir, "changes")).filter((n) => n.endsWith(".json"));
        if (names.length > 0) {
          const cs = JSON.parse(fs.readFileSync(path.join(dir, "changes", names[0]), "utf8")) as { workspace?: string };
          if (cs?.workspace) {
            out.push(cs.workspace);
          }
        }
      } catch {
        // nothing usable
      }
    }
    return out;
  }

  clearChanges(workspace: string): void {
    const dir = this.changesDir(workspace);
    try {
      for (const name of fs.readdirSync(dir)) {
        deleteFileSafe(path.join(dir, name));
      }
    } catch {
      // none
    }
    this.invalidate(workspace);
  }

  /**
   * Drop resolved change sets older than `maxAgeMs`. They are kept after a decision only
   * so an open review tab can render its final state; once the tab is gone or stale they
   * are just disk clutter.
   */
  pruneResolved(maxAgeMs = 5 * 60_000): void {
    const root = path.join(this.baseDir, "workspaces");
    let keys: string[];
    try {
      keys = fs.readdirSync(root);
    } catch {
      return;
    }
    const now = Date.now();
    for (const key of keys) {
      const dir = path.join(root, key, "changes");
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      let removed = false;
      for (const name of names) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const file = path.join(dir, name);
        try {
          const cs = JSON.parse(fs.readFileSync(file, "utf8")) as ChangeSet;
          if (cs.status === "resolved" && now - (cs.updatedAt ?? 0) > maxAgeMs) {
            deleteFileSafe(file);
            removed = true;
          }
        } catch {
          // skip
        }
      }
      if (removed) {
        this.cache.delete(path.join(root, key));
      }
    }
  }

  /**
   * Record the current on-disk content of one file as its baseline, without walking the
   * workspace. Used to seed the baseline for a non-git workspace: the first poll records
   * every file's current state, so only later changes are reported.
   */
  captureBaseline(workspace: string, relPath: string): void {
    const rel = toPosix(relPath);
    const abs = resolveInside(workspace, rel);
    if (!abs) {
      return;
    }
    const cp = this.readCheckpoint(workspace) ?? { workspace, setAt: Date.now(), files: {} };
    if (cp.files[rel]) {
      return;
    }
    const read = readFileSafe(abs);
    if (!read.exists || read.binary) {
      return;
    }
    cp.files[rel] = this.putBaseline(workspace, read.content);
    this.writeCheckpoint(workspace, cp);
  }

  /**
   * Seed baselines for many paths at once, reading the checkpoint once and writing it
   * once. The per-file `captureBaseline` re-parses and rewrites the entire checkpoint
   * JSON on every call, so seeding N files that way is O(N²) disk work — the first scan
   * of a 950-file project rewrote a 120 KB file 950 times.
   *
   * Files above `maxFileSize`, or whose extension is not in `includeExtensions` when that
   * allowlist is given, are skipped *before* being read, so a scan never pulls a huge
   * artifact into memory.
   */
  captureBaselines(
    workspace: string,
    relPaths: string[],
    opts: { includeExtensions?: string[] } = {},
  ): void {
    const cp = this.readCheckpoint(workspace) ?? { workspace, setAt: Date.now(), files: {} };
    let dirty = false;
    for (const relPath of relPaths) {
      const rel = toPosix(relPath);
      if (cp.files[rel]) {
        continue;
      }
      const abs = resolveInside(workspace, rel);
      if (!abs) {
        continue;
      }
      const ext = path.extname(rel).toLowerCase();
      if (opts.includeExtensions && opts.includeExtensions.length > 0 && !opts.includeExtensions.includes(ext)) {
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      if (size > this.maxFileSize) {
        continue;
      }
      const read = readFileSafe(abs);
      if (!read.exists || read.binary) {
        continue;
      }
      cp.files[rel] = this.putBaseline(workspace, read.content);
      dirty = true;
    }
    if (dirty) {
      this.writeCheckpoint(workspace, cp);
    }
  }

  /**
   * Baseline for the watcher path. Prefers the checkpoint; otherwise falls back to
   * git HEAD, which gives the pre-change content for free without a workspace walk.
   */
  private async baselineForObserve(workspace: string, relPath: string): Promise<{ content: string; exists: boolean }> {
    const rel = toPosix(relPath);
    const cp = this.readCheckpoint(workspace);
    const hash = cp?.files[rel];
    if (hash) {
      return { content: this.getBaseline(workspace, hash), exists: true };
    }
    const git = await readGitBaseline(workspace, rel);
    if (git.isRepo && git.content !== null) {
      // Record it so later observations of the same file are consistent.
      const cpNow = this.readCheckpoint(workspace) ?? { workspace, setAt: Date.now(), files: {} };
      cpNow.files[rel] = this.putBaseline(workspace, git.content);
      this.writeCheckpoint(workspace, cpNow);
      return { content: git.content, exists: true };
    }
    return { content: "", exists: false };
  }

  /**
   * Resolve the baseline for a path.
   *
   * `capture: true` (the MCP propose path) reads the current disk content as the
   * baseline when the path is not yet in the checkpoint — correct, because propose
   * runs *before* the change.
   *
   * `capture: false` (the FS observe path) must NOT read the disk: the watcher fires
   * *after* the write, so the disk already holds the new content. An untracked path is
   * treated as absent, which is right for a newly created file.
   */
  private baselineFor(workspace: string, relPath: string, capture: boolean): { content: string; exists: boolean } {
    const rel = toPosix(relPath);
    const cp = this.readCheckpoint(workspace) ?? { workspace, setAt: Date.now(), files: {} };
    const hash = cp.files[rel];
    if (hash) {
      return { content: this.getBaseline(workspace, hash), exists: true };
    }
    if (!capture) {
      return { content: "", exists: false };
    }
    const abs = resolveInside(workspace, rel);
    if (!abs) {
      return { content: "", exists: false };
    }
    const read = readFileSafe(abs);
    if (!read.exists) {
      return { content: "", exists: false };
    }
    const captured = this.putBaseline(workspace, read.content);
    cp.files[rel] = captured;
    this.writeCheckpoint(workspace, cp);
    return { content: read.content, exists: true };
  }

  /**
   * Stage a proposed content (MCP path).
   *
   * The change is written to disk immediately (like Antigravity), so it appears inline
   * in the real file and the user can Accept/Reject hunks right there. "Reject" restores
   * the baseline lines, so nothing is lost. `applied: true` reflects that the disk holds
   * the proposed content.
   */
  propose(workspace: string, relPath: string, content: string, opts: { delete?: boolean } = {}): ChangeSet {
    const abs = resolveInside(workspace, relPath);
    if (!abs) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    const rel = toPosix(path.relative(workspace, abs));
    const base = this.baselineFor(workspace, rel, true);
    const proposed = opts.delete ? "" : content;
    const proposedExists = !opts.delete;
    const existing = this.findChangeByPath(workspace, rel);
    const hunks = computeHunks(splitContent(base.content).lines, splitContent(proposed).lines);
    const meta = splitContent(proposedExists ? proposed : base.content);
    const cs: ChangeSet = {
      id: existing?.id ?? changeIdFor(workspace, rel),
      workspace,
      path: rel,
      absPath: abs,
      origin: "mcp",
      applied: true,
      eol: meta.eol,
      bom: meta.bom,
      finalNewline: meta.finalNewline,
      binary: false,
      baseline: base.content,
      proposed,
      baselineExists: base.exists,
      proposedExists,
      hunks: existing ? rebaseDecisions(existing.hunks, hunks) : hunks,
      status: "pending",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    // Write the proposed content now so the editor shows the change in place.
    if (opts.delete) {
      deleteFileSafe(abs);
    } else {
      writeFileAtomic(abs, proposed);
    }
    this.writeChange(cs);
    return cs;
  }

  /**
   * Observe the current disk state (FS path). Records a direct write we did not stage.
   *
   * Baseline resolution order:
   *   1. the checkpoint (populated by propose/observe for files seen this session),
   *   2. `git show HEAD:<path>` — free, and the common case for a git repo,
   *   3. absent (treated as a newly created file).
   */
  async observe(workspace: string, relPath: string): Promise<ChangeSet | undefined> {
    const abs = resolveInside(workspace, relPath);
    if (!abs) {
      return undefined;
    }
    const rel = toPosix(path.relative(workspace, abs));
    if (this.isExcluded(rel)) {
      return undefined;
    }
    const read = readFileSafe(abs);
    if (read.exists && read.binary) {
      return await this.observeBinary(workspace, rel, abs, read.hash);
    }
    if (read.exists && Buffer.byteLength(read.content) > this.maxFileSize) {
      return await this.observeBinary(workspace, rel, abs, read.hash);
    }
    const base = await this.baselineForObserve(workspace, rel);
    const existing = this.findChangeByPath(workspace, rel);
    // No baseline and no prior change: this is a file created since the checkpoint.
    const proposedExists = read.exists;
    const proposed = read.exists ? read.content : "";
    if (!base.exists && !proposedExists && !existing) {
      return undefined; // nothing to show
    }
    const hunks = computeHunks(splitContent(base.content).lines, splitContent(proposed).lines);
    const meta = splitContent(proposedExists ? proposed : base.content);
    const cs: ChangeSet = {
      id: existing?.id ?? changeIdFor(workspace, rel),
      workspace,
      path: rel,
      absPath: abs,
      origin: "fs",
      applied: true,
      eol: meta.eol,
      bom: meta.bom,
      finalNewline: meta.finalNewline,
      binary: false,
      baseline: base.content,
      proposed,
      baselineExists: base.exists,
      proposedExists,
      hunks: existing ? rebaseDecisions(existing.hunks, hunks) : hunks,
      status: "pending",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    if (hunks.length === 0) {
      // File matches baseline again (agent reverted it) -> drop the change set.
      this.removeChange(cs);
      return undefined;
    }
    this.writeChange(cs);
    return cs;
  }

  private async observeBinary(workspace: string, rel: string, abs: string, hash: string): Promise<ChangeSet | undefined> {
    const base = await this.baselineForObserve(workspace, rel);
    const existing = this.findChangeByPath(workspace, rel);
    const baseHash = hashContent(base.content);
    if (base.exists && baseHash === hash) {
      if (existing) {
        this.removeChange(existing);
      }
      return undefined;
    }
    const cs: ChangeSet = {
      id: existing?.id ?? changeIdFor(workspace, rel),
      workspace,
      path: rel,
      absPath: abs,
      origin: "fs",
      applied: true,
      eol: "\n",
      bom: false,
      finalNewline: false,
      binary: true,
      baseline: base.content,
      proposed: "",
      baselineExists: base.exists,
      proposedExists: true,
      hunks: [],
      status: "pending",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.writeChange(cs);
    return cs;
  }

  private removeChange(cs: ChangeSet): void {
    deleteFileSafe(this.changePath(cs.workspace, cs.id));
    this.invalidate(cs.workspace);
  }

  // ---- decisions ----

  private decide(changeId: string, hunkIds: string[] | undefined, decision: "accepted" | "rejected"): DecideResult {
    const cs = this.findById(changeId);
    if (!cs) {
      throw new Error(`unknown change: ${changeId}`);
    }
    const set = hunkIds ? new Set(hunkIds) : undefined;
    cs.hunks = cs.hunks.map((h) => (set === undefined || set.has(h.id) ? { ...h, decision } : h));
    cs.updatedAt = Date.now();
    return this.settle(cs, decision);
  }

  accept(changeId: string, hunkIds?: string[]): DecideResult {
    return this.decide(changeId, hunkIds, "accepted");
  }

  reject(changeId: string, hunkIds?: string[]): DecideResult {
    return this.decide(changeId, hunkIds, "rejected");
  }

  findById(changeId: string): ChangeSet | undefined {
    // changeId is unique per workspace; search the workspaces we know about.
    const workspacesDir = path.join(this.baseDir, "workspaces");
    let keys: string[];
    try {
      keys = fs.readdirSync(workspacesDir);
    } catch {
      return undefined;
    }
    for (const key of keys) {
      const dir = path.join(workspacesDir, key, "changes");
      const file = path.join(dir, `${changeId}.json`);
      try {
        const cs = JSON.parse(fs.readFileSync(file, "utf8")) as ChangeSet;
        if (cs && cs.id === changeId) {
          return cs;
        }
      } catch {
        // try next
      }
    }
    return undefined;
  }

  /**
   * Apply decisions. In both paths the disk currently holds the proposed content
   * (the MCP path writes it on propose; the FS path observed it), so we reconcile the
   * file on every decision: rejected hunks go back to their baseline lines, pending and
   * accepted hunks stay as proposed. When every hunk is decided, the baseline advances
   * and the change set is cleared.
   */
  private settle(cs: ChangeSet, decision: "accepted" | "rejected"): DecideResult {
    const pending = cs.hunks.filter((h) => h.decision === "pending").length;
    const fullyDecided = cs.hunks.length === 0 ? true : pending === 0;

    const baselineLines = splitContent(cs.baseline).lines;
    const resolvedLines = resolveLines(baselineLines, cs.hunks, "proposed");
    const resolved = joinContent(resolvedLines, this.resolvedMeta(cs, decision));
    this.applyToDisk(cs, resolved);

    if (fullyDecided) {
      this.advanceBaseline(cs, resolved);
      cs.status = "resolved";
      cs.updatedAt = Date.now();
      // Keep the resolved set on disk (instead of deleting it) so an open review tab can
      // still render the final state — old lines only for a reject, new lines only for an
      // accept. Deleting it immediately made the tab go blank the instant the last hunk
      // was decided. `listChangesRaw` hides resolved sets from the tree and status bar,
      // and `pruneResolved` removes them once they are stale.
      this.writeChange(cs);
      return { changeId: cs.id, status: "resolved", resolved: true, remaining: 0, hunks: cs.hunks };
    }

    cs.status = "applied";
    this.writeChange(cs);
    return { changeId: cs.id, status: cs.status, resolved: false, remaining: pending, hunks: cs.hunks };
  }

  /**
   * Framing (EOL / BOM / trailing newline) for the resolved content.
   *
   * The change set records the framing of the *proposed* file, because that is what the
   * agent wrote. But once no hunk remains accepted the resolved file is the baseline, so
   * it must be rebuilt with the *baseline's* framing — otherwise a reject silently
   * converts a file that had no trailing newline (or a BOM, or CRLF) into one that does.
   *
   * A framing-only proposal (same lines, different trailing newline) produces zero hunks,
   * so there the user's intent comes from the decision that was just made.
   */
  private resolvedMeta(
    cs: ChangeSet,
    decision: "accepted" | "rejected",
  ): { eol: "\n" | "\r\n"; bom: boolean; finalNewline: boolean } {
    const allRejected =
      cs.hunks.length === 0 ? decision === "rejected" : cs.hunks.every((h) => h.decision === "rejected");
    if (allRejected) {
      const base = splitContent(cs.baseline);
      return { eol: base.eol, bom: base.bom, finalNewline: base.finalNewline };
    }
    return { eol: cs.eol, bom: cs.bom, finalNewline: cs.finalNewline };
  }

  /**
   * Whether the file will exist on disk once `resolved` is applied. `applyToDisk` and
   * `advanceBaseline` share this predicate so they cannot disagree: if the checkpoint
   * kept a baseline for a file that was just deleted (or dropped one for a file that
   * still exists), the next watcher poll would resurrect the change as a bogus
   * whole-file edit.
   */
  private resolvedExists(cs: ChangeSet, resolved: string): boolean {
    const isDelete = cs.proposedExists === false && cs.baselineExists;
    const acceptedDelete = isDelete && cs.hunks.every((h) => h.decision === "accepted");
    if (acceptedDelete) {
      return false;
    }
    if (!cs.baselineExists && resolved.length === 0) {
      return false;
    }
    return cs.baselineExists || resolved.length > 0 || cs.proposedExists;
  }

  private applyToDisk(cs: ChangeSet, resolved: string): void {
    if (cs.binary) {
      // Binary: accept keeps current bytes; reject restores baseline bytes.
      const allRejected = cs.hunks.length === 0 ? false : cs.hunks.every((h) => h.decision === "rejected");
      if (allRejected) {
        if (cs.baselineExists) {
          writeFileAtomic(cs.absPath, cs.baseline);
        } else {
          deleteFileSafe(cs.absPath);
        }
      }
      return;
    }
    if (this.resolvedExists(cs, resolved)) {
      writeFileAtomic(cs.absPath, resolved);
    } else {
      deleteFileSafe(cs.absPath);
    }
  }

  /**
   * Move the file's checkpoint baseline to the resolved content once every hunk is
   * decided, so the file is not re-reported as a change on the next observation.
   *
   * The baseline must follow what actually survived on disk, not the agent's proposal:
   * a fully rejected modification leaves the file at its *original* baseline (so the
   * entry is kept, and with the same hash), while a fully rejected new file leaves
   * nothing (so the entry is dropped).
   */
  private advanceBaseline(cs: ChangeSet, resolved: string): void {
    const cp = this.readCheckpoint(cs.workspace);
    if (!cp) {
      return;
    }
    if (this.resolvedExists(cs, resolved)) {
      cp.files[cs.path] = this.putBaseline(cs.workspace, resolved);
    } else {
      delete cp.files[cs.path];
    }
    this.writeCheckpoint(cs.workspace, cp);
  }

  /** Restore a file to its baseline (undo everything). */
  undo(changeId: string): DecideResult {
    return this.reject(changeId);
  }
}

export function summarize(cs: ChangeSet): ChangeSummary {
  const stats = diffStats(cs.hunks);
  return {
    id: cs.id,
    workspace: cs.workspace,
    path: cs.path,
    origin: cs.origin,
    applied: cs.applied,
    status: cs.status,
    binary: cs.binary,
    added: stats.added,
    removed: stats.removed,
    accepted: cs.hunks.filter((h) => h.decision === "accepted").length,
    rejected: cs.hunks.filter((h) => h.decision === "rejected").length,
    pending: cs.hunks.filter((h) => h.decision === "pending").length,
  };
}

export type { ChangeStatus, Hunk };
