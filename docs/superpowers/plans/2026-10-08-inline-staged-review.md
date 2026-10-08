# Inline Staged Review (Antigravity model) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every agent edit **inside the real file** the way Antigravity does — old code as a red block, new code as a green block, per-block `$(check) Accept` / `$(chrome-close) Reject`, pending changes accumulating across chats, and an exit flush that leaves the agent's new code on disk with an empty cache.

**Architecture:** A new **staging layer** sits on top of the existing review-then-apply model and never changes it. Staging replaces the editor buffer with a *merged view* (old block above new block, built by the already-shipped `buildMergedView()`), while disk keeps exactly what it holds today; the buffer is a display only. Every decision still runs through `ChangeStore.accept/reject` (framing, baseline advance, watcher suppression are already correct there) and the buffer is **re-staged** afterwards. Four small pieces: a pure content model (`src/staged-content.ts`), a host-injected engine (`src/staged-review.ts`), two presentation branches (decorations + CodeLens) that render the merged view when a file is staged, and an exit flush (`src/exit-flush.ts`) wired into an async `deactivate()`.

**Tech Stack:** TypeScript, VS Code extension API (**stable only** — no proposed API), esbuild (CJS), `node:test` via `scripts/test.mjs`, the existing `diff` v9 and `node:sqlite`.

**Spec:** `docs/superpowers/specs/2026-10-08-inline-staged-review-design.md` (design D1–D9 approved in chat, refinements F1–F4 applied here)

## Global Constraints

- **No proposed APIs, no new dependencies.** Stable API surface only; `engines.vscode` stays `^1.103.0`; no entry may be added to `dependencies` or `devDependencies`. `vscode.window.createWebviewTextEditorInset` and comment threads stay excluded.
- **The write model does not change.** `propose()` writes nothing, `settle()` decides from the real decision, `applyToDisk()` writes exact bytes. The staged buffer is a **view**: it must never be written to disk while any hunk is pending (spec F1/F2).
- **Pure modules stay pure.** `src/merged-diff.ts`, `src/hunk-diff.ts`, `src/staged-content.ts`, `src/exit-flush.ts` must not import `vscode` or touch the filesystem (except `exit-flush`'s injected store, which is an interface).
- **One context key:** `reviewHub.hasStagedReview` (constant `STAGED_CONTEXT_KEY` in `src/staged-review.ts`). The `when` clause in `package.json` must use exactly that string.
- **Staging is skipped when `files.autoSave !== "off"`** (spec D5/F4), for binary changes, for changes with no hunks, and for changes with no pending hunk.
- **Existing behaviour is the fallback.** A file that is not staged keeps today's green + ghost-text decorations, disk-frame CodeLens anchors, `autoOpenDiff` review-tab opening, and `reloadOpenEditors()` after a decision.
- **Verification checkpoint:** every task ends with `npm run typecheck && npm test` → typecheck clean, **all** tests pass (0 fail, no `ExperimentalWarning`), **before** the commit.
- **Git:** one commit per task, message form `Task <N>: <short title>`. Never amend or rewrite earlier commits. The scratch directory `.repro/` stays untracked and must not be committed.
- **Webview protocol and CSP unchanged**; no `innerHTML`, no `eval`, no inline scripts.
- **Test count today: 207** across 31 files. The plan grows it to **244**; each task states its own expected count so a reviewer can check the arithmetic.

## Pre-flight (before Task 1)

The working tree carries work from the previous session that is **not** part of this plan and must be committed first so every task's diff is clean:

| File | What it is |
|---|---|
| `src/editor-sync.ts`, `test/editor-sync.test.ts` (new) | `reloadOpenEditors()` — revert clean editors after a decision (3 tests) |
| `src/extension.ts` | wires `reloadOpenEditors` into `decide()` / `decideMany()` |
| `README.md`, `.vscodeignore`, `package.json` | README rewrite + packaging excludes + version `0.1.1` |
| `src/file-decorations.ts`, `src/harness-paths.ts` | comment/formatting edits only |

```bash
npm run typecheck && npm test        # must be green (207/207) before committing
git add .vscodeignore ANTIGRAVITY_INLINE_DIFF_RESEARCH.md README.md package.json \
        src/extension.ts src/editor-sync.ts src/file-decorations.ts src/harness-paths.ts \
        test/editor-sync.test.ts
git commit -m "Reload open editors after a decision; refresh the README"
git status --short                   # only .repro/ remains untracked
```

- [ ] **Step 0:** run the commands above; if the suite is not 207/207, stop and report instead of committing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/staged-content.ts` | **new, pure** — may this change be staged, what text goes in the buffer, block→decoration ranges, count-lens title |
| `src/staged-review.ts` | **new, `vscode`-free** — the staging engine: stage / restage / unstage, lift-on-user-edit, save guard, adoption; every host capability injected through `StagedHost` |
| `src/exit-flush.ts` | **new, `vscode`-free** — `flushPendingReviews()` for the async `deactivate()` |
| `src/merged-diff.ts` | **modified** — `MergedBlock` gains `hunkId?` so a block can be traced back to its hunk |
| `src/change-decorator.ts` | **modified** — staged branch: red `deleted` block, green `added` block, no ghost text; constructor takes an `isStaged` predicate |
| `src/diff-view.ts` | **modified** — staged CodeLens branch anchored at `MergedHunk.anchor` + count lens with the old code in its tooltip; constructor takes an `isStaged` predicate |
| `src/extension.ts` | **modified** — builds the `StagedHost`, drives the stage triggers, re-stages after every decision, suppresses auto-open for staged files, notice UI, async `deactivate()` |
| `package.json` | **modified** — two commands with icons, `editor/title` menu behind `reviewHub.hasStagedReview`, version `0.2.0`, stale `autoOpenDiff` description |
| `README.md` | **modified** — new section 12 describing the inline review, the auto-save guard and the exit rule |
| `test/vscode-stub.ts` | **modified** — `MarkdownString`, injectable `visibleTextEditors`, decoration-type options, workspace event recording |
| `test/staged-content.test.ts`, `test/staged-review.test.ts`, `test/staged-decorator.test.ts`, `test/staged-codelens.test.ts`, `test/exit-flush.test.ts` | **new** |

---

### Task 1: Pure staged-content model

**Files:**
- Create: `src/staged-content.ts`
- Modify: `src/merged-diff.ts:19-25` (interface), `src/merged-diff.ts:53-56` (push), `src/merged-diff.ts:68-75` (hunk pushes)
- Test: `test/staged-content.test.ts` (new), `test/merged-diff.test.ts` (one added test)

**Interfaces:**
- Consumes: `buildMergedView(baselineLines, hunks): MergedView` from `src/merged-diff.ts`, `splitContent(text)` / `joinContent(lines, meta)` from `src/hunk-diff.ts`, `ChangeSet` / `Hunk` from `src/types.ts`.
- Produces (everything later tasks import):
  - `type StageSkipReason = "binary" | "no-hunks" | "already-decided" | "auto-save"`
  - `stageSkipReason(cs: ChangeSet, autoSave: string): StageSkipReason | undefined`
  - `buildStagedView(cs: ChangeSet): MergedView | undefined`
  - `buildStagedText(cs: ChangeSet): string | undefined`
  - `pendingCount(cs: ChangeSet): number`
  - `stagedCountTitle(removed: number, added: number): string`
  - `type StagedMark = { start: number; end: number; hunkId: string }`, `type StagedMarks = { added: StagedMark[]; removed: StagedMark[] }`
  - `stagedMarks(view: MergedView, docLineCount: number): StagedMarks`
  - `MergedBlock.hunkId?: string`

- [ ] **Step 1: Write the failing tests**

Create `test/staged-content.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildStagedText,
  buildStagedView,
  pendingCount,
  stageSkipReason,
  stagedCountTitle,
  stagedMarks,
} from "../src/staged-content";
import type { ChangeSet, Hunk } from "../src/types";

const BASELINE = "one\ntwo\nthree\n";
const PROPOSED = "one\nTWO\nthree\n";

function hunk(overrides: Partial<Hunk> = {}): Hunk {
  return {
    id: "h1",
    oldStart: 1,
    oldLines: ["two"],
    newStart: 1,
    newLines: ["TWO"],
    decision: "pending",
    ...overrides,
  };
}

