# Hunkwise-style UI, Review-then-Apply, and SQLite Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Review Hub look and behave like [`molon/hunkwise`](https://github.com/molon/hunkwise) — per-hunk ✓ Accept / ↺ Reject, green added lines, red removed lines, a sidebar panel — while keeping Review Hub's MCP layer, changing the write model so **only decided hunks reach disk**, and moving change records into a small SQLite database.

**Architecture:** Three independent layers, built in order. (1) The write model flips from apply-on-propose to **review-then-apply**: `propose()` stops touching the file, and `settle()` materialises only decided hunks, choosing the pending-hunk frame from the change's `origin`. (2) Persistence moves behind a `StoreBackend` interface with a `SqliteBackend` (Node's built-in `node:sqlite`) and a `JsonBackend` (today's file-backed implementation) as the fallback; `ChangeStore` becomes a thin facade so `hub-server.ts`, `mcp-server.ts` and all 120 existing tests keep working unchanged. (3) The UI becomes two webviews: a hunkwise-style sidebar panel replacing the native tree, and a review tab that renders the multi-line red/green diff (which a `TextEditorDecorationType` structurally cannot do).

**Tech Stack:** TypeScript, VS Code extension API (stable only), esbuild (CJS), Node's built-in `node:sqlite` (`DatabaseSync`), `diff` v9, `node:test` via `scripts/test.mjs`, plain DOM/JS webviews with no framework.

**Spec:** `docs/superpowers/specs/2026-10-07-hunkwise-ui-and-sqlite-store-design.md`

## Global Constraints

- **No proposed APIs, no third-party libraries.** Anything needed must be written by hand. The `.vsix` must be installable from the Marketplace. `vscode.window.createWebviewTextEditorInset` (the `editorInsets` proposal) is **excluded**.
- **No external APIs / services.** `node:sqlite` is a Node built-in, not a dependency, so it is allowed. No new entries in `dependencies` or `devDependencies`.
- **Review-then-apply.** Disk = baseline + *decided* hunks. A pending hunk is **not** on disk.
- **`engines.vscode` = `^1.103.0`** (drops VS Code 1.85–1.102; required for the Electron `node:sqlite` fix).
- **esbuild `target` = `node22`** for both bundles, and for the test bundler in `scripts/test.mjs`.
- **Webview message protocol:** extension → webview uses `{ type: ... }`; webview → extension uses `{ command: ... }`. Matches hunkwise's convention.
- **SQLite rows must be spread (`{ ...row }`) before returning** — rows come back with a null prototype and break `assert.deepEqual`. **Booleans must be stored as `0`/`1`** — `node:sqlite` cannot bind a JS boolean.
- **`node:sqlite`'s `ExperimentalWarning` is filtered individually** (match the message `"SQLite is an experimental feature"`), never by muting all warnings. The `process.emitWarning` override must be installed **before** the `require("node:sqlite")`.
- **Git.** A repository now exists in this project (created after this plan was written; baseline commit `71ba6c9`, `core.autocrlf=false`). Each task **ends with a commit** after its verification checkpoint passes, so the review loop can diff `BASE..HEAD`. Commit message form: `Task <N>: <short title>`. Do not rewrite or amend earlier commits.
- **Verification checkpoint:** every task ends with `npm run typecheck && npm test` → typecheck clean, all tests pass, **before** committing.
- **MIT notice:** hunkwise is MIT (`Copyright (c) 2025 molon`). Only its *layout and interaction model* are borrowed; the panel is written fresh. If any hunkwise code or asset is copied verbatim, reproduce the MIT notice.
- **Test count today: 120** across 20 files in `test/`. That number grows as tasks add tests; the plan states the expected count per task.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/change-store.ts` | **modified** — thin facade over a backend; owns diffing, decisions, checkpoints, and the write model |
| `src/store-backend.ts` | **new** — `StoreBackend` interface, `JsonBackend`, `SqliteBackend`, `BaselineBlobs`, `workspaceKey` |
| `src/sqlite.ts` | **new** — `SqlDriver` wrapper over `node:sqlite`, `openDatabase`, warning filter |
| `src/review-panel-state.ts` | **new** — pure state builders for both webviews (`buildPanelState`, `buildReviewState`) |
| `src/webview-html.ts` | **new** — shared HTML templating + nonce/CSP for both webviews |
| `src/review-panel.ts` | **new** — sidebar `WebviewViewProvider` (hunkwise-style panel) |
| `src/review-tab.ts` | **new** — review tab webview, one panel per change |
| `media/panel.html` / `.css` / `.js` | **new** — sidebar assets |
| `media/review.html` / `.css` / `.js` | **new** — review tab assets |
| `src/changes-tree.ts` | **deleted** — replaced by `src/review-panel.ts` |
| `src/content-provider.ts` | **modified** — drop the `merged` authority |
| `src/diff-view.ts` | **modified** — drop the merged CodeLens branch + `MergedDecorator` + `DiffView.open` |
| `src/change-decorator.ts` | **modified** — `baseline` pending frame, red ghost foreground, `⊕` preview for insertions |
| `src/extension.ts` | **modified** — register the panel + review tab, re-point command arguments |
| `src/types.ts` | **modified** — add plain `FileNode` |
| `src/hub-server.ts` | **modified** — `/file/read` returns staged content when a change exists |
| `mcp/mcp-server.ts` | **modified** — `propose_*` result notes |
| `package.json` | **modified** — `engines`, remove dead `view/item/context` menus |
| `esbuild.js`, `scripts/test.mjs`, `tsconfig.json` | **modified** — `node22` target, `node:sqlite` external |
| `test/vscode-stub.ts` | **modified** — webview surfaces |
| `README.md` | **modified** — new write model, UI, `engines` requirement |

---

### Task 1: Review-then-apply write model

Fixes the reported bug *"tôi bấm accept thì nó phải chấp nhận code đó, trong khi hiện tại lại đổi thành accepted"*. Today `propose()` writes the agent's content to disk, so by the time the user clicks Accept the file already holds it and Accept only relabels the hunk.

**Files:**
- Modify: `src/change-store.ts` (`propose` ~701-741, `observe` ~751-804, `settle` ~897-933)
- Modify: `src/extension.ts` (`decide` ~433-437)
- Create: `test/review-then-apply.test.ts`
- Modify: `test/change-store.test.ts:28`, `test/decision-flow.test.ts:127,142`, `test/accept-all.test.ts:103`, `test/e2e.test.ts:42`, `test/shared-hub.test.ts:41,149`, `test/mcp-forward.test.ts:80`

**Interfaces:**
- Consumes: `resolveLines(baselineLines, hunks, pendingMode)` and `splitContent`/`joinContent` from `src/hunk-diff.ts` (already exported).
- Produces: `ChangeStore.propose(workspace, relPath, content, opts?)` still returns a `ChangeSet` but no longer writes the file and returns `applied: false`; `ChangeSet.applied` keeps its type (`boolean`) and now means "the disk holds the whole proposal" (true only for `origin: "fs"`).

- [ ] **Step 1: Write the failing test**

Create `test/review-then-apply.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-rta-"));
}

const PAD = "pad\n".repeat(15);
const OLD = `A = 1\n${PAD}B = 2\n${PAD}C = 3\n`;
const NEW = `A = 111\n${PAD}B = 222\n${PAD}C = 333\n`;

test("propose leaves the file on disk untouched", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });

  const cs = store.propose(ws, "x.py", NEW);
  assert.equal(cs.hunks.length, 3, "three separate blocks");
  assert.equal(cs.applied, false, "a staged proposal is not on disk");
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "propose must not write the file");
  assert.equal(store.listChanges(ws).length, 1, "it is still listed for review");
});

test("accepting one hunk writes only that hunk's lines", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  store.accept(cs.id, [cs.hunks[1].id]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("A = 1\n"), "A is still the baseline value — it is only pending");
  assert.ok(text.includes("B = 222"), "B is the accepted value, now on disk");
  assert.ok(text.includes("C = 3\n"), "C is still the baseline value — it is only pending");
  assert.equal(text.includes("A = 111"), false, "A's new value is NOT on disk");
  assert.equal(text.includes("C = 333"), false, "C's new value is NOT on disk");
});

test("rejecting a hunk leaves its baseline lines in place", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  store.reject(cs.id, [cs.hunks[2].id]);
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "nothing was written for a rejection");
  assert.deepEqual(store.findById(cs.id)!.hunks.map((h) => h.decision), ["pending", "pending", "rejected"]);
});

test("accepting every hunk materialises the whole proposal", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  const result = store.accept(cs.id);
  assert.equal(result.resolved, true);
  assert.equal(fs.readFileSync(file, "utf8"), NEW);
});

test("re-observing a file our own decisions wrote keeps the staged change", async () => {
  // The watcher polls every 3 s. After accepting hunk B the file differs from the
  // baseline, so a naive re-observe would recompute hunks from disk and drop the hunks
  // that are still pending (they are not on disk). The staged set must win.
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);
  store.accept(cs.id, [cs.hunks[1].id]);

  const again = await store.observe(ws, "x.py");
  assert.ok(again, "the change is still there");
  assert.equal(again!.hunks.length, 3, "no pending hunk was dropped");
  assert.deepEqual(again!.hunks.map((h) => h.decision), ["pending", "accepted", "pending"]);
});

