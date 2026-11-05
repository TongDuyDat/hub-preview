import { ReviewEventJournal } from "./review-events";
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
import { computeHunks, diffStats, diskFrame, rebaseDecisions, resolveLines, splitContent, joinContent } from "./hunk-diff";
import {
  writeFileAtomic,
  writeFileAtomicBytes,
  deleteFileSafe,
  readFileSafe,
  readFileBytes,
  resolveInside,
  toPosix,
  encodeBaseline,
  decodeBaseline,
  isEncodedBaseline,
  isBinaryBuffer,
} from "./file-snapshot";
import { JsonBackend, SqliteBackend, type CheckpointRecord, type StoreBackend } from "./store-backend";
import { openDatabase } from "./sqlite";
import { readGitBaseline, readGitBaselineBytes } from "./git-baseline";

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
  /** Review only MCP proposals; ignore legacy filesystem/Git changes. */
  mcpOnly?: boolean;
  baseDir?: string;
  maxFileSize?: number;
  excludeGlobs?: string[];
  /** Which persistence backend to use. `"auto"` prefers SQLite and falls back to JSON. */
  backend?: "auto" | "json" | "sqlite";
}

const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024;

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
  private backend: StoreBackend;
  private readonly mcpOnly: boolean;
  private readonly reviewEvents: ReviewEventJournal;

  constructor(opts: StoreOptions = {}) {
    this.mcpOnly = opts.mcpOnly ?? false;
    this.baseDir = opts.baseDir ?? path.join(os.homedir(), ".review-hub");
    this.reviewEvents = new ReviewEventJournal(this.baseDir);
    this.maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.excludeGlobs = opts.excludeGlobs ?? [];
    this.excludeRes = this.excludeGlobs.map(globToRegExp);

    const mode = opts.backend ?? "auto";
    if (mode === "json") {
      this.backend = new JsonBackend(this.baseDir);
      return;
    }
    const driver = openDatabase(path.join(this.baseDir, "hub.db"));
    if (!driver) {
      if (mode === "sqlite") {
        throw new Error("Review Hub: the sqlite backend was requested but node:sqlite is unavailable.");
      }
      this.backend = new JsonBackend(this.baseDir);
      return;
    }
    try {
      this.backend = new SqliteBackend(driver, this.baseDir);
    } catch (err) {
      // A present-but-unusable file (corrupt, wrong format, permissions) must not take
      // activation down: the spec promises a JSON fallback. The driver may already be
      // half-open, so close it before dropping it.
      try {
        driver.close();
      } catch {
        // best effort
      }
      if (mode === "sqlite") {
        throw err;
      }
      console.warn(
        `Review Hub: the SQLite store could not be opened (${(err as Error).message}); using the JSON store.`,
      );
      this.backend = new JsonBackend(this.baseDir);
    }
  }

  /** Release backend resources (the SQLite connection). Safe to call twice. */
  dispose(): void {
    this.backend.dispose();
  }

  // ---- paths / storage delegation ----

  private isExcluded(relPath: string): boolean {
    const p = toPosix(relPath);
    return this.excludeRes.some((re) => re.test(p));
  }

  private putBaseline(workspace: string, content: string): string {
    return this.backend.putBaseline(workspace, content);
  }

  private getBaseline(workspace: string, hash: string): string {
    return this.backend.getBaseline(workspace, hash);
  }

  /**
   * Store raw bytes in the checkpoint slot, tagging the blob hash so the encoding is
   * explicit. A checkpoint value is either a plain blob hash (utf8 text) or this
   * `bin:`-tagged hash (base64 bytes) — never a value a reader has to sniff.
   */
  private putBytesBaseline(workspace: string, bytes: Buffer): string {
    return "bin:" + this.putBaseline(workspace, encodeBaseline(bytes));
  }

  /**
   * Store a baseline for a file's raw bytes, tagging the blob hash `bin:` **only when the
   * content is genuinely binary**. Text content is stored as a plain utf8 blob, so the
   * text path can read it back later: reserving the byte encoding for binary content is
   * what keeps an oversize *text* file's baseline diffable after it shrinks below
   * `maxFileSize` (otherwise the text path would see a `bin:` value and lose the baseline).
   */
  private putObservedBaseline(workspace: string, bytes: Buffer): string {
    return isBinaryBuffer(bytes)
      ? this.putBytesBaseline(workspace, bytes)
      : this.putBaseline(workspace, bytes.toString("utf8"));
  }

  /** The blob hash inside a checkpoint value, plus whether it holds encoded bytes. */
  private resolveCheckpointValue(value: string): { hash: string; encoded: boolean } {
    return value.startsWith("bin:") ? { hash: value.slice(4), encoded: true } : { hash: value, encoded: false };
  }

  readCheckpoint(workspace: string): CheckpointRecord | undefined {
    return this.backend.readCheckpoint(workspace);
  }

  checkpointInfo(workspace: string): CheckpointInfo | undefined {
    const cp = this.readCheckpoint(workspace);
    if (!cp) {
      return undefined;
    }
    return { workspace, setAt: cp.setAt, files: Object.keys(cp.files).length };
  }

  private writeCheckpoint(workspace: string, cp: CheckpointRecord): void {
    this.backend.writeCheckpoint(cp);
  }

  private writeChange(cs: ChangeSet): void {
    this.backend.writeChange(cs);
  }

  private reviewable(cs: ChangeSet | undefined): ChangeSet | undefined {
    return cs && (!this.mcpOnly || cs.origin === "mcp") ? cs : undefined;
  }

  getChange(workspace: string, id: string): ChangeSet | undefined {
    return this.reviewable(this.backend.getChange(workspace, id));
  }

  findById(changeId: string): ChangeSet | undefined {
    return this.reviewable(this.backend.findById(changeId));
  }

  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined {
    return this.reviewable(this.backend.findChangeByPath(workspace, relPath));
  }

  private removeChange(cs: ChangeSet): void {
    this.backend.removeChange(cs.workspace, cs.id);
  }

  /** Unresolved change sets, full objects — for the sidebar panel and the review tab. */
  listChangeSets(workspace: string): ChangeSet[] {
    return this.backend.listChangeSets(workspace).filter((cs) => !this.mcpOnly || cs.origin === "mcp");
  }

  listChanges(workspace: string): ChangeSummary[] {
    return this.listChangeSets(workspace).map((cs) => summarize(cs));
  }

  listKnownWorkspaces(): string[] {
    return this.backend.knownWorkspaces();
  }

  clearChanges(workspace: string): void {
    this.backend.clearChanges(workspace);
  }

  pruneResolved(maxAgeMs = 5 * 60_000): void {
    this.backend.pruneResolved(maxAgeMs);
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
    const cp: CheckpointRecord = { workspace, setAt: Date.now(), files, truncated };
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
    this.backend.clearCheckpoint(workspace);
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
    const raw = cp?.files[rel];
    if (raw) {
      const { hash, encoded } = this.resolveCheckpointValue(raw);
      if (encoded) {
        // The slot holds raw bytes (base64), not text: line-diffing it would compare the
        // new text against base64 garbage and then write that garbage back. An empty
        // baseline is a whole-file diff, and it can never be written back as garbage.
        return { content: "", exists: true };
      }
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
   * Byte-exact baseline for the binary / oversize observe path.
   *
   * The string path (`baselineForObserve`) cannot be reused here: a utf8 round-trip of a
   * real binary mangles every invalid sequence, so comparing or restoring it would corrupt
   * the file. A genuinely binary baseline is stored `bin:`-tagged (see `putBytesBaseline`),
   * while a plain utf8 blob written by `setCheckpoint` stays untagged — the tag, not a
   * prefix sniff, says which encoding a value holds.
   */
  private async baselineBytesForObserve(
    workspace: string,
    relPath: string,
  ): Promise<{ bytes: Buffer; exists: boolean }> {
    const rel = toPosix(relPath);
    const cp = this.readCheckpoint(workspace);
    const raw = cp?.files[rel];
    if (raw) {
      const { hash, encoded } = this.resolveCheckpointValue(raw);
      const stored = this.getBaseline(workspace, hash);
      return {
        bytes: encoded ? decodeBaseline(stored) : Buffer.from(stored, "utf8"),
        exists: true,
      };
    }
    const git = await readGitBaselineBytes(workspace, rel);
    if (git.isRepo && git.bytes !== null) {
      // Record it so later observations of the same file are consistent.
      const cpNow = this.readCheckpoint(workspace) ?? { workspace, setAt: Date.now(), files: {} };
      cpNow.files[rel] = this.putObservedBaseline(workspace, git.bytes);
      this.writeCheckpoint(workspace, cpNow);
      return { bytes: git.bytes, exists: true };
    }
    return { bytes: Buffer.alloc(0), exists: false };
  }

  /**
   * Persist the review baseline, then apply proposed content immediately so builds/tests
   * use the new code. Accept keeps it; reject restores baseline lines per hunk.
   */
  propose(workspace: string, relPath: string, content: string, opts: { delete?: boolean } = {}): ChangeSet {
    const abs = resolveInside(workspace, relPath);
    if (!abs) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    const rel = toPosix(path.relative(workspace, abs));
    const existing = this.findChangeByPath(workspace, rel);
    // A fresh MCP review starts at the current working file, never a Git/checkpoint
    // snapshot. Further proposals retain the same review baseline and decisions.
    const current = readFileSafe(abs);
    if ((current.binary || existing?.binary) && !opts.delete) {
      throw new Error(`cannot propose text content for a binary file: ${rel}`);
    }
    const binary = existing?.binary ?? current.binary;
    const base = existing
      ? { content: existing.baseline, exists: existing.baselineExists }
      : { content: binary ? encodeBaseline(fs.readFileSync(abs)) : current.content, exists: current.exists };
    const proposed = opts.delete ? "" : content;
    const proposedExists = !opts.delete;
    const hunks = binary ? [] : computeHunks(splitContent(base.content).lines, splitContent(proposed).lines);
    const meta = splitContent(proposedExists ? proposed : base.content);
    const cs: ChangeSet = {
      id: existing?.id ?? changeIdFor(workspace, rel),
      workspace,
      path: rel,
      absPath: abs,
      origin: "mcp",
      applied: false,
      eol: meta.eol,
      bom: meta.bom,
      finalNewline: meta.finalNewline,
      binary,
      baselineB64: binary ? (existing?.baselineB64 ?? true) : undefined,
      baseline: base.content,
      proposed,
      baselineExists: base.exists,
      proposedExists,
      hunks: existing ? rebaseDecisions(existing.hunks, hunks) : hunks,
      status: "pending",
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    // Keep watcher baselines aligned with this review's original, never an older Git/checkpoint value.
    if (!existing) {
      const cp = this.readCheckpoint(workspace) ?? { workspace, setAt: Date.now(), files: {} };
      if (base.exists) cp.files[rel] = (binary ? "bin:" : "") + this.putBaseline(workspace, base.content);
      else delete cp.files[rel];
      this.writeCheckpoint(workspace, cp);
    }
    // Save the original before touching disk, including for new files and deletions.
    this.writeChange(cs);
    const applied = { ...cs, applied: true };
    const resolved = binary ? "" : joinContent(
      resolveLines(splitContent(cs.baseline).lines, cs.hunks, "proposed"),
      this.resolvedMeta(applied, "accepted"),
    );
    try {
      this.applyToDisk(applied, resolved, "accepted");
    } catch (error) {
      if (existing) this.writeChange(existing);
      else this.removeChange(cs);
      throw error;
    }
    this.writeChange(applied);
    return applied;
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
    if (this.mcpOnly) {
      return undefined;
    }
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
      return await this.observeBinary(workspace, rel, abs);
    }
    if (read.exists && Buffer.byteLength(read.content) > this.maxFileSize) {
      return await this.observeBinary(workspace, rel, abs);
    }
    const base = await this.baselineForObserve(workspace, rel);
    const existing = this.findChangeByPath(workspace, rel);
    // No baseline and no prior change: this is a file created since the checkpoint.
    const proposedExists = read.exists;
    const proposed = read.exists ? read.content : "";
    // Our own writes/decisions must not turn an MCP proposal into an FS change or lose
    // its decisions. Legacy unapplied proposals still use their baseline disk frame.
    if (existing && existing.origin === "mcp") {
      const diskLines = splitContent(proposed).lines;
      const projected = resolveLines(splitContent(existing.baseline).lines, existing.hunks, diskFrame(existing.origin, existing.applied));
      if (diskLines.join("\n") === projected.join("\n")) {
        return existing;
      }
    }
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

  private async observeBinary(workspace: string, rel: string, abs: string): Promise<ChangeSet | undefined> {
    // The caller only routes here when the file exists on disk.
    const currentBytes = readFileBytes(abs);
    if (!currentBytes) {
      return undefined;
    }
    const base = await this.baselineBytesForObserve(workspace, rel);
    const existing = this.findChangeByPath(workspace, rel);
    // Compare bytes, not hashes: a hash comparison would need the same mangled string
    // round-trip the baseline deliberately avoids.
    if (base.exists && base.bytes.equals(currentBytes)) {
      if (existing) {
        this.removeChange(existing);
      }
      return undefined;
    }
    // Reserve the byte encoding for genuinely binary content: an oversize *text* file has
    // a text baseline, so a later shrink back to the text path diffs it correctly instead
    // of reading base64 as if it were file content.
    const baseBinary = isBinaryBuffer(base.bytes);
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
      baseline: baseBinary ? encodeBaseline(base.bytes) : base.bytes.toString("utf8"),
      baselineB64: baseBinary,
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

  reviewUpdates(workspace: string, after?: string, limit = 100, latest = false) {
    return this.reviewEvents.read(workspace, after, limit, latest);
  }

  // ---- decisions ----

  private decide(changeId: string, hunkIds: string[] | undefined, decision: "accepted" | "rejected"): DecideResult {
    const cs = this.findById(changeId);
    if (!cs) {
      throw new Error(`unknown change: ${changeId}`);
    }
    const set = hunkIds ? new Set(hunkIds) : undefined;
    const changed = cs.hunks.filter(h => (set === undefined || set.has(h.id)) && h.decision !== decision);
    const previousStatus = cs.status;
    cs.hunks = cs.hunks.map((h) => (set === undefined || set.has(h.id) ? { ...h, decision } : h));
    cs.updatedAt = Date.now();
    const result = this.settle(cs, decision);
    // Capture decisions at the store layer: the editor often bypasses HTTP routes.
    if (cs.origin === "mcp" && (changed.length || (cs.binary && previousStatus !== "resolved"))) {
      try {
        this.reviewEvents.append({ workspace: cs.workspace, path: cs.path, changeId: cs.id,
          decision, hunkIds: changed.slice(0, 200).map(h => h.id), hunksTruncated: changed.length > 200,
          accepted: result.hunks.filter(h => h.decision === "accepted").length,
          rejected: result.hunks.filter(h => h.decision === "rejected").length,
          pending: result.remaining, resolved: result.resolved });
      } catch (error) {
        // A feedback failure must not turn an already-applied user decision into an error.
        console.warn("Review Hub: decision saved, but agent feedback could not be recorded:", error);
      }
    }
    return result;
  }

  accept(changeId: string, hunkIds?: string[]): DecideResult {
    return this.decide(changeId, hunkIds, "accepted");
  }

  reject(changeId: string, hunkIds?: string[]): DecideResult {
    return this.decide(changeId, hunkIds, "rejected");
  }

  /**
   * Apply decisions without reverting pending code. Rejected hunks restore baseline
   * lines while accepted and pending hunks retain the proposal already on disk.
   * When every hunk is decided the baseline advances and the change set is resolved.
   */
  private settle(cs: ChangeSet, decision: "accepted" | "rejected"): DecideResult {
    const pending = cs.hunks.filter((h) => h.decision === "pending").length;
    const fullyDecided = cs.hunks.length === 0 ? true : pending === 0;

    const pendingMode = diskFrame(cs.origin, cs.applied);
    const baselineLines = splitContent(cs.baseline).lines;
    const resolvedLines = resolveLines(baselineLines, cs.hunks, pendingMode);
    // A binary change carries a base64 baseline, not line content: it must never be
    // line-split or rebuilt. `applyToDisk`/`advanceBaseline` read the real bytes instead.
    const resolved = cs.binary ? "" : joinContent(resolvedLines, this.resolvedMeta(cs, decision));
    this.applyToDisk(cs, resolved, decision);

    if (fullyDecided) {
      this.advanceBaseline(cs, resolved, decision);
      cs.status = "resolved";
      cs.updatedAt = Date.now();
      // Keep the resolved set on disk (instead of deleting it) so an open review tab can
      // still render the final state — old lines only for a reject, new lines only for an
      // accept. Deleting it immediately made the tab go blank the instant the last hunk
      // was decided. `listChanges` hides resolved sets from the tree and status bar, and
      // `pruneResolved` removes them once they are stale.
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
   * agent wrote. Applied pending/accepted code keeps proposal framing; restoring any
   * baseline lines uses baseline framing. Fully rejecting restores the original bytes.
   *
   * A framing-only proposal (same lines, different trailing newline) produces zero hunks,
   * so there the user's intent comes from the decision that was just made.
   */
  private resolvedMeta(
    cs: ChangeSet,
    decision: "accepted" | "rejected",
  ): { eol: "\n" | "\r\n"; bom: boolean; finalNewline: boolean } {
    const baselineMeta = () => {
      const base = cs.binary ? splitContent("") : splitContent(cs.baseline);
      return { eol: base.eol, bom: base.bom, finalNewline: base.finalNewline };
    };
    const proposedMeta = () => ({ eol: cs.eol, bom: cs.bom, finalNewline: cs.finalNewline });
    if (cs.hunks.length === 0) {
      return decision === "rejected" ? baselineMeta() : proposedMeta();
    }
    if (!cs.baselineExists) {
      return proposedMeta();
    }
    if (cs.hunks.every((h) => h.decision === "accepted" ||
      (h.decision === "pending" && diskFrame(cs.origin, cs.applied) === "proposed"))) {
      return proposedMeta();
    }
    return baselineMeta();
  }

  /**
   * Whether the file will exist on disk once `resolved` is applied. `applyToDisk` and
   * `advanceBaseline` share this predicate so they cannot disagree: if the checkpoint
   * kept a baseline for a file that was just deleted (or dropped one for a file that
   * still exists), the next watcher poll would resurrect the change as a bogus
   * whole-file edit.
   */
  private resolvedExists(cs: ChangeSet, resolved: string, decision: "accepted" | "rejected"): boolean {
    if (cs.hunks.length === 0) {
      return decision === "rejected" ? cs.baselineExists : cs.proposedExists;
    }
    const isDelete = cs.proposedExists === false && cs.baselineExists;
    const acceptedDelete = isDelete && cs.hunks.every((h) => h.decision === "accepted" ||
      (h.decision === "pending" && diskFrame(cs.origin, cs.applied) === "proposed"));
    if (acceptedDelete) {
      return false;
    }
    if (!cs.baselineExists && resolved.length === 0) {
      return false;
    }
    return cs.baselineExists || resolved.length > 0 || cs.proposedExists;
  }

  private applyToDisk(cs: ChangeSet, resolved: string, decision: "accepted" | "rejected"): void {
    if (cs.binary) {
      // Binary: accept keeps the agent's bytes already on disk; reject restores the
      // baseline bytes exactly (or removes a file the agent created from nothing).
      if (decision === "rejected") {
        if (cs.baselineExists) {
          // `baselineB64` is authoritative whenever a backend persists it (the SQLite row has
          // a `baseline_b64` column, backfilled from the stored prefix during migration). The
          // `isEncodedBaseline` prefix check is only a fallback for a `ChangeSet` that omits the
          // field — e.g. a hand-built one. `b64:`/`bin:` is unambiguous here because a text
          // baseline is never written with that prefix (see `observeBinary`).
          const encoded = cs.baselineB64 ?? isEncodedBaseline(cs.baseline);
          writeFileAtomicBytes(cs.absPath, encoded ? decodeBaseline(cs.baseline) : Buffer.from(cs.baseline, "utf8"));
        } else {
          deleteFileSafe(cs.absPath);
        }
      }
      if (decision === "accepted" && !cs.proposedExists) {
        deleteFileSafe(cs.absPath);
      }
      return;
    }
    if (this.resolvedExists(cs, resolved, decision)) {
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
  private advanceBaseline(cs: ChangeSet, resolved: string, decision: "accepted" | "rejected"): void {
    const cp = this.readCheckpoint(cs.workspace);
    if (!cp) {
      return;
    }
    if (cs.binary) {
      // A binary change has no line content to hash: read back whatever the decision left
      // on disk (accept = the agent's bytes, reject = the restored baseline) and store it
      // byte-exact, so the next observe compares equal and drops the change.
      const bytes = readFileBytes(cs.absPath);
      if (bytes) {
        cp.files[cs.path] = this.putObservedBaseline(cs.workspace, bytes);
      } else {
        delete cp.files[cs.path];
      }
      this.writeCheckpoint(cs.workspace, cp);
      return;
    }
    if (this.resolvedExists(cs, resolved, decision)) {
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
  const pendingHunks = cs.hunks.filter((h) => h.decision === "pending");
  const stats = diffStats(pendingHunks.length > 0 || cs.status !== "resolved" ? pendingHunks : cs.hunks);
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
    pending: pendingHunks.length,
  };
}

export type { ChangeStatus, Hunk };