function makeChange(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "a.txt",
    absPath: "/ws/a.txt",
    origin: "fs",
    applied: true,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: BASELINE,
    proposed: PROPOSED,
    baselineExists: true,
    proposedExists: true,
    hunks: [hunk()],
    status: "applied",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("a pending change is stageable when auto-save is off", () => {
  assert.equal(stageSkipReason(makeChange(), "off"), undefined);
});

test("binary, hunk-less, fully decided and auto-save changes are refused", () => {
  assert.equal(stageSkipReason(makeChange({ binary: true }), "off"), "binary");
  assert.equal(stageSkipReason(makeChange({ hunks: [] }), "off"), "no-hunks");
  assert.equal(
    stageSkipReason(makeChange({ hunks: [hunk({ decision: "accepted" })] }), "off"),
    "already-decided",
  );
  assert.equal(stageSkipReason(makeChange(), "afterDelay"), "auto-save");
});

test("the staged text puts the old code directly above the new code", () => {
  assert.equal(buildStagedText(makeChange()), "one\ntwo\nTWO\nthree\n");
});

test("an accepted hunk shows only the new code, a rejected one only the old", () => {
  assert.equal(buildStagedText(makeChange({ hunks: [hunk({ decision: "accepted" })] })), PROPOSED);
  assert.equal(buildStagedText(makeChange({ hunks: [hunk({ decision: "rejected" })] })), BASELINE);
});

test("the fully accepted staged text is byte-identical to the proposed file", () => {
  // The invariant that lets Task 2's `restage()` hand the buffer back to disk: once no hunk
  // is pending, the view IS the resolved file, so unstage + revert cannot lose anything.
  const cs = makeChange({ hunks: [hunk({ decision: "accepted" })] });
  assert.equal(buildStagedText(cs), cs.proposed);
});

test("a CRLF file keeps its line endings in the staged text", () => {
  const cs = makeChange({ baseline: "one\r\ntwo\r\nthree\r\n", eol: "\r\n" });
  assert.equal(buildStagedText(cs), "one\r\ntwo\r\nTWO\r\nthree\r\n");
});

test("binary and hunk-less changes have no staged view", () => {
  assert.equal(buildStagedView(makeChange({ binary: true })), undefined);
  assert.equal(buildStagedText(makeChange({ hunks: [] })), undefined);
});

test("pendingCount counts only undecided hunks", () => {
  assert.equal(pendingCount(makeChange()), 1);
  assert.equal(
    pendingCount(
      makeChange({ hunks: [hunk({ decision: "accepted" }), hunk({ id: "h2", decision: "rejected" })] }),
    ),
    0,
  );
});

test("the count lens reads like a diff stat", () => {
  assert.equal(stagedCountTitle(4, 2), "−4 lines, +2 lines");
  assert.equal(stagedCountTitle(0, 3), "+3 lines");
  assert.equal(stagedCountTitle(5, 0), "−5 lines");
  assert.equal(stagedCountTitle(1, 1), "−1 line, +1 line");
});

test("stagedMarks colours the old block red and the new block green", () => {
  const view = buildStagedView(makeChange());
  assert.ok(view, "a pending change must have a staged view");
  const marks = stagedMarks(view!, 4);
  assert.deepEqual(marks.removed, [{ start: 1, end: 1, hunkId: "h1" }]);
  assert.deepEqual(marks.added, [{ start: 2, end: 2, hunkId: "h1" }]);
});

test("stagedMarks never leaves the document and skips context blocks", () => {
  const view = buildStagedView(makeChange());
  assert.ok(view);
  const marks = stagedMarks(view!, 2); // a document shorter than the view: every index clamps
  assert.equal(marks.removed.length, 1);
  assert.ok(marks.removed[0].start <= 1 && marks.removed[0].end <= 1);
  assert.equal(marks.added[0].end <= 1, true);
  assert.equal(view!.blocks.some((b) => b.kind === "context" && b.hunkId), false);
});
```

Append this test to `test/merged-diff.test.ts` (it imports `buildMergedView` already):

```ts
test("every non-context block carries the hunk it belongs to", () => {
  const view = buildMergedView(["one", "two", "three"], [
    {
      id: "h1",
      oldStart: 1,
      oldLines: ["two"],
      newStart: 1,
      newLines: ["TWO"],
      decision: "pending",
    },
  ]);
  assert.deepEqual(
    view.blocks.map((b) => b.hunkId),
    [undefined, "h1", "h1", undefined],
    "context blocks have no hunk; the red and green blocks of a hunk share its id",
  );
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test`
Expected: **FAIL** — esbuild reports `Could not resolve "../src/staged-content"` for the new test file (module does not exist yet).

- [ ] **Step 3: Tag the blocks in `src/merged-diff.ts`**

Replace the interface:

```ts
export interface MergedBlock {
  kind: MergedBlockKind;
  /** Inclusive first line index in the merged document. */
  start: number;
  /** Exclusive last line index in the merged document. */
  end: number;
  /** The hunk this block renders; context blocks belong to no hunk. */
  hunkId?: string;
}
```

Replace the `push` helper and the three hunk pushes:

```ts
  const push = (kind: MergedBlockKind, from: string[], hunkId?: string): void => {
    if (from.length === 0) {
      return;
    }
    const start = lines.length;
    lines.push(...from);
    blocks.push({ kind, start, end: lines.length, hunkId });
  };
```

```ts
    if (h.decision === "rejected") {
      push("deleted", h.oldLines, h.id);
    } else if (h.decision === "accepted") {
      push("added", h.newLines, h.id);
    } else {
      push("deleted", h.oldLines, h.id);
      push("added", h.newLines, h.id);
    }
```

The two `push("context", …)` call sites stay unchanged (no `hunkId`).

- [ ] **Step 4: Create `src/staged-content.ts`**

```ts
/**
 * What goes into the editor buffer for a file under inline staged review, and how that
 * buffer maps back onto decorations and CodeLenses.
 *
 * Pure: no `vscode`, no filesystem. `src/staged-review.ts` owns the staging state machine
 * and `src/extension.ts` owns the host; this module is only the content model, so the
 * "the buffer must never be wrong" rules are unit-testable on their own.
 *
 * The staged text is the merged view (old block above new block for a pending hunk) rebuilt
 * with the BASELINE framing. Once no hunk is pending the view is byte-identical to the file
 * `settle()` wrote, which is what lets the engine hand the buffer back to disk safely.
 */
import { buildMergedView, type MergedView } from "./merged-diff";
import { joinContent, splitContent } from "./hunk-diff";
import type { ChangeSet } from "./types";

export type StageSkipReason = "binary" | "no-hunks" | "already-decided" | "auto-save";

/**
 * Why a change cannot be staged right now, or `undefined` when it can.
 * `autoSave` is the raw `files.autoSave` value; anything other than `"off"` means a timer
 * could flush the buffer, so staging is off entirely (spec D5/F4).
 */
export function stageSkipReason(cs: ChangeSet, autoSave: string): StageSkipReason | undefined {
  if (cs.binary) {
    return "binary";
  }
  if (cs.hunks.length === 0) {
    return "no-hunks";
  }
  if (!cs.hunks.some((h) => h.decision === "pending")) {
    return "already-decided";
  }
  return autoSave === "off" ? undefined : "auto-save";
}

/** The interleaved old/new view, or `undefined` when there is nothing to show. */
export function buildStagedView(cs: ChangeSet): MergedView | undefined {
  if (cs.binary || cs.hunks.length === 0) {
    return undefined;
  }
  return buildMergedView(splitContent(cs.baseline).lines, cs.hunks);
}

/** The buffer content for a staged file: the merged view in the baseline's framing. */
export function buildStagedText(cs: ChangeSet): string | undefined {
  const view = buildStagedView(cs);
  if (!view) {
    return undefined;
  }
  const info = splitContent(cs.baseline);
  return joinContent(view.lines, { eol: info.eol, bom: info.bom, finalNewline: info.finalNewline });
}

export function pendingCount(cs: ChangeSet): number {
  return cs.hunks.filter((h) => h.decision === "pending").length;
}

/** Title for the count lens: `−4 lines, +2 lines`. */
export function stagedCountTitle(removed: number, added: number): string {
  const parts: string[] = [];
  if (removed > 0) {
    parts.push(`−${removed} line${removed === 1 ? "" : "s"}`);
  }
  if (added > 0) {
    parts.push(`+${added} line${added === 1 ? "" : "s"}`);
  }
  return parts.join(", ");
}

export interface StagedMark {
  /** Inclusive first line of the block. */
  start: number;
  /** Inclusive last line of the block (clamped to the document). */
  end: number;
  hunkId: string;
}

export interface StagedMarks {
  added: StagedMark[];
  removed: StagedMark[];
}

/**
 * Line ranges to colour in a staged buffer. `deleted` blocks are baseline code (red),
 * `added` blocks are proposed code (green) — the merged view only emits a deleted block for
 * a pending/rejected hunk and an added block for a pending/accepted one, so colouring by
 * kind reproduces exactly the semantics the unstaged decorations already use.
 */
export function stagedMarks(view: MergedView, docLineCount: number): StagedMarks {
  const lastLine = Math.max(0, docLineCount - 1);
  const clamp = (n: number): number => Math.max(0, Math.min(lastLine, n));
  const marks: StagedMarks = { added: [], removed: [] };
  for (const block of view.blocks) {
    if (block.kind === "context" || !block.hunkId || block.end <= block.start) {
      continue;
    }
    const mark: StagedMark = { start: clamp(block.start), end: clamp(block.end - 1), hunkId: block.hunkId };
    (block.kind === "added" ? marks.added : marks.removed).push(mark);
  }
  return marks;
}
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `npm test`
Expected: **PASS** — **219 tests** (207 baseline + 11 in `test/staged-content.test.ts` + 1 added to `test/merged-diff.test.ts`), 0 fail, no `ExperimentalWarning`. If the real number differs, report it — later tasks' counts are built on this one.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean, no output.

- [ ] **Step 7: Commit**

```bash
git add src/staged-content.ts src/merged-diff.ts test/staged-content.test.ts test/merged-diff.test.ts
git commit -m "Task 1: pure staged-content model"
```

### Task 2: The staging engine (`StagedReview`)

**Files:**
- Create: `src/staged-review.ts`
- Test: `test/staged-review.test.ts`

**Interfaces:**
- Consumes: `buildStagedText`, `pendingCount`, `stageSkipReason`, `StageSkipReason` from `src/staged-content.ts`; `ChangeSet` from `src/types.ts`.
- Produces (used by Tasks 3–7):
  - `type StageNotice = StageSkipReason | "save-blocked"`
  - `const STAGED_CONTEXT_KEY = "reviewHub.hasStagedReview"`
  - `interface StagedDocument { uri: { scheme: string; fsPath: string }; getText(): string; isDirty: boolean }`
  - `interface StagedHost` — the 14 injected capabilities listed in the code below
  - `class StagedReview` — `start()`, `stage(changeId)`, `restage(changeId)`, `unstage(changeId, opts?)`, `isStaged(fsPath)`, `changeIdFor(fsPath)`, `stagedCount()`, `adoptOpenDocuments()`, `dispose()`
- **No `vscode` import**: `src/extension.ts` builds the real host in Task 5.

- [ ] **Step 1: Write the failing tests**

Create `test/staged-review.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  StagedReview,
  STAGED_CONTEXT_KEY,
  type StageNotice,
  type StagedDocument,
  type StagedHost,
} from "../src/staged-review";
import { buildStagedText } from "../src/staged-content";
import type { ChangeSet, Hunk } from "../src/types";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeDoc implements StagedDocument {
  readonly uri = { scheme: "file", fsPath: "" };
  isDirty = false;
  constructor(fsPath: string, private text: string) {
    this.uri.fsPath = fsPath;
  }
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
    this.isDirty = true;
  }
}

function hunk(id: string, oldStart: number, oldLine: string, newLine: string, decision: Hunk["decision"] = "pending"): Hunk {
  return { id, oldStart, oldLines: [oldLine], newStart: oldStart, newLines: [newLine], decision };
}

function makeChange(overrides: Partial<ChangeSet> = {}): ChangeSet {
  return {
    id: "c1",
    workspace: "/ws",
    path: "a.txt",
    absPath: "/ws/a.txt",
    origin: "fs",
    applied: true,
    eol: "\n",
    bom: false,
    finalNewline: true,
    binary: false,
    baseline: "one\ntwo\nthree\n",
    proposed: "one\nTWO\nthree\n",
    baselineExists: true,
    proposedExists: true,
    hunks: [hunk("h1", 1, "two", "TWO")],
    status: "applied",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

interface Harness {
  staged: StagedReview;
  docs: FakeDoc[];
  contexts: [string, boolean][];
  notices: StageNotice[];
  reverts: string[];
  replaced(): number;
  stagedEvents(): number;
  fireTextChange(doc: FakeDoc): void;
  fireWillSave(fsPath: string): boolean; // true when the save was prevented
  fireOpen(fsPath: string): void;
}

function harness(changes: ChangeSet[], opts: { autoSave?: string; docs?: FakeDoc[] } = {}): Harness {
  const docs = opts.docs ?? [];
  const contexts: [string, boolean][] = [];
  const notices: StageNotice[] = [];
  const reverts: string[] = [];
  let replaced = 0;
  let stagedEvents = 0;
  const changeCbs: ((d: StagedDocument) => void)[] = [];
  const saveCbs: ((p: string, prevent: () => void) => void)[] = [];
  const openCbs: ((p: string) => void)[] = [];

  const host: StagedHost = {
    documents: () => docs,
    open: async (fsPath) => {
      const doc = docs.find((d) => d.uri.fsPath === fsPath);
      // VS Code fires onDidOpenTextDocument when a document enters the workspace, including
      // the open our own stage() performs — this is what exercises the re-entry guard.
      if (doc) {
        for (const cb of openCbs) cb(fsPath);
      }
      return doc;
    },
    replace: async (fsPath, text) => {
      const doc = docs.find((d) => d.uri.fsPath === fsPath);
      if (!doc) {
        return false;
      }
      replaced++;
      doc.setText(text);
      for (const cb of changeCbs) cb(doc); // fires synchronously, while `applying` is set
      return true;
    },
    revert: (fsPath) => reverts.push(fsPath),
    autoSave: () => opts.autoSave ?? "off",
    findById: (id) => changes.find((c) => c.id === id),
    changeForPath: (fsPath) => changes.find((c) => c.absPath === fsPath),
    onDidChangeTextDocument: (cb) => {
      changeCbs.push(cb);
      return { dispose() {} };
    },
    onWillSaveTextDocument: (cb) => {
      saveCbs.push(cb);
      return { dispose() {} };
    },
    onDidOpenTextDocument: (cb) => {
      openCbs.push(cb);
      return { dispose() {} };
    },
    setContext: (key, value) => contexts.push([key, value]),
    notice: (reason) => notices.push(reason),
    onStaged: () => {
      stagedEvents++;
    },
  };

  const staged = new StagedReview(host);
  staged.start();
  return {
    staged,
    docs,
    contexts,
    notices,
    reverts,
    replaced: () => replaced,
    stagedEvents: () => stagedEvents,
    fireTextChange: (doc) => changeCbs.forEach((cb) => cb(doc)),
    fireWillSave: (fsPath) => {
      let prevented = false;
      saveCbs.forEach((cb) => cb(fsPath, () => (prevented = true)));
      return prevented;
    },
    fireOpen: (fsPath) => openCbs.forEach((cb) => cb(fsPath)),
  };
}

test("staging puts the merged view in the buffer and records the file", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed); // origin fs: the disk already has the new code
  const h = harness([cs], { docs: [doc] });

  assert.equal(await h.staged.stage("c1"), true);
  assert.equal(doc.getText(), buildStagedText(cs), "the buffer now shows old + new");
  assert.equal(doc.isDirty, true, "the buffer is a view; the disk is untouched");
  assert.equal(h.staged.isStaged("/ws/a.txt"), true);
  assert.equal(h.staged.changeIdFor("/ws/a.txt"), "c1");
  assert.deepEqual(h.contexts.at(-1), [STAGED_CONTEXT_KEY, true]);
  assert.equal(h.replaced(), 1);
});

test("staging the same change twice replaces the buffer once", async () => {
  const cs = makeChange();
  const h = harness([cs], { docs: [new FakeDoc("/ws/a.txt", cs.proposed)] });

  assert.equal(await h.staged.stage("c1"), true);
  assert.equal(await h.staged.stage("c1"), true);
  assert.equal(h.replaced(), 1, "the re-entrant open fired by our own open() must not restage");
});

test("a buffer the user already edited is never overwritten", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", "my own unsaved edits\n");
  doc.isDirty = true;
  const h = harness([cs], { docs: [doc] });

  assert.equal(await h.staged.stage("c1"), false);
  assert.equal(doc.getText(), "my own unsaved edits\n");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
  assert.equal(h.replaced(), 0);
});

test("auto-save turns staging off and reports it exactly once", async () => {
  const cs = makeChange();
  const h = harness([cs], { docs: [new FakeDoc("/ws/a.txt", cs.proposed)], autoSave: "afterDelay" });

  assert.equal(await h.staged.stage("c1"), false);
  assert.equal(await h.staged.stage("c1"), false);
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
  assert.deepEqual(h.notices, ["auto-save"]);
});

test("the decision that closes the last hunk hands the buffer back to disk", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness([cs], { docs: [doc] });
  await h.staged.stage("c1");

  cs.hunks = cs.hunks.map((x) => ({ ...x, decision: "accepted" }));
  assert.equal(await h.staged.restage("c1"), false, "nothing is pending any more");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
  assert.deepEqual(h.reverts, ["/ws/a.txt"], "the editor reloads the file settle() wrote");
});

test("restaging rebuilds the view for the hunks that are still pending", async () => {
  const cs = makeChange({
    baseline: "a\nb\nc\nd\n",
    proposed: "A\nb\nC\nd\n",
    hunks: [hunk("h1", 0, "a", "A"), hunk("h2", 2, "c", "C")],
  });
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness([cs], { docs: [doc] });
  await h.staged.stage("c1");
  assert.equal(doc.getText(), "a\nA\nb\nc\nC\nd\n");

  cs.hunks = cs.hunks.map((x) => (x.id === "h1" ? { ...x, decision: "accepted" } : x));
  assert.equal(await h.staged.restage("c1"), true, "h2 is still pending, so staging stays");
  assert.equal(doc.getText(), "A\nb\nc\nC\nd\n", "the accepted old block is gone from the view");
  assert.equal(h.staged.isStaged("/ws/a.txt"), true);
});

test("typing into a staged buffer lifts the staging and keeps the record pending", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness([cs], { docs: [doc] });
  await h.staged.stage("c1");

  doc.setText("hand edit\n");
  h.fireTextChange(doc);

  assert.equal(h.staged.isStaged("/ws/a.txt"), false, "the user owns the buffer now");
  assert.equal(h.reverts.length, 0, "nothing of the user's is reverted (spec F3)");
  assert.deepEqual(h.contexts.at(-1), [STAGED_CONTEXT_KEY, false]);
});

test("an explicit save is refused while a hunk is still pending", async () => {
  const cs = makeChange();
  const h = harness([cs], { docs: [new FakeDoc("/ws/a.txt", cs.proposed)] });
  await h.staged.stage("c1");

  assert.equal(h.fireWillSave("/ws/a.txt"), true, "the interleaved view must not reach disk");
  assert.deepEqual(h.notices, ["save-blocked"]);
  assert.equal(h.fireWillSave("/ws/a.txt"), true, "still refused, but the user is told once");
  assert.deepEqual(h.notices, ["save-blocked"], "the warning is not repeated");
});

test("files that are not staged are never touched by the save guard", () => {
  const h = harness([makeChange()], { docs: [new FakeDoc("/ws/a.txt", "plain\n")] });
  assert.equal(h.fireWillSave("/ws/a.txt"), false);
  assert.deepEqual(h.notices, []);
});

test("a buffer hot exit restored is re-adopted when it still matches the view", () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", buildStagedText(cs)!);
  doc.isDirty = true;
  const h = harness([cs], { docs: [doc] });

  assert.equal(h.staged.adoptOpenDocuments(), 1);
  assert.equal(h.staged.isStaged("/ws/a.txt"), true);
  assert.equal(h.replaced(), 0, "matching content needs no edit");
});

test("a buffer that does not match is left exactly as it is", () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", "my crash-time edits\n");
  doc.isDirty = true;
  const h = harness([cs], { docs: [doc] });

  assert.equal(h.staged.adoptOpenDocuments(), 0);
  assert.equal(doc.getText(), "my crash-time edits\n");
  assert.equal(h.reverts.length, 0, "never reverted — that would destroy the user's work");
  assert.equal(h.staged.isStaged("/ws/a.txt"), false);
});

test("opening a file that still has a pending change stages it", async () => {
  const cs = makeChange();
  const doc = new FakeDoc("/ws/a.txt", cs.proposed);
  const h = harness([cs], { docs: [doc] });

  h.fireOpen("/ws/a.txt");
  await tick();
  await tick();

  assert.equal(h.staged.isStaged("/ws/a.txt"), true);
  assert.equal(doc.getText(), buildStagedText(cs));
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test`
Expected: **FAIL** — esbuild: `Could not resolve "../src/staged-review"`.

- [ ] **Step 3: Create `src/staged-review.ts`**

```ts
/**
 * Inline staged review: keep a change's review state IN the editor buffer.
 *
 * The buffer holds the merged view (old block above new block) while the file on disk keeps
 * exactly what it held before — for an "fs" change the agent's new code, for an "mcp" change
 * the baseline. Decisions never run through this module: `ChangeStore.accept/reject` still
 * writes the correctly resolved bytes, and this engine only re-stages the view afterwards
 * (spec F1). When the last hunk is decided the view is byte-identical to the file, so
 * `restage()` un-stages and reverts the editor (spec F2).
 *
 * Deliberately free of `vscode`: every host capability arrives through `StagedHost`, so the
 * state machine is unit-testable and `src/extension.ts` owns all VS Code calls.
 */
import { buildStagedText, pendingCount, stageSkipReason, type StageSkipReason } from "./staged-content";
import type { ChangeSet } from "./types";

export type StageNotice = StageSkipReason | "save-blocked";

/** Context key the editor-title Accept/Reject buttons are gated on (`package.json`). */
export const STAGED_CONTEXT_KEY = "reviewHub.hasStagedReview";

/** The subset of `vscode.TextDocument` the engine needs. */
export interface StagedDocument {
  readonly uri: { scheme: string; fsPath: string };
  getText(): string;
  readonly isDirty: boolean;
}

export interface StagedHost {
  /** Every document currently open in the workspace. */
  documents(): StagedDocument[];
  /** Open the document for `fsPath` (never shows it). `undefined` when it cannot be opened. */
  open(fsPath: string): Promise<StagedDocument | undefined>;
  /** Replace the whole document text (a `WorkspaceEdit` in the real host). */
  replace(fsPath: string, text: string): Promise<boolean>;
  /** Discard the buffer and reload the file from disk. */
  revert(fsPath: string): void;
  /** The raw `files.autoSave` value. */
  autoSave(): string;
  findById(changeId: string): ChangeSet | undefined;
  changeForPath(fsPath: string): ChangeSet | undefined;
  onDidChangeTextDocument(cb: (doc: StagedDocument) => void): { dispose(): void };
  onWillSaveTextDocument(cb: (fsPath: string, prevent: () => void) => void): { dispose(): void };
  onDidOpenTextDocument(cb: (fsPath: string) => void): { dispose(): void };
  /** Set the `when`-clause context key for the editor title buttons. */
  setContext(key: string, value: boolean): void;
  /** One-shot user-facing notice (auto-save guard, blocked save). */
  notice(reason: StageNotice, changeId?: string): void;
  /** Something changed about what is staged — re-render the presentation layer. */
  onStaged(): void;
}

interface Entry {
  changeId: string;
  /** True while our own `replace()` is in flight, so its change event is not mistaken for typing. */
  applying: boolean;
}

export class StagedReview {
  private readonly entries = new Map<string, Entry>();
  /** Files with a `stage()` in flight — the re-entrancy guard for our own `open()`. */
  private readonly busy = new Set<string>();
  private readonly noticed = new Set<StageNotice>();
  private subs: { dispose(): void }[] = [];

  constructor(private readonly host: StagedHost) {}

  /** Register the three host listeners. Call once, after the rest of the UI exists. */
  start(): void {
    this.subs.push(
      this.host.onDidChangeTextDocument((doc) => this.handleTextChange(doc)),
      this.host.onWillSaveTextDocument((fsPath, prevent) => this.handleWillSave(fsPath, prevent)),
      this.host.onDidOpenTextDocument((fsPath) => {
        // A failed stage is never fatal: the file simply keeps the unstaged path.
        this.stageOnOpen(fsPath).catch(() => undefined);
      }),
    );
  }

  isStaged(fsPath: string): boolean {
    return this.entries.has(fsPath);
  }

  changeIdFor(fsPath: string): string | undefined {
    return this.entries.get(fsPath)?.changeId;
  }

  stagedCount(): number {
    return this.entries.size;
  }

  /** Stage one change's file (spec D1). Returns true when the buffer shows the merged view. */
  async stage(changeId: string): Promise<boolean> {
    const cs = this.host.findById(changeId);
    if (!cs) {
      return false;
    }
    const held = this.entries.get(cs.absPath);
    if (held?.changeId === changeId) {
      return true;
    }
    const reason = stageSkipReason(cs, this.host.autoSave());
    if (reason) {
      this.noticeOnce(reason, changeId);
      return false;
    }
    if (this.busy.has(cs.absPath)) {
      return false;
    }
    const text = buildStagedText(cs);
    if (text === undefined) {
      return false;
    }
    this.busy.add(cs.absPath);
    try {
      const doc = await this.host.open(cs.absPath);
      if (!doc || doc.uri.scheme !== "file") {
        return false;
      }
      // The user's own unsaved edits always win (spec D1 guard).
      if (doc.isDirty && !held) {
        return false;
      }
      this.remember(cs.absPath, changeId);
      if (doc.getText() !== text) {
        const entry = this.entries.get(cs.absPath)!;
        entry.applying = true;
        try {
          const ok = await this.host.replace(cs.absPath, text);
          if (!ok) {
            this.entries.delete(cs.absPath);
            return false;
          }
        } finally {
          entry.applying = false;
        }
      }
    } finally {
      this.busy.delete(cs.absPath);
    }
    this.syncContext();
    this.host.onStaged();
    return true;
  }

  /**
   * Re-render after a decision: rebuild the view, or hand the buffer back to disk when
   * nothing is pending any more (spec F1/F2). Returns whether the file is still staged.
   */
  async restage(changeId: string): Promise<boolean> {
    const cs = this.host.findById(changeId);
    const fsPath = cs?.absPath ?? this.pathOf(changeId);
    if (!cs || !fsPath) {
      return false;
    }
    const entry = this.entries.get(fsPath);
    if (!entry || entry.changeId !== changeId) {
      return false;
    }
    if (pendingCount(cs) === 0) {
      this.unstage(changeId, { revert: true });
      return false;
    }
    const text = buildStagedText(cs);
    if (text === undefined) {
      this.unstage(changeId);
      return false;
    }
    entry.applying = true;
    try {
      await this.host.replace(fsPath, text);
    } finally {
      entry.applying = false;
    }
    this.host.onStaged();
    return true;
  }

  /** Stop staging a change. `revert` reloads the editor from disk (only used when they match). */
  unstage(changeId: string, opts: { revert?: boolean } = {}): void {
    const fsPath = this.pathOf(changeId);
    if (fsPath) {
      this.entries.delete(fsPath);
      if (opts.revert) {
        this.host.revert(fsPath);
      }
    }
    this.syncContext();
    this.host.onStaged();
  }

  /**
   * Reconciliation after hot exit / crash (spec D6b): adopt every open buffer that still
   * holds the view we built for it, leave every other buffer alone (spec F3).
   */
  adoptOpenDocuments(): number {
    let adopted = 0;
    for (const doc of this.host.documents()) {
      if (doc.uri.scheme !== "file" || this.entries.has(doc.uri.fsPath)) {
        continue;
      }
      const cs = this.host.changeForPath(doc.uri.fsPath);
      if (!cs || stageSkipReason(cs, this.host.autoSave())) {
        continue;
      }
      const text = buildStagedText(cs);
      if (text !== undefined && doc.getText() === text) {
        this.remember(doc.uri.fsPath, cs.id);
        adopted++;
      }
    }
    if (adopted > 0) {
      this.syncContext();
      this.host.onStaged();
    }
    return adopted;
  }

  dispose(): void {
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.subs = [];
    this.entries.clear();
  }

  private async stageOnOpen(fsPath: string): Promise<void> {
    if (this.entries.has(fsPath) || this.busy.has(fsPath)) {
      return;
    }
    const cs = this.host.changeForPath(fsPath);
    if (cs) {
      await this.stage(cs.id);
    }
  }

  private handleTextChange(doc: StagedDocument): void {
    if (doc.uri.scheme !== "file") {
      return;
    }
    const entry = this.entries.get(doc.uri.fsPath);
    if (!entry || entry.applying) {
      return;
    }
    const cs = this.host.findById(entry.changeId);
    const staged = cs ? buildStagedText(cs) : undefined;
    if (staged !== undefined && doc.getText() === staged) {
      return; // our own edit, delivered after `replace()` settled
    }
    // The user typed into the staged view (spec D7): lift the staging, keep the record.
    this.unstage(entry.changeId);
  }

  private handleWillSave(fsPath: string, prevent: () => void): void {
    const entry = this.entries.get(fsPath);
    if (!entry) {
      return;
    }
    const cs = this.host.findById(entry.changeId);
    if (!cs || pendingCount(cs) === 0) {
      return;
    }
    // Saving now would write the display text (old + new interleaved) to the real file.
    prevent();
    this.noticeOnce("save-blocked", entry.changeId);
  }

  private noticeOnce(reason: StageNotice, changeId?: string): void {
    if (this.noticed.has(reason)) {
      return;
    }
    this.noticed.add(reason);
    this.host.notice(reason, changeId);
  }

  private remember(fsPath: string, changeId: string): void {
    const applying = this.entries.get(fsPath)?.applying ?? false;
    this.entries.set(fsPath, { changeId, applying });
  }

  private pathOf(changeId: string): string | undefined {
    for (const [fsPath, entry] of this.entries) {
      if (entry.changeId === changeId) {
        return fsPath;
      }
    }
    return undefined;
  }

  private syncContext(): void {
    this.host.setContext(STAGED_CONTEXT_KEY, this.entries.size > 0);
  }
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: **PASS** — **231 tests** (219 + 12), 0 fail.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/staged-review.ts test/staged-review.test.ts
git commit -m "Task 2: staging engine with an injected host"
```

---

### Task 3: Red/green block decorations on a staged file

**Files:**
- Modify: `src/change-decorator.ts:25-32` (constructor), `src/change-decorator.ts:124-131` (top of `apply`)
- Modify: `test/vscode-stub.ts` (`MarkdownString`, injectable `visibleTextEditors`, decoration-type options)
- Test: `test/staged-decorator.test.ts`

**Interfaces:**
- Consumes: `buildStagedView`, `stagedMarks`, `StagedMark` (Task 1); the existing `hunkLabel()` helper inside `change-decorator.ts`.
- Produces: `constructor ChangeDecorator(store: ChangeStore, isStaged?: (fsPath: string) => boolean)` — the second parameter defaults to `() => false`, so every existing caller/test keeps working.

- [ ] **Step 1: Extend the VS Code stub (additive)**

In `test/vscode-stub.ts`, add these three hooks to the `stub` object (keep everything else as is):

```ts
  /** Test hook: the documents `window.visibleTextEditors` should report. */
  __visibleEditors: [] as unknown[],
  /** Test hook: every decoration type created, with the options it was created with. */
  __decorationTypes: [] as { id: number; opts: Record<string, unknown> }[],
  MarkdownString: class {
    value: string;
    isTrusted = false;
    constructor(value = "") {
      this.value = value;
    }
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
    appendText(text: string) {
      this.value += text;
      return this;
    }
    appendCodeblock(code: string) {
      this.value += "```\n" + code + "\n```";
      return this;
    }
  },
```

and change these two members of `stub.window`:

```ts
    createTextEditorDecorationType: (opts: Record<string, unknown> = {}) => {
      const type = { id: stub.__decorationTypes.length, opts, dispose: () => {} };
      stub.__decorationTypes.push(type);
      return type;
    },
    get visibleTextEditors() {
      return stub.__visibleEditors;
    },
```

- [ ] **Step 2: Write the failing test**

Create `test/staged-decorator.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../src/change-store";
import { ChangeDecorator } from "../src/change-decorator";
import { buildStagedText } from "../src/staged-content";

const OLD = "one\ntwo\nthree\n";
const NEW = "one\nTWO\nthree\n";

interface Call {
  colorId: string;
  lines: [number, number][];
}

function setup(): { ws: string; store: ChangeStore; fsPath: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-dec-"));
  process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
  const store = new ChangeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-dec-home-")) });
  fs.writeFileSync(path.join(ws, "a.txt"), OLD);
  store.propose(ws, "a.txt", NEW);
  return { ws, store, fsPath: path.join(ws, "a.txt") };
}

function show(fsPath: string, lineCount: number, calls: Call[]): void {
  vscode.__visibleEditors.length = 0;
  vscode.__decorationTypes.length = 0;
  vscode.__visibleEditors.push({
    document: { uri: { scheme: "file", fsPath }, lineCount },
    setDecorations: (
      type: { opts?: { backgroundColor?: { id?: string } } },
      options: { range?: { startLine: number; endLine: number } }[],
    ) => {
      calls.push({
        colorId: type.opts?.backgroundColor?.id ?? "none",
        lines: (options ?? []).map((o) => [o.range!.startLine, o.range!.endLine]),
      });
    },
  });
}

function byColor(calls: Call[]): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>();
  for (const call of calls) {
    map.set(call.colorId, [...(map.get(call.colorId) ?? []), ...call.lines]);
  }
  return map;
}

test("a staged file gets a green row for the new code and a red row for the old", () => {
  const { store, fsPath } = setup();
  const stagedText = buildStagedText(store.findChangeByPath(path.dirname(fsPath), "a.txt")!)!;
  const calls: Call[] = [];
  show(fsPath, stagedText.split("\n").length, calls);

  const decorator = new ChangeDecorator(store, () => true);
  decorator.start();
  decorator.dispose();

  const colors = byColor(calls);
  assert.deepEqual(colors.get("diffEditor.insertedLineBackground"), [[2, 2]], "line 2 is the new code");
  assert.deepEqual(colors.get("diffEditor.removedLineBackground"), [[1, 1]], "line 1 is the old code");
  const ghost = calls.find((c) => c.colorId === "none");
  assert.deepEqual(ghost?.lines, [], "both sides are visible, so there is no ghost preview");
});

test("an unstaged file keeps today's ghost-text behaviour", () => {
  const { store, fsPath } = setup();
  const calls: Call[] = [];
  show(fsPath, OLD.split("\n").length, calls);

  const decorator = new ChangeDecorator(store, () => false);
  decorator.start();
  decorator.dispose();

  const colors = byColor(calls);
  assert.deepEqual(
    colors.get("diffEditor.insertedLineBackground"),
    [],
    "no green row: the pending new line is not on disk yet",
  );
  assert.ok((colors.get("none") ?? []).length > 0, "the pending hunk still gets its ghost preview");
});

test("a file with no change gets no decorations at all", () => {
  const { store, ws } = setup();
  const other = path.join(ws, "untouched.txt");
  const calls: Call[] = [];
  show(other, 3, calls);

  const decorator = new ChangeDecorator(store, () => true);
  decorator.start();
  decorator.dispose();

  assert.deepEqual(byColor(calls).get("diffEditor.insertedLineBackground"), [], "cleared, never coloured");
  assert.deepEqual(byColor(calls).get("diffEditor.removedLineBackground"), [], "cleared, never coloured");
});
```

- [ ] **Step 3: Run the suite to verify it fails**

Run: `npm test`
Expected: **FAIL** — `ChangeDecorator` still takes one argument, so the staged branch never runs: the first assertion gets `undefined` instead of `[[2, 2]]` (the `isStaged` predicate is ignored today).

- [ ] **Step 4: Implement the staged branch**

`src/change-decorator.ts` — add the import:

```ts
import { buildStagedView, stagedMarks, type StagedMark } from "./staged-content";
```

Replace the constructor signature (the body is unchanged):

```ts
  constructor(
    private store: ChangeStore,
    /** True while this file's buffer holds the merged view (Task 2). */
    private isStaged: (fsPath: string) => boolean = () => false,
  ) {
```

Replace the opening guard of `apply()` (lines 124-135 today) — this exact text:

```ts
  private apply(editor: vscode.TextEditor): void {
    const cs = this.changeForDocument(editor);
    if (!cs || cs.binary || cs.hunks.length === 0) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.removed, []);
      editor.setDecorations(this.deletionMarker, []);
      return;
    }
    const doc = editor.document;
```

with:

```ts
  private apply(editor: vscode.TextEditor): void {
    const cs = this.changeForDocument(editor);
    if (!cs) {
      this.clear(editor);
      return;
    }
    // A staged buffer contains BOTH sides of every hunk, so each block can be a real colour
    // row — the thing a plain highlight structurally cannot do (see the module header).
    if (this.isStaged(editor.document.uri.fsPath)) {
      this.applyStaged(editor, cs);
      return;
    }
    if (cs.binary || cs.hunks.length === 0) {
      this.clear(editor);
      return;
    }
    const doc = editor.document;
```

Everything from the `const added: vscode.DecorationOptions[] = [];` line to
`editor.setDecorations(this.deletionMarker, deleted);` and `apply()`'s closing `}` is **untouched**.
Immediately after that closing `}` insert two private methods:

```ts
  private clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.removed, []);
    editor.setDecorations(this.deletionMarker, []);
  }

  /** Staged view: `deleted` blocks red, `added` blocks green, no ghost text (spec D2). */
  private applyStaged(editor: vscode.TextEditor, cs: ChangeSet): void {
    const view = buildStagedView(cs);
    if (!view) {
      this.clear(editor);
      return;
    }
    const marks = stagedMarks(view, editor.document.lineCount);
    const hunks = new Map(cs.hunks.map((h) => [h.id, h]));
    const decorate = (list: StagedMark[]): vscode.DecorationOptions[] =>
      list.flatMap((mark) => {
        const hunk = hunks.get(mark.hunkId);
        if (!hunk) {
          return [];
        }
        return [
          {
            range: new vscode.Range(mark.start, 0, mark.end, 0),
            hoverMessage: stagedHover(hunkLabel(cs, hunk), hunk),
          },
        ];
      });
    editor.setDecorations(this.added, decorate(marks.added));
    editor.setDecorations(this.removed, decorate(marks.removed));
    editor.setDecorations(this.deletionMarker, []);
  }
```

…plus this module-level helper, next to the existing `pendingHover`/`removedHover` (line 245-263)
— spec D2 requires the hover to carry the label **and the full old/new text**:

```ts
/** Staged hover: the hunk label plus both sides, worded for the hunk's current decision. */
function stagedHover(label: string, hunk: Hunk): vscode.MarkdownString {
  const block = (title: string, lines: string[]): string[] =>
    lines.length === 0 ? [] : ["", `**${title}:**`, "```", ...lines.map((l) => l.replace(/\t/g, "    ")), "```"];
  if (hunk.decision === "accepted") {
    return new vscode.MarkdownString([label, ...block("Removed from the baseline", hunk.oldLines)].join("\n"));
  }
  if (hunk.decision === "rejected") {
    return new vscode.MarkdownString([label, ...block("Discarded (the baseline was kept)", hunk.newLines)].join("\n"));
  }
  return new vscode.MarkdownString(
    [label, ...block("Old code (red block)", hunk.oldLines), ...block("New code (green block)", hunk.newLines)].join(
      "\n",
    ),
  );
}
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `npm test`
Expected: **PASS** — **234 tests** (231 + 3), 0 fail.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/change-decorator.ts test/vscode-stub.ts test/staged-decorator.test.ts
git commit -m "Task 3: red/green block decorations on a staged file"
```

---

### Task 4: CodeLens anchored on the merged view

**Files:**
- Modify: `src/diff-view.ts:15-24` (constructor), `src/diff-view.ts:45-57` (file branch), `src/diff-view.ts:76-162` (`lensesFor` signature + count lens)
- Test: `test/staged-codelens.test.ts`

**Interfaces:**
- Consumes: `buildStagedView`, `stagedCountTitle` (Task 1); `MergedHunk.anchor`.
- Produces: `constructor HunkCodeLensProvider(store: ChangeStore, isStaged?: (fsPath: string) => boolean)`; `lensesFor(..., counts?: { removed: number; added: number })`.

- [ ] **Step 1: Write the failing test**

Create `test/staged-codelens.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../src/change-store";
import { HunkCodeLensProvider } from "../src/diff-view";
import { buildStagedText } from "../src/staged-content";

function storeFor(OLD: string, NEW: string): { ws: string; store: ChangeStore; changeId: string } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-lens-"));
  process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
  const store = new ChangeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-lens-home-")) });
  fs.writeFileSync(path.join(ws, "a.txt"), OLD);
  const cs = store.propose(ws, "a.txt", NEW);
  return { ws, store, changeId: cs.id };
}

const doc = (fsPath: string, lineCount: number): never =>
  ({ uri: { scheme: "file", fsPath }, lineCount }) as never;

test("a staged file's lenses sit on the merged-view lines and show a diff stat", () => {
  const { ws, store, changeId } = storeFor("one\ntwo\nthree\n", "one\nTWO\nthree\n");
  const stagedText = buildStagedText(store.findById(changeId)!)!;
  const provider = new HunkCodeLensProvider(store, () => true);

  const lenses = provider.provideCodeLenses(doc(path.join(ws, "a.txt"), stagedText.split("\n").length));

  assert.equal(lenses.length, 3, "Accept, Reject and the count lens");
  assert.equal(lenses[0].range.startLine, 1, "merged line 1 is the red block");
  assert.equal(lenses[0].command?.title, "$(check) Accept");
  assert.equal(lenses[0].command?.arguments?.[0], changeId);
  assert.equal(lenses[1].command?.title, "$(chrome-close) Reject");
  assert.equal(lenses[2].command?.title, "−1 line, +1 line");
  const tooltip = String((lenses[2].command?.tooltip as { value?: string } | undefined)?.value ?? "");
  assert.match(tooltip, /two/, "the count lens carries the old code");
});

test("a decided hunk keeps its badge at the merged line", () => {
  const { ws, store, changeId } = storeFor("a\nb\nc\nd\n", "A\nb\nC\nd\n");
  const cs = store.findById(changeId)!;
  store.accept(changeId, [cs.hunks[0].id]); // one hunk decided, one still pending
  const stagedText = buildStagedText(store.findById(changeId)!)!;
  const provider = new HunkCodeLensProvider(store, () => true);

  const lenses = provider.provideCodeLenses(doc(path.join(ws, "a.txt"), stagedText.split("\n").length));

  assert.equal(lenses.length, 6, "3 lenses for the accepted hunk + 3 for the pending one");
  assert.equal(lenses[0].range.startLine, 0, "the accepted block starts the merged view");
  assert.equal(lenses[0].command?.title, "$(check) Accepted");
  assert.equal(lenses[3].range.startLine, 2, "the second hunk's red block is on merged line 2");
  assert.equal(lenses[3].command?.title, "$(check) Accept");
});

test("an unstaged file keeps the disk-frame anchors and the plain pending label", () => {
  const { ws, store, changeId } = storeFor("one\ntwo\nthree\n", "one\nTWO\nthree\n");
  const provider = new HunkCodeLensProvider(store, () => false);

  const lenses = provider.provideCodeLenses(doc(path.join(ws, "a.txt"), 4));

  assert.equal(lenses.length, 3);
  assert.equal(lenses[0].range.startLine, 1, "baseline frame: the hunk starts on baseline line 1");
  assert.equal(lenses[2].command?.title, "hunk 1/1 · pending", "no diff stat outside staging");
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test`
Expected: **FAIL** — esbuild: `Could not resolve "../src/staged-codelens"`.

- [ ] **Step 3: Implement the staged branch**

`src/diff-view.ts` — add imports:

```ts
import { buildStagedView, stagedCountTitle } from "./staged-content";
import type { Hunk } from "./types";
```

Replace the constructor:

```ts
  constructor(
    private store: ChangeStore,
    /** True while this file's buffer holds the merged view (Task 2). */
    private isStaged: (fsPath: string) => boolean = () => false,
  ) {}
```

Insert this block at the top of the `if (uri.scheme === "file")` branch (before the `ranges` computation):

```ts
      // Staged: the buffer IS the merged view, so the anchor is a merged-view line and the
      // diff stat is the block's own size (spec D3).
      if (this.isStaged(uri.fsPath)) {
        const view = buildStagedView(cs);
        if (!view) {
          return [];
        }
        return view.hunks.flatMap((h, index) => {
          const hunk = cs.hunks.find((x) => x.id === h.id);
          return hunk
            ? this.lensesFor(cs, hunk, index, h.anchor, document, cs.hunks.length, {
                removed: h.removed,
                added: h.added,
              })
            : [];
        });
      }
```

Change `lensesFor`'s signature to take the optional counts:

```ts
  private lensesFor(
    cs: NonNullable<ReturnType<ChangeStore["findById"]>>,
    hunk: NonNullable<ReturnType<ChangeStore["findById"]>>["hunks"][number],
    index: number,
    anchorLine: number,
    document: vscode.TextDocument,
    total: number,
    counts?: { removed: number; added: number },
  ): vscode.CodeLens[] {
```

…and replace the pending `return [...]` (the last one in the method) with:

```ts
    return [
      new vscode.CodeLens(range, {
        title: "$(check) Accept",
        command: "review-hub.acceptHunk",
        arguments: [cs.id, hunk.id],
        tooltip: "Keep this hunk's proposed lines",
      }),
      new vscode.CodeLens(range, {
        title: "$(chrome-close) Reject",
        command: "review-hub.rejectHunk",
        arguments: [cs.id, hunk.id],
        tooltip: "Restore this hunk's baseline lines",
      }),
      new vscode.CodeLens(range, {
        title: counts ? stagedCountTitle(counts.removed, counts.added) : `hunk ${index + 1}/${total} · pending`,
        command: "",
        tooltip: counts ? oldCodeTooltip(hunk) : undefined,
      }),
    ];
  }
```

Append this helper at the bottom of `src/diff-view.ts` (next to the existing `clamp`):

```ts
/** Old code in a lens tooltip, so a block the eye skims is still readable. */
function oldCodeTooltip(hunk: Hunk): vscode.MarkdownString | undefined {
  if (hunk.oldLines.length === 0) {
    return undefined;
  }
  const md = new vscode.MarkdownString("**Old code (removed if accepted):**");
  md.appendCodeblock(hunk.oldLines.map((l) => l.replace(/\t/g, "    ")).join("\n"));
  return md;
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: **PASS** — **237 tests** (234 + 3), 0 fail.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/diff-view.ts test/staged-codelens.test.ts
git commit -m "Task 4: CodeLens anchored on the merged view"
```

### Task 5: Wire the staging engine into the extension

**Files:**
- Modify: `src/extension.ts:19-20` (imports), `src/extension.ts:157-161` (host + construction), `src/extension.ts:207-212` (assign + start), `src/extension.ts:281-297` (stage triggers), `src/extension.ts:400` (adoption), `src/extension.ts:474-495` + `src/extension.ts:683-691` (re-stage after a decision), `src/extension.ts:263-266` (auto-open suppression), `src/extension.ts:503-515` (dispose)
- Modify: `test/vscode-stub.ts` (workspace event recording + `textDocuments` + `WorkspaceEdit`)
- Test: `test/staged-wiring.test.ts`

**Interfaces:**
- Consumes: `StagedReview`, `StagedHost`, `StageNotice` (Task 2); the `isStaged` predicates required by Tasks 3–4.
- Produces: `stagePath(ws, relPath)` — the single staging trigger used by the watcher, the MCP path and the poll.

- [ ] **Step 1: Extend the VS Code stub (additive)**

In `test/vscode-stub.ts`, add to the `stub` object (next to `__visibleEditors`):

```ts
  /** Test hook: documents reported by `workspace.textDocuments`. */
  __textDocuments: [] as unknown[],
  /** Test hook: every workspace listener registered, tagged with its event name. */
  __listeners: [] as { event: string; cb: (...args: never[]) => unknown }[],
  WorkspaceEdit: class {
    readonly edits: { uri: unknown; text: string }[] = [];
    replace(uri: unknown, _range: unknown, text: string): void {
      this.edits.push({ uri, text });
    }
    insert(uri: unknown, _pos: unknown, text: string): void {
      this.edits.push({ uri, text });
    }
    delete(_uri: unknown, _range: unknown): void {}
  },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
```

Change these members of `stub.workspace`:

```ts
    get textDocuments() {
      return stub.__textDocuments;
    },
    onDidChangeTextDocument: (cb: (e: never) => unknown) => {
      stub.__listeners.push({ event: "change", cb });
      return { dispose: () => {} };
    },
    onWillSaveTextDocument: (cb: (e: never) => unknown) => {
      stub.__listeners.push({ event: "willSave", cb });
      return { dispose: () => {} };
    },
    onDidOpenTextDocument: (cb: (e: never) => unknown) => {
      stub.__listeners.push({ event: "open", cb });
      return { dispose: () => {} };
    },
```

…make `getConfiguration` also offer `update`, and give `openTextDocument`'s fake document the two
members the staging host reads:

```ts
    getConfiguration: () => {
      const config = envJson("VSCODE_STUB_CONFIG");
      return {
        get: <T>(key: string, fallback: T): T => (key in config ? (config[key] as T) : fallback),
        update: async (): Promise<void> => {},
      };
    },
```

```ts
    openTextDocument: async (uri: unknown) => ({
      uri,
      isDirty: false,
      lineCount: 1,
      lineAt: () => ({ range: {} }),
      positionAt: (offset: number) => ({ line: 0, character: offset }),
      getText: () => "",
    }),
```

- [ ] **Step 2: Write the failing test**

Create `test/staged-wiring.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The runner aliases `vscode` to test/vscode-stub.ts. This file activates the extension in
// its own process, so it gets a private hub and a private ~/.review-hub.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-wiring-home-"));
process.env.HOME = home;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-staged-wiring-ws-"));
fs.writeFileSync(path.join(ws, "a.txt"), "one\ntwo\n");
process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
process.env.VSCODE_STUB_CONFIG = JSON.stringify({ enabled: true, watchDirectWrites: false });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require("./vscode-stub") as {
  __listeners: { event: string }[];
  __commands: Map<string, unknown[]>;
  __log: string[];
  Uri: { file(p: string): unknown };
};

/** Module-level so later tests in this file can dispose exactly what activation created. */
const ctx = {
  subscriptions: [] as { dispose(): void }[],
  extension: { packageJSON: { version: "0.2.0" } },
  extensionUri: vscode.Uri.file(process.cwd()),
  asAbsolutePath: (p: string) => path.join(process.cwd(), p),
  globalState: { get: () => undefined, update: async () => {} },
};

test("activation wires the staging engine into the workspace events", async () => {
  const { activate } = await import("../src/extension");
  await activate(ctx as never);

  const events = vscode.__listeners.map((l) => l.event);
  for (const event of ["change", "willSave", "open"]) {
    assert.ok(
      events.includes(event),
      `the staging engine must subscribe to "${event}", got [${events.join(", ")}]`,
    );
  }
});
```

- [ ] **Step 3: Run the suite to verify it fails**

Run: `npm test`
Expected: **FAIL** — `the staging engine must subscribe to "change", got []`.

- [ ] **Step 4: Build the host and construct the engine**

`src/extension.ts` — first the imports:

```ts
import { StagedReview, type StageNotice, type StagedHost } from "./staged-review";
```

```ts
import { HUB_PROTOCOL, type ChangeSet, type FileNode } from "./types";
```

Insert this block between `context.subscriptions.push({ dispose: () => clearInterval(republishTimer) });`
(line 157) and `const provider = new ChangeContentProvider(hub.store);` (line 159):

```ts
  // ---- Inline staged review (spec D1) --------------------------------------
  // `staged` is assigned after `openReviewTab` exists, exactly like the forward declaration
  // below: the CodeLens provider and the decorator only read it through the closures passed
  // to their constructors, and nothing renders before activation has finished.
  let staged: StagedReview;

  const changeForPath = (fsPath: string): ChangeSet | undefined => {
    for (const ws of workspaceFolders()) {
      const root = ws.replace(/[\\/]+$/, "");
      if (!fsPath.startsWith(root + "/") && !fsPath.startsWith(root + "\\")) {
        continue;
      }
      const rel = fsPath.slice(root.length + 1).split("\\").join("/");
      const cs = hub.store.findChangeByPath(root, rel);
      if (cs) {
        return cs;
      }
    }
    return undefined;
  };

  const autoSaveNoticeMuted = context.globalState.get<boolean>("review-hub.autoSaveNoticeShown") === true;

  const notice = (reason: StageNotice, changeId?: string): void => {
    if (reason === "save-blocked") {
      void vscode.window.showInformationMessage(
        "Review Hub: this file is staged for review — Accept or Reject its blocks before saving.",
      );
      return;
    }
    if (autoSaveNoticeMuted || reason !== "auto-save") {
      return;
    }
    void vscode.window
      .showInformationMessage(
        "Review Hub: files.autoSave is on, so inline staged review is off — changes appear as highlights instead.",
        "Turn off auto-save",
        "Open the review tab",
        "Don't show again",
      )
      .then((choice) => {
        if (choice === "Turn off auto-save") {
          void vscode.workspace
            .getConfiguration("files")
            .update("autoSave", "off", vscode.ConfigurationTarget.Global);
        } else if (choice === "Open the review tab" && changeId) {
          openReviewTab(changeId);
        } else if (choice === "Don't show again") {
          void context.globalState.update("review-hub.autoSaveNoticeShown", true);
        }
      });
  };

  const stagedHost: StagedHost = {
    documents: () => [...vscode.workspace.textDocuments],
    open: async (fsPath) => {
      try {
        return await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      } catch {
        return undefined; // deleted on disk, unreadable, … — the unstaged path covers it
      }
    },
    replace: async (fsPath, text) => {
      try {
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
        if (!doc) {
          return false;
        }
        const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, full, text);
        return await vscode.workspace.applyEdit(edit);
      } catch {
        return false;
      }
    },
    revert: (fsPath) =>
      void vscode.commands.executeCommand("workbench.action.files.revert", vscode.Uri.file(fsPath)),
    autoSave: () => vscode.workspace.getConfiguration("files").get("autoSave", "off"),
    findById: (changeId) => hub.store.findById(changeId),
    changeForPath,
    onDidChangeTextDocument: (cb) => vscode.workspace.onDidChangeTextDocument((e) => cb(e.document)),
    onWillSaveTextDocument: (cb) =>
      vscode.workspace.onWillSaveTextDocument((e) => cb(e.document.uri.fsPath, () => e.preventDefault())),
    onDidOpenTextDocument: (cb) =>
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === "file") {
          cb(doc.uri.fsPath);
        }
      }),
    setContext: (key, value) => void vscode.commands.executeCommand("setContext", key, value),
    notice,
    onStaged: () => {
      codeLens.refresh();
      refreshUi();
    },
  };

  /**
   * The one staging trigger: watcher (D1a), MCP propose (D1b) and the poll all land here.
   * If this exact change is already staged we re-render instead of staging again — that is
   * how a decision made in another window (or by the MCP server directly) reaches the
   * buffer: `stage()` short-circuits on an unchanged id, `restage()` rebuilds the view.
   */
  const stagePath = (ws: string, relPath: string): void => {
    const cs = hub.store.findChangeByPath(ws, relPath);
    if (!cs) {
      return;
    }
    const run =
      staged.changeIdFor(cs.absPath) === cs.id ? staged.restage(cs.id) : staged.stage(cs.id);
    run.catch((err) => logger.warn(`stage ${cs.path} failed: ${String(err)}`));
  };
```

Now the five one-line wirings:

```ts
  const codeLens = new HunkCodeLensProvider(hub.store, (fsPath) => staged.isStaged(fsPath));
```

```ts
  const decorator = new ChangeDecorator(hub.store, (fsPath) => staged.isStaged(fsPath));
```

```ts
  openReviewTab = (changeId) => tab.open(changeId);
  staged = new StagedReview(stagedHost);
```

```ts
  decorator.start();
  staged.start();
```

- [ ] **Step 5: Add the staging triggers, the decision hooks and the disposal**

Watcher callback (the `(ws, relPath) => { … }` passed to `new WorkspaceWatcher`, line 281):

```ts
    (ws, relPath) => {
      refreshUi();
      scheduleAutoOpen(ws, relPath);
      stagePath(ws, relPath);
    },
```

MCP path (`hubChanged`, line 292):

```ts
  hubChanged = (workspace, relPath) => {
    refreshUi();
    if (relPath) {
      scheduleAutoOpen(workspace, relPath);
      stagePath(workspace, relPath);
    }
  };
```

Adoption, right after the first `refreshUi();` (line 400):

```ts
  refreshUi();
  // Hot exit can restore buffers we staged last session: adopt the ones that still hold the
  // view, leave every other buffer alone (spec D6b/F3).
  staged.adoptOpenDocuments();
```

`decide()` — insert immediately before `await diffView.refresh(changeId);`:

```ts
      // The buffer is only a view: re-render it from the decisions just recorded. When the
      // last hunk is decided this hands the buffer back to disk (spec F1/F2).
      await staged.restage(changeId);
```

`decideMany()` — insert right after `watcher.noteSelfWrite(cs.absPath);` inside the `if (cs) { … }` block:

```ts
          await staged.restage(cs.id);
```

Auto-open suppression (`flushAutoOpen`, after `if (autoOpened.has(cs.id)) { continue; }`):

```ts
      // A staged file is already being reviewed in place — the review tab would be the
      // second surface for the same change (spec D8).
      if (staged.isStaged(cs.absPath)) {
        continue;
      }
```

Finally, dispose the engine — add `staged,` to the `context.subscriptions.push(…)` list, right after `decorator,` (line 514).

- [ ] **Step 6: Run the suite to verify it passes**

> **Known limitation (accepted, document in Task 8 if you want):** the 2 s cross-window poll
> (`src/extension.ts:312-344`) only detects *appearances/disappearances* of change ids, so a
> decision made in a *different* VS Code window while this window has the same file staged is
> not re-rendered until the next write or decision in this window. Detecting it would mean
> tracking per-change `updatedAt` in the poll; the in-window flow (watcher, MCP, every decision
> path in this window) is fully covered by `stagePath` and `decide`.

Run: `npm test`
Expected: **PASS** — **238 tests** (237 + 1), 0 fail.

- [ ] **Step 7: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: typecheck clean; both bundles build.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts test/vscode-stub.ts test/staged-wiring.test.ts
git commit -m "Task 5: wire staging into the extension"
```

---

### Task 6: Accept All / Reject All in the editor title

**Files:**
- Modify: `src/extension.ts:544-560` (two new commands next to `acceptHunk`/`rejectHunk`)
- Modify: `package.json` → `contributes.commands` and `contributes.menus`
- Test: appended to `test/staged-wiring.test.ts`

**Interfaces:**
- Consumes: `staged.changeIdFor(fsPath)` (Task 2), `STAGED_CONTEXT_KEY` (Task 2), `decide(changeId, undefined, kind)` (existing, decides every hunk of a change).
- Produces: commands `review-hub.stagedAcceptAll`, `review-hub.stagedRejectAll`.

- [ ] **Step 1: Write the failing test**

Append this test to `test/staged-wiring.test.ts`:

```ts
test("the staged Accept/Reject buttons are declared and registered", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    contributes: { commands: { command: string; icon?: string }[]; menus: Record<string, { command: string; when?: string }[]> };
  };
  const { STAGED_CONTEXT_KEY } = await import("../src/staged-review");

  for (const id of ["review-hub.stagedAcceptAll", "review-hub.stagedRejectAll"]) {
    const declared = pkg.contributes.commands.find((c) => c.command === id);
    assert.ok(declared, `${id} must be declared`);
    assert.ok(declared.icon, `${id} needs an icon to render in the editor title`);
    assert.ok(vscode.__commands.has(id), `${id} must be registered by activate()`);
  }

  const titleMenu = pkg.contributes.menus["editor/title"] ?? [];
  const entries = titleMenu.filter((i) => i.command.endsWith("stagedAcceptAll") || i.command.endsWith("stagedRejectAll"));
  assert.equal(entries.length, 2, "both buttons live in editor/title");
  for (const entry of entries) {
    assert.ok(entry.when?.includes(STAGED_CONTEXT_KEY), `a button must be gated on ${STAGED_CONTEXT_KEY}`);
    assert.ok(entry.when?.includes("resourceScheme == file"));
  }
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test`
Expected: **FAIL** — `review-hub.stagedAcceptAll must be declared`.

- [ ] **Step 3: Register the two commands**

In `src/extension.ts`, immediately after the `review-hub.rejectHunk` registration (line 547-549):

```ts
    // Editor-title buttons (spec D3): every hunk of the file being reviewed in place.
    vscode.commands.registerCommand("review-hub.stagedAcceptAll", () => decideActiveStaged("accept")),
    vscode.commands.registerCommand("review-hub.stagedRejectAll", () => decideActiveStaged("reject")),
```

…and, just above `async function decideFileById(...)` (line 643), the helper:

```ts
  const decideActiveStaged = async (kind: "accept" | "reject"): Promise<void> => {
    const active = vscode.window.activeTextEditor;
    const changeId = active ? staged.changeIdFor(active.document.uri.fsPath) : undefined;
    if (!changeId) {
      void vscode.window.showInformationMessage("Review Hub: no staged review in this file.");
      return;
    }
    await decide(changeId, undefined, kind);
  };
```

- [ ] **Step 4: Declare them in `package.json`**

Inside `contributes.commands`, after the existing `review-hub.rejectFile` entry:

```json
      {
        "command": "review-hub.stagedAcceptAll",
        "title": "Review Hub: Accept Every Change in This File",
        "icon": "$(check)"
      },
      {
        "command": "review-hub.stagedRejectAll",
        "title": "Review Hub: Reject Every Change in This File",
        "icon": "$(chrome-close)"
      }
```

Inside `contributes.menus`, alongside `view/title` and `explorer/context`:

```json
    "editor/title": [
      {
        "command": "review-hub.stagedAcceptAll",
        "when": "resourceScheme == file && reviewHub.hasStagedReview",
        "group": "navigation@1"
      },
      {
        "command": "review-hub.stagedRejectAll",
        "when": "resourceScheme == file && reviewHub.hasStagedReview",
        "group": "navigation@2"
      }
    ]
```

- [ ] **Step 5: Run the suite to verify it passes**

Run: `npm test`
Expected: **PASS** — **239 tests** (238 + 1), 0 fail.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/extension.ts package.json test/staged-wiring.test.ts
git commit -m "Task 6: editor-title Accept All / Reject All"
```

---

### Task 7: Exit flush and async `deactivate()`

**Files:**
- Create: `src/exit-flush.ts`
- Modify: `src/extension.ts:53` (module-scope `runtime`), `src/extension.ts:64-78` (set it), `src/extension.ts:821-823` (`deactivate`)
- Test: `test/exit-flush.test.ts`, plus one test appended to `test/staged-wiring.test.ts`

**Interfaces:**
- Consumes: `ChangeStore.listChangeSets(ws)`, `accept(changeId, hunkIds?)`, `pruneResolved(maxAgeMs?)`.
- Produces: `interface FlushStore { listChangeSets(workspace: string): ChangeSet[]; accept(changeId: string, hunkIds?: string[]): unknown; pruneResolved(maxAgeMs?: number): void }`, `interface FlushResult { accepted: number; workspaces: number }`, `flushPendingReviews(store: FlushStore, workspaces: string[]): FlushResult`.

- [ ] **Step 1: Write the failing tests**

Create `test/exit-flush.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChangeStore } from "../src/change-store";
import { flushPendingReviews } from "../src/exit-flush";

const OLD = "a\nb\nc\nd\n";
const NEW = "A\nb\nC\nd\n";

function fixture(): { ws: string; file: string; store: ChangeStore } {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-flush-"));
  const file = path.join(ws, "a.txt");
  fs.writeFileSync(file, OLD);
  const store = new ChangeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-flush-home-")) });
  return { ws, file, store };
}

test("a staged (mcp) change the user never touched lands as the agent's new code", () => {
  const { ws, file, store } = fixture();
  const cs = store.propose(ws, "a.txt", NEW);
  assert.equal(fs.readFileSync(file, "utf8"), OLD, "propose() writes nothing — review-then-apply");

  const result = flushPendingReviews(store, [ws]);

  assert.equal(result.accepted, 1);
  assert.equal(fs.readFileSync(file, "utf8"), NEW, "exit means: undecided = accepted (spec D6)");
  assert.equal(store.listChangeSets(ws).length, 0, "the cache is pruned");
});

test("a direct write (fs) change keeps the agent's bytes and is marked resolved", async () => {
  const { ws, file, store } = fixture();
  fs.writeFileSync(file, NEW);
  const observed = await store.observe(ws, "a.txt");
  assert.ok(observed, "the direct write is observed");
  assert.equal(observed!.origin, "fs");
  assert.equal(observed!.status, "pending");

  const result = flushPendingReviews(store, [ws]);

  assert.equal(result.accepted, 1);
  assert.equal(fs.readFileSync(file, "utf8"), NEW, "the file is untouched: the agent already wrote it");
  assert.equal(store.listChangeSets(ws).length, 0, "the record is resolved and pruned");
});

test("a hunk the user rejected survives the flush", () => {
  const { ws, file, store } = fixture();
  const cs = store.propose(ws, "a.txt", NEW);
  assert.equal(cs.hunks.length, 2, "two independent hunks");
  store.reject(cs.id, [cs.hunks[0].id]); // keep the baseline for hunk 1 only

  flushPendingReviews(store, [ws]);

  assert.equal(
    fs.readFileSync(file, "utf8"),
    "a\nb\nC\nd\n",
    "hunk 1 stays at the baseline, hunk 2 becomes the agent's new code",
  );
});

test("a window with nothing pending accepts nothing", () => {
  const { ws, file, store } = fixture();
  const cs = store.propose(ws, "a.txt", NEW);
  store.accept(cs.id); // already decided before the window closed

  const result = flushPendingReviews(store, [ws]);

  assert.equal(result.accepted, 0);
  assert.equal(fs.readFileSync(file, "utf8"), NEW);
});
```

> Note: the observed change must be `origin: "fs"` (status `pending`) *before* the flush runs —
> that is what proves the fs branch of `settle()` kept the agent's bytes.

- [ ] **Step 2: Run the suite to verify it fails**

Run: `npm test`
Expected: **FAIL** — esbuild: `Could not resolve "../src/exit-flush"`.

- [ ] **Step 3: Create `src/exit-flush.ts`**

```ts
/**
 * Exit flush (spec D6): when the window goes away, everything the user never decided
 * resolves to the AGENT's new code — the rule the user chose ("thoát VS Code → dùng code
 * mới của agents, dọn cache").
 *
 * Accepting only the *pending* hunk ids is deliberate: a hunk the user already rejected must
 * stay rejected, and a hunk already accepted stays as it is. For a change with no hunks
 * (binary, framing-only) the id list is empty, which resolves the set without touching any
 * decision. The store then writes the resolved bytes, advances the baseline and marks the
 * set `resolved`; `pruneResolved(0)` drops those records so the next start is genuinely
 * clean (this is what finally empties the ~200 historical entries).
 *
 * Pure of `vscode`: the store and the workspace list arrive as parameters, so the rule is
 * unit-testable and `src/extension.ts` only wires it.
 */
import type { ChangeSet } from "./types";

export interface FlushStore {
  listChangeSets(workspace: string): ChangeSet[];
  accept(changeId: string, hunkIds?: string[]): unknown;
  pruneResolved(maxAgeMs?: number): void;
}

export interface FlushResult {
  /** Changes this flush resolved (and therefore wrote / pruned). */
  accepted: number;
  workspaces: number;
}

export function flushPendingReviews(store: FlushStore, workspaces: string[]): FlushResult {
  const result: FlushResult = { accepted: 0, workspaces: workspaces.length };
  for (const workspace of workspaces) {
    for (const cs of store.listChangeSets(workspace)) {
      const pending = cs.hunks.filter((h) => h.decision === "pending").map((h) => h.id);
      store.accept(cs.id, pending);
      result.accepted++;
    }
  }
  store.pruneResolved(0);
  return result;
}
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm test`
Expected: **PASS** — **243 tests** (239 + 4), 0 fail.

- [ ] **Step 5: Wire it into `deactivate()`**

Module scope, right after the `Config` interface (which ends around line 34):

```ts
/**
 * What `deactivate()` needs. Set by `activate()`, cleared by `deactivate()` so a second
 * activation (tests) cannot flush twice. The body of `deactivate` contains no `await`, so it
 * runs to completion synchronously — the store is still alive when the flush happens, and
 * `context.subscriptions` teardown runs after it.
 */
let runtime:
  | {
      store: ChangeStore;
      workspaces: () => string[];
      log: (message: string) => void;
    }
  | undefined;
```

Add the type import: `import type { ChangeStore } from "./change-store";` (extend the existing
line 15 import: `import { DEFAULT_EXCLUDES, DEFAULT_INCLUDE_EXTENSIONS, type ChangeStore } from "./change-store";`).

Set it in `activate()`, right after `const hub = new HubServer({ … });` (after line 76):

```ts
  runtime = { store: hub.store, workspaces: workspaceFolders, log: (message) => logger.info(message) };
```

Replace `deactivate()` (line 821):

```ts
export async function deactivate(): Promise<void> {
  const pending = runtime;
  runtime = undefined;
  if (!pending) {
    return; // never activated (or already flushed)
  }
  try {
    const result = flushPendingReviews(pending.store, pending.workspaces());
    pending.log(`exit flush: ${result.accepted} change(s) accepted across ${result.workspaces} workspace(s), cache pruned`);
  } catch (err) {
    // Never block window teardown on a flush.
    pending.log(`exit flush failed: ${String(err)}`);
  }
}
```

Add the import at the top:

```ts
import { flushPendingReviews } from "./exit-flush";
```

- [ ] **Step 6: Write the failing wiring test**

Append this test to the **end** of `test/staged-wiring.test.ts` (after the package.json test):

```ts
test("deactivate() runs the exit flush before the window goes away", async () => {
  const { deactivate } = await import("../src/extension");

  await deactivate();

  assert.ok(
    vscode.__log.some((line) => line.includes("exit flush")),
    `the flush must log its summary; log was: ${vscode.__log.join(" | ")}`,
  );

  // Release the hub the first test started so the process can exit. `ctx` is the module-level
  // context created in Task 5 — activation already pushed its subscriptions onto it.
  for (const d of ctx.subscriptions) {
    d.dispose();
  }
  await new Promise((r) => setTimeout(r, 1500));
});
```

> This test runs last in the file (node:test runs a file's tests in order), so the flush sees the
> store the activation test created, and the disposal above is the file's teardown.

- [ ] **Step 7: Run the suite to verify it passes**

Run: `npm test`
Expected: **PASS** — **244 tests** (243 + 1), 0 fail.

- [ ] **Step 8: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/exit-flush.ts src/extension.ts test/exit-flush.test.ts test/staged-wiring.test.ts
git commit -m "Task 7: exit flush for pending reviews"
```

---

### Task 8: Documentation, version, package

**Files:**
- Modify: `README.md` (table of contents at line 14, new section after `## 14. Phát triển`)
- Modify: `package.json` (`version` → `0.2.0`)
- No test changes: the suite must stay at **244**.

- [ ] **Step 1: Add the section to `README.md`**

Append after the last line of `## 14. Phát triển`, and add the matching entry to `## Mục lục`:

```markdown
## 15. Inline staged review (kiểu Antigravity)

Khi agent sửa một file, Review Hub **thay nội dung buffer của file đó** bằng chế độ xem gộp:
mỗi khối thay đổi hiện **cả hai phía** — code cũ nền đỏ nằm trên code mới nền xanh — kèm
`✓ Accept` / `✗ Reject` ngay tại khối đó (CodeLens) và hai nút
**Accept All / Reject All** trên thanh tiêu đề editor.

| Thao tác | Kết quả |
|---|---|
| `✓ Accept` một khối | giữ code mới; khối đỏ biến mất; file trên đĩa ghi ngay dòng vừa chấp nhận |
| `✗ Reject` một khối | giữ code cũ; khối xanh biến mất; file trên đĩa lùi về dòng gốc |
| `Ctrl+S` khi còn khối chưa quyết | **bị chặn** — buffer đang là chế độ xem, không phải nội dung file |
| Quyết định xong khối cuối | buffer tự trả lại file trên đĩa (sạch, không còn gì chờ lưu) |
| Gõ tay vào buffer đang review | extension nhả file đó (không revert gì), record vẫn chờ bạn duyệt |
| Thoát VS Code khi còn change chưa quyết | change đó được **Accept** (lấy code mới của agent), cache dọn sạch |

Điều kiện:

- `files.autoSave` phải là `off` (mặc định). Nếu bạn bật auto-save, staging tự tắt và hiện
  thông báo **một lần** — thay vào đó file được highlight và hiện code cũ bằng ghost text như
  trước đây (bật `review-hub.autoOpenDiff` nếu muốn mở tab review tự động).
- File binary, file agent xoá, hoặc change không có hunk → không stage, giữ nguyên cơ chế cũ
  (highlight + tab review).
- File không stage được vẫn dùng đường cũ: `decide()` ghi đĩa rồi reload editor.
```

`## Mục lục` entry (keep the existing numbering):

```markdown
- [15. Inline staged review (kiểu Antigravity)](#15-inline-staged-review-kiểu-antigravity)
```

- [ ] **Step 2: Bump the version**

`package.json` → `"version": "0.2.0"` (0.1.1 was the reload fix; this is a feature release, so
VS Code offers the upgrade over the installed 0.1.1).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, **244 tests**, 0 fail, both bundles built.

Run: `npm run package`
Expected: a file named `review-hub-vscode-0.2.0.vsix` exists in the repo root.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "Task 8: document inline staged review; release 0.2.0"
```

> `*.vsix` is in `.gitignore` (line 4), so `review-hub-vscode-0.2.0.vsix` is a build artifact:
> verify it exists (Step 3) but do **not** `git add` it. The previous 0.1.1 artifact is likewise
> untracked — if it is still in the working tree, delete it so nobody installs a stale build:
> `rm -f review-hub-vscode-0.1.1.vsix`.

---

## Self-Review

**1. Spec coverage** (`docs/superpowers/specs/2026-10-08-inline-staged-review-design.md`):

| Spec item | Where |
|---|---|
| R1 red/green blocks + ✓/✗ in the real file | Task 1 (`buildStagedView`/`stagedMarks`), Task 3 (decorations), Task 4 (CodeLens) |
| R2 accumulate pending | nothing to do (spec D9) — `propose()` rebase is untouched |
| R3 Accept → new, Reject → old | unchanged `settle()`; Task 2 `restage()` makes it visible immediately |
| R4 exit → agent's new code + empty cache | Task 7 (`flushPendingReviews`, `pruneResolved(0)`) |
| D1 staging pipeline (3 triggers, skip rules) | Task 2 (`stage`, `stageSkipReason`), Task 5 (`stagePath` × 2, `onDidOpenTextDocument`) |
| D2 block decorations | Task 3 |
| D3 CodeLens + editor-title buttons + context key | Task 4, Task 6 |
| D4 one decision pipeline, fallback for unstaged | Task 5 (`decide`/`decideMany` re-stage; unchanged fallback), refinement F1 documented in the spec |
| D5 auto-save guard + one-time notice | Task 1 (`stageSkipReason`), Task 2 (`noticeOnce`), Task 5 (notice UI), refinement F4 |
| D6 exit flush + D6b reconciliation | Task 7 (flush), Task 2 (`adoptOpenDocuments`) + Task 5 (call) |
| F2 save guard | Task 2 (`handleWillSave`), Task 5 (`onWillSaveTextDocument` host) |
| F3 never revert a mismatched buffer | Task 2 (`adoptOpenDocuments`), asserted by the "left exactly as it is" test |
| D7 loop safety / lift on user edit | Task 2 (`handleTextChange`), Task 5 (`noteSelfWrite` path untouched) |
| D8 no review tab for a staged file | Task 5 (`flushAutoOpen` skip) |
| Test strategy (TDD, ≈244 tests) | every task's RED → GREEN steps; arithmetic below |

**2. Placeholder scan:** no `TBD`/`TODO`/“handle edge cases”/“similar to Task N” remains; every
code step carries the actual code, every run step carries the command and the expected result.

**3. Type consistency:** `StageSkipReason` = `"binary" | "no-hunks" | "already-decided" | "auto-save"`
(Task 1) ⊂ `StageNotice` (Task 2); `stagedMarks(view, docLineCount)` used identically in Tasks 1/3;
`buildStagedView` in Tasks 1/3/4; `lensesFor(..., counts?)` optional so the two existing call sites
stay valid; `ChangeDecorator`/`HunkCodeLensProvider` second parameters optional so existing tests
compile unchanged; `flushPendingReviews(store, workspaces)` matches Task 7's `runtime` wiring;
`STAGED_CONTEXT_KEY` is the single string used by Task 5's `setContext` and Task 6's `when` clause.

**Test arithmetic:** 207 → +12 (Task 1) 219 → +12 (Task 2) 231 → +3 (Task 3) 234 → +3 (Task 4)
237 → +1 (Task 5) 238 → +1 (Task 6) 239 → +5 (Task 7) 244 → +0 (Task 8) = **244**.


