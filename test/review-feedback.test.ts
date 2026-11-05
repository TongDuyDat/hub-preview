import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../core/src/change-store";
import { ReviewEventJournal } from "../core/src/review-events";
import { workspaceKey } from "../core/src/store-backend";
import { ReviewFeedback } from "../mcp/review-feedback";
import { reviewToolAllowed } from "../vscode/src/agents/review-policy";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rh-review-feedback-"));
const baseline = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
const proposed = baseline.replace("line 2\n", "changed first\n").replace("line 24\n", "changed last\n");

for (const backend of ["json", "auto"] as const) {
  test(backend + " journals partial/resolved decisions from direct UI store calls and survives restart/pruning", () => {
    const baseDir = tmp(); const workspace = tmp();
    fs.writeFileSync(path.join(workspace, "code.ts"), baseline);
    const store = new ChangeStore({ baseDir, backend, mcpOnly: true });
    const cs = store.propose(workspace, "code.ts", proposed);
    assert.equal(cs.hunks.length, 2);
    store.accept(cs.id, [cs.hunks[0].id]);
    const first = store.reviewUpdates(workspace);
    assert.equal(first.events.length, 1);
    assert.deepEqual(first.events[0].hunkIds, [cs.hunks[0].id]);
    assert.equal(first.events[0].accepted, 1); assert.equal(first.events[0].pending, 1);
    assert.equal(first.events[0].resolved, false);
    store.accept(cs.id, [cs.hunks[0].id]); // duplicate click, no duplicate event
    assert.equal(store.reviewUpdates(workspace).events.length, 1);
    store.reject(cs.id, [cs.hunks[1].id]);
    const last = store.reviewUpdates(workspace, first.cursor);
    assert.equal(last.events.length, 1); assert.equal(last.events[0].decision, "rejected");
    assert.equal(last.events[0].resolved, true); assert.equal(last.events[0].pending, 0);
    assert.equal(last.events[0].accepted, 1); assert.equal(last.events[0].rejected, 1);
    const content = fs.readFileSync(path.join(workspace, "code.ts"), "utf8");
    assert.match(content, /changed first/); assert.match(content, /line 24/); assert.doesNotMatch(content, /changed last/);
    assert.equal(store.listChanges(workspace).length, 0);
    store.pruneResolved(-1); store.dispose();
    const restarted = new ChangeStore({ baseDir, backend });
    assert.equal(restarted.reviewUpdates(workspace).events.length, 2);
    assert.equal(restarted.reviewUpdates(workspace, last.cursor).events.length, 0);
    assert.equal(restarted.reviewUpdates(tmp()).events.length, 0);
    restarted.dispose();
  });
}

test("failed decisions and unknown hunk IDs do not emit feedback", () => {
  const store = new ChangeStore({ baseDir: tmp(), backend: "json" }); const workspace = tmp();
  const cs = store.propose(workspace, "code.ts", proposed);
  assert.throws(() => store.reject("missing"));
  store.accept(cs.id, ["unknown"]);
  assert.equal(store.reviewUpdates(workspace).events.length, 0);
  const original = (store as any).applyToDisk;
  (store as any).applyToDisk = () => { throw new Error("write failed"); };
  assert.throws(() => store.reject(cs.id), /write failed/);
  assert.equal(store.reviewUpdates(workspace).events.length, 0);
  (store as any).applyToDisk = original; store.dispose();
});

test("journal cursor pagination, stale cursors and latest snapshots are explicit", () => {
  const journal = new ReviewEventJournal(tmp()); const workspace = tmp();
  const event = { workspace, path: "a.ts", changeId: "test", decision: "accepted" as const, hunkIds: ["a"], hunksTruncated: false, accepted: 1, rejected: 0, pending: 0, resolved: true };
  journal.append(event); journal.append({ ...event, path: "b.ts" });
  const first = journal.read(workspace, undefined, 1);
  assert.equal(first.hasMore, true); assert.equal(first.events.length, 1);
  const next = journal.read(workspace, first.cursor, 1);
  assert.equal(next.events[0].path, "b.ts"); assert.equal(next.hasMore, false);
  assert.equal(journal.read(workspace, "expired").reset, true);
  assert.equal(journal.read(workspace, undefined, 100, true).cursor, next.cursor);
  assert.equal(journal.read(workspace, undefined, 100, true).events.length, 0);
  assert.equal(journal.read(tmp(), "expired").reset, true);
});