test("an fs change keeps pending hunks on disk (the agent already wrote them)", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  fs.writeFileSync(file, NEW);
  const cs = await store.observe(ws, "x.py");
  assert.ok(cs);
  assert.equal(cs!.applied, true);
  store.accept(cs!.id, [cs!.hunks[1].id]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("A = 111") && text.includes("B = 222") && text.includes("C = 333"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: `test/review-then-apply.test.ts` fails on `assert.equal(cs.applied, false)` — *Received: true* — and on `propose must not write the file`.

- [ ] **Step 3: Stop `propose()` writing to disk**

In `src/change-store.ts`, replace the `propose` doc comment and the tail of the method. The comment currently says the change is written to disk immediately; replace the whole comment with:

```ts
  /**
   * Stage a proposed content (MCP path). **Nothing is written to disk.** The file keeps
   * its baseline content until the user decides, and only the hunks they accept are
   * materialised — so `applied: false` here means "the disk does not hold this proposal".
   */
```

Then set `applied: false` in the `cs` object literal and delete the write:

```ts
      origin: "mcp",
      applied: false,
```

```ts
    this.writeChange(cs);
    return cs;
  }
```

(The lines to delete are the `// Write the proposed content now so the editor shows the change in place.` comment and the `if (opts.delete) { deleteFileSafe(abs); } else { writeFileAtomic(abs, proposed); }` block.)

`writeFileAtomic` and `deleteFileSafe` stay imported — `applyToDisk` still uses both.

- [ ] **Step 4: Make `settle()` frame pending hunks by origin**

In `src/change-store.ts`, replace the body's resolution block in `settle`:

```ts
    // Which frame the disk is in depends on where the change came from:
    //   "mcp" — the agent staged the edit and the disk still holds the baseline, so an
    //           undecided hunk must stay at its baseline lines until the user accepts it.
    //   "fs"  — the agent wrote the file directly, so an undecided hunk is already on disk.
    const pendingMode = cs.origin === "mcp" ? "baseline" : "proposed";
    const baselineLines = splitContent(cs.baseline).lines;
    const resolvedLines = resolveLines(baselineLines, cs.hunks, pendingMode);
    const resolved = joinContent(resolvedLines, this.resolvedMeta(cs, decision));
    this.applyToDisk(cs, resolved);
```

Also update the `settle` doc comment, which currently claims "the disk currently holds the proposed content ... in both paths":

```ts
  /**
   * Apply decisions. The disk holds the baseline plus whatever the user has already
   * accepted — for an "mcp" change nothing else is written, for an "fs" change the agent's
   * own write is already there. `applyToDisk` re-materialises the file on every decision,
   * so an accepted hunk's lines appear and a rejected hunk's baseline lines are restored.
   * When every hunk is decided the baseline advances and the change set is resolved.
   */
```

- [ ] **Step 5: Stop the watcher from clobbering a staged change**

In `src/change-store.ts`, inside `observe`, immediately after `const existing = this.findChangeByPath(workspace, rel);`, insert:

```ts
    // A staged (mcp) change owns the review state for this path: the disk holds at most
    // the hunks the user has accepted, never the pending ones. Re-deriving hunks from the
    // disk would silently drop every pending hunk, so trust the staged set unless someone
    // wrote content that our own decisions did not put there. Compare lines only, so a
    // framing-only difference (trailing newline) cannot trip it.
    if (existing && existing.origin === "mcp") {
      const diskLines = splitContent(proposed).lines;
      const projected = resolveLines(splitContent(existing.baseline).lines, existing.hunks, "baseline");
      if (diskLines.join("\n") === projected.join("\n")) {
        return existing;
      }
    }
```

- [ ] **Step 6: Always suppress the watcher echo after a decision**

In `src/extension.ts`, in `decide`, replace:

```ts
      // Ignore the watcher echo for the file we just wrote.
      if (result.status === "resolved" || cs.applied) {
        watcher.noteSelfWrite(cs.absPath);
      }
```

with:

```ts
      // Every decision may write the file — accepting materialises lines, and rejecting a
      // previously accepted hunk removes them again — so always suppress the watcher echo
      // for the file we just wrote. Gating this on `cs.applied` missed the partial-accept
      // case and let the watcher re-observe and clobber the staged change.
      watcher.noteSelfWrite(cs.absPath);
```

- [ ] **Step 7: Update the tests that encoded apply-on-propose**

`test/change-store.test.ts` — replace the test at line 28 with:

```ts
test("propose stages without writing; accept writes the accepted lines", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  assert.equal(cs.hunks.length, 1);
  // Review-then-apply: nothing is written until the user decides.
  assert.equal(cs.applied, false);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\ntwo\nthree\n");

  const result = store.accept(cs.id);
  assert.equal(result.resolved, true);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  // The resolved set is kept so an open review tab can render its final state...
  assert.equal(store.findById(cs.id)?.status, "resolved");
  // ...but it no longer counts as a change awaiting review.
  assert.equal(store.listChanges(ws).length, 0);
  // And once stale, it is pruned from disk.
  store.pruneResolved(0);
  assert.equal(store.findById(cs.id), undefined);
});
```

`test/decision-flow.test.ts` — replace the two tests at lines 127 and 142 with:

```ts
test("accept B writes only B; A and C stay at their baseline lines", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  const r = store.accept(cs.id, [cs.hunks[1].id]);
  assert.equal(r.resolved, false);
  assert.deepEqual(store.findById(cs.id)!.hunks.map((h) => h.decision), ["pending", "accepted", "pending"]);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("B = 222"), "B is on disk");
  assert.equal(text.includes("A = 111"), false, "A is only pending, so it is not on disk");
  assert.equal(text.includes("C = 333"), false, "C is only pending, so it is not on disk");
});

test("reject B writes nothing; A and C stay at their baseline lines", async () => {
  const ws = tmp();
  const file = path.join(ws, "x.py");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "x.py", NEW);

  store.reject(cs.id, [cs.hunks[1].id]);
  assert.deepEqual(store.findById(cs.id)!.hunks.map((h) => h.decision), ["pending", "rejected", "pending"]);
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "the file is still exactly the baseline");
  assert.equal(store.listChanges(ws).length, 1, "still pending for A and C");
});
```

`test/accept-all.test.ts` — in "independent per-block decisions: accept A, leave B pending, reject C" replace the disk assertions:

```ts
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes("A = 111"), "A is the accepted (new) value");
  assert.ok(text.includes("B = 2\n"), "B is untouched — pending hunks are not written");
  assert.equal(text.includes("B = 222"), false, "B's new value is not on disk until accepted");
  assert.ok(text.includes("C = 3\n"), "C is reverted to the baseline value");
  assert.equal(text.includes("C = 333"), false, "C's new value is gone");
```

`test/e2e.test.ts` — replace line 42:

```ts
    // Review-then-apply: staging must NOT touch the file.
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /function sub/, "not applied on propose");
```

and after the `POST /changes/accept` call keep the existing `assert.match(..., /function sub/, "accepted edit kept")`.

`test/shared-hub.test.ts` — replace the disk assertions at lines 41-42 and 149-150 (both read the file after `propose`). For the first:

```ts
  // Accepting in one workspace must not touch the other.
  store.accept(a[0].id);
  assert.equal(fs.readFileSync(path.join(wsA, "a.txt"), "utf8"), "one\nTWO\n");
  assert.equal(fs.readFileSync(path.join(wsB, "b.txt"), "utf8"), "alpha\nbeta\n", "wsB is untouched");
  assert.equal(store.listChanges(wsB).length, 1, "wsB change is untouched");
```

For the second (in "one hub serves proposes for two different workspaces"), the file was never accepted, so both stay at their baseline:

```ts
    assert.equal(fs.readFileSync(path.join(wsA, "a.txt"), "utf8"), "one\ntwo\n");
    assert.equal(fs.readFileSync(path.join(wsB, "b.txt"), "utf8"), "alpha\nbeta\n");
```

`test/mcp-forward.test.ts` — replace line 80:

```ts
    // Review-then-apply: the edit is staged, not written. `read_file` returns it (see Task 2).
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hello world\n");
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 126`, `# fail 0` (120 + 6 new in `review-then-apply.test.ts`).

---

### Task 2: `/file/read` returns staged content

Under review-then-apply the disk no longer holds the agent's pending edits, so a second sequential `propose_edit` would fail: its `old_string` comes from the first call's output, which is not on disk. `propose_edit` already reads through the hub (`mcp/mcp-server.ts:232`), so the route is the fix. This is a correctness requirement, not a nicety.

**Files:**
- Modify: `src/hub-server.ts` (`routeFileRead` ~229-244)
- Modify: `mcp/mcp-server.ts` (`propose_edit` note ~252-258, `propose_write` note ~281-287)
- Create: `test/file-read-staged.test.ts`

**Interfaces:**
- Consumes: `ChangeStore.findChangeByPath(workspace, relPath): ChangeSet | undefined`, `resolveLines`, `splitContent`, `joinContent`.
- Produces: `GET /file/read?workspace=&path=` returns `{ exists, binary, content, hash, path }` where `content` is the **staged** content (baseline + every hunk except rejected ones) when an unresolved change exists for that path, and the on-disk content otherwise.

- [ ] **Step 1: Write the failing test**

Create `test/file-read-staged.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HubServer } from "../src/hub-server";

async function hubOn(workspace: string, content: string) {
  fs.writeFileSync(path.join(workspace, "a.txt"), content);
  const hub = new HubServer({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-")), token: "t", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });
  const call = async (p: string, method = "GET", body?: unknown) => {
    const url = new URL(addr.url + p);
    const res = await fetch(url, {
      method,
      headers: { authorization: "Bearer t", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json() as Promise<any>;
  };
  return { hub, addr, call, workspace };
}

test("/file/read returns the staged content, not the disk", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-ws-"));
  const { hub, call } = await hubOn(workspace, "hello world\n");
  try {
    await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "hello there\n" });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.equal(read.content, "hello there\n", "the hub reports the staged content");
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hello world\n", "the disk is untouched");
  } finally {
    await hub.stop();
  }
});

test("two sequential edits both succeed because the second sees the first", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-seq-"));
  const { hub, call } = await hubOn(workspace, "alpha\nbeta\n");
  try {
    await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "ALPHA\nbeta\n" });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.match(read.content, /^ALPHA/, "the first staged edit is visible to the second");
  } finally {
    await hub.stop();
  }
});

test("a rejected hunk is not part of the staged content", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-rej-"));
  const { hub, call } = await hubOn(workspace, "one\ntwo\nthree\n");
  try {
    const proposed = await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "one\nTWO\nthree\n" });
    await call("/changes/reject", "POST", { changeId: proposed.changeId });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.equal(read.content, "one\ntwo\nthree\n", "a rejected hunk reads as baseline");
  } finally {
    await hub.stop();
  }
});

test("an accepted hunk is part of the staged content", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-fr-acc-"));
  const { hub, call } = await hubOn(workspace, "one\ntwo\nthree\n");
  try {
    const proposed = await call("/changes/propose", "POST", { workspace, path: "a.txt", content: "one\nTWO\nthree\n" });
    await call("/changes/accept", "POST", { changeId: proposed.changeId, hunkIds: [proposed.hunks[0].id] });
    const read = await call(`/file/read?workspace=${encodeURIComponent(workspace)}&path=a.txt`);
    assert.equal(read.content, "one\nTWO\nthree\n");
  } finally {
    await hub.stop();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: `/file/read returns the staged content, not the disk` fails with *expected 'hello there\n' but got 'hello world\n'*.

- [ ] **Step 3: Make the route prefer staged content**

In `src/hub-server.ts`, add the imports:

```ts
import { resolveLines, splitContent, joinContent } from "./hunk-diff";
```

Then replace `routeFileRead`:

```ts
  /**
   * Read a file **through the review state**, not from the disk.
   *
   * Under review-then-apply the disk holds only the baseline plus whatever the user has
   * already accepted, so an agent's own pending edits are not there. An agent that makes
   * two sequential `propose_edit` calls sends the second one's `old_string` from the first
   * one's output, so this route must report the *staged* content — baseline with every
   * non-rejected hunk materialised — or the second call fails. Falls back to the disk when
   * no change exists for the path.
   */
  private routeFileRead(url: URL, res: http.ServerResponse): void {
    const workspace = this.param(url, "workspace");
    const relPath = this.param(url, "path");
    const abs = resolveInside(workspace, relPath);
    if (!abs) {
      this.send(res, 400, { error: { code: "bad_path", message: relPath } });
      return;
    }
    const cs = this.store.findChangeByPath(workspace, toPosix(relPath));
    if (cs && !cs.binary) {
      const base = splitContent(cs.baseline);
      const lines = resolveLines(base.lines, cs.hunks, "proposed");
      const content = joinContent(lines, { eol: cs.eol, bom: cs.bom, finalNewline: cs.finalNewline });
      this.send(res, 200, {
        exists: cs.baselineExists || content.length > 0,
        binary: false,
        content,
        hash: "",
        path: toPosix(relPath),
        staged: true,
      });
      return;
    }
    const read = readFileSafe(abs);
    this.send(res, 200, {
      exists: read.exists,
      binary: read.binary,
      content: read.content,
      hash: read.hash,
      path: toPosix(relPath),
    });
  }
```

`resolveLines(..., "proposed")` is correct here: it keeps every hunk that is not rejected, which is exactly "what the agent believes the file contains".

- [ ] **Step 4: Fix the `propose_*` result notes**

In `mcp/mcp-server.ts`, replace the `note` in `propose_edit`:

```ts
      note:
        "Edit staged for review. Nothing was written to disk: the user sees it in the Review Hub panel and each hunk is written only when they accept it. Reading the file with your own tools will therefore show the OLD content — that is expected, not a failure. Use the `read_file` tool to see the staged content. This is success: do not retry with another tool and do not ask for confirmation. Continue with your task.",
```

and in `propose_write`:

```ts
      note:
        "Write staged for review. Nothing was written to disk: the user sees it in the Review Hub panel and each hunk is written only when they accept it. Reading the file with your own tools will therefore show the OLD content — that is expected, not a failure. Use the `read_file` tool to see the staged content. This is success: do not retry with another tool and do not ask for confirmation. Continue with your task.",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 130`, `# fail 0` (126 + 4 staged-read tests). The review fix round adds one absolute-path test → **131**.

---

### Task 3: Real-file decorations under the new model

Fixes the reported bug *"các phần code bị xóa đi thay thế mới code khác thì không hiển thị màu đỏ lên"* as far as the real editor allows. Under review-then-apply the on-disk document is `resolveLines(baselineLines, hunks, diskFrame(cs.origin))` — the frame depends on the change's origin (see `diskFrame` below), so every anchor must use that frame instead of a hardcoded one. The multi-line red block itself is impossible in the real buffer (see spec §2.1); it is delivered by the review tab in Task 12.

> **Plan correction (applied after Task 3's first review).** This task originally said every anchor uses the literal `"baseline"` frame. That is correct for `origin: "mcp"` but **wrong for `origin: "fs"`**: a direct write is already on disk in the *proposed* frame (see the authoritative rule at `src/change-store.ts:910`). The frame rule was duplicated in three places and had already drifted once, so this task now centralises it in a single exported helper, `diskFrame(origin)`, and every consumer calls that.

**Files:**
- Modify: `src/change-decorator.ts` (`apply` ~115-175, `ghostFor` ~180-200, new `addedGhostFor`)
- Modify: `src/diff-view.ts` (file-scheme branch ~66-78)
- Modify: `test/decoration-range.test.ts` (whole file)
- Modify: `test/inline-review.test.ts` (the two `review-hub://merged/...` tests stay until Task 10)

**Interfaces:**
- Consumes: `resolveHunkRanges(baselineLines, hunks, diskFrame(cs.origin))`, `splitContent`.
- Produces: `export function diskFrame(origin: ChangeOrigin): "baseline" | "proposed"` (in `src/hunk-diff.ts`), `export function ghostFor(oldLines: string[]): string` (unchanged signature, unchanged output strings) and `export function addedGhostFor(newLines: string[]): string` (same shape, `⊕` marker).

**Step 0: Add the shared frame helper (do this first).**

`src/hunk-diff.ts` is pure (no `vscode`, no filesystem), so the frame rule belongs there. Add, importing `ChangeOrigin` from `./types` alongside the existing `Hunk, HunkDecision`:

```ts
/**
 * Which frame the on-disk content is in for a change set.
 *   "mcp" — the agent staged the edit, so the disk still holds the baseline: an
 *           undecided hunk must be anchored at its baseline lines.
 *   "fs"  — the agent wrote the file directly, so an undecided hunk is already on disk.
 * Every anchor (decorations, CodeLens, settle) must use this so the frames cannot drift.
 */
export function diskFrame(origin: ChangeOrigin): "baseline" | "proposed" {
  return origin === "mcp" ? "baseline" : "proposed";
}
```

Then replace the inline ternary at `src/change-store.ts:910` with `const pendingMode = diskFrame(cs.origin);` (keep the explanatory comment above it), importing `diskFrame` from `./hunk-diff`.

- [ ] **Step 1: Write the failing test**

Replace the top of `test/decoration-range.test.ts` (the comment block and `marksFor`) with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { diskFrame, resolveHunkRanges, splitContent } from "../src/hunk-diff";

/**
 * Real-file decorations under review-then-apply. The disk holds the BASELINE plus the
 * hunks the user has accepted for a staged ("mcp") change, so an anchor is computed with
 * `pendingMode = diskFrame(origin)`. The frame is not always "baseline": a direct write
 * ("fs") is already on disk in the proposed frame. Marks:
 *   accepted — the new lines are on disk -> green background; the removed old lines are
 *              gone, so they are shown as red ghost text (`⊖`).
 *   pending  — the baseline lines are still on disk -> no background; the removal is
 *              previewed as red ghost text, or the insertion as green ghost text (`⊕`).
 *   rejected — the baseline lines are back and visible -> red background, so the user can
 *              see the rejection took effect. No ghost.
 *
 * Mirrors `ChangeDecorator.apply`, which needs the full editor surface to import.
 */

interface Hunk {
  id: string;
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  decision: "pending" | "accepted" | "rejected";
}

interface Mark {
  added: [number, number][];
  removed: [number, number][];
  ghost: { line: number; kind: "removed" | "added" }[];
}

const BASELINE = ["a", "b", "c"];

function marksFor(hunks: Hunk[], docLineCount: number, frame: "baseline" | "proposed" = "baseline"): Mark {
  const lastLine = Math.max(0, docLineCount - 1);
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const ranges = new Map(resolveHunkRanges(BASELINE, hunks as never, frame).map((r) => [r.id, r]));
  const pendingOnDisk = frame === "proposed";
  const out: Mark = { added: [], removed: [], ghost: [] };
  for (const h of hunks) {
    const range = ranges.get(h.id);
    const start = clamp(range?.start ?? h.newStart, 0, lastLine);
    const span = range ? range.length : h.oldLines.length;
    // The new lines are on disk when the hunk was accepted, or when it is still pending in
    // a frame where pending means "the agent's direct write is already there" (`fs`).
    const newOnDisk = h.decision === "accepted" || (h.decision === "pending" && pendingOnDisk);
    if (newOnDisk && span > 0) {
      out.added.push([start, clamp(start + span - 1, start, lastLine)]);
    }
    if (h.decision === "rejected") {
      const redSpan = Math.max(1, span || h.newLines.length || h.oldLines.length);
      out.removed.push([start, clamp(start + redSpan - 1, start, lastLine)]);
    }
    // A ghost marks only what the user cannot see in the file.
    if (newOnDisk) {
      if (h.oldLines.length > 0) {
        out.ghost.push({ line: start, kind: "removed" });
      }
    } else if (h.decision === "pending" && h.oldLines.length > 0) {
      out.ghost.push({ line: start, kind: "removed" });
    } else if (h.decision === "pending" && h.newLines.length > 0) {
      out.ghost.push({ line: start, kind: "added" });
    }
  }
  return out;
}

const h = (over: Partial<Hunk>): Hunk => ({
  id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B2"], decision: "pending", ...over,
});

test("a pending modify shows a red ghost of the removed line and nothing green", () => {
  const m = marksFor([h({})], 3);
  assert.deepEqual(m.ghost, [{ line: 1, kind: "removed" }], "the line that would be replaced is previewed in red");
  assert.deepEqual(m.added, [], "nothing is on disk yet, so nothing is green");
  assert.deepEqual(m.removed, []);
});

test("a pending pure insertion shows a green ghost", () => {
  const m = marksFor([h({ oldLines: [], newLines: ["b"] })], 3);
  assert.deepEqual(m.ghost, [{ line: 1, kind: "added" }], "the pending addition is previewed in green");
  assert.deepEqual(m.added, [], "it is not on disk yet");
});

test("an accepted hunk is green on disk and shows the removed line as a red ghost", () => {
  const m = marksFor([h({ decision: "accepted" })], 3);
  assert.deepEqual(m.added, [[1, 1]], "the new line is on disk");
  assert.deepEqual(m.ghost, [{ line: 1, kind: "removed" }], "the old line is gone, so it is ghosted in red");
});

test("a rejected hunk is red on the restored baseline line and has no ghost", () => {
  const m = marksFor([h({ decision: "rejected" })], 3);
  assert.deepEqual(m.removed, [[1, 1]], "the baseline line is back on disk and marked red");
  assert.deepEqual(m.ghost, [], "the old line is really on disk again");
  assert.deepEqual(m.added, []);
});

test("accepting an insertion writes it and shows no ghost", () => {
  const m = marksFor([h({ oldLines: [], newLines: ["b"], decision: "accepted" })], 3);
  assert.deepEqual(m.added, [[1, 1]]);
  assert.deepEqual(m.ghost, [], "nothing was removed");
});

test("a multi-line pending deletion is one red ghost at its anchor", () => {
  const m = marksFor([h({ oldLines: ["x", "y", "z"], newLines: [] })], 5);
  assert.equal(m.ghost.length, 1);
  assert.equal(m.ghost[0].kind, "removed");
});

test("a rejected hunk below an accepted one anchors in the baseline frame", () => {
  // accept a one-line insertion at the top: it contributes 1 line. The second hunk's
  // baseline line 3 lands at resolved line 3, not at its proposed line 4.
  const hunks: Hunk[] = [
    h({ id: "top", oldStart: 0, oldLines: [], newStart: 0, newLines: ["new"], decision: "accepted" }),
    h({ id: "bot", oldStart: 2, oldLines: ["c"], newStart: 3, newLines: ["C2"], decision: "rejected" }),
  ];
  const m = marksFor(hunks, 4);
  assert.deepEqual(m.removed, [[3, 3]], "the rejected hunk is anchored on baseline line 3");
});

// ---- the fs frame (the agent wrote the file directly) -------------------------

test("diskFrame maps mcp to the baseline frame and fs to the proposed frame", () => {
  // The single source of truth for the frame rule, shared by settle, the decorations and
  // the CodeLens, so the three can never drift apart.
  assert.equal(diskFrame("mcp"), "baseline", "a staged change leaves the disk on the baseline");
  assert.equal(diskFrame("fs"), "proposed", "a direct write is already on disk");
});

test("an fs pending hunk is already on disk: green row and red ghost in the proposed frame", () => {
  const m = marksFor([h({})], 3, "proposed");
  assert.deepEqual(m.added, [[1, 1]], "the agent's write is on disk, so the new line is green");
  assert.deepEqual(m.ghost, [{ line: 1, kind: "removed" }], "the replaced old line is gone: red ghost");
  assert.deepEqual(m.removed, [], "nothing was rejected");
});

test("the same pending hunks anchor differently in the two frames", () => {
  const hunks: Hunk[] = [
    h({ id: "ins", oldStart: 0, oldLines: [], newStart: 0, newLines: ["x"] }),
    h({ id: "rep", oldStart: 2, oldLines: ["c"], newStart: 3, newLines: ["C2"] }),
  ];

  // mcp (baseline frame): the disk holds the baseline, so the insertion is a green ghost
  // and the replacement still sits on baseline line 3 (0-based 2).
  const mcp = marksFor(hunks, 3, "baseline");
  assert.deepEqual(mcp.added, [], "nothing is on disk for a staged change");
  assert.deepEqual(mcp.ghost, [
    { line: 0, kind: "added" },
    { line: 2, kind: "removed" },
  ]);

  // fs (proposed frame): the agent's write is already on disk, so both hunks are green and
  // the replacement is anchored one line lower, at its proposed line 4 (0-based 3).
  const fs = marksFor(hunks, 4, "proposed");
  assert.deepEqual(fs.added, [[0, 0], [3, 3]], "both hunks are on disk");
  assert.deepEqual(fs.ghost, [{ line: 3, kind: "removed" }], "the replaced line is ghosted at its real position");
});

// ---- ghost text formatting ---------------------------------------------------

test("ghost text shows a single removed line", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  assert.equal(ghostFor(["import sys"]), "  ⊖ import sys");
});

test("ghost text preserves indentation with non-breaking spaces", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  const out = ghostFor(["        return None"]);
  assert.equal(out, "  \u2296 \u2003\u2003\u2003\u2003return None");
});

test("ghost text summarises a multi-line deletion", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  const out = ghostFor(["first", "second", "third"]);
  assert.match(out, /first/);
  assert.match(out, /\+2 more deleted/);
});

test("ghost text truncates a very long line", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  const out = ghostFor(["x".repeat(300)]);
  assert.ok(out.includes("…"), "long lines are truncated");
  assert.ok(out.length < 200);
});

test("added ghost text uses the ⊕ marker", async () => {
  const { addedGhostFor } = await import("../src/change-decorator");
  assert.equal(addedGhostFor(["import sys"]), "  ⊕ import sys");
  assert.match(addedGhostFor(["a", "b"]), /\+1 more added/);
});

