# Inline staged review in the real file — the Antigravity model

Date: 2026-10-08
Status: approved (design approved in chat 2026-10-08; plan: `docs/superpowers/plans/2026-10-08-inline-staged-review.md`)
Scope: feature (new staging layer over the existing review-then-apply write model)

## 1. Context

The user reviews agent edits **inside the real file**, the way Google's Antigravity does:

> *"Khi agents có thay đổi code thì hiển thị ở mỗi khối thay đổi: code cũ nền đỏ, code mới nền
> xanh, có ✓ Accept / ✗ Reject. Tôi đồng ý thì lấy code mới, tôi reject thì giữ code cũ. Khi tôi
> thoát chat hoặc có chat mới thì cộng dồn nếu tôi chưa xử lý. Tôi thoát khỏi VS Code thì xóa cache
> thay đổi và dùng code mới của agent nếu tôi chưa thao tác gì."*

Four requirements:

| | Requirement | State today |
|---|---|---|
| **R1** | Per-block old (red) / new (green) + ✓/✗ **in the real file** | Missing — the real file only gets a one-line ghost preview (`src/change-decorator.ts`); old code is only visible in the review tab / side-by-side diff |
| **R2** | Pending changes accumulate across chats/sessions | **Already correct** — `propose()` rebases decisions; nothing clears pending |
| **R3** | Accept → new code, Reject → old code | Correct at the data layer (`settle()`/`applyToDisk`), but in the `origin: fs` case Accept is a silent no-op because the agent already wrote the file |
| **R4** | Exit VS Code → unreviewed = the agent's new code, cache cleared | Missing — `deactivate()` is empty (`src/extension.ts:821`) |

Evidence that shapes the design: on this machine **200/200 recorded changes are `origin: "fs"`**
(the agent writes the file directly with Write/Edit; MCP `propose_*` was never called — `AGENTS.md`
had no Review Hub block). So the "agent's new code is already on disk" case is the default one, and
it is exactly the case Antigravity handles by staging the *display* in the buffer while leaving disk
alone.

## 2. Constraints (verified, not assumed)

1. **Stable extension API only.** The user runs VS Code **1.140.0 stable**; `editorInsets` (the only
   multi-line inline API) is still a proposed API, open since 2019 (`microsoft/vscode#85682`,
   Backlog). No proposed API, no patched workbench, no new dependency. See
   `ANTIGRAVITY_INLINE_DIFF_RESEARCH.md`.
2. **The Antigravity *extension* (`google.google-antigravity-1.7.0`) proves the ceiling is enough.**
   Read from its bundle on this machine: it stages `combinedText` into the buffer
   (`applyContentReplacement`), colours whole lines with `diffEditor.removedTextBackground` /
   `insertedTextBackground` + `border*` (12 `createTextEditorDecorationType`, `isWholeLine`), and
   puts ✓/✗ CodeLenses on each block. `enabledApiProposals` is absent, `engines ^1.80.0`.
3. **`files.autoSave` is `off` on this machine** (verified: not set in `~/.vscode-server/data/Machine/settings.json`),
   so the full staging mode is available; Antigravity itself warns and falls back when auto-save is on.
4. **Antigravity defaults:** `antigravity.enableInlineDiff = true`, `antigravity.autoOpenFiles = false`
   (from the manifest). We mirror both: inline staging on by default, no file auto-open.
5. **The write model must not change.** `propose()` still writes nothing, `settle()` still decides
   from the real decision (not `hunks.length`), `applyToDisk()` still writes bytes exactly. The new
   layer sits **on top** of it.
6. **Existing guarantees:** 207 tests green, `tsc --noEmit` clean, `engines.vscode ^1.103.0`, no
   `innerHTML`/`eval` in webviews, `node:sqlite` stays a Node built-in.

## 3. Goals / Non-goals

**Goals**

- **G1** Inline staged view in the real file: red old block, green new block, ✓/✗ CodeLens per
  block, Accept All / Reject All in the editor title — on stable 1.140.
- **G2** One decision pipeline for both origins: every decision goes through `ChangeStore.accept/reject`
  (disk framing, baseline advance, watcher suppression) — the staged buffer is a *view*, never the
  source of truth.
- **G3** Exit flush: on deactivate every still-pending change resolves to the **agent's new code**,
  resolved records are pruned, and the next activation reconciles any buffer hot-exit restored.

**Non-goals**

- No proposed API, no workbench patch, no third-party library.
- No auto-revert of files when a change is observed; no retroactive staging of the ~200 historical
  changes beyond what exit-flush cleans up.
- No change to `settle()`/`applyToDisk()`/`propose()` semantics, and no second review surface — the
  review tab and side-by-side diff stay as fallbacks.

## 4. Decisions (approved in chat)

**D1 — Staging pipeline** (new module `src/staged-review.ts`)
Stage when: (a) the watcher observes a new change in this session, (b) an MCP `propose` arrives, or
(c) the user opens a file that still has a pending change. Build the text with `buildMergedView()`
(`src/merged-diff.ts:48`) and replace the whole buffer with a `WorkspaceEdit` — **disk never changes
by staging** (fs already holds the new code, mcp still holds the baseline). Skip when the file is
binary / has no hunks / is not a `file` URI / the buffer is already dirty from the user's own edits.

