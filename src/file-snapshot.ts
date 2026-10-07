/**
 * Filesystem helpers for reading/writing file content safely: binary detection,
 * atomic writes, path containment. No `vscode` import so the hub and tests can use it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface FileReadResult {
  exists: boolean;
  content: string;
  binary: boolean;
  hash: string;
}

const NUL = 0;

export function isBinaryBuffer(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  return sample.includes(NUL);
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readFileSafe(absPath: string): FileReadResult {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return { exists: false, content: "", binary: false, hash: hashContent("") };
  }
  if (isBinaryBuffer(buf)) {
    return { exists: true, content: "", binary: true, hash: hashContent(buf) };
  }
  const content = buf.toString("utf8");
  return { exists: true, content, binary: false, hash: hashContent(buf) };
}

/** Write text atomically: write a sibling tmp file, then rename over the target. */
export function writeFileAtomic(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, absPath);
}

export function deleteFileSafe(absPath: string): void {
  try {
    fs.unlinkSync(absPath);
  } catch {
    // already gone
  }
}

/**
 * Resolve a path and refuse anything that escapes the workspace.
 * Returns null when the path is outside the workspace (path traversal guard).
 *
 * Accepts either form: an absolute path that already sits inside the workspace is used
 * as-is, anything else is treated as workspace-relative. Both are then re-checked by
 * containment, so a path like `/etc/passwd` (or `../secrets`) is still rejected.
 */
export function resolveInside(workspace: string, relPath: string): string | null {
  const normalized = relPath.replace(/\\/g, "/");
  const abs = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workspace, normalized.replace(/^\/+/, ""));
  const rel = path.relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return null;
  }
  return abs;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
