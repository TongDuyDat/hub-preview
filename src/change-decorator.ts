/**
 * Inline change highlighting on the real file in the editor.
 *
 * When a file with a change set is open, we decorate the changed line ranges
 * (background + gutter icon + overview ruler) and attach per-hunk Accept/Reject
 * CodeLens directly on the file — so the user sees and resolves the change without
 * leaving the file, not only in the separate diff view.
 *
 * For a staged change (origin "mcp") the file on disk is still the baseline, so we
 * mark where the change will land. For an applied change (origin "fs") the file
 * already holds the new content, so we mark the changed lines as they are.
 */
import * as vscode from "vscode";
import type { ChangeStore } from "./change-store";
import type { ChangeSet, Hunk } from "./types";
import { splitContent, resolveHunkRanges } from "./hunk-diff";

export class ChangeDecorator implements vscode.Disposable {
  private added: vscode.TextEditorDecorationType;
  private removed: vscode.TextEditorDecorationType;
  /** A pure deletion has no surviving line to colour, so it gets a boundary marker. */
  private deletionMarker: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];

  constructor(private store: ChangeStore) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      // A left border marks the block's extent even when the themed background is subtle.
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    });
    // A removed line is not on disk any more, so it cannot be coloured. Instead its text
    // is shown as ghost text after the line where it was removed, so the user can read
    // what the agent deleted without opening a separate diff.
    this.deletionMarker = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.apply(editor);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          this.apply(editor);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.visibleTextEditors.find((ed) => ed.document === e.document);
        if (editor) {
          this.apply(editor);
        }
      }),
    );
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  /** Re-apply decorations to any visible editor showing the given change's file. */
  refresh(changeId: string): void {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.fsPath === cs.absPath) {
        this.apply(editor);
      }
    }
  }

  /** Clear decorations on every visible editor (e.g. after a checkpoint). */
  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  private changeForDocument(editor: vscode.TextEditor): ChangeSet | undefined {
    if (editor.document.uri.scheme !== "file") {
      return undefined;
    }
    const fsPath = editor.document.uri.fsPath;
    for (const ws of vscode.workspace.workspaceFolders ?? []) {
      const rel = fsPath.slice(ws.uri.fsPath.length + 1);
      if (!rel || rel.startsWith("..")) {
        continue;
      }
      const cs = this.store.findChangeByPath(ws.uri.fsPath, rel.split("\\").join("/"));
      if (cs) {
        return cs;
      }
    }
    return undefined;
  }

  private apply(editor: vscode.TextEditor): void {
    const cs = this.changeForDocument(editor);
    if (!cs || cs.binary || cs.hunks.length === 0) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.removed, []);
      editor.setDecorations(this.deletionMarker, []);
      return;
    }
    const doc = editor.document;
    const added: vscode.DecorationOptions[] = [];
    const removed: vscode.DecorationOptions[] = [];
    const deleted: vscode.DecorationOptions[] = [];

    // The disk holds the RESOLVED content, so a hunk's line range must be computed against
    // the replay of every decision — not the proposed frame. Rejecting a hunk above shifts
    // the lines below it, so anchoring on `newStart` would colour the wrong lines.
    const ranges = new Map(
      resolveHunkRanges(splitContent(cs.baseline).lines, cs.hunks, "proposed").map((r) => [r.id, r]),
    );

    const lastLine = Math.max(0, doc.lineCount - 1);
    for (const hunk of cs.hunks) {
      const label = hunkLabel(cs, hunk);
      const rejected = hunk.decision === "rejected";
      const range = ranges.get(hunk.id);
      const start = clamp(range?.start ?? hunk.newStart, 0, lastLine);
      // The surviving lines for this hunk (baseline lines once rejected, proposed otherwise).
      const span = range ? range.length : rejected ? hunk.oldLines.length : hunk.newLines.length;

      // GREEN — the new lines the agent wrote, while they are in effect (pending/accepted).
      if (!rejected && span > 0) {
        const end = clamp(start + span - 1, start, lastLine);
        added.push({ range: new vscode.Range(start, 0, end, 0), hoverMessage: new vscode.MarkdownString(label) });
      }

      // RED — when rejected, the baseline lines are what survives on disk.
      if (rejected) {
        const redSpan = Math.max(1, span || hunk.newLines.length || hunk.oldLines.length);
        const end = clamp(start + redSpan - 1, start, lastLine);
        removed.push({ range: new vscode.Range(start, 0, end, 0), hoverMessage: new vscode.MarkdownString(label) });
      }

      // GHOST — the removed (baseline) lines. They are no longer on disk, so their content
      // is shown after the line where they were removed; without this the user sees the
      // additions but not what the agent deleted. Not shown once the hunk is rejected
      // (the lines are back on disk then).
      if (!rejected && hunk.oldLines.length > 0) {
        deleted.push({
          range: new vscode.Range(start, 0, start, 0),
          hoverMessage: removedHover(label, hunk.oldLines),
          renderOptions: { after: { contentText: ghostFor(hunk.oldLines) } },
        });
      }
    }
    editor.setDecorations(this.added, added);
    editor.setDecorations(this.removed, removed);
    editor.setDecorations(this.deletionMarker, deleted);
  }

  dispose(): void {
    this.added.dispose();
    this.removed.dispose();
    this.deletionMarker.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Ghost text for a removed line (or lines). VS Code injected text must be a single line,
 * so one removed line is shown verbatim and several are summarised with the first shown
 * and the rest counted; the full text is on the decoration's hover.
 *
 * Leading whitespace in `contentText` is collapsed by the renderer, so indentation is
 * rebuilt from non-breaking spaces (U+2003) to keep the removed code readable.
 */
export function ghostFor(oldLines: string[]): string {
  const raw = (oldLines[0] ?? "").replace(/\t/g, "    ");
  const indent = raw.length - raw.trimStart().length;
  const body = raw.trimStart();
  const shown = body.length > 100 ? `${body.slice(0, 100)}…` : body;
  // An em-space is about two columns wide, so halve the indent to keep it looking right.
  const pad = " ".repeat(Math.min(Math.ceil(indent / 2), 20));
  const more = oldLines.length > 1 ? `  ⊖ +${oldLines.length - 1} more deleted` : "";
  return `  ⊖ ${pad}${shown}${more}`;
}

/** Hover for a ghost decoration: the full text of every removed line. */
function removedHover(label: string, oldLines: string[]): vscode.MarkdownString {
  return new vscode.MarkdownString(
    [label, "", "**Removed:**", "```", ...oldLines.map((l) => l.replace(/\t/g, "    ")), "```"].join("\n"),
  );
}

function hunkLabel(cs: ChangeSet, hunk: Hunk): string {
  const decision =
    hunk.decision === "accepted" ? "accepted" : hunk.decision === "rejected" ? "rejected" : "pending review";
  const origin = cs.origin === "mcp" ? "from agent" : "direct write";
  const added = hunk.newLines.length;
  const removed = hunk.oldLines.length;
  return [
    `**Review Hub** — ${origin} · ${decision}`,
    "",
    `\`+${added} −${removed}\``,
    "",
    "Use the Accept / Reject buttons above to resolve this hunk.",
  ].join("\n");
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
