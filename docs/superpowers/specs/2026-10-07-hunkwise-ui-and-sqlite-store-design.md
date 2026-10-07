# Review Hub — Hunkwise-style UI, decide-to-disk apply model, SQLite store

Date: 2026-10-07
Status: approved; implemented
Scope: architectural (new UI subsystem, changed write semantics, new persistence layer)

## 1. Goal

Make Review Hub feel like [`molon/hunkwise`](https://github.com/molon/hunkwise): per-hunk
**✓ Accept / ↺ Discard** controls, added lines green, removed lines red, a sidebar panel listing
files and hunks — while keeping Review Hub's own MCP layer so AI agents (Claude Code, opencode,
dsh, Cline, Roo) stage their edits for review instead of writing straight to disk.

Three concrete problems drive this:

1. **Clicking Accept only re-labels the hunk.** Today `propose_*` writes the agent's content to
   disk immediately, so the file already holds the new code before the user decides. Accept then
   just advances the baseline and flips a CodeLens badge to "Accepted". Nothing visibly happens —
   the user's words: *"tôi bấm accept thì nó phải chấp nhận code đó, trong khi hiện tại lại đổi
   thành accepted"*.
2. **Removed lines are not red.** `src/change-decorator.ts:48-51` creates the deletion marker
   decoration **without a `backgroundColor`** — only an overview-ruler colour and ghost text. The
   comment there explains why: a deleted line is no longer on disk, so a line decoration cannot
   colour it.
3. **The UI does not look like hunkwise.** Review Hub uses a native `TreeDataProvider`
   (`src/changes-tree.ts`) plus a virtual merged document with CodeLens. hunkwise uses a webview
   panel and inline editor insets.

## 2. Hard constraints (verified, not assumed)

These were researched and confirmed; they shape the design.

### 2.1 No proposed APIs, and no third-party libraries

The user requires: **a `.vsix` installable from the Marketplace, using no external APIs** —
anything needed must be written by hand.

That rules out hunkwise's own inline mechanism. hunkwise renders a multi-line red deleted-lines
block *inside the real editor* with `vscode.window.createWebviewTextEditorInset`
(`hunkwise/src/decorationManager.ts:293`), which is the **proposed `editorInsets` API**
(`hunkwise/package.json:15-17`). hunkwise's README states it "cannot be installed from the
marketplace" for exactly this reason.

Research findings (see `ANTIGRAVITY_INLINE_DIFF_RESEARCH.md`):

- `microsoft/vscode#85682` "Api for editor insets" — **open since 2019**, milestone Backlog, 214👍.
- `microsoft/vscode#260313` — closed as duplicate; maintainer jrieken: *"There are currently no
  plans"* to expose the inline-diff view to extensions.
- No open-source extension achieves multi-line inline red/green in the real buffer using only
  stable APIs.

**Therefore: a Marketplace-installable extension structurally cannot put a multi-line red block
inline in the real file.** The stable ceiling is:

| Technique | Stable? | Multi-line inline in real file? |
|---|---|---|
| `TextEditorDecorationType` (whole-line background) | yes | colours existing lines only |
| `renderOptions.before`/`after` injected text | yes | **single line only** |
| `CodeLens` | yes | buttons, no diff content |
| `vscode.diff` + `TextDocumentContentProvider` | yes | separate tab |
| Webview (panel or editor tab) | yes | **yes, fully custom** — but a separate surface |
| `createWebviewTextEditorInset` | **proposed** | yes — **excluded** |

Antigravity is a **fork of VS Code** (it patches the workbench and may use internal APIs), so its
inline review UI is not reproducible by an extension. We can borrow its *layout and interaction
model*, not its *mechanism*.

**Consequence:** the red/green multi-line diff moves into a **webview**, where it is fully under our
control. The real editor keeps stable decorations (green background on added lines, single-line red
ghost text for deletions) and CodeLens.

### 2.2 SQLite: use the Node built-in, and pin `engines` accordingly

The user wants "một db nhỏ như sqlite" to manage changes. `node:sqlite` (`DatabaseSync`) is a
**Node built-in module**, not a third-party dependency, so it satisfies §2.1. Verified:

- Unflagged from **Node 22.13.0** (nodejs/node#55890; changelog entry in
  `doc/changelogs/CHANGELOG_V22.md`).
- Runs clean in a CJS context with no flags: `create table`, prepared `insert`/`select`,
  `begin`/`commit` all OK (spike run in this session).
