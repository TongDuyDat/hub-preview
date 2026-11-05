import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { workspaceKey } from "./store-backend";
import type { ReviewDecisionEvent, ReviewUpdates } from "./types";

const MAX_READ = 1024 * 1024;

/** Append-only metadata journal shared by UI windows and surviving resolved-set pruning. */
export class ReviewEventJournal {
  constructor(private readonly baseDir: string) {}
  private file(workspace: string): string {
    return path.join(this.baseDir, "workspaces", workspaceKey(workspace), "review-events.jsonl");
  }
  append(event: Omit<ReviewDecisionEvent, "id" | "at">): void {
    const file = this.file(event.workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // One append syscall per record; no source code is stored in the journal.
    const fd = fs.openSync(file, "a+", 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(1);
      if (size) fs.readSync(fd, tail, 0, 1, size - 1);
      // Separate a previous interrupted record from the next complete event.
      const separator = size && tail[0] !== 10 ? "\n" : "";
      fs.appendFileSync(fd, separator + JSON.stringify({ ...event, id: randomUUID(), at: Date.now() }) + "\n");
    } finally { fs.closeSync(fd); }
  }
  read(workspace: string, after?: string, limit = 100, latest = false): ReviewUpdates {
    let fd: number | undefined;
    let partial = false;
    let text = "";
    try {
      fd = fs.openSync(this.file(workspace), "r");
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - MAX_READ);
      partial = start > 0;
      const buffer = Buffer.alloc(Math.min(size, MAX_READ));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
      text = buffer.subarray(0, bytes).toString("utf8");
      if (partial) text = text.slice(text.indexOf("\n") + 1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    const records: ReviewDecisionEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const record = JSON.parse(line) as ReviewDecisionEvent;
        if (record.workspace === workspace && typeof record.id === "string") records.push(record);
      } catch { /* Ignore an interrupted final append; subsequent reads can recover it. */ }
    }
    const last = records.at(-1)?.id ?? "";
    if (latest) return { workspace, events: [], cursor: last, hasMore: false, reset: false };
    const index = after ? records.findIndex(event => event.id === after) : -1;
    const reset = after ? index < 0 : partial;
    const available = records.slice(index + 1);
    const events = available.slice(0, Math.max(1, Math.min(100, limit)));
    return { workspace, events, cursor: events.at(-1)?.id ?? last, hasMore: events.length < available.length, reset };
  }
}