**D2 — Block decorations** (extend `src/change-decorator.ts`)
While a file is staged, decorate from `MergedView.blocks`: `deleted` → `diffEditor.removedLineBackground`
+ left border, `added` → `diffEditor.insertedLineBackground` + left border, both `isWholeLine`;
hover shows the hunk label and the full old/new text. A file that is **not** staged keeps today's
green + ghost-text behaviour unchanged.

**D3 — CodeLens** (extend `src/diff-view.ts`)
Anchor each hunk at `MergedHunk.anchor` (a merged-view line), `$(check) Accept` · `$(chrome-close) Reject`
+ a count lens (`−4 lines, +2 lines`) whose tooltip carries the old code. Two extra buttons in the
editor title — Accept All / Reject All for the active file — behind the context key
`reviewHub.hasStagedReview`.

**D4 — Decisions**
Accept → the new lines, Reject → the old lines, per hunk, immediately visible in the file. A change
that cannot be staged falls back to today's `decide()`/`decideMany()` disk-write + `reloadOpenEditors`.

**D5 — Auto-save guard** (copy Antigravity)
If `files.autoSave ≠ "off"` staging is skipped entirely (the buffer stays equal to disk, so nothing
unsaved can be flushed by the timer) and a one-time notice offers: turn auto-save off / open the
review tab / don't show again.

**D6 — Exit flush** (`deactivate()` becomes async)
For every change still pending in this window's workspaces: `store.accept(id)` — which writes the
agent's proposed content (fs: already there, mcp: materialised now) and advances the baseline — then
`pruneResolved(0)` so the cache is genuinely empty. A crash/force-kill skips this, so activation runs
a reconciliation pass over the open documents (D6b, below).

**D7 — Loop safety**
Staging never touches disk, so the watcher never re-observes our own edit; every `save()` the
extension performs stays wrapped in `watcher.noteSelfWrite()` (2 s). If the user types into a staged
buffer, staging is **lifted for that file** (nothing is reverted, the record stays pending) and the
observe/rebase machinery rebalances when they save.

**D8 — Review tab & discoverability**
When a change is staged, the inline buffer *is* the review surface: the auto-open of the review tab
is suppressed for it. `autoOpenDiff` keeps working for changes that could not be staged. No file is
opened automatically (Antigravity's `autoOpenFiles = false`).

**D9 — R2 needs no code** — pending already accumulates.

## 5. Refinements applied while writing the plan

Four points of the chat design were tightened before implementation, because a literal reading of
them loses data or writes the wrong bytes. Each keeps the *observable* behaviour the user approved.

- **F1 (replaces D4's mechanism).** D4 said "Accept = delete the `deleted` block from the buffer →
  `save()`". With two or more pending hunks the buffer still holds the other hunk's old block, so
  `save()` would write the **display text (old + new interleaved) to disk** — file corruption. The
  plan instead: the decision always runs through `ChangeStore.accept/reject`, which writes the
  correctly resolved bytes, and the buffer is then **re-staged** (`restage()`) purely as a view.
  The buffer is saved to disk only when it is byte-identical to disk (see F2).
- **F2 (new guard).** While a staged file still has a pending hunk, an explicit save is refused via
  `onWillSaveTextDocument.preventDefault()` plus a one-time message. When the last hunk is decided
  the merged text equals the resolved file, so `restage()` **unstages and reverts** the editor —
  clean buffer, disk framing (`EOL`/`BOM`) taken from what `settle()` actually wrote.
- **F3 (softer than D6b).** D6b said a hot-exit buffer that does not match the known combined text
  should be *reverted to disk*. That destroys the user's own unsaved edits after a crash. The plan
  instead **leaves such a buffer alone** (staging not adopted, record stays pending) — no data loss,
  and the existing decoration/CodeLens path still reviews it.
- **F4 (narrower D5).** No separate `hideDeletedLines` rendering mode: skipping staging while
  auto-save is on already leaves the buffer equal to disk, and today's ghost text + hover already
  show the old code. The notice from D5 is kept.

## 6. Risks / trade-offs

| Risk | Handling |
|---|---|
| Hidden dirty document (file staged but never opened) | `deactivate()` flush writes the outcome to disk; hot-exit backs up *editors*, so an unopened staged document is simply discarded — no save prompt |
| Hot-exit restores a staged buffer after a crash | Reconciliation on activation: content matches the recomputed merged text → re-adopt; mismatch → lift staging and leave the buffer alone (F3) |
| Two windows on the same folder | Accepted for v1 (Antigravity behaves the same); staging is per window, the store is shared |
| `document.save()` fails (read-only file) | The save is prevented while pending anyway; the decision path already falls back to `writeFileAtomic` |
| The ~200 historical changes | Not staged (most are resolved by the first exit flush); they keep the current decoration path |
| Format-on-save / manual edit inside a staged buffer | User edit → staging lifted (D7); format-on-save only runs on save, which is prevented while pending |

## 7. Test strategy

TDD, RED → GREEN, per task. Pure modules first (`staged-content`, `exit-flush`), then the engine
against injected fakes (`StagedReview` takes a `StagedHost`, so no VS Code stub is needed for its
logic), then the VS Code glue (decorations, CodeLens) against the extended `test/vscode-stub.ts`.
Baseline: **207 tests**; the plan targets **244**. Every task ends with
`npm run typecheck && npm test` green before committing.