// keep `splitContent` referenced so an unused-import error cannot slip in
test("splitContent is available for the anchor math", () => {
  assert.deepEqual(splitContent("a\nb\n").lines, ["a", "b"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: `test/decoration-range.test.ts` fails — `addedGhostFor is not a function` and the anchor expectations for the baseline frame.

- [ ] **Step 3: Re-frame `ChangeDecorator.apply`**

In `src/change-decorator.ts`, replace the header comment's paragraph about disk state:

```ts
 * Under review-then-apply the disk holds the baseline plus the hunks the user has accepted,
 * so every anchor is computed in the change's disk frame (`diskFrame(cs.origin)`). A pending
 * hunk is not on disk: its removal (or insertion) is previewed as ghost text, since VS Code
 * injected text must be a single line.
```

and replace the body of `apply` from the `ranges` line to the end of the `for` loop:

```ts
    // The disk holds the baseline plus the accepted hunks, so a hunk's line range must be
    // computed in the change's disk frame (`diskFrame(cs.origin)`) — not a hardcoded one.
    // Accepting a hunk above changes how many lines it contributes, so `newStart` would
    // colour the wrong lines. The frame differs by origin: a staged ("mcp") change sits on
    // the baseline, a direct write ("fs") is already on disk in the proposed frame.
    const frame = diskFrame(cs.origin);
    const pendingOnDisk = frame === "proposed";
    const ranges = new Map(
      resolveHunkRanges(splitContent(cs.baseline).lines, cs.hunks, frame).map((r) => [r.id, r]),
    );

    const lastLine = Math.max(0, doc.lineCount - 1);
    for (const hunk of cs.hunks) {
      const label = hunkLabel(cs, hunk);
      const range = ranges.get(hunk.id);
      const start = clamp(range?.start ?? hunk.newStart, 0, lastLine);
      const span = range ? range.length : hunk.oldLines.length;
      // A hunk's *new* lines are on disk when it was accepted, or when it is still pending
      // in a frame where pending means "the agent's direct write is already there" (`fs`).
      const newOnDisk = hunk.decision === "accepted" || (hunk.decision === "pending" && pendingOnDisk);

      // GREEN — the new lines, which really are on disk now.
      if (newOnDisk && span > 0) {
        const end = clamp(start + span - 1, start, lastLine);
        added.push({ range: new vscode.Range(start, 0, end, 0), hoverMessage: new vscode.MarkdownString(label) });
      }

      // RED — a rejected hunk put the baseline lines back, so colour them to show the
      // rejection took effect.
      if (hunk.decision === "rejected") {
        const redSpan = Math.max(1, span || hunk.newLines.length || hunk.oldLines.length);
        const end = clamp(start + redSpan - 1, start, lastLine);
        removed.push({ range: new vscode.Range(start, 0, end, 0), hoverMessage: new vscode.MarkdownString(label) });
      }

      // GHOST — only what the user cannot see in the file. Red for a removal, green for an
      // insertion, so a deletion reads as red even though it cannot have a red row.
      if (newOnDisk) {
        // The new lines are visible, so the old ones are really gone: show what was removed.
        if (hunk.oldLines.length > 0) {
          deleted.push({
            range: new vscode.Range(start, 0, start, 0),
            hoverMessage: removedHover(label, hunk.oldLines),
            renderOptions: { after: { contentText: ghostFor(hunk.oldLines), color: DELETED_COLOR } },
          });
        }
      } else if (hunk.decision === "pending" && hunk.oldLines.length > 0) {
        deleted.push({
          range: new vscode.Range(start, 0, start, 0),
          hoverMessage: pendingHover(label, hunk.oldLines, hunk.newLines),
          renderOptions: { after: { contentText: ghostFor(hunk.oldLines), color: DELETED_COLOR } },
        });
      } else if (hunk.decision === "pending" && hunk.newLines.length > 0) {
        deleted.push({
          range: new vscode.Range(start, 0, start, 0),
          hoverMessage: pendingHover(label, hunk.oldLines, hunk.newLines),
          renderOptions: { after: { contentText: addedGhostFor(hunk.newLines), color: ADDED_COLOR } },
        });
      }
    }
```

Add the two colour constants just below the imports:

```ts
/** Red/green foregrounds for the single-line ghost text, so a deletion reads as red. */
const DELETED_COLOR = new vscode.ThemeColor("gitDecoration.deletedResourceForeground");
const ADDED_COLOR = new vscode.ThemeColor("gitDecoration.addedResourceForeground");
```

Add `addedGhostFor` and `pendingHover` next to `ghostFor`:

```ts
/** Ghost text for a pending insertion — the lines that would land if the user accepts. */
export function addedGhostFor(newLines: string[]): string {
  const raw = (newLines[0] ?? "").replace(/\t/g, "    ");
  const indent = raw.length - raw.trimStart().length;
  const body = raw.trimStart();
  const shown = body.length > 100 ? `${body.slice(0, 100)}…` : body;
  const pad = "\u2003".repeat(Math.min(Math.ceil(indent / 2), 20));
  const more = newLines.length > 1 ? `  ⊕ +${newLines.length - 1} more added` : "";
  return `  ⊕ ${pad}${shown}${more}`;
}

/** Hover for a pending hunk: both sides, so the user can read what would change. */
function pendingHover(label: string, oldLines: string[], newLines: string[]): vscode.MarkdownString {
  const block = (title: string, lines: string[]): string[] =>
    lines.length === 0 ? [] : ["", `**${title}:**`, "```", ...lines.map((l) => l.replace(/\t/g, "    ")), "```"];
  return new vscode.MarkdownString(
    [
      label,
      ...block("Will be removed if accepted", oldLines),
      ...block("Will be added if accepted", newLines),
    ].join("\n"),
  );
}
```

The `deletionMarker` decoration type at `src/change-decorator.ts:48-51` currently has only `overviewRulerColor` and `overviewRulerLane` — no `backgroundColor`. **Keep it that way** (a pending hunk's lines are not on disk, so there is no row to colour; a per-decoration `backgroundColor` would paint the *anchor* line, which is the wrong line). Only replace its comment:

```ts
    // A pending hunk's removal, or an accepted hunk's already-removed lines, cannot be a
    // coloured row: the lines are not on disk. Their text is shown as ghost text after the
    // anchor line, in red (removed) or green (added), with an overview-ruler mark so the
    // deletion is discoverable from the scrollbar too.
    this.deletionMarker = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
```

- [ ] **Step 4: Re-frame the real-file CodeLens anchors**

In `src/diff-view.ts`, in the `uri.scheme === "file"` branch, change the hardcoded frame to `diskFrame(cs.origin)`:

```ts
      const ranges = new Map(
        resolveHunkRanges(splitContent(cs.baseline).lines, cs.hunks, diskFrame(cs.origin)).map((r) => [r.id, r]),
      );
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 137`, `# fail 0` (131 + 3 for the frame-helper tests + 3 for the fs-frame tests: `decoration-range.test.ts` grows from 10 tests to 16).

---

### Task 4: SQLite driver wrapper

**Files:**
- Create: `src/sqlite.ts`
- Create: `test/sqlite.test.ts`
- Modify: `esbuild.js` (`external`), `scripts/test.mjs` (`external`), `tsconfig.json` (no change expected)

**Interfaces:**
- Produces:
  - `export interface SqlDriver { exec(sql: string): void; run(sql: string, ...params: unknown[]): void; get<T>(sql: string, ...params: unknown[]): T | undefined; all<T>(sql: string, ...params: unknown[]): T[]; transaction<T>(fn: () => T): T; close(): void }`
  - `export function openDatabase(file: string): SqlDriver | undefined` — `undefined` when `node:sqlite` is unavailable or the file cannot be opened.

- [ ] **Step 1: Write the failing test**

Create `test/sqlite.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../src/sqlite";

function dbFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rh-sql-")), "hub.db");
}

test("openDatabase creates the file and its directory", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rh-sql-")), "nested", "hub.db");
  const db = openDatabase(file);
  assert.ok(db, "node:sqlite must be available on Node 22.13+");
  db!.close();
  assert.ok(fs.existsSync(file));
});

test("schema, upsert and read round-trip", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL, flag INTEGER NOT NULL)");
    db.run("INSERT INTO t (id, n, flag) VALUES (?, ?, ?)", "a", 1, Number(true));
    db.run("INSERT OR REPLACE INTO t (id, n, flag) VALUES (?, ?, ?)", "a", 2, Number(false));
    const row = db.get<{ id: string; n: number; flag: number }>("SELECT * FROM t WHERE id = ?", "a");
    assert.deepEqual({ ...row! }, { id: "a", n: 2, flag: 0 });
    assert.equal(db.all<{ id: string }>("SELECT id FROM t").length, 1);
  } finally {
    db.close();
  }
});

test("rows come back as plain objects, spread out of the null-prototype row", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    db.run("INSERT INTO t (id) VALUES (?)", "a");
    const row = db.get<{ id: string }>("SELECT * FROM t")!;
    // The driver spreads every row on the way out, so the value the caller sees has
    // Object.prototype (unlike the raw node:sqlite row, which has a null prototype and
    // would fail the deep-equality assertion below).
    assert.equal(Object.getPrototypeOf(row), Object.prototype);
    assert.deepEqual(row, { id: "a" });
  } finally {
    db.close();
  }
});

test("a boolean cannot be bound, so it is stored as 0/1", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (flag INTEGER NOT NULL)");
    assert.throws(() => db.run("INSERT INTO t (flag) VALUES (?)", true), /cannot be bound/);
    db.run("INSERT INTO t (flag) VALUES (?)", Number(true));
    assert.equal(db.get<{ flag: number }>("SELECT flag FROM t")!.flag, 1);
  } finally {
    db.close();
  }
});

test("ON DELETE CASCADE removes the child rows", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE child (id TEXT NOT NULL REFERENCES parent(id) ON DELETE CASCADE)");
    db.run("INSERT INTO parent (id) VALUES (?)", "p");
    db.run("INSERT INTO child (id) VALUES (?)", "p");
    db.run("INSERT INTO child (id) VALUES (?)", "p");
    assert.equal(db.all("SELECT id FROM child").length, 2);
    db.run("DELETE FROM parent WHERE id = ?", "p");
    assert.equal(db.all("SELECT id FROM child").length, 0);
  } finally {
    db.close();
  }
});

test("transaction rolls back on a throw and commits on success", () => {
  const db = openDatabase(dbFile())!;
  try {
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    assert.throws(() =>
      db.transaction(() => {
        db.run("INSERT INTO t (id) VALUES (?)", "a");
        throw new Error("boom");
      }),
    );
    assert.equal(db.all("SELECT id FROM t").length, 0, "the rolled-back row is gone");
    db.transaction(() => db.run("INSERT INTO t (id) VALUES (?)", "b"));
    assert.equal(db.all("SELECT id FROM t").length, 1);
  } finally {
    db.close();
  }
});

test("a second connection on the same file sees the first one's committed rows", () => {
  const file = dbFile();
  const a = openDatabase(file)!;
  const b = openDatabase(file)!;
  try {
    a.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    a.run("INSERT INTO t (id) VALUES (?)", "from-a");
    assert.equal(b.all<{ id: string }>("SELECT id FROM t").length, 1, "b sees a's commit");
    b.run("INSERT INTO t (id) VALUES (?)", "from-b");
    assert.equal(a.all<{ id: string }>("SELECT id FROM t").length, 2, "a sees b's commit");
  } finally {
    a.close();
    b.close();
  }
});

test("journal_mode is WAL and busy_timeout is set", () => {
  const db = openDatabase(dbFile())!;
  try {
    assert.equal(String(db.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode).toLowerCase(), "wal");
    assert.equal(Number(db.get<{ timeout: number }>("PRAGMA busy_timeout")!.timeout), 3000);
    assert.equal(Number(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys), 1);
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: the build fails to resolve `../src/sqlite` — *Could not resolve "../src/sqlite"*.

- [ ] **Step 3: Write the driver**

Create `src/sqlite.ts`:

```ts
/**
 * A minimal wrapper over Node's built-in `node:sqlite` (`DatabaseSync`). No third-party
 * dependency, no external service — `node:sqlite` ships with Node, so it satisfies the
 * "write it by hand / no external APIs" constraint.
 *
 * Two runtime facts drive the shape of this file:
 *   1. `node:sqlite` is unflagged from Node 22.13.0 but still emits an
 *      `ExperimentalWarning` **at require time**. We filter that one warning — and only
 *      that one — by installing a `process.emitWarning` override *before* the require.
 *   2. Real Electron builds have shipped without the sqlite binding, so `openDatabase`
 *      returns `undefined` instead of throwing, and the caller falls back to the JSON
 *      store.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

interface StatementLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (file: string, opts?: { timeout?: number }) => DatabaseLike;
}

const WARNING_FRAGMENT = "SQLite is an experimental feature";

let warned = false;
function warnOnce(message: string): void {
  if (warned) {
    return;
  }
  warned = true;
  // console.warn, not a vscode OutputChannel: this module is also loaded by tests.
  console.warn(`Review Hub: ${message}`);
}

let patched = false;
/** Drop only the node:sqlite experimental notice; every other warning still prints. */
function silenceSqliteWarning(): void {
  if (patched) {
    return;
  }
  patched = true;
  const original = process.emitWarning.bind(process) as (...args: unknown[]) => void;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const text =
      typeof warning === "string" ? warning : String((warning as { message?: string } | undefined)?.message ?? "");
    if (text.includes(WARNING_FRAGMENT)) {
      return;
    }
    original(warning, ...rest);
  }) as typeof process.emitWarning;
}

function loadModule(): SqliteModule | undefined {
  try {
    silenceSqliteWarning();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("node:sqlite") as Partial<SqliteModule>;
    return mod && typeof mod.DatabaseSync === "function" ? (mod as SqliteModule) : undefined;
  } catch {
    return undefined;
  }
}

class Driver implements SqlDriver {
  constructor(private db: DatabaseLike) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    const row = this.db.prepare(sql).get(...params);
    // Rows come back with a null prototype, which breaks deep-equality assertions and
    // any `instanceof` check downstream. Spread every row on the way out.
    return row === undefined || row === null ? undefined : ({ ...(row as Record<string, unknown>) } as T);
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...(row as Record<string, unknown>) }) as T);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // the transaction may already be gone
      }
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Open `file`, or return `undefined` when SQLite is unavailable on this runtime. */
export function openDatabase(file: string): SqlDriver | undefined {
  const sqlite = loadModule();
  if (!sqlite) {
    warnOnce("node:sqlite is unavailable on this runtime; using the JSON store.");
    return undefined;
  }
  let db: DatabaseLike;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new sqlite.DatabaseSync(file, { timeout: 3000 });
  } catch {
    warnOnce("could not open the SQLite store; using the JSON store.");
    return undefined;
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  } catch {
    // The defaults are usable; a read-only filesystem must not stop activation.
  }
  return new Driver(db);
}
```

- [ ] **Step 4: Keep `node:sqlite` external in every bundle**

In `esbuild.js`, change `target: "node18"` to `target: "node22"` and add `node:sqlite` to the externals:

```js
const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcemap: true,
  target: "node22",
  logLevel: "info",
};

const extensionOptions = {
  ...common,
  entryPoints: ["src/extension.ts"],
  external: ["vscode", "node:sqlite"],
  outfile: "dist/extension.js",
};

// The MCP server is bundled standalone (no vscode) so harnesses can run it directly.
// It never imports the store, so it needs no node:sqlite external — but listing it is
// harmless and keeps the two bundles' rules identical.
const mcpOptions = {
  ...common,
  entryPoints: ["mcp/mcp-server.ts"],
  external: ["node:sqlite"],
  outfile: "dist/mcp-server.cjs",
  banner: { js: "#!/usr/bin/env node" },
};
```

In `scripts/test.mjs`, change `target: "node18"` to `target: "node22"` and add `"node:sqlite"` to `external`:

```js
  target: "node22",
  sourcemap: "inline",
  external: ["esbuild", "node:sqlite"],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 145`, `# fail 0` (137 + 8 new sqlite tests). No `ExperimentalWarning: SQLite is an experimental feature` in the output.

---

### Task 5: `StoreBackend` interface + `JsonBackend`

Pure code motion: the file-backed storage that lives inside `ChangeStore` today moves into a backend, unchanged in behaviour, so the existing 120 tests remain a safety net.

**Files:**
- Create: `src/store-backend.ts`
- Create: `test/store-backend.test.ts`

**Interfaces:**
- Consumes: `SqlDriver` from `src/sqlite.ts` (only for the type of `SqliteBackend`, added in Task 6); `writeFileAtomic`, `deleteFileSafe`, `hashContent` from `src/file-snapshot.ts`; `ChangeSet`, `ChangeOrigin`, `ChangeStatus`, `HunkDecision` from `src/types.ts`.
- Produces:
  - `export function workspaceKey(workspace: string): string`
  - `export interface CheckpointRecord { workspace: string; setAt: number; files: Record<string, string>; truncated?: boolean }`
  - `export interface StoreBackend { readCheckpoint(workspace: string): CheckpointRecord | undefined; writeCheckpoint(cp: CheckpointRecord): void; clearCheckpoint(workspace: string): void; knownWorkspaces(): string[]; writeChange(cs: ChangeSet): void; getChange(workspace: string, id: string): ChangeSet | undefined; listChangeSets(workspace: string): ChangeSet[]; findById(id: string): ChangeSet | undefined; findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined; removeChange(workspace: string, id: string): void; clearChanges(workspace: string): void; pruneResolved(maxAgeMs: number): void; putBaseline(workspace: string, content: string): string; getBaseline(workspace: string, hash: string): string; dispose(): void }`
  - `export class JsonBackend implements StoreBackend`
  - `export class BaselineBlobs` (shared content-addressed blob store on disk)

- [ ] **Step 1: Write the failing test**

