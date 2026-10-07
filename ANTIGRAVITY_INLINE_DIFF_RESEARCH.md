# How Antigravity renders inline diff review — and what a marketplace VS Code extension can/cannot do

Research report. Sources are cited inline. Everything that is inference rather than documented fact is
explicitly labelled **[SPECULATION]**.

---

## TL;DR

1. **Antigravity is a VS Code fork** (standalone Chromium/Electron desktop app built from modified VS
   Code source). Google also ships a lighter **official extension** for stock VS Code / JetBrains / Zed.
   The inline red/green review UI is a *core-workbench* feature of the fork, not something an
   extension reproduces.
2. The fork can use **internal/private APIs and patch the workbench**; a marketplace extension cannot.
   The concrete mechanism Antigravity uses is **[SPECULATION]** but the public evidence points to a
   **custom URI scheme (`jetski-diff`) feeding a custom/`vscode.diff` editor**, plus workbench-level
   "diff zones". What is *documented* is that the review surfaces changes in the editor with
   per-hunk Accept/Reject.
3. **There is NO stable, documented VS Code extension API that renders a multi-line red "deleted
   lines" block inline in the middle of a real text editor.** The only API that can do multi-line
   inline content is the **`editorInsets` proposed API** (Insiders-only, cannot be published to the
   Marketplace). Everything stable is either single-line injected text or a *separate* editor tab.
4. **No open-source extension achieves true multi-line inline red/green inside the real file using
   only stable APIs.** `molon/hunkwise` gets closest but requires the proposed `editorInsets` API. The
   stable-only workarounds are: (a) full-line background decorations + single-line ghost text, or
   (b) a virtual "merged" document, or (c) the built-in diff editor.
5. **`microsoft/vscode#85682` ("Api for editor insets") is OPEN**, milestone **Backlog**, 214 👍,
   open since 2019 — i.e. the very API needed is still unshipped. A 2025 duplicate request
   (`#260313`) was **closed as duplicate**, with a maintainer stating *"There are currently no plans"*
   to expose the Copilot inline-diff view to extensions.

---

## Q1. Fork or extension?

**Both exist, but they are different products.**

- **Antigravity (the IDE)** is a **fork of VS Code** — a standalone Chromium/Electron desktop
  application built from a modified VS Code source tree, in the same family as Cursor/Windsurf.
  - Wikipedia and Google's own material describe the architecture as a VS Code fork.
  - Because it is a fork, it uses the **Open VSX registry** (not the Microsoft Marketplace) for
    extensions, since a fork cannot legally use the proprietary Marketplace.
  - Refs: <https://antigravity.google>, Wikipedia entry on Google Antigravity, and the many
    secondary write-ups (e.g. visualstudiomagazine.com, index.dev) describing the "VS Code fork
    foundation".
- **Antigravity 2.0** additionally ships an **official extension** that runs inside *stock* VS Code,
  JetBrains, Zed and Visual Studio. That extension is a *client/bridge* to Google's agent backend —
  it is a normal extension and is therefore bounded by the public extension API.
  - Refs: Google Antigravity docs / blog describing "Antigravity IDE Extensions for VS Code,
    JetBrains, Zed, and Visual Studio".