- Present in the user's local extension host (VS Code 1.140 via Remote/WSL, Node 24.21.0).

**Electron caveat — the reason `engines` must move.** Electron 37.2.0 shipped **without**
`node:sqlite` (`require('node:sqlite')` threw `No such binding: sqlite`,
electron#47671). Cause: the Node bump to 22.17.0 (electron#47555) dropped sqlite from the GN build
config. Fixed on `main` 2025-07-15 (electron#47706) and backported to 37-x-y 2025-07-16
(electron#47756), 36-x-y (electron#47755), 38-x-y (electron#47757). Electron 35 additionally
required `--experimental-sqlite` (electron#45532).

| VS Code | Electron | Node | `node:sqlite` |
|---|---|---|---|
| ≤ 1.102 | 35.6.0 | 22.15.1 | not reliable |
| **1.103** | **37.2.3 (2025-07-16)** | 22.17.0 | ✅ includes the fix |
| 1.104 | 37.3.1 | 22.18.0 | ✅ |
| 1.105+ | 37.6.0 | 22.18+ | ✅ |

So `engines.vscode` becomes **`^1.103.0`** (currently `^1.85.0`). This drops VS Code 1.85–1.102.

### 2.3 The store must survive a missing `node:sqlite`

Because §2.2 is an environment hazard, `node:sqlite` is wrapped behind a storage interface with a
JSON fallback. If the driver cannot be loaded, the extension degrades to the current file-backed
behaviour instead of failing to activate.

## 3. Apply model: review-then-apply

This is the fix for problem 1, and it is the most invasive change.

### 3.1 Today vs proposed

| | Today | Proposed |
|---|---|---|
| `propose_edit` / `propose_write` | writes the agent's content to disk immediately (`change-store.ts:737`) | **stores it only; disk untouched** |
| File on disk | baseline + all proposed hunks | baseline + **decided** hunks only |
| Accept hunk | baseline advances; disk unchanged | **writes that hunk's new lines to disk** |
| Reject hunk | restores baseline lines | leaves baseline lines in place (no write) |
| Pending hunk | present on disk | **absent from disk** |

The user's requirement, verbatim: *"Chỉ ghi lên đĩa những phần mà tôi bấm chấp nhận hoặc hủy."*
(Only write to disk the parts I accept or reject.)

### 3.2 How this is implemented

`hunk-diff.ts` already parameterises pending-hunk behaviour: `resolveLines(baselineLines, hunks,
pendingMode)` where `pendingMode` is `"proposed"` or `"baseline"`. `resolveLines(..., "baseline")`
yields exactly the semantics in §3.1: accepted hunks contribute their new lines, rejected and
pending hunks contribute their baseline lines.

Changes required:

1. `ChangeStore.propose()` — remove the `writeFileAtomic(abs, proposed)` call
   (`change-store.ts:736`) and the delete-on-propose path. Set `applied: false`.
2. `ChangeStore.settle()` — pass `"baseline"` instead of `"proposed"` when resolving
   (`change-store.ts:902`) so only decided hunks reach disk.
3. `applied` semantics change meaning: it now means "the disk reflects every hunk" (true only once
   the change resolves), not "the proposal is on disk".

`settle()` already calls `applyToDisk()` on every decision, so per-hunk writes work without new
plumbing. Accept writes the file with the accepted hunks materialised; reject writes it back to
baseline where nothing was accepted.

### 3.3 The consequence that must not be missed: `read` must see staged content

`GET /file/read` reads from **disk** (`hub-server.ts:237`). Under review-then-apply, disk no longer
holds the agent's pending edits, so an agent that makes two sequential `propose_edit` calls would
have the second call fail: its `old_string` comes from the first call's output, which is not on
disk.

`propose_edit` already reads through the hub before computing the replacement
(`mcp/mcp-server.ts:232-238`). Therefore **`/file/read` must return the *staged* content when a
pending change exists for that path** — i.e. baseline with every hunk (pending and accepted)
materialised, and rejected hunks left at baseline. Only when no change exists does it fall back to
disk.

The same rule applies to the `read_file` MCP tool (`mcp/mcp-server.ts:291-301`), which shares the
route.

This is a correctness requirement, not a nicety: without it the agent's own edit sequence breaks.

### 3.4 Residual risk: agents that read the file natively

An agent using its built-in `Read`/`cat` sees baseline content and may believe its own edit was
lost, then rewrite it. Mitigations:

- `AGENTS.md` / `CLAUDE.md` block (installed by `review-hub.installInstructions`) already directs
  agents to the hub's `read_file`; strengthen the wording to say the on-disk file lags until the
  user decides.
- The `propose_*` tool result note explains that staging is success and that the file will not show
  the change until the user accepts.

This risk is inherent to review-then-apply and is accepted, with documentation as the mitigation.

## 4. UI design

Two surfaces, both using stable APIs.

### 4.1 Sidebar webview panel (hunkwise-style)

Replaces the native tree in `src/changes-tree.ts` with a `WebviewViewProvider` in the existing
`review-hub` activity-bar container.

Layout, modelled on hunkwise's `media/panel.js` review screen:

```
┌──────────────────────────────────────────┐
│ Review Hub            3 files  +42 −17   │
│ [✓ Accept All]  [↺ Discard All]          │
├──────────────────────────────────────────┤
│ ▾ src/hub-server.ts            +12 −4    │
│     @line 108   +4 −1   [✓] [↺]          │
│     @line 231   +8 −3   [✓] [↺]          │
│ ▸ src/change-store.ts          +30 −13   │
│ ▸ src/new-file.ts        [new]  +0 −0    │
└──────────────────────────────────────────┘
```

- Header: total file count and `+added / −removed` across the workspace.
- Batch actions: accept/discard all (with the existing confirmation for destructive scope).
- One collapsible row per file: chevron, file name, directory, `new` / `deleted` badge, stats,
  hover file-level ✓ / ↺.
- Expanded: one row per hunk showing `@line N` and `+a −b`, each with ✓ / ↺.
- Clicking a hunk row opens the review tab at that hunk.

Message protocol: inbound (extension → webview) uses `type`, outbound (webview → extension) uses
`command`, matching hunkwise's convention so the ported panel code stays legible. Messages:
inbound `update` / `loading`; outbound `ready`, `acceptHunk`, `rejectHunk`, `acceptFile`,
`rejectFile`, `acceptAll`, `rejectAll`, `openHunk`, `openFile`, `setCheckpoint`.

The panel is a pure renderer: it receives a serialisable state object and posts commands. All
decisions go through the same `ChangeStore` calls the commands already use.

### 4.2 Review tab webview (the red/green diff)

The primary review surface, replacing the merged virtual document (which is being removed — see
§4.3). One webview tab per file, opened from the panel or from a file's badge.

Per hunk it renders three regions, in order:

- **Context** — unchanged baseline lines, neutral.
- **Removed** — the hunk's baseline lines, `background: removedLineBackground` (red).
- **Added** — the hunk's proposed lines, `background: insertedLineBackground` (green).

Above each hunk, a decision bar: **✓ Accept** / **↺ Reject**, plus `+a −b`. A decided hunk renders
its resolved form (accepted → added lines only; rejected → removed lines only) with the bar showing
the current decision and a way to undo it, mirroring the current merged view's behaviour.

Colours come from VS Code theme variables (`--vscode-diffEditor-removedLineBackground`,
`--vscode-diffEditor-insertedLineBackground`, plus `--vscode-editor-*` for text), so the tab matches
the user's theme exactly as hunkwise's insets do.

The document text is assembled by the existing pure function `buildMergedView`
(`src/merged-diff.ts`), which already produces `lines` plus `blocks` tagged
`context` / `deleted` / `added` with line ranges. The webview consumes those blocks directly, so no
diff logic is duplicated in JavaScript and the existing tests keep covering it.

This is where problem 2 is actually solved: a webview can render as many red rows as it likes,
which a `TextEditorDecorationType` cannot.

### 4.3 Removals

- **`src/changes-tree.ts`** — replaced by the webview panel. Its `FileNode` type is imported by
  `src/extension.ts` in eight places (`extension.ts:9, 365, 471, 478, 485, 499-501, 600`) for
  command arguments and `resolveChange`. That type moves to `src/types.ts` as a plain
  `{ workspace: string; path: string }` — webview commands cannot pass a class instance across the
  message boundary, so a serialisable shape is required anyway. `TreeNode`, `FolderNode`,
  `CheckpointNode` and `ChangesModel` are deleted with the file.
- **`src/merged-diff.ts`** — **kept**; it becomes the review tab's renderer rather than the merged
  virtual document's. Its unit tests stay valid.
- **Merged virtual document** — removed: the `review-hub://merged/...` authority in
  `src/content-provider.ts` and its CodeLens branch in `src/diff-view.ts:34-48`. The user chose to
  delete it rather than keep it alongside the webview.
- **`review-hub.openDiff`** — re-pointed at the review tab webview.
- **`review-hub.openSideBySide`** — kept; the built-in `vscode.diff` of baseline vs proposed remains
  a useful second opinion.

### 4.4 Real-file decorations (kept, and improved)

`src/change-decorator.ts` keeps working, with its limitation documented rather than hidden:

- Added lines: whole-line green background (unchanged).
- Removed lines: the current ghost-text approach stays, because a multi-line red block is
  impossible without the proposed API. The **overview ruler and gutter marker** are kept so the
  deletion is still discoverable, and the ghost text now carries a red foreground so the deletion
  reads as red even though it cannot have a red row.

CodeLens ✓/↺ stays on the real file (`src/diff-view.ts:66-78`) so a hunk can be decided without
opening any review surface.

## 5. SQLite store

### 5.1 Placement and schema

One database per user: `~/.review-hub/hub.db`, replacing the per-workspace JSON files under
`~/.review-hub/workspaces/<hash>/changes/*.json` and `checkpoint.json`.

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  workspace  TEXT PRIMARY KEY,
  set_at     INTEGER NOT NULL,
  files_json TEXT NOT NULL          -- path -> {hash, exists}
);

CREATE TABLE IF NOT EXISTS changes (
  id              TEXT PRIMARY KEY,
  workspace       TEXT NOT NULL,
  path            TEXT NOT NULL,     -- workspace-relative, POSIX
  abs_path        TEXT NOT NULL,
  origin          TEXT NOT NULL,     -- 'mcp' | 'fs'
  applied         INTEGER NOT NULL,
  status          TEXT NOT NULL,     -- 'pending' | 'applied' | 'resolved'
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
  change_id  TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  ordinal    INTEGER NOT NULL,       -- preserves display order
  old_start  INTEGER NOT NULL,
  new_start  INTEGER NOT NULL,
  old_lines  TEXT NOT NULL,          -- JSON array
  new_lines  TEXT NOT NULL,          -- JSON array
  decision   TEXT NOT NULL,          -- 'pending' | 'accepted' | 'rejected'
  PRIMARY KEY (change_id, id)
);

CREATE INDEX IF NOT EXISTS idx_changes_workspace ON changes(workspace);
CREATE INDEX IF NOT EXISTS idx_changes_status    ON changes(workspace, status);
```

Baseline *blobs* stay content-addressed on disk exactly as today
(`~/.review-hub/workspaces/<hash>/baselines/<hash>`); only the small change records move into
SQLite. This keeps the database small and avoids rewriting large file contents on every decision.

### 5.2 Driver wrapper

`src/sqlite.ts`:

```ts
export interface SqlDriver {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: unknown[]): T[];
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(file: string): SqlDriver | undefined;  // undefined when unavailable
```

`openDatabase` lazily `require("node:sqlite")` inside a try/catch. On failure it returns
`undefined` and logs a warning once. `node:sqlite` is CJS-requireable; the extension bundle is CJS,
so no interop shim is needed. Verified in this session that esbuild leaves it as an external
`require("node:sqlite")` rather than trying to inline it, so no `external:` entry is required. The
`ExperimentalWarning` it may emit is suppressed by filtering that one warning from the logger, not
by muting all warnings.

**Build config also changes.** `esbuild.js` currently sets `target: "node18"` for both bundles. It
becomes `node22` so esbuild does not down-level syntax the SQLite-era runtime supports. The
`node:sqlite` require stays a runtime `require`, so this is a syntax-target change only.

### 5.3 Fallback path

`ChangeStore` keeps its current JSON implementation as `JsonBackend`, and gains
`SqliteBackend`. A thin `StoreBackend` interface covers the operations `ChangeStore` already
exposes. Selection happens once at construction:

```ts
const driver = openDatabase(path.join(baseDir, "hub.db"));
this.backend = driver ? new SqliteBackend(driver) : new JsonBackend(baseDir);
```

Rationale: §2.2 shows real Electron builds have shipped without `node:sqlite`. A review tool that
refuses to activate on such a build would be worse than one that silently uses JSON. The fallback
is not a second-class path — it is the current, tested implementation.

### 5.4 What does not change

`HubServer` (`src/hub-server.ts`) and the MCP server talk to `ChangeStore` through its existing
public methods — `propose`, `observe`, `accept`, `reject`, `listChanges`, `findById`,
`findChangeByPath`, `getChange`, `setCheckpoint`, `clearCheckpoint`, `checkpointInfo`, `undo`. The
backends implement behind those signatures, so **neither HTTP routes nor MCP tool definitions
change**, and `mcp-server.cjs` does not need to know SQLite exists.

The 120 existing tests are the safety net for this refactor. `test/change-store.test.ts`,
`test/decision-flow.test.ts`, `test/accept-all.test.ts`, `test/hub-server.test.ts`,
`test/mcp-forward.test.ts` and `test/e2e.test.ts` must all still pass.

## 6. Files touched

| File | Change |
|---|---|
| `src/sqlite.ts` | **new** — driver wrapper, `SqlDriver`, `openDatabase` |
| `src/store-backend.ts` | **new** — `StoreBackend` interface, `SqliteBackend`, `JsonBackend` (moved from `change-store.ts`) |
| `src/change-store.ts` | thin facade over a backend; `propose()` no longer writes; `settle()` uses `"baseline"` pending mode |
| `src/hub-server.ts` | `/file/read` returns staged content when a change exists |
| `src/review-panel.ts` | **new** — sidebar `WebviewViewProvider` |
| `src/review-tab.ts` | **new** — review webview tab, renders `buildMergedView` blocks |
| `media/panel.html`, `media/panel.css`, `media/panel.js` | **new** — sidebar assets |
| `media/review.html`, `media/review.css`, `media/review.js` | **new** — review tab assets |
| `src/changes-tree.ts` | **deleted** — replaced by the panel |
| `src/content-provider.ts` | drop the `merged` authority |
| `src/diff-view.ts` | drop the merged CodeLens branch; re-point `openDiff` at the review tab |
| `src/change-decorator.ts` | red foreground on the deletion ghost text |
| `src/extension.ts` | register the panel + review tab; re-point command arguments |
| `package.json` | `engines.vscode` → `^1.103.0`; new view + commands; keep settings |
| `README.md` | document the new model and the `engines` bump |

## 7. Testing

- **Existing 120 tests** must stay green. The store refactor is the main risk; the backend
  interface is what makes them meaningful.
- **New, pure (no `vscode`)**: `sqlite.test.ts` — schema creation, upsert/read round-trip, hunk
  cascade delete, transaction rollback; `store-backend.test.ts` — the same scenario run against
  both backends and asserted to produce identical results.
- **New, semantics**: a test asserting that after `propose()` **the file on disk is unchanged**,
  after `accept(hunk)` only that hunk's lines are on disk, and after `reject(hunk)` the baseline
  lines are present. This is the regression test for the reported bug.
- **New, `/file/read`**: two sequential `propose_edit` calls against one file must both succeed.
- **Panel/tab JS** is not unit-tested (no DOM harness); the state-building function is extracted
  into `src/review-panel-state.ts` so it is testable without a webview.

## 8. Out of scope

- Inline multi-line red blocks in the real editor. Impossible without the proposed API (§2.1).
- Replacing hunkwise's git-blob baseline store — Review Hub keeps its own content-addressed
  baselines and its checkpoint model.
- Multi-root behaviour beyond what exists today.
- Any change to how agents are registered (harness config writing is untouched).

## 9. Resolved: the engines bump

`engines.vscode` moves from `^1.85.0` to `^1.103.0`, dropping VS Code 1.85–1.102. This is required
for the Electron SQLite fix. If supporting those older versions matters more than SQLite, the JSON
backend is the default and `engines` can stay at `^1.85.0` — say so and §5 becomes
"SQLite when available, JSON otherwise, no version bump".

Resolved 2026-10-07: the user accepted `engines.vscode = "^1.103.0"`. SQLite is the default
backend, with the JSON backend as the fallback when `node:sqlite` is missing.

## 10. Licensing note

hunkwise is MIT (`Copyright (c) 2025 molon`). The design borrows its **layout and interaction
model**; the panel is written fresh against Review Hub's own store, not copied. If any hunkwise
code or asset is copied verbatim during implementation, the MIT notice must be reproduced — this
applies in particular to `hunkwise/src/vscode.proposed.editorInsets.d.ts`, which is not being used
at all under §2.1.
