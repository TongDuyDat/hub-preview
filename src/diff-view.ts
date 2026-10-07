/**
 * The review surfaces for a change.
 *
 * Primary: the **merged view** (`review-hub://merged/<id>`) — one editor showing, for each
 * hunk, the baseline lines that were removed (red) directly above the proposed lines that
 * were added (green), with unchanged context between them. This is how the user sees old
 * and new code at once, which a plain decoration on the real file cannot do: VS Code
 * injected text must be a single line, so the old lines cannot be shown as ghost text.
 *
 * Secondary: the classic side-by-side `vscode.diff` of baseline vs proposed.
 *
 * Both carry per-hunk Accept/Reject CodeLens, as does the real file itself.
 */
import * as vscode from "vscode";
import type { ChangeStore } from "./change-store";
import type { ChangeContentProvider } from "./content-provider";
import { splitContent, resolveHunkRanges } from "./hunk-diff";
import { buildMergedView, type MergedView } from "./merged-diff";

export class HunkCodeLensProvider implements vscode.CodeLensProvider {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private store: ChangeStore) {}

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const uri = document.uri;

    // The merged review view: anchors come from the merged layout, not the raw hunks.
    if (uri.scheme === "review-hub" && uri.authority === "merged") {
      const changeId = uri.path.replace(/^\//, "");
      const cs = this.store.findById(changeId);
      if (!cs || cs.binary) {
        return [];
      }
      const view = buildMergedView(splitContent(cs.baseline).lines, cs.hunks);
      return view.hunks.flatMap((h, index) => {
        const hunk = cs.hunks.find((x) => x.id === h.id);
        if (!hunk) {
          return [];
        }
        return this.lensesFor(cs, hunk, index, h.anchor, document, cs.hunks.length);
      });
    }

    // The virtual "proposed" side of a side-by-side diff.
    if (uri.scheme === "review-hub" && uri.authority === "proposed") {
      const changeId = uri.path.replace(/^\//, "");
      const cs = this.store.findById(changeId);
      if (!cs || cs.binary) {
        return [];
      }
      return cs.hunks.flatMap((hunk, index) =>
        this.lensesFor(cs, hunk, index, hunk.newStart, document, cs.hunks.length),
      );
    }

    // The real file, so Accept/Reject is available without opening any review tab.
    // Anchor on the RESOLVED line, not the proposed one: rejecting a hunk above changes
    // how many lines it contributes, so `newStart` would put the buttons on the wrong
    // line for every hunk below it.
    if (uri.scheme === "file") {
      const cs = this.changeForFile(uri.fsPath);
      if (!cs || cs.binary) {
        return [];
      }
      const ranges = new Map(
        resolveHunkRanges(splitContent(cs.baseline).lines, cs.hunks, "proposed").map((r) => [r.id, r]),
      );
      return cs.hunks.flatMap((hunk, index) => {
        const anchor = ranges.get(hunk.id)?.start ?? hunk.newStart;
        return this.lensesFor(cs, hunk, index, anchor, document, cs.hunks.length);
      });
    }
    return [];
  }

  private changeForFile(fsPath: string): ReturnType<ChangeStore["findChangeByPath"]> {
    for (const ws of vscode.workspace.workspaceFolders ?? []) {
      const root = ws.uri.fsPath;
      if (!fsPath.startsWith(root + "/") && !fsPath.startsWith(root + "\\")) {
        continue;
      }
      const rel = fsPath.slice(root.length + 1).split("\\").join("/");
      const cs = this.store.findChangeByPath(root, rel);
      if (cs) {
        return cs;
      }
    }
    return undefined;
  }

  private lensesFor(
    cs: NonNullable<ReturnType<ChangeStore["findById"]>>,
    hunk: NonNullable<ReturnType<ChangeStore["findById"]>>["hunks"][number],
    index: number,
    anchorLine: number,
    document: vscode.TextDocument,
    total: number,
  ): vscode.CodeLens[] {
    const line = clamp(anchorLine, 0, Math.max(0, document.lineCount - 1));
    const range = new vscode.Range(line, 0, line, 0);

    // A resolved change set is shown read-only: the decision is already on disk, so
    // offering Accept/Reject again would be misleading.
    if (cs.status === "resolved") {
      const what = hunk.decision === "accepted" ? "✓ kept (accepted)" : "✗ reverted (rejected)";
      return [
        new vscode.CodeLens(range, {
          title: `Review Hub · hunk ${index + 1}/${total} · ${what}`,
          command: "",
        }),
      ];
    }

    // A decided hunk must LOOK decided. Previously it kept the same Accept/Reject buttons
    // as a pending hunk (only a non-clickable label changed), so a click produced no
    // visible change, the user clicked again, and nothing happened because the hunk was
    // already accepted. Now the resolved side becomes a static badge and the other side
    // turns into "Undo", which both confirms the click and offers a way back.
    if (hunk.decision === "accepted") {
      return [
        new vscode.CodeLens(range, {
          title: "$(check) Accepted",
          command: "",
          tooltip: "This hunk's new lines are kept",
        }),
        new vscode.CodeLens(range, {
          title: "$(discard) Undo",
          command: "review-hub.rejectHunk",
          arguments: [cs.id, hunk.id],
          tooltip: "Undo — restore this hunk's baseline lines",
        }),
        new vscode.CodeLens(range, {
          title: `hunk ${index + 1}/${total} · ✓ accepted`,
          command: "",
        }),
      ];
    }

    if (hunk.decision === "rejected") {
      return [
        new vscode.CodeLens(range, {
          title: "$(chrome-close) Rejected",
          command: "",
          tooltip: "This hunk was restored to its baseline",
        }),
        new vscode.CodeLens(range, {
          title: "$(discard) Undo",
          command: "review-hub.acceptHunk",
          arguments: [cs.id, hunk.id],
          tooltip: "Undo — keep this hunk's new lines instead",
        }),
        new vscode.CodeLens(range, {
          title: `hunk ${index + 1}/${total} · ✗ rejected`,
          command: "",
        }),
      ];
    }

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
        title: `hunk ${index + 1}/${total} · pending`,
        command: "",
      }),
    ];
  }
}