test("journal bounds reads, skips interrupted records, never stores source contents", () => {
  const baseDir = tmp(); const journal = new ReviewEventJournal(baseDir); const workspace = tmp();
  const event = { workspace, path: "code.ts", changeId: "test", decision: "rejected" as const, hunkIds: ["h"], hunksTruncated: false, accepted: 0, rejected: 1, pending: 0, resolved: true };
  journal.append(event);
  const file = path.join(baseDir, "workspaces", workspaceKey(workspace), "review-events.jsonl");
  const line = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, line.repeat(Math.ceil(1_100_000 / line.length)) + '{interrupted');
  const page = journal.read(workspace);
  assert.equal(page.reset, true); assert.equal(page.events.length, 100); assert.equal(page.hasMore, true);
  assert.equal("content" in page.events[0], false);
  journal.append({ ...event, path: "recovered.ts" });
  const latest = journal.read(workspace, undefined, 100, true);
  assert.notEqual(latest.cursor, "");
  const replay = journal.read(workspace, page.cursor);
  assert.ok(replay.events.length > 0);
  // The record appended after an interrupted line is complete and recoverable.
  assert.match(fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1)!, /recovered.ts/);
});

test("notifications do not consume tool feedback; full reads unlock only the reviewed path", async () => {
  const baseDir = tmp(); const workspace = tmp(); const journal = new ReviewEventJournal(baseDir);
  const feedback = new ReviewFeedback(async (ws, after, latest) => journal.read(ws, after, 100, latest));
  assert.equal((await feedback.take(workspace)).events.length, 0);
  journal.append({ workspace, path: "a.ts", changeId: "c", decision: "rejected", hunkIds: ["h"], hunksTruncated: false, accepted: 0, rejected: 1, pending: 0, resolved: true });
  let notifications = 0;
  await feedback.poll(async page => { notifications++; assert.equal(page.events.length, 1); });
  await feedback.poll(async () => { notifications++; });
  assert.equal(notifications, 1);
  const pages = await Promise.all([feedback.take(workspace), feedback.take(workspace)]);
  assert.deepEqual(pages.map(page => page.events.length), [1, 0]);
  assert.equal(await feedback.requiresRead(workspace, "a.ts"), true);
  assert.equal(await feedback.requiresRead(workspace, "b.ts"), false);
  await feedback.didRead(workspace, "b.ts");
  assert.equal(await feedback.requiresRead(workspace, "a.ts"), true);
  await feedback.didRead(workspace, "a.ts");
  assert.equal(await feedback.requiresRead(workspace, "a.ts"), false);
});

test("failed notifications retry without losing tool feedback; disconnected polling recovers", async () => {
  const journal = new ReviewEventJournal(tmp()); const workspace = tmp(); let down = false;
  const feedback = new ReviewFeedback(async (ws, after, latest) => { if (down) throw Error("offline"); return journal.read(ws, after, 100, latest); });
  await feedback.take(workspace);
  journal.append({ workspace, path: "a.ts", changeId: "c", decision: "accepted", hunkIds: ["h"], hunksTruncated: false, accepted: 1, rejected: 0, pending: 0, resolved: true });
  await feedback.poll(async () => { throw Error("client dropped log"); });
  down = true; await assert.rejects(() => feedback.take(workspace));
  down = false; let count = 0;
  await feedback.poll(async page => { count = page.events.length; }); assert.equal(count, 1);
  assert.equal((await feedback.take(workspace)).events.length, 1);
});

test("strict review hooks permit the feedback tool, including OMP XDEV", () => {
  assert.equal(reviewToolAllowed("claude", "mcp__review_hub__get_review_updates", {}), true);
  assert.equal(reviewToolAllowed("omp", "mcp__review_hub_get_review_updates", {}), true);
  assert.equal(reviewToolAllowed("omp", "write", { path: "xd://mcp__review_hub_get_review_updates" }), true);
});
