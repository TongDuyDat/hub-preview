/**
 * Persistence for checkpoints, change sets, and baseline blobs.
 *
 * `JsonBackend` is the original file-backed implementation, moved here unchanged: one
 * directory per workspace under `~/.review-hub/workspaces/<hash>/`, one JSON file per
 * change set, plus `checkpoint.json`. It is the fallback when `node:sqlite` is missing.
 *
 * `SqliteBackend` (see the bottom of this file) stores the same records in one
 * `~/.review-hub/hub.db`. Baseline *blobs* stay content-addressed on disk in both
 * backends — they can be megabytes, and moving them into SQLite would mean rewriting
 * large values on every decision for no benefit.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic, deleteFileSafe, hashContent } from "./file-snapshot";
import type { ChangeSet } from "./types";
import type { SqlDriver } from "./sqlite";

export interface CheckpointRecord {
  workspace: string;
  setAt: number;
  files: Record<string, string>; // relPath -> content hash
  /** True when the walk hit maxFiles/maxDurationMs and did not see the whole tree. */
  truncated?: boolean;
}

export interface StoreBackend {
  readCheckpoint(workspace: string): CheckpointRecord | undefined;
  writeCheckpoint(cp: CheckpointRecord): void;
  clearCheckpoint(workspace: string): void;
  knownWorkspaces(): string[];

  writeChange(cs: ChangeSet): void;
  getChange(workspace: string, id: string): ChangeSet | undefined;
  listChangeSets(workspace: string): ChangeSet[];
  findById(id: string): ChangeSet | undefined;
  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined;
  removeChange(workspace: string, id: string): void;
  clearChanges(workspace: string): void;
  pruneResolved(maxAgeMs: number): void;

  putBaseline(workspace: string, content: string): string;
  getBaseline(workspace: string, hash: string): string;

  dispose(): void;
}

export function workspaceKey(workspace: string): string {
  return createHash("sha256").update(workspace).digest("hex").slice(0, 16);
}

/** Content-addressed baseline storage, shared by both backends. */
export class BaselineBlobs {
  constructor(private baseDir: string) {}

  private dir(workspace: string): string {
    return path.join(this.baseDir, "workspaces", workspaceKey(workspace), "baselines");
  }

  put(workspace: string, content: string): string {
    const hash = hashContent(content);
    const file = path.join(this.dir(workspace), hash);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, content);
    }
    return hash;
  }

  get(workspace: string, hash: string): string {
    try {
      return fs.readFileSync(path.join(this.dir(workspace), hash), "utf8");
    } catch {
      return "";
    }
  }
}

export class JsonBackend implements StoreBackend {
  private blobs: BaselineBlobs;
  /**
   * In-memory cache of change sets per workspace. CodeLens and the panel call the list
   * methods on every keystroke / render, so re-reading every JSON from disk each time is
   * wasteful. Revalidated against the changes directory's mtime, because the store is
   * shared: another VS Code window may write changes we must see.
   */
  private cache = new Map<string, { at: number; items: ChangeSet[] }>();

  constructor(private baseDir: string) {
    this.blobs = new BaselineBlobs(baseDir);
  }

  private wsDir(workspace: string): string {
    return path.join(this.baseDir, "workspaces", workspaceKey(workspace));
  }

  private checkpointPath(workspace: string): string {
    return path.join(this.wsDir(workspace), "checkpoint.json");
  }

  private changesDir(workspace: string): string {
    return path.join(this.wsDir(workspace), "changes");
  }

  private changePath(workspace: string, id: string): string {
    return path.join(this.changesDir(workspace), `${id}.json`);
  }

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

  readCheckpoint(workspace: string): CheckpointRecord | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.checkpointPath(workspace), "utf8")) as CheckpointRecord;
      if (parsed && typeof parsed === "object" && parsed.files) {
        return parsed;
      }
    } catch {
      // none yet
    }
    return undefined;
  }

  writeCheckpoint(cp: CheckpointRecord): void {
    fs.mkdirSync(this.wsDir(cp.workspace), { recursive: true });
    writeFileAtomic(this.checkpointPath(cp.workspace), `${JSON.stringify(cp, null, 2)}\n`);
  }

  clearCheckpoint(workspace: string): void {
    deleteFileSafe(this.checkpointPath(workspace));
    this.clearChanges(workspace);
  }

  knownWorkspaces(): string[] {
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

  writeChange(cs: ChangeSet): void {
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

  listChangeSets(workspace: string): ChangeSet[] {
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
    // One row per file, always the latest edit.
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

  findById(id: string): ChangeSet | undefined {
    const workspacesDir = path.join(this.baseDir, "workspaces");
    let keys: string[];
    try {
      keys = fs.readdirSync(workspacesDir);
    } catch {
      return undefined;
    }
    for (const key of keys) {
      const file = path.join(workspacesDir, key, "changes", `${id}.json`);
      try {
        const cs = JSON.parse(fs.readFileSync(file, "utf8")) as ChangeSet;
        if (cs && cs.id === id) {
          return cs;
        }
      } catch {
        // try next
      }
    }
    return undefined;
  }

  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined {
    const p = relPath.split(path.sep).join("/");
    return this.listChangeSets(workspace).find((cs) => cs.path === p);
  }

  removeChange(workspace: string, id: string): void {
    deleteFileSafe(this.changePath(workspace, id));
    this.invalidate(workspace);
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

  pruneResolved(maxAgeMs: number): void {
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
          // `>=` rather than `>` so `pruneResolved(0)` reliably drops a set that was just
          // resolved in the same millisecond ("older than 0ms" holds for anything).
          if (cs.status === "resolved" && now - (cs.updatedAt ?? 0) >= maxAgeMs) {
            deleteFileSafe(file);
            removed = true;
          }
        } catch {
          // skip
        }
      }
      if (removed) {
        this.invalidate(path.join(root, key));
      }
    }
  }

  putBaseline(workspace: string, content: string): string {
    return this.blobs.put(workspace, content);
  }

  getBaseline(workspace: string, hash: string): string {
    return this.blobs.get(workspace, hash);
  }

  dispose(): void {
    this.cache.clear();
  }
}