**Why this matters (the user's key point):** a fork can use VS Code's **internal/proposed APIs** and
**patch the editor/workbench rendering**, while a Marketplace extension cannot. This is exactly the
distinction that lets the Antigravity *IDE* show native-looking inline diff zones that the Antigravity
*extension* (and every other extension) cannot fully reproduce in stock VS Code.

> **[SPECULATION]** The `jetski` codename is Google's internal pre-launch name for Antigravity; it
> survives in internal build strings, tab titles ("Jetski Preview"), process names, and URI schemes.
> Reported by community sources (Reddit / secondary blogs), not by an official Google doc I could
> verify.

---

## Q2. How does Antigravity render the removed (red) lines inline?

**What is documented/observable:** Antigravity's review flow shows agent edits *inside the editor*
with **green additions** and **red deletions/strikethrough**, plus **per-hunk Accept / Reject**
controls, and a **"Review Changes"** surface in the Agent panel. There are autonomy policies
("Request Review" vs "Always Proceed"). Refs: antigravity.google docs, Google Antigravity help pages,
and multiple secondary walkthroughs.

**What the mechanism is — the honest answer:**
- I could **not** find an official Google engineering document stating the exact API. Google has not
  open-sourced the fork.
- The strongest *public* evidence for the mechanism is a **custom URI scheme** used as a virtual
  document for diffing. Community/technical write-ups repeatedly describe schemes like
  `jetski-diff://` / `jetski://` registered via `registerTextDocumentContentProvider`, and a
  custom/`vscode.diff` editor consuming them. **[SPECULATION — medium confidence]**.
  - Corroborating artifact inside this very workspace: `src/content-provider.ts` in the parent's
    `review-hub-vscode` extension carries the comment *"Mirrors Antigravity's jetski-diff scheme"* and
    registers `review-hub://baseline|proposed|merged/<id>` virtual documents to feed
    `vscode.diff`. That is the same *architecture* (virtual docs → diff editor), which is a stable,
    extension-reachable technique — **but it renders in a separate diff tab, not truly inline in the
    real file.**
- Because it is a fork, Antigravity *can* additionally use workbench-internal "diff zone" /
  view-zone machinery (see Q5 — `diff zones` are core code coupled to Copilot and not exposed to
  extensions). Whether it does is **[SPECULATION]**.

**Bottom line:** the plausible, evidence-backed description is: **fork + custom scheme + a custom or
built-in diff editor (and possibly internal view-zone rendering)** — i.e. **not** the extension-only
`createWebviewTextEditorInset` path, because Antigravity is not limited to it.

---

## Q3. What IS available to a *stable* VS Code extension?

Precise inventory. "Stable" = usable in a published Marketplace extension on stock VS Code.

| Mechanism | Stable? | What it can do | Can it render a **multi-line red deleted-lines block inline in the real file**? |
|---|---|---|---|
| `TextEditorDecorationType` (`window.createTextEditorDecorationType`) with `isWholeLine`, `backgroundColor`, `borderColor`, `overviewRulerColor`, `gutterIconPath` | **Stable** | Colours/gutters/overview-ruler marks on **lines that exist on disk**. Red background on surviving lines, green on added lines. | **No for deleted lines** — the deleted text is not in the document, so there is nothing to colour. Works for highlighting *existing* added/changed lines. |
| `TextEditorDecorationType` with `renderOptions.before` / `renderOptions.after` (injected text) | **Stable** | Injects text before/after a line, e.g. ghost text. | **Single line only.** Injected `contentText` must be one line; VS Code collapses newlines, so you cannot inject a multi-line red block. |
| `CodeLens` (`languages.registerCodeLensProvider`) | **Stable** | A clickable command row **above a line** — good for per-hunk **Accept/Reject** buttons. | Not a diff renderer, but the standard way to attach per-hunk actions. |
| `Comment` / `CommentThread` API (`comments.createCommentController`) | **Stable** | Threaded comments anchored to a range; can render an input/thread inline. Used by the GitHub PR extension. | No — renders a comment thread, not red/green diff lines. |
| `QuickDiffProvider` (`sourceControl.createSourceControl(...).quickDiffProvider`) | **Stable** | Supplies an "original" resource so VS Code renders **gutter change markers + the click-to-peek inline diff**. | No — this is what Git/GitLens use; it shows gutter decorations in the real file and a **peek/diff editor**, not inline deleted lines in the file body. |
| `vscode.diff` command + `TextDocumentContentProvider` (`workspace.registerTextDocumentContentProvider`) | **Stable** | Opens the **built-in diff editor** between two virtual documents, in a **separate tab**. `diffEditor.renderSideBySide=false` gives the *unified/inline* layout. | **Separate tab, not inline in the real file.** This is the mainstream stable approach (and what the parent extension uses). |
| Custom Editor API (`window.registerCustomEditorProvider`) / `WebviewPanel` | **Stable** | Full HTML/JS rendering you control — you can draw any red/green UI. | **Separate editor tab / webview panel**, not the real text editor buffer. |
| `InlineCompletionItemProvider` (`languages.registerInlineCompletionItemProvider`) | **Stable** | Multi-line **ghost text** for *insertions* (Tab to accept). | Additions only; no deletion rendering; tied to suggestion UX. |
| **`editorInsets` / `window.createWebviewTextEditorInset`** | **PROPOSED** (`vscode.proposed.editorInsets.d.ts`) | Renders a **webview inset between lines** — genuinely multi-line, interactive, can show a red deleted block. | **Yes — but only via a proposed API.** Insiders-only; **cannot be published to the Marketplace**; only shareable as a VSIX + `--enable-proposed-api`. |

Citations:
- `editorInsets` proposal source:
  <https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.editorInsets.d.ts>
  (`createWebviewTextEditorInset(editor, line, height, options?)`).
- Proposed-API rules (Insiders only, cannot publish):
  <https://code.visualstudio.com/api/advanced-topics/using-proposed-api>
- Decoration `renderOptions` / single-line injected text and `TextEditorDecorationType`:
  <https://code.visualstudio.com/api/references/vscode-api> (see `DecorationRenderOptions`, `ThemedDecorationRenderOptions`).
- `vscode.diff` / `TextDocumentContentProvider` / QuickDiff: same API reference; SCM guide
  <https://code.visualstudio.com/api/extension-guides/scm-provider>.

**Also unavailable to extensions:** patching the editor **DOM**. Extensions run in the out-of-process
**extension host** and cannot touch the renderer's DOM/CSS. That route is open only to a fork.

---

## Q4. Open-source / public examples of multi-line inline red/green with **stable APIs only**?

**Honest answer: none that achieve true multi-line red/green inside the real file on stable APIs.**

- **`molon/hunkwise`** — closest UX: per-hunk `✓ Accept | ↺ Discard`, added lines green, removed
  lines red, inline in the editor. **But it explicitly uses the proposed `editorInsets` API** and
  therefore **cannot be installed from the Marketplace** (README states this outright; `package.json`
  has `"enabledApiProposals": ["editorInsets"]`).
  - <https://github.com/molon/hunkwise> ; <https://github.com/molon/hunkwise/blob/main/package.json>
- **Stable-only workarounds actually used in the wild:**
  1. **Full-line background decorations + single-line ghost text.** Colour surviving added lines green
     (`diffEditor.insertedLineBackground`), colour surviving/reverted lines red
     (`diffEditor.removedLineBackground`), and show *deleted* content as **single-line** ghost text via
     `renderOptions.after.contentText` (multi-line deletions must be truncated/summarised with the full
     text in a hover). Attach per-hunk `CodeLens` Accept/Reject. **This is exactly the technique used
     by the parent's own `review-hub-vscode` extension** (`src/change-decorator.ts`,
     `src/diff-view.ts`) — and it is honest about the limitation in its own comments: *"VS Code injected
     text must be a single line, so the old lines cannot be shown as ghost text."*
  2. **Virtual "merged" document.** A `TextDocumentContentProvider` builds a document that interleaves
     the baseline (removed, red) lines with the proposed (added, green) lines, opened in a normal editor
     with decorations + CodeLens. This shows old+new together but in a **separate tab** (the parent
     calls this the "merged view"; the built-in `vscode.diff` unified layout is the same idea).
  3. **Built-in diff editor** (`vscode.diff`) in unified mode — separate tab.
  4. **GitHub Pull Requests extension** renders inline *comments* (Comment API) and opens diffs in the
     diff editor — not inline deleted lines in the file body.