/**
 * Red/green line decorations for the merged view, so removed and added lines read exactly
 * like a diff even though they live in one document.
 */
class MergedDecorator implements vscode.Disposable {
  private deleted: vscode.TextEditorDecorationType;
  private added: vscode.TextEditorDecorationType;

  constructor(
    private store: ChangeStore,
    private provider: ChangeContentProvider,
  ) {
    this.deleted = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      // A left border makes the block's extent obvious even on a themed background that is
      // close to the editor's own colour.
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
    });
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      borderWidth: "0 0 0 3px",
      borderStyle: "solid",
      borderColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
    });
  }

  apply(editor: vscode.TextEditor): void {
    const uri = editor.document.uri;
    if (uri.scheme !== "review-hub" || uri.authority !== "merged") {
      return;
    }
    const changeId = uri.path.replace(/^\//, "");
    const cs = this.store.findById(changeId);
    if (!cs || cs.binary) {
      editor.setDecorations(this.deleted, []);
      editor.setDecorations(this.added, []);
      return;
    }
    const view = buildMergedView(splitContent(cs.baseline).lines, cs.hunks);
    const del: vscode.DecorationOptions[] = [];
    const add: vscode.DecorationOptions[] = [];
    for (const block of view.blocks) {
      if (block.kind === "context") {
        continue;
      }
      const start = clamp(block.start, 0, Math.max(0, editor.document.lineCount - 1));
      const end = clamp(block.end - 1, start, Math.max(0, editor.document.lineCount - 1));
      const range = new vscode.Range(start, 0, end, 0);
      if (block.kind === "deleted") {
        del.push({ range });
      } else {
        add.push({ range });
      }
    }
    editor.setDecorations(this.deleted, del);
    editor.setDecorations(this.added, add);
  }

  /** Re-apply to whichever merged editors are visible. */
  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
  }

  dispose(): void {
    this.deleted.dispose();
    this.added.dispose();
  }
}

export class DiffView implements vscode.Disposable {
  private decorator: MergedDecorator;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private store: ChangeStore,
    private provider: ChangeContentProvider,
    private codeLens: HunkCodeLensProvider,
    private onDidChange: () => void,
  ) {
    this.decorator = new MergedDecorator(store, provider);
    this.disposables.push(
      this.decorator,
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e) {
          this.decorator.apply(e);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const e of editors) {
          this.decorator.apply(e);
        }
      }),
    );
  }

  /** Open the merged review view: old (red) and new (green) code in one editor. */
  async open(changeId: string, preview = true): Promise<void> {
    const cs = this.store.findById(changeId);
    if (!cs) {
      void vscode.window.showWarningMessage(`Review Hub: change ${changeId} no longer exists.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.provider.mergedUri(changeId));
    const editor = await vscode.window.showTextDocument(doc, {
      preview,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
    this.decorator.apply(editor);
  }

  /** Open the classic side-by-side diff (baseline | proposed). */
  async openSideBySide(changeId: string): Promise<void> {
    const cs = this.store.findById(changeId);
    if (!cs) {
      void vscode.window.showWarningMessage(`Review Hub: change ${changeId} no longer exists.`);
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.provider.baselineUri(changeId),
      this.provider.proposedUri(changeId),
      this.titleFor(changeId),
    );
  }

  titleFor(changeId: string): string {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return "Review Hub";
    }
    // Keep the tab title short: just the file name plus progress. A long title
    // pushes the other tabs off-screen when the editor group is narrow.
    const name = cs.path.split("/").pop() ?? cs.path;
    const pending = cs.hunks.filter((h) => h.decision === "pending").length;
    const accepted = cs.hunks.filter((h) => h.decision === "accepted").length;
    if (cs.hunks.length === 0) {
      return name;
    }
    if (pending === 0) {
      return `${name} ✓`;
    }
    return `${name} (${accepted}/${cs.hunks.length})`;
  }

  /**
   * After a decision: refresh the virtual docs and the lens, re-decorate the merged view,
   * and reopen its tab so the title reflects the new state (VS Code has no rename API for
   * an editor tab).
   */
  async refresh(changeId: string): Promise<void> {
    this.provider.refresh(changeId);
    this.codeLens.refresh();
    this.onDidChange();
    this.decorator.refreshAll();
    await this.retitle(changeId);
  }

  private async retitle(changeId: string): Promise<void> {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return;
    }
    const newTitle = this.titleFor(changeId);
    let merged = false;
    let sideBySide = false;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as
          | { uri?: vscode.Uri; modified?: vscode.Uri }
          | undefined;
        const id = (u?: vscode.Uri) => u?.scheme === "review-hub" && u.path.replace(/^\//, "") === changeId;
        if (input?.uri?.authority === "merged" && id(input.uri)) {
          await vscode.window.tabGroups.close(tab, true);
          merged = true;
        } else if (input?.modified?.scheme === "review-hub" && id(input.modified)) {
          await vscode.window.tabGroups.close(tab, true);
          sideBySide = true;
        }
      }
    }
    if (merged) {
      await this.open(changeId, false);
    }
    if (sideBySide) {
      await this.openSideBySide(changeId);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export type { MergedView };