Create `test/store-backend.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonBackend, type StoreBackend } from "../src/store-backend";
import type { ChangeSet } from "../src/types";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-be-"));
}

function changeSet(over: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "a.txt",
    absPath: "/ws/a.txt",
    origin: "mcp",
    applied: false,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: "one\ntwo\n",
    proposed: "one\nTWO\n",
    baselineExists: true,
    proposedExists: true,
    hunks: [
      {
        id: "h1",
        oldStart: 1,
        oldLines: ["two"],
        newStart: 1,
        newLines: ["TWO"],
        decision: "pending",
      },
    ],
    status: "pending",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

/** Every assertion in this file runs against each backend, so they cannot drift. */
function eachBackend(run: (name: string, make: () => StoreBackend) => void): void {
  run("JsonBackend", () => new JsonBackend(tmp()));
}

eachBackend((name, make) => {
  test(`[${name}] change round-trip keeps its hunks`, () => {
    const backend = make();
    const cs = changeSet();
    backend.writeChange(cs);
    const got = backend.getChange("/ws", "c1");
    assert.ok(got);
    assert.equal(got!.path, "a.txt");
    assert.equal(got!.applied, false);
    assert.equal(got!.hunks.length, 1);
    assert.deepEqual(got!.hunks[0].newLines, ["TWO"]);
    assert.equal(got!.hunks[0].decision, "pending");
    backend.dispose();
  });

  test(`[${name}] resolved sets are hidden from the list but still readable by id`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.writeChange(changeSet({ id: "c2", path: "b.txt", status: "resolved" }));
    assert.deepEqual(backend.listChangeSets("/ws").map((c) => c.path), ["a.txt"]);
    assert.equal(backend.findById("c2")?.status, "resolved");
    backend.dispose();
  });

  test(`[${name}] findChangeByPath ignores a resolved set`, () => {
    const backend = make();
    backend.writeChange(changeSet({ status: "resolved" }));
    assert.equal(backend.findChangeByPath("/ws", "a.txt"), undefined);
    backend.dispose();
  });

  test(`[${name}] removeChange drops the change and its hunks`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.removeChange("/ws", "c1");
    assert.equal(backend.getChange("/ws", "c1"), undefined);
    assert.equal(backend.findById("c1"), undefined);
    backend.dispose();
  });

  test(`[${name}] listChangeSets is scoped to one workspace`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.writeChange(changeSet({ id: "c2", workspace: "/other", path: "a.txt" }));
    assert.equal(backend.listChangeSets("/ws").length, 1);
    assert.equal(backend.listChangeSets("/other").length, 1);
    backend.dispose();
  });

  test(`[${name}] checkpoint round-trip and clear`, () => {
    const backend = make();
    assert.equal(backend.readCheckpoint("/ws"), undefined);
    backend.writeCheckpoint({ workspace: "/ws", setAt: 5, files: { "a.txt": "abc" } });
    const cp = backend.readCheckpoint("/ws");
    assert.equal(cp?.setAt, 5);
    assert.deepEqual(cp?.files, { "a.txt": "abc" });
    assert.deepEqual(backend.knownWorkspaces(), ["/ws"]);
    backend.clearCheckpoint("/ws");
    assert.equal(backend.readCheckpoint("/ws"), undefined);
    backend.dispose();
  });

  test(`[${name}] clearCheckpoint also drops the workspace's changes`, () => {
    const backend = make();
    backend.writeChange(changeSet());
    backend.clearCheckpoint("/ws");
    assert.equal(backend.listChangeSets("/ws").length, 0);
    backend.dispose();
  });

  test(`[${name}] pruneResolved drops only stale resolved sets`, () => {
    const backend = make();
    backend.writeChange(changeSet({ id: "c2", path: "b.txt", status: "resolved", updatedAt: 1 }));
    backend.writeChange(changeSet({ id: "c3", path: "c.txt", status: "resolved", updatedAt: Date.now() }));
    backend.writeChange(changeSet({ id: "c1", path: "a.txt" }));
    backend.pruneResolved(1000);
    assert.equal(backend.findById("c2"), undefined, "the stale resolved set is gone");
    assert.ok(backend.findById("c3"), "a fresh resolved set is kept");
    assert.ok(backend.findById("c1"), "a pending set is never pruned");
    backend.dispose();
  });

  test(`[${name}] baselines are content-addressed and readable back`, () => {
    const backend = make();
    const hash = backend.putBaseline("/ws", "hello\n");
    assert.equal(backend.putBaseline("/ws", "hello\n"), hash, "the same content gives the same hash");
    assert.equal(backend.getBaseline("/ws", hash), "hello\n");
    assert.equal(backend.getBaseline("/ws", "missing"), "");
    backend.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: build fails — *Could not resolve "../src/store-backend"*.

- [ ] **Step 3: Write `src/store-backend.ts` with the interface, blob store, and `JsonBackend`**

Create `src/store-backend.ts`:

```ts
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
          if (cs.status === "resolved" && now - (cs.updatedAt ?? 0) > maxAgeMs) {
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
```

Note: `findById` used to iterate `workspaces/<key>/changes/<id>.json`; that is preserved. `findChangeByPath` used `toPosix` from `file-snapshot`; here it inlines the same conversion to keep this module's imports minimal — the behaviour is identical on POSIX and on Windows (where `path.sep` is `\`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 154`, `# fail 0` (145 + 9 new backend tests).

---

### Task 6: `SqliteBackend`

**Files:**
- Modify: `src/store-backend.ts` (append `SqliteBackend` + `rowToChangeSet`)
- Modify: `test/store-backend.test.ts` (register `SqliteBackend` in `eachBackend`)

**Interfaces:**
- Consumes: `SqlDriver`, `openDatabase` from `src/sqlite.ts`; `BaselineBlobs`, `StoreBackend`, `CheckpointRecord` from the same file.
- Produces: `export class SqliteBackend implements StoreBackend { constructor(driver: SqlDriver) }`.

- [ ] **Step 1: Extend the test to run both backends**

In `test/store-backend.test.ts`, add the imports:

```ts
import { JsonBackend, SqliteBackend, type StoreBackend } from "../src/store-backend";
import { openDatabase } from "../src/sqlite";
```

and replace `eachBackend`:

```ts
/** Every assertion in this file runs against each backend, so they cannot drift. */
function eachBackend(run: (name: string, make: () => StoreBackend) => void): void {
  run("JsonBackend", () => new JsonBackend(tmp()));
  run("SqliteBackend", () => {
    const dir = tmp();
    const driver = openDatabase(path.join(dir, "hub.db"));
    assert.ok(driver, "node:sqlite must be available for the SQLite backend test");
    return new SqliteBackend(driver!);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: `SqliteBackend is not a constructor` for every `[SqliteBackend]` test.

- [ ] **Step 3: Append `SqliteBackend` to `src/store-backend.ts`**

```ts
// ---- SQLite backend ---------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  workspace  TEXT PRIMARY KEY,
  set_at     INTEGER NOT NULL,
  files_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changes (
  id              TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  path            TEXT NOT NULL,
  abs_path        TEXT NOT NULL,
  origin          TEXT NOT NULL,
  applied         INTEGER NOT NULL,
  status          TEXT NOT NULL,
  eol             TEXT NOT NULL,
  bom             INTEGER NOT NULL,
  final_newline   INTEGER NOT NULL,
  binary          INTEGER NOT NULL,
  baseline        TEXT NOT NULL,
  proposed        TEXT NOT NULL,
  baseline_exists INTEGER NOT NULL,
  proposed_exists INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (workspace, path)
);
CREATE TABLE IF NOT EXISTS hunks (
  change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  id        TEXT NOT NULL,
  ordinal   INTEGER NOT NULL,
  old_start INTEGER NOT NULL,
  new_start INTEGER NOT NULL,
  old_lines TEXT NOT NULL,
  new_lines TEXT NOT NULL,
  decision  TEXT NOT NULL,
  PRIMARY KEY (change_id, id)
);
CREATE INDEX IF NOT EXISTS idx_changes_workspace ON changes(workspace);
CREATE INDEX IF NOT EXISTS idx_changes_status    ON changes(workspace, status);
`;

interface ChangeRow {
  id: string;
  workspace: string;
  path: string;
  abs_path: string;
  origin: string;
  applied: number;
  status: string;
  eol: string;
  bom: number;
  final_newline: number;
  binary: number;
  baseline: string;
  proposed: string;
  baseline_exists: number;
  proposed_exists: number;
  created_at: number;
  updated_at: number;
}

interface HunkRow {
  change_id: string;
  id: string;
  ordinal: number;
  old_start: number;
  new_start: number;
  old_lines: string;
  new_lines: string;
  decision: string;
}

function rowToChangeSet(row: ChangeRow, hunks: HunkRow[]): ChangeSet {
  return {
    id: row.id,
    workspace: row.workspace,
    path: row.path,
    absPath: row.abs_path,
    origin: row.origin as ChangeSet["origin"],
    applied: row.applied === 1,
    status: row.status as ChangeSet["status"],
    eol: row.eol === "\r\n" ? "\r\n" : "\n",
    bom: row.bom === 1,
    finalNewline: row.final_newline === 1,
    binary: row.binary === 1,
    baseline: row.baseline,
    proposed: row.proposed,
    baselineExists: row.baseline_exists === 1,
    proposedExists: row.proposed_exists === 1,
    hunks: hunks.map((h) => ({
      id: h.id,
      oldStart: h.old_start,
      oldLines: JSON.parse(h.old_lines) as string[],
      newStart: h.new_start,
      newLines: JSON.parse(h.new_lines) as string[],
      decision: h.decision as ChangeSet["hunks"][number]["decision"],
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteBackend implements StoreBackend {
  private blobs: BaselineBlobs;

  constructor(private driver: SqlDriver, baseDir?: string) {
    this.blobs = new BaselineBlobs(baseDir ?? path.join(process.env.HOME ?? "", ".review-hub"));
    this.driver.exec(SCHEMA);
  }

  // ---- checkpoints ----

  readCheckpoint(workspace: string): CheckpointRecord | undefined {
    const row = this.driver.get<{ workspace: string; set_at: number; files_json: string }>(
      "SELECT workspace, set_at, files_json FROM checkpoints WHERE workspace = ?",
      workspace,
    );
    if (!row) {
      return undefined;
    }
    return {
      workspace: row.workspace,
      setAt: row.set_at,
      files: JSON.parse(row.files_json) as Record<string, string>,
    };
  }

  writeCheckpoint(cp: CheckpointRecord): void {
    this.driver.run(
      "INSERT OR REPLACE INTO checkpoints (workspace, set_at, files_json) VALUES (?, ?, ?)",
      cp.workspace,
      cp.setAt,
      JSON.stringify(cp.files),
    );
  }

  clearCheckpoint(workspace: string): void {
    this.driver.run("DELETE FROM checkpoints WHERE workspace = ?", workspace);
    this.clearChanges(workspace);
  }

  knownWorkspaces(): string[] {
    const rows = this.driver.all<{ workspace: string }>(
      "SELECT workspace FROM checkpoints UNION SELECT workspace FROM changes",
    );
    return rows.map((r) => r.workspace);
  }

  // ---- changes ----

  writeChange(cs: ChangeSet): void {
    this.driver.transaction(() => {
      // `INSERT OR REPLACE` on the unique (workspace, path) row. The id is derived
      // deterministically from (workspace, path), so a re-propose of the same file
      // replaces its own row rather than colliding with it.
      this.driver.run(
        `INSERT OR REPLACE INTO changes
           (id, workspace, path, abs_path, origin, applied, status, eol, bom, final_newline,
            binary, baseline, proposed, baseline_exists, proposed_exists, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        cs.id,
        cs.workspace,
        cs.path,
        cs.absPath,
        cs.origin,
        Number(cs.applied),
        cs.status,
        cs.eol,
        Number(cs.bom),
        Number(cs.finalNewline),
        Number(cs.binary),
        cs.baseline,
        cs.proposed,
        Number(cs.baselineExists),
        Number(cs.proposedExists),
        cs.createdAt,
        cs.updatedAt,
      );
      // Delete explicitly rather than relying on ON DELETE CASCADE firing for a REPLACE.
      this.driver.run("DELETE FROM hunks WHERE change_id = ?", cs.id);
      cs.hunks.forEach((h, ordinal) => {
        this.driver.run(
          `INSERT INTO hunks (change_id, id, ordinal, old_start, new_start, old_lines, new_lines, decision)
           VALUES (?,?,?,?,?,?,?,?)`,
          cs.id,
          h.id,
          ordinal,
          h.oldStart,
          h.newStart,
          JSON.stringify(h.oldLines),
          JSON.stringify(h.newLines),
          h.decision,
        );
      });
    });
  }

  private hunksFor(ids: string[]): Map<string, HunkRow[]> {
    const out = new Map<string, HunkRow[]>();
    if (ids.length === 0) {
      return out;
    }
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.driver.all<HunkRow>(
      `SELECT * FROM hunks WHERE change_id IN (${placeholders}) ORDER BY change_id, ordinal`,
      ...ids,
    );
    for (const row of rows) {
      const list = out.get(row.change_id) ?? [];
      list.push(row);
      out.set(row.change_id, list);
    }
    return out;
  }

  getChange(workspace: string, id: string): ChangeSet | undefined {
    const row = this.driver.get<ChangeRow>(
      "SELECT * FROM changes WHERE workspace = ? AND id = ?",
      workspace,
      id,
    );
    if (!row) {
      return undefined;
    }
    return rowToChangeSet(row, this.hunksFor([id]).get(id) ?? []);
  }

  findById(id: string): ChangeSet | undefined {
    const row = this.driver.get<ChangeRow>("SELECT * FROM changes WHERE id = ?", id);
    if (!row) {
      return undefined;
    }
    return rowToChangeSet(row, this.hunksFor([id]).get(id) ?? []);
  }

  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined {
    const row = this.driver.get<ChangeRow>(
      "SELECT * FROM changes WHERE workspace = ? AND path = ? AND status != 'resolved'",
      workspace,
      relPath.split(path.sep).join("/"),
    );
    if (!row) {
      return undefined;
    }
    return rowToChangeSet(row, this.hunksFor([row.id]).get(row.id) ?? []);
  }

  listChangeSets(workspace: string): ChangeSet[] {
    const rows = this.driver.all<ChangeRow>(
      "SELECT * FROM changes WHERE workspace = ? AND status != 'resolved' ORDER BY path",
      workspace,
    );
    if (rows.length === 0) {
      return [];
    }
    const hunks = this.hunksFor(rows.map((r) => r.id));
    const out = rows.map((r) => rowToChangeSet(r, hunks.get(r.id) ?? []));
    // UNIQUE (workspace, path) already guarantees one row per file; the dedupe mirrors
    // JsonBackend so the two backends cannot drift if that constraint ever changes.
    const latest = new Map<string, ChangeSet>();
    for (const cs of out) {
      const prev = latest.get(cs.path);
      if (!prev || (cs.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
        latest.set(cs.path, cs);
      }
    }
    return [...latest.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  removeChange(workspace: string, id: string): void {
    this.driver.run("DELETE FROM changes WHERE workspace = ? AND id = ?", workspace, id);
  }

  clearChanges(workspace: string): void {
    this.driver.run("DELETE FROM changes WHERE workspace = ?", workspace);
  }

  pruneResolved(maxAgeMs: number): void {
    this.driver.run("DELETE FROM changes WHERE status = 'resolved' AND updated_at < ?", Date.now() - maxAgeMs);
  }

  // ---- baselines (content-addressed blobs on disk, same as JsonBackend) ----

  putBaseline(workspace: string, content: string): string {
    return this.blobs.put(workspace, content);
  }

  getBaseline(workspace: string, hash: string): string {
    return this.blobs.get(workspace, hash);
  }

  dispose(): void {
    this.driver.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 163`, `# fail 0` (154 + 9 mirrored SQLite tests).

---

### Task 7: `ChangeStore` becomes a facade over a backend

**Files:**
- Modify: `src/change-store.ts` (delete the moved storage methods, delegate to `this.backend`, add `listChangeSets`, add the `backend` option)
- Modify: `test/change-store.test.ts` (the `globToRegExp` import stays; nothing else)

**Interfaces:**
- Consumes: `StoreBackend`, `JsonBackend`, `SqliteBackend`, `CheckpointRecord`, `workspaceKey` from `src/store-backend.ts`; `openDatabase` from `src/sqlite.ts`.
- Produces: `ChangeStore` public API unchanged, plus:
  - `constructor(opts: StoreOptions)` where `StoreOptions` gains `backend?: "auto" | "json" | "sqlite"` (default `"auto"`).
  - `listChangeSets(workspace: string): ChangeSet[]` — the unresolved change sets, full objects (not summaries), sorted by path.
  - `dispose(): void`.

- [ ] **Step 1: Write the failing test**

Add to the end of `test/change-store.test.ts`:

```ts
test("listChangeSets returns full change sets for the panel and the review tab", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp() });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");

  const sets = store.listChangeSets(ws);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].id, cs.id);
  assert.equal(sets[0].hunks.length, 1, "hunks come with it, not just counts");
  assert.equal(sets[0].baseline, "one\ntwo\nthree\n", "the baseline travels too");

  store.accept(cs.id);
  assert.equal(store.listChangeSets(ws).length, 0, "a resolved set is not listed");
  store.dispose();
});

test("the JSON backend can be selected explicitly and behaves identically", async () => {
  const ws = makeWorkspace();
  const store = new ChangeStore({ baseDir: tmp(), backend: "json" });
  await store.setCheckpoint(ws, { maxFileSize: 1e9, excludeGlobs: [] });
  const cs = store.propose(ws, "a.txt", "one\nTWO\nthree\n");
  store.accept(cs.id);
  assert.equal(fs.readFileSync(path.join(ws, "a.txt"), "utf8"), "one\nTWO\nthree\n");
  assert.equal(store.listChanges(ws).length, 0);
  store.dispose();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: `store.listChangeSets is not a function` and `backend` rejected as an unknown option (the second test still passes, since excess properties on an object literal are allowed only for a known type — it will fail typecheck instead).

- [ ] **Step 3: Rewire `ChangeStore`**

In `src/change-store.ts`:

1. Replace the imports of `file-snapshot` so `writeFileAtomic`/`deleteFileSafe` remain (still used by `applyToDisk`) and add the backend imports. **Keep `hashContent`** — `observeBinary` still calls it at `src/change-store.ts:809`, so dropping it breaks the typecheck:

```ts
import { writeFileAtomic, deleteFileSafe, readFileSafe, resolveInside, toPosix, hashContent } from "./file-snapshot";
import { JsonBackend, SqliteBackend, workspaceKey, type CheckpointRecord, type StoreBackend } from "./store-backend";
import { openDatabase } from "./sqlite";
```

2. Extend `StoreOptions`:

```ts
export interface StoreOptions {
  baseDir?: string;
  maxFileSize?: number;
  excludeGlobs?: string[];
  /** Which persistence backend to use. `"auto"` prefers SQLite and falls back to JSON. */
  backend?: "auto" | "json" | "sqlite";
}
```

3. Delete the `CheckpointFile` interface and keep `DEFAULT_MAX_FILE_SIZE`; delete `workspaceKey` (it now lives in `store-backend.ts`). `changeIdFor` and `globToRegExp` stay.

4. Replace the class fields and constructor:

```ts
export class ChangeStore {
  private baseDir: string;
  private maxFileSize: number;
  private excludeGlobs: string[];
  private excludeRes: RegExp[];
  private backend: StoreBackend;

  constructor(opts: StoreOptions = {}) {
    this.baseDir = opts.baseDir ?? path.join(os.homedir(), ".review-hub");
    this.maxFileSize = opts.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.excludeGlobs = opts.excludeGlobs ?? [];
    this.excludeRes = this.excludeGlobs.map(globToRegExp);

    const mode = opts.backend ?? "auto";
    const driver = mode === "json" ? undefined : openDatabase(path.join(this.baseDir, "hub.db"));
    if (mode === "sqlite" && !driver) {
      throw new Error("Review Hub: the sqlite backend was requested but node:sqlite is unavailable.");
    }
    this.backend =
      driver !== undefined
        ? new SqliteBackend(driver, this.baseDir)
        : new JsonBackend(this.baseDir);
  }

  /** Release backend resources (the SQLite connection). Safe to call twice. */
  dispose(): void {
    this.backend.dispose();
  }
```

5. Delete these methods entirely, because the backend now owns them: `wsDir`, `checkpointPath`, `changesDir`, `baselinesDir`, `baselineFile`, `putBaseline`, `getBaseline`, `writeCheckpoint`, `changePath`, `writeChange`, `getChange`, `cache`, `invalidate`, `changesDirMtime`, `listChangesRaw`, `listKnownWorkspaces`, `clearChanges`, `pruneResolved`, `removeChange`, `findById`.

6. Add the delegations in their place:

```ts
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

  readCheckpoint(workspace: string): CheckpointRecord | undefined {
    return this.backend.readCheckpoint(workspace);
  }

  private writeCheckpoint(workspace: string, cp: CheckpointRecord): void {
    this.backend.writeCheckpoint(cp);
  }

  private writeChange(cs: ChangeSet): void {
    this.backend.writeChange(cs);
  }

  getChange(workspace: string, id: string): ChangeSet | undefined {
    return this.backend.getChange(workspace, id);
  }

  findById(changeId: string): ChangeSet | undefined {
    return this.backend.findById(changeId);
  }

  findChangeByPath(workspace: string, relPath: string): ChangeSet | undefined {
    return this.backend.findChangeByPath(workspace, relPath);
  }

  private removeChange(cs: ChangeSet): void {
    this.backend.removeChange(cs.workspace, cs.id);
  }

  /** Unresolved change sets, full objects — for the sidebar panel and the review tab. */
  listChangeSets(workspace: string): ChangeSet[] {
    return this.backend.listChangeSets(workspace);
  }

  listChanges(workspace: string): ChangeSummary[] {
    return this.backend.listChangeSets(workspace).map((cs) => summarize(cs));
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
```

7. Fix the two remaining internal uses of the old private names:
   - `setCheckpoint` ends with `this.clearChanges(workspace)` — still valid (now delegating).
   - `clearCheckpoint(workspace)` becomes:

```ts
  clearCheckpoint(workspace: string): void {
    this.backend.clearCheckpoint(workspace);
  }
```

   - `removeChange(cs)` is called from `observe` as `this.removeChange(cs)` — the signature above matches.

8. `readCheckpoint` is `public` and now returns `CheckpointRecord` instead of `CheckpointFile`. Delete the local `CheckpointFile` interface; every construction site already uses the `{ workspace, setAt, files }` literal shape, which is structurally identical.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 165`, `# fail 0` (163 + 2 new `ChangeStore` tests). All 120 original tests now exercise `SqliteBackend` by default (because `node:sqlite` is present on Node 22.23) — that is the point of the backend interface.

- [ ] **Step 5: Confirm the JSON fallback still works end to end**

Run: `npm test 2>&1 | tail -20`
Expected: no `ExperimentalWarning: SQLite is an experimental feature` line, and no `# fail`.

---

### Task 8: Build and runtime configuration for the SQLite era

**Files:**
- Modify: `package.json` (`engines.vscode`, remove dead `view/item/context` menus)
- Modify: `src/extension.ts` (dispose the store)
- Modify: `README.md` (the "Phát triển" section's test count — see Task 14 for the full doc pass)

**Interfaces:**
- Consumes: nothing new.
- Produces: `engines.vscode` = `^1.103.0`; `review-hub.changes` no longer declares `viewItem` context menus (it is a webview, not a tree).

- [ ] **Step 1: Bump the engine floor**

In `package.json`:

```json
  "engines": {
    "vscode": "^1.103.0"
  },
```

- [ ] **Step 2: Delete the dead tree-item menus**

In `package.json`, delete the whole `"view/item/context"` array from `contributes.menus` (it gates on `viewItem == reviewHub.file` / `reviewHub.folder`, and a webview has no tree items). Keep `view/title` and `explorer/context` unchanged.

After the edit, `contributes.menus` must be exactly:

```json
    "menus": {
      "view/title": [
        {
          "command": "review-hub.setCheckpoint",
          "when": "view == review-hub.changes",
          "group": "navigation@1"
        },
        {
          "command": "review-hub.acceptAll",
          "when": "view == review-hub.changes",
          "group": "navigation@2"
        },
        {
          "command": "review-hub.rejectAll",
          "when": "view == review-hub.changes",
          "group": "navigation@3"
        },
        {
          "command": "review-hub.refresh",
          "when": "view == review-hub.changes",
          "group": "navigation@4"
        }
      ],
      "explorer/context": [
        {
          "command": "review-hub.openDiff",
          "when": "resourceScheme == file",
          "group": "reviewhub@1"
        },
        {
          "command": "review-hub.openSideBySide",
          "when": "resourceScheme == file",
          "group": "reviewhub@2"
        },
        {
          "command": "review-hub.acceptFile",
          "when": "resourceScheme == file",
          "group": "reviewhub@3"
        },
        {
          "command": "review-hub.rejectFile",
          "when": "resourceScheme == file",
          "group": "reviewhub@4"
        }
      ]
    }
```

- [ ] **Step 3: Dispose the store on deactivate**

In `src/extension.ts`, inside the final `{ dispose: () => { ... } }` subscription, add the store disposal after the hub stop:

```ts
    {
      dispose: () => {
        disposed = true;
        if (!isHost) {
          return;
        }
        void hub.stop();
        // Only clear the entry if it is still ours; another window may have taken over.
        const current = registry.readEntry();
        if (current && current.pid === process.pid) {
          registry.clearEntry();
        }
      },
    },
```

The SQLite connection is closed by the `HubServer`'s store owner. Add to `HubServer` a `stop()` tail — in `src/hub-server.ts`, at the end of `stop()`:

```ts
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Release the SQLite handle so a restart in the same process does not leak it.
    this.store.dispose();
  }
```

Note: `stop()` is now idempotent about the store (a second `dispose()` on `SqliteBackend` would close twice), so guard `SqliteBackend.dispose` in `src/store-backend.ts`:

```ts
  private closed = false;
  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.driver.close();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 165`, `# fail 0`. `test/extension.test.ts` still passes (it stops the hub on teardown).

- [ ] **Step 5: Verify the packaged output**

Run: `npm run build && ls -la dist/ && grep -c 'require("node:sqlite")' dist/extension.js`
Expected: `dist/extension.js` and `dist/mcp-server.cjs` are rebuilt; the `grep` prints `1`.

---

### Task 9: Pure webview state builders

**Files:**
- Create: `src/review-panel-state.ts`
- Create: `test/review-state.test.ts`

**Interfaces:**
- Consumes: `buildMergedView` from `src/merged-diff.ts`; `splitContent` from `src/hunk-diff.ts`; `diffStats` from `src/hunk-diff.ts`; `ChangeSet`, `ChangeStatus`, `CheckpointInfo`, `HunkDecision` from `src/types.ts`.
- Produces:
  - `export interface PanelSource { workspaces(): string[]; checkpoint(workspace: string): CheckpointInfo | undefined; changeSets(workspace: string): ChangeSet[] }`
  - `export interface PanelHunk { id: string; anchorLine: number; added: number; removed: number; decision: HunkDecision }`
  - `export interface PanelFile { id: string; path: string; name: string; dir: string; added: number; removed: number; pending: number; accepted: number; rejected: number; binary: boolean; isNew: boolean; isDeleted: boolean; hunks: PanelHunk[] }`
  - `export interface PanelGroup { workspace: string; label: string; files: PanelFile[] }`
  - `export interface PanelState { groups: PanelGroup[]; totalFiles: number; added: number; removed: number; checkpoint: CheckpointInfo | undefined }`
  - `export function buildPanelState(source: PanelSource): PanelState`
  - `export interface ReviewLine { kind: "context" | "deleted" | "added"; text: string }`
  - `export interface ReviewHunk { id: string; line: number; decision: HunkDecision; added: number; removed: number }`
  - `export interface ReviewState { changeId: string; name: string; dir: string; binary: boolean; status: ChangeStatus; lines: ReviewLine[]; hunks: ReviewHunk[]; added: number; removed: number; pending: number }`
  - `export function buildReviewState(cs: ChangeSet): ReviewState`

- [ ] **Step 1: Write the failing test**

Create `test/review-state.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPanelState, buildReviewState, type PanelSource } from "../src/review-panel-state";
import type { ChangeSet } from "../src/types";

function changeSet(over: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "src/app.ts",
    absPath: "/ws/src/app.ts",
    origin: "mcp",
    applied: false,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: "a\nb\nc\n",
    proposed: "a\nB\nc\n",
    baselineExists: true,
    proposedExists: true,
    hunks: [
      { id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"], decision: "pending" },
    ],
    status: "pending",
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

function source(sets: ChangeSet[]): PanelSource {
  return {
    workspaces: () => ["/ws"],
    checkpoint: () => ({ workspace: "/ws", setAt: 1000, files: 7 }),
    changeSets: (ws) => (ws === "/ws" ? sets : []),
  };
}

test("the panel totals files and added/removed lines across workspaces", () => {
  const state = buildPanelState(source([changeSet()]));
  assert.equal(state.totalFiles, 1);
  assert.equal(state.added, 1);
  assert.equal(state.removed, 1);
  assert.equal(state.checkpoint?.files, 7);
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].label, "ws");
});

test("a file row splits its name from its directory", () => {
  const state = buildPanelState(source([changeSet()]));
  const file = state.groups[0].files[0];
  assert.equal(file.name, "app.ts");
  assert.equal(file.dir, "src");
  assert.equal(file.pending, 1);
  assert.equal(file.binary, false);
});

test("a hunk row carries a 1-based anchor line and its own counts", () => {
  const state = buildPanelState(source([changeSet()]));
  const hunk = state.groups[0].files[0].hunks[0];
  assert.equal(hunk.anchorLine, 2, "oldStart 1 becomes line 2");
  assert.equal(hunk.added, 1);
  assert.equal(hunk.removed, 1);
  assert.equal(hunk.decision, "pending");
});

test("a brand-new file is flagged and gets no directory", () => {
  const cs = changeSet({
    baseline: "",
    baselineExists: false,
    path: "new.ts",
    proposed: "x\n",
    hunks: [{ id: "h1", oldStart: 0, oldLines: [], newStart: 0, newLines: ["x"], decision: "pending" }],
  });
  const state = buildPanelState(source([cs]));
  const file = state.groups[0].files[0];
  assert.equal(file.isNew, true);
  assert.equal(file.isDeleted, false);
  assert.equal(file.dir, "");
});

test("a deleted file is flagged", () => {
  const cs = changeSet({
    proposed: "",
    proposedExists: false,
    hunks: [{ id: "h1", oldStart: 0, oldLines: ["a", "b", "c"], newStart: 0, newLines: [], decision: "pending" }],
  });
  assert.equal(buildPanelState(source([cs])).groups[0].files[0].isDeleted, true);
});

test("an empty source yields an empty panel state", () => {
  const state = buildPanelState(source([]));
  assert.deepEqual(state.groups, []);
  assert.equal(state.totalFiles, 0);
  assert.equal(state.added, 0);
});

test("the review state tags every line with its block kind", () => {
  const state = buildReviewState(changeSet());
  assert.deepEqual(
    state.lines.map((l) => l.kind),
    ["context", "deleted", "added", "context"],
    "pending shows the old line then the new one",
  );
  assert.deepEqual(state.lines.map((l) => l.text), ["a", "b", "B", "c"]);
  assert.equal(state.hunks.length, 1);
  assert.equal(state.hunks[0].line, 1, "the hunk starts at line index 1");
  assert.equal(state.pending, 1);
});

test("an accepted hunk renders only its added lines", () => {
  const cs = changeSet({
    hunks: [{ id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"], decision: "accepted" }],
  });
  const state = buildReviewState(cs);
  assert.deepEqual(state.lines.map((l) => l.kind), ["context", "added", "context"]);
  assert.equal(state.pending, 0);
});

test("a rejected hunk renders only its deleted lines", () => {
  const cs = changeSet({
    hunks: [{ id: "h1", oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B"], decision: "rejected" }],
  });
  const state = buildReviewState(cs);
  assert.deepEqual(state.lines.map((l) => l.kind), ["context", "deleted", "context"]);
});

test("a binary change renders a placeholder instead of a diff", () => {
  const state = buildReviewState(changeSet({ binary: true }));
  assert.equal(state.binary, true);
  assert.deepEqual(state.lines, []);
  assert.equal(state.hunks.length, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: build fails — *Could not resolve "../src/review-panel-state"*.

- [ ] **Step 3: Write `src/review-panel-state.ts`**

```ts
/**
 * The serialisable state objects the two webviews render.
 *
 * Both builders are pure — no `vscode`, no DOM, no filesystem — so the panel and the
 * review tab stay dumb renderers and their state is unit-testable without a webview.
 *
 * `buildPanelState` produces the sidebar's nested view (workspace → file → hunk).
 * `buildReviewState` produces the review tab's flat line list, reusing `buildMergedView`
 * so the diff logic is not duplicated in JavaScript.
 */
import { buildMergedView } from "./merged-diff";
import { diffStats, splitContent } from "./hunk-diff";
import type { ChangeSet, ChangeStatus, CheckpointInfo, HunkDecision } from "./types";

export interface PanelSource {
  workspaces(): string[];
  checkpoint(workspace: string): CheckpointInfo | undefined;
  changeSets(workspace: string): ChangeSet[];
}

export interface PanelHunk {
  id: string;
  /** 1-based line number in the baseline where this hunk starts. */
  anchorLine: number;
  added: number;
  removed: number;
  decision: HunkDecision;
}

export interface PanelFile {
  id: string;
  path: string;
  name: string;
  dir: string;
  added: number;
  removed: number;
  pending: number;
  accepted: number;
  rejected: number;
  binary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: PanelHunk[];
}

export interface PanelGroup {
  workspace: string;
  label: string;
  files: PanelFile[];
}

export interface PanelState {
  groups: PanelGroup[];
  totalFiles: number;
  added: number;
  removed: number;
  checkpoint: CheckpointInfo | undefined;
}

function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function dirName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}

function fileOf(cs: ChangeSet): PanelFile {
  const stats = diffStats(cs.hunks);
  return {
    id: cs.id,
    path: cs.path,
    name: baseName(cs.path),
    dir: dirName(cs.path),
    added: stats.added,
    removed: stats.removed,
    pending: cs.hunks.filter((h) => h.decision === "pending").length,
    accepted: cs.hunks.filter((h) => h.decision === "accepted").length,
    rejected: cs.hunks.filter((h) => h.decision === "rejected").length,
    binary: cs.binary,
    isNew: !cs.baselineExists && cs.proposedExists,
    isDeleted: cs.baselineExists && !cs.proposedExists,
    hunks: cs.hunks.map((h) => ({
      id: h.id,
      anchorLine: h.oldStart + 1,
      added: h.newLines.length,
      removed: h.oldLines.length,
      decision: h.decision,
    })),
  };
}

export function buildPanelState(source: PanelSource): PanelState {
  const groups: PanelGroup[] = [];
  let totalFiles = 0;
  let added = 0;
  let removed = 0;
  let checkpoint: CheckpointInfo | undefined;

  for (const workspace of source.workspaces()) {
    const sets = source.changeSets(workspace);
    if (sets.length === 0) {
      continue;
    }
    checkpoint = checkpoint ?? source.checkpoint(workspace);
    const files = sets.map(fileOf);
    for (const f of files) {
      totalFiles++;
      added += f.added;
      removed += f.removed;
    }
    groups.push({ workspace, label: baseName(workspace), files });
  }

  if (checkpoint === undefined) {
    checkpoint = source.checkpoint(source.workspaces()[0] ?? "");
  }
  return { groups, totalFiles, added, removed, checkpoint };
}

export interface ReviewLine {
  kind: "context" | "deleted" | "added";
  text: string;
}

export interface ReviewHunk {
  id: string;
  /** Index into `lines` where this hunk's decision bar belongs. */
  line: number;
  decision: HunkDecision;
  added: number;
  removed: number;
}

export interface ReviewState {
  changeId: string;
  name: string;
  dir: string;
  binary: boolean;
  status: ChangeStatus;
  lines: ReviewLine[];
  hunks: ReviewHunk[];
  added: number;
  removed: number;
  pending: number;
}

export function buildReviewState(cs: ChangeSet): ReviewState {
  const stats = diffStats(cs.hunks);
  const base = {
    changeId: cs.id,
    name: baseName(cs.path),
    dir: dirName(cs.path),
    binary: cs.binary,
    status: cs.status,
    added: stats.added,
    removed: stats.removed,
    pending: cs.hunks.filter((h) => h.decision === "pending").length,
  };
  if (cs.binary) {
    // A binary file has no lines to show; the panel's accept/reject is the whole story.
    return { ...base, lines: [], hunks: [] };
  }
  const view = buildMergedView(splitContent(cs.baseline).lines, cs.hunks);
  const lines: ReviewLine[] = [];
  for (const block of view.blocks) {
    for (let i = block.start; i < block.end; i++) {
      lines.push({ kind: block.kind, text: view.lines[i] });
    }
  }
  return {
    ...base,
    lines,
    hunks: view.hunks.map((h) => ({
      id: h.id,
      line: h.anchor,
      decision: h.decision,
      added: h.added,
      removed: h.removed,
    })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 175`, `# fail 0` (165 + 10 new state tests).

---

### Task 10: Remove the merged virtual document

The user chose to delete the old merged view rather than keep it alongside the review tab. `src/merged-diff.ts` is **kept** — it becomes the review tab's renderer (Task 9 already consumes it), so its 7 tests stay valid.

**Files:**
- Modify: `src/content-provider.ts` (drop the `merged` authority, `mergedUri`, and `mergedText`)
- Modify: `src/diff-view.ts` (drop the merged CodeLens branch, `MergedDecorator`, `DiffView.open`, and the merged half of `retitle`)
- Modify: `test/inline-review.test.ts` (re-point the merged tests at `buildReviewState`)

**Interfaces:**
- Consumes: `buildReviewState` from `src/review-panel-state.ts`.
- Produces: `ChangeContentProvider` keeps `SCHEME`, `baselineUri`, `proposedUri`, `refresh(changeId)`, `provideTextDocumentContent`, `onDidChange`, `dispose`. `DiffView` keeps `openSideBySide(changeId)`, `titleFor(changeId)`, `refresh(changeId)`, `dispose()`, and `HunkCodeLensProvider` keeps `refresh()` and `provideCodeLenses(document)`.

- [ ] **Step 1: Rewrite the merged tests against the review-tab state**

In `test/inline-review.test.ts`, replace the imports:

```ts
import { ChangeStore } from "../src/change-store";
import { ChangeContentProvider } from "../src/content-provider";
import { HunkCodeLensProvider } from "../src/diff-view";
import { buildReviewState } from "../src/review-panel-state";
```

Replace the test "the merged review document shows the OLD lines above the NEW lines" with:

```ts
test("the review state shows the OLD lines above the NEW lines", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const state = buildReviewState(cs);
  const oldLine = "from typing import List, Optional, Sequence, Tuple";
  const newLine = "from typing import List, Sequence, Tuple";
  const iOld = state.lines.findIndex((l) => l.text === oldLine && l.kind === "deleted");
  const iNew = state.lines.findIndex((l) => l.text === newLine && l.kind === "added");

  assert.notEqual(iOld, -1, "the old code is present, tagged as deleted (red)");
  assert.notEqual(iNew, -1, "the new code is present, tagged as added (green)");
  assert.ok(iOld < iNew, "the old line is shown directly above the new line");
  assert.ok(state.lines.some((l) => l.text === "print('old')" && l.kind === "deleted"));
  assert.ok(state.lines.some((l) => l.text === "print('new')" && l.kind === "added"));
});
```

Replace "rejecting a hunk makes the merged view show only the old code again" with:

```ts
test("rejecting a hunk makes the review state show only the old code again", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  store.reject(cs.id);

  const state = buildReviewState(store.findById(cs.id)!);
  assert.ok(state.lines.some((l) => l.text.includes("Optional")), "the old code is still shown after reject");
  assert.equal(state.lines.some((l) => l.kind === "added"), false, "nothing is added after reject");
  assert.equal(state.pending, 0);
  // And the file on disk is back to the original.
  assert.equal(fs.readFileSync(path.join(ws, "demo.py"), "utf8"), OLD);
});
```

Replace "accepting a hunk makes the merged view show only the new code" with:

```ts
test("accepting a hunk makes the review state show only the new code", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  store.accept(cs.id);

  const state = buildReviewState(store.findById(cs.id)!);
  assert.equal(state.lines.some((l) => l.text.includes("Optional")), false, "the old code is gone after accept");
  assert.ok(state.lines.some((l) => l.text === "from typing import List, Sequence, Tuple" && l.kind === "added"));
  assert.equal(fs.readFileSync(path.join(ws, "demo.py"), "utf8"), NEW);
});
```

Delete the test "the merged view carries Accept/Reject CodeLens for every hunk" — the review tab has no CodeLens, its decision bars come from `state.hunks` — and replace it with:

```ts
test("the review state carries one decision bar per hunk", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const state = buildReviewState(cs);
  assert.equal(state.hunks.length, cs.hunks.length);
  for (const h of state.hunks) {
    assert.ok(h.line >= 0 && h.line < state.lines.length, "the bar anchors on a real line");
  }
});
```

Replace "a fully-resolved change stays readable but is read-only" with:

```ts
test("a fully-resolved change stays readable but has no pending hunks", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);
  store.reject(cs.id);

  const kept = store.findById(cs.id);
  assert.equal(kept?.status, "resolved");
  assert.equal(store.listChanges(ws).length, 0, "not listed as a pending change");

  const state = buildReviewState(kept!);
  assert.equal(state.status, "resolved");
  assert.equal(state.pending, 0);
  assert.ok(state.lines.length > 0, "the resolved state is still renderable");
});
```

Replace "a decided hunk looks decided: its buttons change, not just a label" with:

```ts
test("a decided hunk is visibly decided in the review state", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  const pad = "pad\n".repeat(15);
  fs.writeFileSync(path.join(ws, "demo.py"), `A = 1\n${pad}B = 2\n`);
  const cs = store.propose(ws, "demo.py", `A = 111\n${pad}B = 222\n`);
  assert.equal(cs.hunks.length, 2, "two hunks, so one can stay pending");

  const before = buildReviewState(store.findById(cs.id)!);
  assert.deepEqual(before.hunks.map((h) => h.decision), ["pending", "pending"]);

  store.accept(cs.id, [cs.hunks[0].id]);
  const after = buildReviewState(store.findById(cs.id)!);
  assert.deepEqual(after.hunks.map((h) => h.decision), ["accepted", "pending"]);
  assert.equal(after.pending, 1);
});
```

Keep the `onDidChange` regression test and the `provider.mergedText` assertions removed from it — that test only uses `provider.refresh`, so it is unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: the rewritten tests pass already (they only use `buildReviewState`), and `npm run typecheck` still succeeds because `mergedUri`/`mergedText` still exist. This step is the checkpoint: run `npm test` and confirm `# pass 175`, `# fail 0` **before** deleting the merged view, so the new tests are proven against the old code.

- [ ] **Step 3: Delete the merged authority from the content provider**

In `src/content-provider.ts`:

- Update the header comment to describe only the two sides of a diff.
- Delete the `buildMergedView` import.
- Delete the `if (side === "merged") { return this.mergedText(changeId); }` branch from `provideTextDocumentContent`.
- Delete the whole `mergedText(changeId: string): string` method.
- Delete `mergedUri(changeId: string): vscode.Uri`.
- In `refresh`, delete the `this.emitter.fire(this.mergedUri(changeId));` line.

The resulting `provideTextDocumentContent` is:

```ts
  provideTextDocumentContent(uri: vscode.Uri): string {
    const side = uri.authority;
    const changeId = uri.path.replace(/^\//, "");
    const cs = this.store.findById(changeId);
    if (!cs) {
      return "";
    }
    if (side === "baseline") {
      return cs.binary ? "(binary file)" : cs.baseline;
    }
    if (cs.binary) {
      return "(binary file)";
    }
    return cs.proposed;
  }
```

- [ ] **Step 4: Delete the merged CodeLens branch and `MergedDecorator`**

In `src/diff-view.ts`:

- Update the header comment: the primary surface is now the review tab (`src/review-tab.ts`), and this file owns the side-by-side diff plus the CodeLens on the real file.
- Delete the `buildMergedView` import and the `import { ... type MergedView } from "./merged-diff";` tail export.
- Delete the whole `if (uri.scheme === "review-hub" && uri.authority === "merged") { ... }` branch in `provideCodeLenses`.
- Delete the `MergedDecorator` class entirely (from its doc comment through its closing brace, including `refreshAll`).
- In `DiffView`: delete the `decorator` field and its construction, delete the two `onDidChangeActiveTextEditor`/`onDidChangeVisibleTextEditors` subscriptions that only fed the decorator, delete `open(changeId, preview)`, and simplify `refresh`:

```ts
  async refresh(changeId: string): Promise<void> {
    this.provider.refresh(changeId);
    this.codeLens.refresh();
    this.onDidChange();
    await this.retitle(changeId);
  }
```

- Simplify `retitle` to only reopen the side-by-side tab:

```ts
  private async retitle(changeId: string): Promise<void> {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return;
    }
    let sideBySide = false;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { modified?: vscode.Uri } | undefined;
        const id = (u?: vscode.Uri) => u?.scheme === "review-hub" && u.path.replace(/^\//, "") === changeId;
        if (input?.modified?.scheme === "review-hub" && id(input.modified)) {
          await vscode.window.tabGroups.close(tab, true);
          sideBySide = true;
        }
      }
    }
    if (sideBySide) {
      await this.openSideBySide(changeId);
    }
  }
```

- Update the class doc comment on `DiffView` to say it owns the side-by-side diff only.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 175`, `# fail 0` (the rewritten `inline-review.test.ts` tests replace the old ones one-for-one). No test references `review-hub://merged` any more.

---

### Task 11: Sidebar webview panel

**Files:**
- Create: `src/webview-html.ts`
- Create: `src/review-panel.ts`
- Create: `media/panel.html`, `media/panel.css`, `media/panel.js`
- Modify: `test/vscode-stub.ts` (webview surfaces)
- Create: `test/review-panel.test.ts`

**Interfaces:**
- Consumes: `buildPanelState`, `PanelSource`, `PanelState` from `src/review-panel-state.ts`.
- Produces:
  - `export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, files: { html: string; css: string; js: string }): string`
  - `export interface PanelActions { acceptHunk(changeId: string, hunkId: string): void; rejectHunk(changeId: string, hunkId: string): void; acceptFile(changeId: string): void; rejectFile(changeId: string): void; acceptAll(): void; rejectAll(): void; openHunk(changeId: string, hunkId: string): void; openDiff(changeId: string): void; setCheckpoint(): void }`
  - `export class ReviewPanelProvider implements vscode.WebviewViewProvider { static readonly viewType = "review-hub.changes"; constructor(extensionUri: vscode.Uri, source: PanelSource, actions: PanelActions); resolveWebviewView(view: vscode.WebviewView): void; refresh(): void }`

- [ ] **Step 1: Add the webview surfaces to the test stub**

In `test/vscode-stub.ts`, add a `webviews` registry near the other registries:

```ts
const webviews = new Map<string, unknown>();
```

and replace the `window.registerWebviewViewProvider` entry with:

```ts
    registerWebviewViewProvider: (id: string, provider: unknown) => {
      const fake = {
        viewType: id,
        visible: true,
        title: "Changes",
        show: () => {},
        onDidChangeVisibility: () => ({ dispose: () => {} }),
        webview: makeFakeWebview(),
      };
      (provider as { resolveWebviewView(view: unknown): void }).resolveWebviewView(fake);
      webviews.set(id, fake);
      return { dispose: () => webviews.delete(id) };
    },
```

and add `createWebviewPanel`:

```ts
    createWebviewPanel: (id: string, title: string, _column: unknown, _options: unknown) => {
      const listeners: ((msg: unknown) => void)[] = [];
      const posted: unknown[] = [];
      const panel = {
        viewType: id,
        title,
        posted,
        webview: {
          html: "",
          options: {} as unknown,
          cspSource: "vscode-resource://test",
          asWebviewUri: (uri: { toString(): string }) => uri,
          onDidReceiveMessage: (cb: (msg: unknown) => void) => {
            listeners.push(cb);
            return { dispose: () => {} };
          },
          postMessage: async (msg: unknown) => {
            posted.push(msg);
            return true;
          },
          /** Test hook: pretend the webview sent this message. */
          __receive: (msg: unknown) => listeners.forEach((cb) => cb(msg)),
        },
        onDidDispose: (cb: () => void) => {
          (panel as { __dispose?: () => void }).__dispose = cb;
          return { dispose: () => {} };
        },
        reveal: () => {},
        dispose: () => (panel as { __dispose?: () => void }).__dispose?.(),
      };
      panels.push(panel);
      return panel;
    },
```

with a helper and registry above `stub`:

```ts
const panels: unknown[] = [];

function makeFakeWebview() {
  const listeners: ((msg: unknown) => void)[] = [];
  return {
    html: "",
    options: {} as unknown,
    cspSource: "vscode-resource://test",
    asWebviewUri: (uri: { toString(): string }) => uri,
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      listeners.push(cb);
      return { dispose: () => {} };
    },
    postMessage: async (_msg: unknown) => true,
    __receive: (msg: unknown) => listeners.forEach((cb) => cb(msg)),
  };
}
```

and export the new registries in `stub`:

```ts
  __webviews: webviews,
  __panels: panels,
```

Also add `joinPath` handling for a three-argument call — the existing `Uri.joinPath` already spreads `...parts`, so `Uri.joinPath(uri, "media", "panel.html")` works.

- [ ] **Step 2: Write the failing test**

Create `test/review-panel.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "./vscode-stub";
import { ChangeStore } from "../src/change-store";
import { ReviewPanelProvider, type PanelActions } from "../src/review-panel";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-panel-"));
}

function actions(): PanelActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    acceptHunk: (c, h) => calls.push(`acceptHunk:${c}:${h}`),
    rejectHunk: (c, h) => calls.push(`rejectHunk:${c}:${h}`),
    acceptFile: (c) => calls.push(`acceptFile:${c}`),
    rejectFile: (c) => calls.push(`rejectFile:${c}`),
    acceptAll: () => calls.push("acceptAll"),
    rejectAll: () => calls.push("rejectAll"),
    openHunk: (c, h) => calls.push(`openHunk:${c}:${h}`),
    openDiff: (c) => calls.push(`openDiff:${c}`),
    setCheckpoint: () => calls.push("setCheckpoint"),
  };
}

function makeProvider() {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
  const store = new ChangeStore({ baseDir: tmp(), backend: "json" });
  const cs = store.propose(ws, "a.txt", "one\nTWO\n");
  const a = actions();
  const provider = new ReviewPanelProvider(
    vscode.Uri.file(process.cwd()),
    {
      workspaces: () => [ws],
      checkpoint: () => undefined,
      changeSets: () => store.listChangeSets(ws),
    },
    a,
  );
  const view = (vscode as unknown as { __webviews: Map<string, { webview: { __receive(msg: unknown): void; html: string } }> })
    .__webviews.get("review-hub.changes")!;
  return { provider, a, cs, store, view, ws };
}

test("the panel html loads the assets through a CSP with a nonce", () => {
  const { provider } = makeProvider();
  assert.ok(provider);
  const { __webviews } = vscode as unknown as { __webviews: Map<string, { webview: { html: string } }> };
  const view = __webviews.get("review-hub.changes")!;
  assert.match(view.webview.html, /Content-Security-Policy/);
  assert.match(view.webview.html, /nonce-/);
  assert.match(view.webview.html, /panel\.js/);
  assert.match(view.webview.html, /panel\.css/);
});

test("a webview command is routed to the matching action", () => {
  const { a, cs, view } = makeProvider();
  view.webview.__receive({ command: "acceptHunk", changeId: cs.id, hunkId: cs.hunks[0].id });
  assert.deepEqual(a.calls, [`acceptHunk:${cs.id}:${cs.hunks[0].id}`]);

  view.webview.__receive({ command: "rejectAll" });
  assert.equal(a.calls[1], "rejectAll");

  view.webview.__receive({ command: "openDiff", changeId: cs.id });
  assert.equal(a.calls[2], `openDiff:${cs.id}`);

  view.webview.__receive({ command: "setCheckpoint" });
  assert.equal(a.calls[3], "setCheckpoint");
});

test("an unknown or malformed webview command is ignored, not thrown", () => {
  const { a, view } = makeProvider();
  view.webview.__receive({ command: "nonsense" });
  view.webview.__receive({});
  view.webview.__receive(null);
  assert.deepEqual(a.calls, [], "nothing is dispatched");
});

test("refresh posts the panel state to the webview", () => {
  const { provider, cs } = makeProvider();
  const { __panels } = vscode as unknown as { __panels: { posted: unknown[] }[] };
  provider.refresh();
  assert.ok(__panels.length >= 1);
  const messages = __panels.flatMap((p) => p.posted) as { type: string; state: { totalFiles: number } }[];
  const update = messages.find((m) => m.type === "update");
  assert.ok(update, "an update message was posted");
  assert.equal(update!.state.totalFiles, 1);
  assert.ok(cs.hunks.length === 1);
});
```

Note: the stub's `registerWebviewViewProvider` resolves the view eagerly, so `resolveWebviewView` runs at registration time. The test relies on that: it builds the provider, then reads the fake view out of `__webviews`.

Hmm — but the test calls `makeProvider()`, which constructs the provider, and the provider only registers itself when the extension calls `vscode.window.registerWebviewViewProvider`. The test must do that itself. Fix `makeProvider` to register:

```ts
  const provider = new ReviewPanelProvider(...);
  vscode.window.registerWebviewViewProvider(ReviewPanelProvider.viewType, provider);
```

and add `registerWebviewViewProvider` to the stub's `window` (already added in Step 1). Then `__webviews.get(...)` works.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: build fails — *Could not resolve "../src/review-panel"*.

- [ ] **Step 4: Write `src/webview-html.ts`**

```ts
/**
 * Shared HTML templating for both webviews. The HTML lives in `media/*.html` so it is
 * syntax-highlighted and editable, with four placeholders substituted at render time:
 * `${cspSource}`, `${nonce}`, `${styleUri}`, `${scriptUri}`.
 *
 * The CSP is strict — no inline script, no remote origins — and the script tag carries a
 * per-render nonce. `localResourceRoots` is narrowed to `media/` by each caller.
 */
import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  files: { html: string; css: string; js: string },
): string {
  const nonce = randomBytes(16).toString("base64");
  const asset = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name)).toString();
  const template = fs.readFileSync(vscode.Uri.joinPath(extensionUri, "media", files.html).fsPath, "utf8");
  return template
    .replace(/\$\{cspSource\}/g, webview.cspSource)
    .replace(/\$\{nonce\}/g, nonce)
    .replace(/\$\{styleUri\}/g, asset(files.css))
    .replace(/\$\{scriptUri\}/g, asset(files.js));
}
```

- [ ] **Step 5: Write `media/panel.html`, `media/panel.css`, `media/panel.js`**

`media/panel.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Review Hub</title>
  </head>
  <body>
    <div id="root" aria-live="polite"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>
```

`media/panel.css`:

```css
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: transparent;
}
.header,
.actions,
.file-head,
.hunk {
  display: flex;
  align-items: center;
  gap: 6px;
}
.header {
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
}
.actions {
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.count {
  font-weight: 600;
}
.stat {
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}
.stat.add {
  color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
}
.stat.del {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
}
.btn {
  background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  padding: 1px 6px;
  cursor: pointer;
  font: inherit;
  line-height: 1.6;
}
.btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
}
.group {
  padding: 8px 8px 2px;
  font-weight: 600;
  opacity: 0.8;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.file {
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
}
.file-head {
  padding: 5px 8px;
  cursor: pointer;
}
.file-head:hover {
  background: var(--vscode-list-hoverBackground);
}
.twisty {
  width: 12px;
  opacity: 0.7;
  cursor: pointer;
}
.name {
  font-weight: 600;
}
.dir {
  opacity: 0.6;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hunk {
  padding: 3px 8px 3px 26px;
  cursor: pointer;
}
.hunk:hover {
  background: var(--vscode-list-hoverBackground);
}
.hunk .line,
.hunk .stat {
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}
.badge {
  font-size: 11px;
  padding: 0 4px;
  border-radius: 3px;
}
.badge.ok {
  color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
}
.badge.no {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
}
.empty {
  padding: 16px 8px;
  opacity: 0.7;
}
```

`media/panel.js`:

```js
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  const expanded = new Set();
  let state = null;

  function send(command, payload) {
    vscode.postMessage(Object.assign({ command: command }, payload || {}));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, title, onClick) {
    const b = el("button", "btn", label);
    b.title = title;
    b.addEventListener("click", function (e) {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function renderHunk(file, hunk) {
    const row = el("div", "hunk hunk-" + hunk.decision);
    row.appendChild(el("span", "line", "@line " + hunk.anchorLine));
    row.appendChild(el("span", "stat", "+" + hunk.added + " \u2212" + hunk.removed));
    row.appendChild(el("span", "spacer"));
    if (hunk.decision === "accepted") {
      row.appendChild(el("span", "badge ok", "\u2713 accepted"));
      row.appendChild(button("\u21ba", "Undo — reject this hunk", function () {
        send("rejectHunk", { changeId: file.id, hunkId: hunk.id });
      }));
    } else if (hunk.decision === "rejected") {
      row.appendChild(el("span", "badge no", "\u2717 rejected"));
      row.appendChild(button("\u2713", "Undo — accept this hunk", function () {
        send("acceptHunk", { changeId: file.id, hunkId: hunk.id });
      }));
    } else {
      row.appendChild(button("\u2713", "Accept this hunk", function () {
        send("acceptHunk", { changeId: file.id, hunkId: hunk.id });
      }));
      row.appendChild(button("\u21ba", "Reject this hunk", function () {
        send("rejectHunk", { changeId: file.id, hunkId: hunk.id });
      }));
    }
    row.addEventListener("click", function () {
      send("openHunk", { changeId: file.id, hunkId: hunk.id });
    });
    return row;
  }

  function renderFile(file) {
    const wrap = el("div", "file");
    const head = el("div", "file-head");
    const open = expanded.has(file.id);
    const twisty = el("span", "twisty", open ? "\u25be" : "\u25b8");
    twisty.addEventListener("click", function (e) {
      e.stopPropagation();
      if (expanded.has(file.id)) expanded.delete(file.id);
      else expanded.add(file.id);
      render(state);
    });
    head.appendChild(twisty);
    head.appendChild(el("span", "name", file.name));
    if (file.dir) head.appendChild(el("span", "dir", file.dir));
    if (file.isNew) head.appendChild(el("span", "badge ok", "new"));
    if (file.isDeleted) head.appendChild(el("span", "badge no", "deleted"));
    if (file.binary) head.appendChild(el("span", "badge", "binary"));
    head.appendChild(el("span", "spacer"));
    head.appendChild(el("span", "stat", "+" + file.added + " \u2212" + file.removed));
    head.appendChild(button("\u2713", "Accept every hunk in this file", function () {
      send("acceptFile", { changeId: file.id });
    }));
    head.appendChild(button("\u21ba", "Reject every hunk in this file", function () {
      send("rejectFile", { changeId: file.id });
    }));
    head.addEventListener("click", function () {
      send("openDiff", { changeId: file.id });
    });
    wrap.appendChild(head);
    if (open) {
      for (const hunk of file.hunks) wrap.appendChild(renderHunk(file, hunk));
    }
    return wrap;
  }

  function render(next) {
    state = next;
    root.textContent = "";

    const header = el("div", "header");
    header.appendChild(el("span", "count", next.totalFiles + (next.totalFiles === 1 ? " file" : " files")));
    header.appendChild(el("span", "spacer"));
    header.appendChild(el("span", "stat add", "+" + next.added));
    header.appendChild(el("span", "stat del", "\u2212" + next.removed));
    root.appendChild(header);

    const actions = el("div", "actions");
    actions.appendChild(button("\u2713 Accept All", "Accept every change in every project", function () {
      send("acceptAll");
    }));
    actions.appendChild(button("\u21ba Discard All", "Reject every change in every project", function () {
      send("rejectAll");
    }));
    actions.appendChild(button("\u27f3", "Set a new checkpoint (accept the current state)", function () {
      send("setCheckpoint");
    }));
    root.appendChild(actions);

    if (next.totalFiles === 0) {
      const cp = next.checkpoint
        ? "Checkpoint: " + next.checkpoint.files + " files"
        : "No checkpoint set — changes are measured from now.";
      root.appendChild(el("div", "empty", "No changes to review. " + cp));
      return;
    }

    for (const group of next.groups) {
      if (next.groups.length > 1) root.appendChild(el("div", "group", group.label));
      for (const file of group.files) root.appendChild(renderFile(file));
    }
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") render(msg.state);
  });

  send("ready");
})();
```

- [ ] **Step 6: Write `src/review-panel.ts`**

```ts
/**
 * The sidebar panel: a hunkwise-style review list in the `review-hub` activity-bar
 * container, replacing the native tree in `src/changes-tree.ts`.
 *
 * The panel is a pure renderer. It receives a serialisable `PanelState` and posts
 * commands back; every command is forwarded to `PanelActions`, which the extension wires
 * to the same `ChangeStore` calls the commands already use. Inbound messages use
 * `type`, outbound use `command` — hunkwise's convention.
 */
import * as vscode from "vscode";
import { buildPanelState, type PanelSource } from "./review-panel-state";
import { webviewHtml } from "./webview-html";

export interface PanelActions {
  acceptHunk(changeId: string, hunkId: string): void;
  rejectHunk(changeId: string, hunkId: string): void;
  acceptFile(changeId: string): void;
  rejectFile(changeId: string): void;
  acceptAll(): void;
  rejectAll(): void;
  openHunk(changeId: string, hunkId: string): void;
  openDiff(changeId: string): void;
  setCheckpoint(): void;
}

interface PanelMessage {
  command?: string;
  changeId?: string;
  hunkId?: string;
}

export class ReviewPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "review-hub.changes";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: PanelSource,
    private readonly actions: PanelActions,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = webviewHtml(view.webview, this.extensionUri, {
      html: "panel.html",
      css: "panel.css",
      js: "panel.js",
    });
    view.webview.onDidReceiveMessage((msg: PanelMessage) => this.onMessage(msg));
    this.refresh();
  }

  /** Re-render with the current state. A no-op before the view is resolved. */
  refresh(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    void view.webview.postMessage({ type: "update", state: buildPanelState(this.source) });
  }

  private onMessage(msg: PanelMessage | null | undefined): void {
    if (!msg || typeof msg !== "object" || typeof msg.command !== "string") {
      return;
    }
    const changeId = typeof msg.changeId === "string" ? msg.changeId : "";
    const hunkId = typeof msg.hunkId === "string" ? msg.hunkId : "";
    switch (msg.command) {
      case "ready":
        this.refresh();
        return;
      case "acceptHunk":
        if (changeId && hunkId) this.actions.acceptHunk(changeId, hunkId);
        return;
      case "rejectHunk":
        if (changeId && hunkId) this.actions.rejectHunk(changeId, hunkId);
        return;
      case "acceptFile":
        if (changeId) this.actions.acceptFile(changeId);
        return;
      case "rejectFile":
        if (changeId) this.actions.rejectFile(changeId);
        return;
      case "acceptAll":
        this.actions.acceptAll();
        return;
      case "rejectAll":
        this.actions.rejectAll();
        return;
      case "openHunk":
        if (changeId) this.actions.openHunk(changeId, hunkId);
        return;
      case "openDiff":
        if (changeId) this.actions.openDiff(changeId);
        return;
      case "setCheckpoint":
        this.actions.setCheckpoint();
        return;
      default:
        return;
    }
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 179`, `# fail 0` (175 + 4 new panel tests).

---

### Task 12: Review tab webview

**Files:**
- Create: `src/review-tab.ts`
- Create: `media/review.html`, `media/review.css`, `media/review.js`
- Create: `test/review-tab.test.ts`

**Interfaces:**
- Consumes: `buildReviewState`, `ReviewState` from `src/review-panel-state.ts`; `webviewHtml` from `src/webview-html.ts`; `ChangeSet` from `src/types.ts`.
- Produces:
  - `export interface TabSource { change(changeId: string): ChangeSet | undefined }`
  - `export interface TabActions { acceptHunk(changeId: string, hunkId: string): void; rejectHunk(changeId: string, hunkId: string): void; acceptFile(changeId: string): void; rejectFile(changeId: string): void }`
  - `export class ReviewTab { static readonly viewType = "review-hub.review"; constructor(extensionUri: vscode.Uri, source: TabSource, actions: TabActions); open(changeId: string): void; refresh(changeId: string): void; refreshAll(): void; close(changeId: string): void; dispose(): void }`

- [ ] **Step 1: Write the failing test**

Create `test/review-tab.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "./vscode-stub";
import { ChangeStore } from "../src/change-store";
import { ReviewTab, type TabActions } from "../src/review-tab";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-tab-"));
}

interface FakePanel {
  title: string;
  webview: { html: string; __receive(msg: unknown): void };
  posted: unknown[];
}

function setup() {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
  const store = new ChangeStore({ baseDir: tmp(), backend: "json" });
  const cs = store.propose(ws, "a.txt", "one\nTWO\n");
  const calls: string[] = [];
  const actions: TabActions = {
    acceptHunk: (c, h) => calls.push(`acceptHunk:${c}:${h}`),
    rejectHunk: (c, h) => calls.push(`rejectHunk:${c}:${h}`),
    acceptFile: (c) => calls.push(`acceptFile:${c}`),
    rejectFile: (c) => calls.push(`rejectFile:${c}`),
  };
  const tab = new ReviewTab(vscode.Uri.file(process.cwd()), { change: (id) => store.findById(id) }, actions);
  return { tab, store, cs, calls, ws };
}

function panels(): FakePanel[] {
  return (vscode as unknown as { __panels: FakePanel[] }).__panels;
}

test("open creates one panel with the review assets and a nonce CSP", () => {
  const { tab, cs } = setup();
  const before = panels().length;
  tab.open(cs.id);
  assert.equal(panels().length, before + 1, "exactly one panel was created");
  const panel = panels()[panels().length - 1];
  assert.match(panel.webview.html, /Content-Security-Policy/);
  assert.match(panel.webview.html, /nonce-/);
  assert.match(panel.webview.html, /review\.js/);
  assert.match(panel.webview.html, /review\.css/);
  assert.match(panel.title, /a\.txt/);
});

test("open twice reuses the existing panel instead of opening a second tab", () => {
  const { tab, cs } = setup();
  tab.open(cs.id);
  const after = panels().length;
  tab.open(cs.id);
  assert.equal(panels().length, after, "no second panel");
});

test("the first post carries the rendered review state", () => {
  const { tab, cs } = setup();
  tab.open(cs.id);
  const panel = panels()[panels().length - 1];
  const update = panel.posted.find((m) => (m as { type?: string }).type === "update") as
    | { state: { lines: { kind: string; text: string }[]; hunks: unknown[] } }
    | undefined;
  assert.ok(update, "an update message was posted");
  assert.deepEqual(update!.state.lines.map((l) => l.kind), ["context", "deleted", "added", "context"]);
  assert.equal(update!.state.hunks.length, 1);
});

test("webview commands are routed to the tab actions", () => {
  const { tab, cs, calls } = setup();
  tab.open(cs.id);
  const panel = panels()[panels().length - 1];
  panel.webview.__receive({ command: "acceptHunk", changeId: cs.id, hunkId: cs.hunks[0].id });
  panel.webview.__receive({ command: "rejectFile", changeId: cs.id });
  assert.deepEqual(calls, [`acceptHunk:${cs.id}:${cs.hunks[0].id}`, `rejectFile:${cs.id}`]);
});

test("refresh re-posts the state and updates the title with the progress", () => {
  const { tab, store, cs } = setup();
  tab.open(cs.id);
  const panel = panels()[panels().length - 1];
  store.accept(cs.id, [cs.hunks[0].id]);
  tab.refresh(cs.id);
  const updates = panel.posted.filter((m) => (m as { type?: string }).type === "update");
  assert.ok(updates.length >= 2, "a second update was posted");
  assert.match(panel.title, /✓/, "a fully decided file is ticked");
});

test("opening an unknown change shows a warning and creates no panel", () => {
  const { tab } = setup();
  const before = panels().length;
  tab.open("deadbeef");
  assert.equal(panels().length, before);
  const messages = (vscode as unknown as { __messages: string[] }).__messages;
  assert.ok(messages.some((m) => m.includes("no longer exists")));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: build fails — *Could not resolve "../src/review-tab"*.

- [ ] **Step 3: Write `media/review.html`, `media/review.css`, `media/review.js`**

`media/review.html`:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src ${cspSource} data:;"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Review Hub</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>
```

`media/review.css`:

```css
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 13px);
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
}
.bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
}
.hunkbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
}
.spacer {
  flex: 1;
}
.stat {
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}
.btn {
  background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 3px;
  padding: 1px 6px;
  cursor: pointer;
  font: inherit;
  line-height: 1.6;
}
.btn:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.3));
}
.line {
  display: flex;
  white-space: pre;
}
.line .gutter {
  flex: none;
  width: 56px;
  padding-right: 10px;
  text-align: right;
  opacity: 0.45;
  user-select: none;
}
.line .text {
  flex: 1;
  padding-right: 12px;
}
.line.deleted {
  background: var(--vscode-diffEditor-removedLineBackground, rgba(248, 81, 73, 0.15));
}
.line.added {
  background: var(--vscode-diffEditor-insertedLineBackground, rgba(63, 185, 80, 0.15));
}
.line.deleted .text,
.line.deleted .gutter {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
}
.line.added .text,
.line.added .gutter {
  color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
}
```

`media/review.js`:

```js
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let state = null;

  function send(command, payload) {
    vscode.postMessage(Object.assign({ command: command }, payload || {}));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, title, onClick) {
    const b = el("button", "btn", label);
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  function renderBar(s) {
    const bar = el("div", "bar");
    bar.appendChild(el("span", "name", s.name + (s.dir ? "  " + s.dir : "")));
    bar.appendChild(el("span", "stat", "+" + s.added + " \u2212" + s.removed));
    if (s.status === "resolved") bar.appendChild(el("span", "stat", "resolved"));
    bar.appendChild(el("span", "spacer"));
    bar.appendChild(button("\u2713 Accept All", "Accept every hunk", function () {
      send("acceptFile", { changeId: s.changeId });
    }));
    bar.appendChild(button("\u21ba Discard All", "Reject every hunk", function () {
      send("rejectFile", { changeId: s.changeId });
    }));
    return bar;
  }

  function renderHunkBar(s, hunk) {
    const bar = el("div", "hunkbar");
    bar.appendChild(el("span", "stat", "+" + hunk.added + " \u2212" + hunk.removed + " \u00b7 " + hunk.decision));
    bar.appendChild(el("span", "spacer"));
    if (hunk.decision === "accepted") {
      bar.appendChild(button("\u2713 Accepted", "Undo — reject this hunk", function () {
        send("rejectHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    } else if (hunk.decision === "rejected") {
      bar.appendChild(button("\u2717 Rejected", "Undo — accept this hunk", function () {
        send("acceptHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    } else {
      bar.appendChild(button("\u2713 Accept", "Keep this hunk's new lines", function () {
        send("acceptHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
      bar.appendChild(button("\u21ba Reject", "Restore this hunk's baseline lines", function () {
        send("rejectHunk", { changeId: s.changeId, hunkId: hunk.id });
      }));
    }
    return bar;
  }

  function render(next) {
    state = next;
    root.textContent = "";
    root.appendChild(renderBar(next));
    if (next.binary) {
      root.appendChild(el("div", "line", "(binary file — accept or reject the whole file from the Review Hub panel)"));
      return;
    }
    const byLine = new Map();
    for (const hunk of next.hunks) byLine.set(hunk.line, hunk);
    for (let i = 0; i < next.lines.length; i++) {
      const hunk = byLine.get(i);
      if (hunk) root.appendChild(renderHunkBar(next, hunk));
      const line = next.lines[i];
      const row = el("div", "line " + line.kind);
      row.appendChild(el("span", "gutter", String(i + 1)));
      row.appendChild(el("span", "text", line.text === "" ? " " : line.text));
      root.appendChild(row);
    }
  }

  window.addEventListener("message", function (event) {
    const msg = event.data;
    if (msg && msg.type === "update") render(msg.state);
  });

  send("ready");
})();
```

- [ ] **Step 4: Write `src/review-tab.ts`**

```ts
/**
 * The review tab: the primary surface for a change. One webview panel per change, opened
 * from the sidebar panel, a file's badge, or `review-hub.openDiff`.
 *
 * This is where the multi-line red/green diff actually happens. A `TextEditorDecorationType`
 * cannot colour a line that is not on disk, and injected text must be a single line, so a
 * real red block of deleted lines is impossible in the editor buffer with stable APIs
 * (spec §2.1). A webview has no such limit.
 *
 * The line list comes from `buildReviewState`, which reuses the pure `buildMergedView`, so
 * no diff logic is duplicated in JavaScript.
 */
import * as vscode from "vscode";
import { buildReviewState } from "./review-panel-state";
import { webviewHtml } from "./webview-html";
import type { ChangeSet } from "./types";

export interface TabSource {
  change(changeId: string): ChangeSet | undefined;
}

export interface TabActions {
  acceptHunk(changeId: string, hunkId: string): void;
  rejectHunk(changeId: string, hunkId: string): void;
  acceptFile(changeId: string): void;
  rejectFile(changeId: string): void;
}

interface TabMessage {
  command?: string;
  changeId?: string;
  hunkId?: string;
}

export class ReviewTab implements vscode.Disposable {
  static readonly viewType = "review-hub.review";
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: TabSource,
    private readonly actions: TabActions,
  ) {}

  /** Open (or reveal) the review tab for a change. */
  open(changeId: string): void {
    const existing = this.panels.get(changeId);
    if (existing) {
      existing.reveal();
      this.refresh(changeId);
      return;
    }
    const cs = this.source.change(changeId);
    if (!cs) {
      void vscode.window.showWarningMessage(`Review Hub: change ${changeId} no longer exists.`);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ReviewTab.viewType,
      titleFor(cs),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      },
    );
    panel.webview.html = webviewHtml(panel.webview, this.extensionUri, {
      html: "review.html",
      css: "review.css",
      js: "review.js",
    });
    panel.webview.onDidReceiveMessage((msg: TabMessage) => this.onMessage(msg));
    panel.onDidDispose(() => this.panels.delete(changeId));
    this.panels.set(changeId, panel);
    this.refresh(changeId);
  }

  /** Re-post the state after a decision, and refresh the title with the new progress. */
  refresh(changeId: string): void {
    const panel = this.panels.get(changeId);
    if (!panel) {
      return;
    }
    const cs = this.source.change(changeId);
    if (!cs) {
      return;
    }
    panel.title = titleFor(cs);
    void panel.webview.postMessage({ type: "update", state: buildReviewState(cs) });
  }

  refreshAll(): void {
    for (const changeId of [...this.panels.keys()]) {
      this.refresh(changeId);
    }
  }

  close(changeId: string): void {
    const panel = this.panels.get(changeId);
    if (panel) {
      this.panels.delete(changeId);
      panel.dispose();
    }
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  private onMessage(msg: TabMessage | null | undefined): void {
    if (!msg || typeof msg !== "object" || typeof msg.command !== "string") {
      return;
    }
    const changeId = typeof msg.changeId === "string" ? msg.changeId : "";
    const hunkId = typeof msg.hunkId === "string" ? msg.hunkId : "";
    if (!changeId) {
      return;
    }
    switch (msg.command) {
      case "acceptHunk":
        if (hunkId) this.actions.acceptHunk(changeId, hunkId);
        return;
      case "rejectHunk":
        if (hunkId) this.actions.rejectHunk(changeId, hunkId);
        return;
      case "acceptFile":
        this.actions.acceptFile(changeId);
        return;
      case "rejectFile":
        this.actions.rejectFile(changeId);
        return;
      default:
        return;
    }
  }
}

/** `name (accepted/total)`, or `name ✓` once nothing is pending. */
function titleFor(cs: ChangeSet): string {
  const name = cs.path.split("/").pop() ?? cs.path;
  if (cs.hunks.length === 0) {
    return name;
  }
  const pending = cs.hunks.filter((h) => h.decision === "pending").length;
  if (pending === 0) {
    return `${name} ✓`;
  }
  const accepted = cs.hunks.filter((h) => h.decision === "accepted").length;
  return `${name} (${accepted}/${cs.hunks.length})`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 185`, `# fail 0` (179 + 6 new tab tests).

---

### Task 13: Wire the webviews into the extension

**Files:**
- Modify: `src/types.ts` (add `FileNode`)
- Modify: `src/extension.ts` (replace the tree with the panel; add the review tab; re-point command arguments)
- Delete: `src/changes-tree.ts`
- Modify: `test/extension.test.ts` (add `extensionUri` to the fake context)
- Modify: `test/extension.test.ts` (assert the panel and tab surfaces)

**Interfaces:**
- Consumes: `ReviewPanelProvider`, `PanelActions` from `src/review-panel.ts`; `ReviewTab`, `TabSource`, `TabActions` from `src/review-tab.ts`; `PanelSource` from `src/review-panel-state.ts`; `buildReviewState` (not directly — the tab uses it).
- Produces: `export interface FileNode { workspace: string; path: string }` in `src/types.ts`.

- [ ] **Step 1: Add the plain `FileNode` to `src/types.ts`**

Append to `src/types.ts`:

```ts
/**
 * A changed file, as passed across the webview boundary and between commands.
 *
 * A plain serialisable shape, not a class: webview commands cannot pass class instances
 * over the message boundary, and the tree's `FileNode` carried a whole `ChangeSummary`.
 */
export interface FileNode {
  workspace: string;
  path: string;
}
```

- [ ] **Step 2: Update the extension test first**

In `test/extension.test.ts`, add `extensionUri` to the fake context:

```ts
  const context = {
    subscriptions: [] as { dispose(): void }[],
    extension: { packageJSON: { version: "0.1.0" } },
    extensionUri: vscode.Uri.file(process.cwd()),
    asAbsolutePath: (p: string) => path.join(process.cwd(), p),
    globalState: { get: () => undefined, update: async () => {} },
  };
```

`vscode` must be in scope — the file already does `const vscode = require("./vscode-stub")`. Change that line to also expose the registries:

```ts
const vscode = require("./vscode-stub") as {
  __commands: Map<string, unknown[]>;
  __webviews: Map<string, unknown>;
  Uri: { file(p: string): unknown };
};
```

Then, after the `hub.json` assertion, add:

```ts
  assert.ok(vscode.__webviews.has("review-hub.changes"), "the sidebar panel view is registered");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: `test/extension.test.ts` fails — *the sidebar panel view is registered* (the extension still creates a tree view).

- [ ] **Step 4: Rewire `src/extension.ts`**

Replace the imports:

```ts
import { HunkCodeLensProvider, DiffView } from "./diff-view";
import { ReviewPanelProvider, type PanelActions } from "./review-panel";
import { ReviewTab } from "./review-tab";
import type { PanelSource } from "./review-panel-state";
```

Delete `import { ChangesTreeProvider, type ChangesModel, type FileNode, type TreeNode } from "./changes-tree";` and add `FileNode` to the `./types` import:

```ts
import { HUB_PROTOCOL, type ChangeSummary, type CheckpointInfo, type FileNode } from "./types";
```

Replace the model + tree block:

```ts
  const model: ChangesModel = {
    checkpoint: (ws) => hub.store.checkpointInfo(ws),
    summaries: (ws) => hub.store.listChanges(ws),
    // Only this window's own folders. The store is shared across windows, but a window
    // must show only the project the user has open here — not changes from other windows.
    workspaces: () => workspaceFolders(),
  };
  const tree = new ChangesTreeProvider(model);
  const treeView = vscode.window.createTreeView("review-hub.changes", { treeDataProvider: tree });
```

with:

```ts
  // Only this window's own folders. The store is shared across windows, but a window must
  // show only the project the user has open here — not changes from other windows.
  const source: PanelSource = {
    workspaces: () => workspaceFolders(),
    checkpoint: (ws) => hub.store.checkpointInfo(ws),
    changeSets: (ws) => hub.store.listChangeSets(ws),
  };

  // Declared before the panel/tab so their action closures can call them; assigned below.
  let decide: (changeId: string, hunkIds: string[] | undefined, kind: "accept" | "reject") => Promise<void>;
  let decideFileById: (changeId: string, kind: "accept" | "reject") => Promise<void>;
  let decideMany: (workspaces: string[], kind: "accept" | "reject") => Promise<void>;
  let openReviewTab: (changeId: string) => void;

  const panelActions: PanelActions = {
    acceptHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "accept"),
    rejectHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "reject"),
    acceptFile: (changeId) => void decideFileById(changeId, "accept"),
    rejectFile: (changeId) => void decideFileById(changeId, "reject"),
    acceptAll: () => void decideMany(workspaceFolders(), "accept"),
    rejectAll: () => void decideMany(workspaceFolders(), "reject"),
    openHunk: (changeId) => openReviewTab(changeId),
    openDiff: (changeId) => openReviewTab(changeId),
    setCheckpoint: () => void vscode.commands.executeCommand("review-hub.setCheckpoint"),
  };
  const panel = new ReviewPanelProvider(context.extensionUri, source, panelActions);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ReviewPanelProvider.viewType, panel),
  );

  const tab = new ReviewTab(
    context.extensionUri,
    { change: (changeId) => hub.store.findById(changeId) },
    {
      acceptHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "accept"),
      rejectHunk: (changeId, hunkId) => void decide(changeId, [hunkId], "reject"),
      acceptFile: (changeId) => void decideFileById(changeId, "accept"),
      rejectFile: (changeId) => void decideFileById(changeId, "reject"),
    },
  );
  openReviewTab = (changeId) => tab.open(changeId);
```

Replace `refreshUi`:

```ts
  function refreshUi(): void {
    panel.refresh();
    tab.refreshAll();
    decorator.refreshAll();
    fileDecorations.refresh();
    updateStatus();
  }
```

Delete the `const diffView = new DiffView(...)` line and everything that referenced it. In its place, keep a provider + CodeLens (both still needed) and nothing else:

```ts
  const diffView = new DiffView(hub.store, provider, codeLens, () => {
    refreshUi();
  });
```

`DiffView` now only serves `openSideBySide`, so it is still constructed but never `open`ed.

Replace every `model.workspaces()` with `source.workspaces()` — four call sites today, at `src/extension.ts:276` (the 2 s poll), `:349` (`updateStatus`), and `:513`/`:516` (the `acceptAll` / `rejectAll` commands). Then delete the `model` object entirely; `source` replaces it.

Replace `resolveChange` with a workspace+path based resolver:

```ts
  /**
   * Turn a command argument into a change id. Accepts an id, a plain `{ workspace, path }`
   * node (from a webview command or a menu), or a `Uri` from the Explorer.
   */
  const resolveChange = async (arg: FileNode | vscode.Uri | string | undefined): Promise<string | undefined> => {
    if (typeof arg === "string") {
      return arg;
    }
    if (arg && typeof arg === "object" && "fsPath" in arg) {
      for (const ws of workspaceFolders()) {
        const root = ws.replace(/[\\/]+$/, "");
        const fsPath = (arg as vscode.Uri).fsPath;
        if (!fsPath.startsWith(root + "/") && !fsPath.startsWith(root + "\\")) {
          continue;
        }
        const rel = fsPath.slice(root.length + 1).split("\\").join("/");
        const cs = hub.store.findChangeByPath(root, rel);
        if (cs) {
          return cs.id;
        }
      }
      return undefined;
    }
    if (arg && typeof arg === "object" && "path" in arg && "workspace" in arg) {
      return hub.store.findChangeByPath(arg.workspace, arg.path)?.id;
    }
    // Fall back to the active diff tab.
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { modified?: vscode.Uri } | undefined;
        if (input?.modified?.scheme === "review-hub") {
          return input.modified.path.replace(/^\//, "");
        }
      }
    }
    return undefined;
  };
```

Re-point the commands:

```ts
    vscode.commands.registerCommand("review-hub.openDiff", async (arg?: FileNode | vscode.Uri | string) => {
      const changeId = await resolveChange(arg);
      if (changeId) {
        tab.open(changeId);
      }
    }),
```

`review-hub.openSideBySide` and `review-hub.openFile` are unchanged apart from the `FileNode` type.

Replace `decideFile`:

```ts
  async function decideFileById(changeId: string, kind: "accept" | "reject") {
    await decide(changeId, undefined, kind);
  }

  async function decideFile(arg: FileNode | undefined, kind: "accept" | "reject") {
    const changeId = await resolveChange(arg);
    if (changeId) {
      await decideFileById(changeId, kind);
    }
  }
```

Replace `decideMany`'s signature use: keep the existing body but change the signature to `async function decideMany(workspaces: string[], kind: "accept" | "reject"): Promise<void>` and replace `hub.store.listChanges(ws)` with `hub.store.listChangeSets(ws)`.

Inside `decide`, after `await diffView.refresh(changeId)`, add the tab refresh and drop the tree refresh (it is inside `refreshUi`):

```ts
      await diffView.refresh(changeId);
      tab.refresh(changeId);
      refreshUi();
```

Replace the `treeView` entry in the big `context.subscriptions.push(...)` with `tab`:

```ts
  context.subscriptions.push(
    status,
    provider,
    watcher,
    diffView,
    tab,
    fileDecorations,
    ...
```

Leave `decorator` and `decorator.start()` exactly as they are. `DiffView.refresh` no longer calls `decorator.refreshAll()` (Task 10 Step 4 removed it) because its `onDidChange` callback is `refreshUi`, which now calls `decorator.refreshAll()` itself — so the decorations are still refreshed on every decision, exactly once.

- [ ] **Step 5: Delete `src/changes-tree.ts`**

Run: `rm src/changes-tree.ts`

Then confirm nothing imports it:

Run: `grep -rn "changes-tree" src/ mcp/ test/ || echo "no references"`

Expected: `no references`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; `# pass 185`, `# fail 0`. `test/extension.test.ts` now asserts `review-hub.changes` is a webview view.

- [ ] **Step 7: Verify the bundle builds and ships the media**

Run: `npm run build && ls dist/ media/`
Expected: `dist/extension.js`, `dist/mcp-server.cjs`, and `media/` containing `panel.html`, `panel.css`, `panel.js`, `review.html`, `review.css`, `review.js`, `review-hub.svg`.

---

### Task 14: Documentation

**Files:**
- Modify: `README.md` (write model, UI, `engines`, test count)
- Modify: `docs/superpowers/specs/2026-10-07-hunkwise-ui-and-sqlite-store-design.md` (stale "118" → "120", mark the open question resolved)
- Modify: `src/extension.ts` (`installInstructions` wording)

**Interfaces:**
- Consumes: nothing new.
- Produces: an `AGENTS.md` / `CLAUDE.md` block that tells agents the on-disk file lags until the user decides.

- [ ] **Step 1: Fix the stale test count and the resolved open question in the spec**

In `docs/superpowers/specs/2026-10-07-hunkwise-ui-and-sqlite-store-design.md`:

- Line ~375: `The 118 existing tests are the safety net for this refactor.` → `The 120 existing tests are the safety net for this refactor.`
- Line ~401: `**Existing 118 tests** must stay green.` → `**Existing 120 tests** must stay green.`
- §9 "Open question for the user" → retitle to `## 9. Resolved: the engines bump` and append: `Resolved 2026-10-07: the user accepted `engines.vscode = "^1.103.0"`. SQLite is the default backend, with the JSON backend as the fallback when `node:sqlite` is missing.`
- Change the `Status:` line at the top from `awaiting user review` to `approved; implemented`.

- [ ] **Step 2: Fix the README test count**

In `README.md`, the "Phát triển" section's comment:

```bash
npm test            # 185 test: hunk diff, store, backend, sqlite, hub, panel, tab, MCP, e2e
```

(120 before this work, 185 after — the plan's per-task checkpoints add 65.)

- [ ] **Step 3: Document the review-then-apply model in the README**

Replace the section that describes the apply behaviour with this text (keep the surrounding heading numbering intact):

```markdown
## Cách hoạt động: xem trước rồi mới ghi

Review Hub **không ghi gì lên đĩa khi agent đề xuất thay đổi**. Agent gọi `propose_edit` /
`propose_write`, thay đổi được lưu lại kèm diff, và **chỉ những hunk bạn bấm ✓ mới được ghi
lên đĩa**. Hunk chưa quyết định không tồn tại trên đĩa; hunk bị ↺ giữ nguyên nội dung gốc.

| Hành động | Trên đĩa sau đó |
|---|---|
| Agent đề xuất (`propose_edit`) | **không đổi** — vẫn là bản gốc |
| Bạn bấm ✓ một hunk | đúng các dòng mới của hunk đó |
| Bạn bấm ↺ một hunk | không ghi gì (giữ dòng gốc) |
| Hunk chưa quyết định | không có trên đĩa |

Hệ quả: nếu agent tự đọc file bằng công cụ riêng của nó, nó sẽ thấy **nội dung cũ**. Đó là
đúng thiết kế, không phải lỗi. Agent nên đọc qua công cụ `read_file` của Review Hub để thấy
bản đã đề xuất.

## Hai bề mặt giao diện

- **Panel ở sidebar** (biểu tượng Review Hub trên thanh hoạt động): danh sách file kèm
  `+thêm −bớt`, mở ra xem từng hunk `@line N`, mỗi hunk có ✓ / ↺, kèm nút cấp file và cấp
  toàn bộ. Kiểu bố cục của [hunkwise](https://github.com/molon/hunkwise).
- **Tab review**: cửa sổ diff đầy đủ — dòng bị xoá hiển thị **nền đỏ**, dòng thêm vào hiển
  thị **nền xanh**, mỗi hunk có thanh quyết định riêng. Đây là nơi duy nhất hiển thị được
  khối đỏ nhiều dòng: API ổn định của VS Code không cho phép vẽ nhiều dòng chèn vào buffer
  thật (xem `docs/superpowers/specs/2026-10-07-hunkwise-ui-and-sqlite-store-design.md` §2.1).
```

- [ ] **Step 4: Document the `engines` requirement and the store in the README**

Add to the "Yêu cầu" / requirements area:

```markdown
## Yêu cầu

- **VS Code 1.103.0 trở lên.** Bản 1.85–1.102 dùng Electron cũ thiếu binding `node:sqlite`
  (lỗi đã được sửa ở Electron 37.2.3). Nếu không có SQLite, extension tự động chuyển sang
  kho JSON trong `~/.review-hub/workspaces/` — không hỏng, chỉ chậm hơn.
- Node 22.13+ trong extension host (đi kèm VS Code 1.103+).

## Lưu trữ

Một database nhỏ tại `~/.review-hub/hub.db` (bảng `checkpoints`, `changes`, `hunks`) giữ
trạng thái review. Nội dung baseline được lưu theo hash trong
`~/.review-hub/workspaces/<hash>/baselines/` để database không phình to.
```

- [ ] **Step 5: Strengthen the agent instructions block**

In `src/extension.ts`, find the `installInstructions` body and add these two lines to the block it writes between `<!-- review-hub:start -->` and `<!-- review-hub:end -->`:

```markdown
- Review Hub **does not write your edit to disk until the user accepts it**. Reading the file
  with your own tools will show the OLD content — that is expected, not a failed edit.
- Use the `read_file` tool (not `cat`/Read) to see the content you have staged so far.
```

- [ ] **Step 6: Verify the docs render and nothing else broke**

Run: `npm run typecheck && npm test && grep -n "118" README.md docs/superpowers/specs/2026-10-07-hunkwise-ui-and-sqlite-store-design.md || echo "no stale 118"`
Expected: typecheck clean; `# pass 185`, `# fail 0`; `no stale 118`.

---

## Self-Review

**Spec coverage.** §2.1 (no proposed APIs, no third-party libs) → Global Constraints + Task 4 (`node:sqlite` is a built-in) + Task 12 (the red/green diff lives in a webview). §2.2 (`engines` → `^1.103.0`) → Task 8. §2.3 (survive a missing `node:sqlite`) → Tasks 5-7 (`JsonBackend` fallback). §3.1/§3.2 (review-then-apply) → Task 1. §3.3 (`/file/read` returns staged content) → Task 2. §3.4 (agents that read natively) → Task 2 Step 4 + Task 14 Step 5. §4.1 (sidebar panel) → Task 11. §4.2 (review tab) → Task 12. §4.3 (removals: tree deleted, `merged-diff.ts` kept, merged authority dropped, `openDiff` re-pointed, side-by-side kept) → Tasks 10 and 13. §4.4 (real-file decorations, red ghost) → Task 3. §5.1 (schema) → Task 6. §5.2 (`SqlDriver`, `openDatabase`, esbuild target) → Tasks 4 and 8. §5.3 (fallback) → Task 7. §5.4 (public API unchanged) → Task 7. §6 (files touched) → the File Structure table. §7 (testing) → every task. §8 (out of scope) → not implemented, by design. §9 (engines) → Task 8 + Task 14 Step 1. §10 (licensing) → Global Constraints.

**Placeholder scan.** No "TBD"/"TODO"/"implement later". Every code step shows the code. The one place a task says "keep the existing X" is `propose_edit`'s unchanged `status`/`changeId` fields, which the surrounding block shows in full.

**Type consistency.** `StoreBackend` method names (`readCheckpoint`, `writeCheckpoint`, `clearCheckpoint`, `knownWorkspaces`, `writeChange`, `getChange`, `listChangeSets`, `findById`, `findChangeByPath`, `removeChange`, `clearChanges`, `pruneResolved`, `putBaseline`, `getBaseline`, `dispose`) are identical in `JsonBackend`, `SqliteBackend`, and the `ChangeStore` delegations. `CheckpointRecord` replaces `CheckpointFile` everywhere (Task 7 Step 3.8). `PanelSource`/`PanelState`/`ReviewState` field names match between Task 9 (producer), Task 11/12 (consumers), and `media/panel.js`/`media/review.js` (`state.totalFiles`, `state.groups[].files[].hunks[].anchorLine`, `state.lines[].kind`, `state.hunks[].line`). `ReviewPanelProvider.viewType` is `"review-hub.changes"`, matching the existing `package.json` view id and the `view/title` menu gates. `FileNode` is `{ workspace, path }` in `types.ts` (Task 13) and is used only as such.

**Two deliberate departures from the spec, both narrower than the spec and justified inline:** (1) Task 7 keeps `ChangeStore`'s diffing/decision logic in place and moves only persistence behind the backend — the spec's "thin facade over a backend" is satisfied for storage, and keeping the logic avoids rewriting 120 passing tests for no behaviour change. (2) Task 1 adds an `observe()` guard the spec does not mention: without it the watcher would re-derive hunks from the partially-written disk and silently drop pending hunks. This is required for the spec's §3.1 model to be correct in practice.