- **GitLens** shows inline change decorations via SCM/quick-diff (gutter + peek), not multi-line red
  blocks inline.

Conclusion: the only public example that truly does "multi-line red/green inline in the real editor"
is **hunkwise, and it needs the proposed API.** Everything stable is single-line injected text, line
backgrounds, and/or a separate diff tab.

---

## Q5. Documentation & the microsoft/vscode issues

### Antigravity's own docs
- Google documents the **review workflow** (inline diffs, green additions / red deletions, per-hunk
  Accept/Reject, "Review Changes" in the Agent panel, autonomy policies). It does **not** document the
  underlying API/scheme. Refs: <https://antigravity.google> docs and the Google Antigravity help
  pages surfaced in search. There is no open-source repo for the fork.

### The decisive VS Code issues

| Issue | Title | Status | Relevance |
|---|---|---|---|
| **[#85682](https://github.com/microsoft/vscode/issues/85682)** | **"Api for editor insets"** | **OPEN**, milestone **Backlog**, labels `feature-request` / `api-proposal` / `editor-insets`, **214 👍**, open since **2019-11-27**, last updated 2026 | This *is* the proposal that would let extensions render multi-line inline content. Still **not shipped**. |
| **[#260313](https://github.com/microsoft/vscode/issues/260313)** | "Is there any plan to support vscode extension to use the inline diff view feature" | **CLOSED as duplicate** (2025-12-09), locked | A developer asked to use Copilot's inline diff view. Maintainer **jrieken**: *"There are currently no plans like that… it could be that we make the workspace edit preview UI use this or the NES UI."* Assigned to jrieken, labels `under-discussion` / `chat-agent-editing`. |
| **[#3220](https://github.com/microsoft/vscode/issues/3220)** | "Custom peek widgets" | **OPEN**, **246 👍** (185 👍 / 61 ❤️), Backlog, labels include `editor-insets` | The origin request for inline widgets; still open since 2016. |
| **[#66418](https://github.com/microsoft/vscode/pull/66418)** | "Code inset feature" (PR) | **MERGED** 2019-02 | The PR that introduced editor insets (HTML inset at a line) — the basis of the `editorInsets` proposal. |
| **[#236040](https://github.com/microsoft/vscode/issues/236040)** | "Missing Red/Green Diff Zones for CoPilot Edits" | **CLOSED** (completed) | Confirms the internal term **"diff zones"** for Copilot's inline red/green blocks. |
| **[#240674](https://github.com/microsoft/vscode/issues/240674)** | "Diff Editor Tab Rendering Different In View Zones" | **OPEN**, assigned hediet | Confirms **view zones** are core diff-editor internals. |
| **[#197928](https://github.com/microsoft/vscode/pull/197928)** | "fix height of diff zones" | **MERGED** (2023-11, jrieken) | Internal "diff zone" machinery lives in the workbench, not the public API. |

**The key takeaway from the issue tracker:** the granular inline-diff/"diff zones" machinery that
Copilot (and by extension fork-based IDEs) use is **core workbench code**, and the one proposal that
would expose a multi-line inline surface to extensions (**`editorInsets`, #85682**) has sat in the
**Backlog since 2019**. Microsoft has explicitly said there are **no plans** to expose the Copilot
inline-diff view to extensions (#260313). Therefore an extension is structurally shut out of the
native multi-line inline diff experience.

---

## What this means for a Marketplace-installable extension (explicit, honest)

- **You CANNOT** render a **multi-line red "deleted lines" block inline in the middle of a real file**
  using only stable APIs. There is no such API. The renderer only injects **single-line** text and
  colours **existing** lines.
- **You CAN** (stable) do all of the following:
  - Green/red **full-line background + border + overview-ruler + gutter** decorations on the *real*
    lines that exist on disk.
  - **Single-line** ghost text for removed content (multi-line deletions summarised, full text in hover).
  - **Per-hunk Accept/Reject `CodeLens`** anchored above a hunk.
  - A **virtual "merged" document** (old red lines above new green lines) via
    `TextDocumentContentProvider` + decorations + CodeLens — shown in a **separate tab**.
  - The **built-in diff editor** (`vscode.diff`, unified or side-by-side) in a **separate tab**.
  - Inline **comments** via the Comment API.
- **You CAN** get true multi-line inline content **only** with the **`editorInsets` proposed API**
  (Insiders-only, non-publishable, VSIX + `--enable-proposed-api`) — the route `hunkwise` takes.
- **A fork** (like Antigravity) is not bound by any of the above: it can patch the workbench, use
  internal APIs, and render genuine inline diff zones. That asymmetry is the whole reason the
  Antigravity *IDE* looks different from anything an extension can build.

---

## Citation index

- Antigravity (fork / product): <https://antigravity.google> ; Google Antigravity help/blog pages;
  Wikipedia "Google Antigravity".
- Proposed API rules: <https://code.visualstudio.com/api/advanced-topics/using-proposed-api>
- `editorInsets` proposal d.ts:
  <https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.editorInsets.d.ts>
- VS Code API reference (decorations, diff, comments, SCM):
  <https://code.visualstudio.com/api/references/vscode-api> ;
  <https://code.visualstudio.com/api/extension-guides/scm-provider>
- hunkwise: <https://github.com/molon/hunkwise> ;
  <https://github.com/molon/hunkwise/blob/main/package.json> (enabledApiProposals: editorInsets)
- Issues/PRs: #85682, #260313, #3220, #66418, #236040, #240674, #197928 (links above).
