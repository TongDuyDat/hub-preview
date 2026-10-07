/**
 * Explorer decorations: a coloured badge on every file an agent has changed, so the user
 * can see *which files* need review without opening a diff.
 *
 * This is the "always visible indicator" requirement. The badge mirrors git's vocabulary
 * (M/A/D) so it reads instantly, and `propagate` puts a dot on the containing folder, so a
 * change buried deep in the tree is still visible when the folder is collapsed.
 *
 * A file drops out of the decoration set as soon as every hunk is decided — the store hides
 * resolved change sets from `findChangeByPath`, so "badge present" means "still to review".
 */
import * as vscode from "vscode";
import type { ChangeStore } from "./change-store";

export class ChangeFileDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  // `undefined` means "re-evaluate every URI", which is what we want after any decision.
  private emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  constructor(
    private store: ChangeStore,
    private getWorkspaces: () => string[],
  ) {}

  /** Re-evaluate every visible file's decoration. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const cs = this.changeFor(uri.fsPath);
    if (!cs) {
      return undefined;
    }
    const pending = cs.hunks.filter((h) => h.decision === "pending").length;
    if (pending === 0) {
      // Every hunk decided: the change is settled, so it is no longer "needs review".
      return undefined;
    }
    const added = cs.hunks.reduce((n, h) => n + h.newLines.length, 0);
    const removed = cs.hunks.reduce((n, h) => n + h.oldLines.length, 0);

    // Git's letters, so the meaning is obvious at a glance.
    const letter = !cs.baselineExists ? "A" : !cs.proposedExists ? "D" : "M";
    const color =
      letter === "A"
        ? new vscode.ThemeColor("gitDecoration.addedResourceForeground")
        : letter === "D"
          ? new vscode.ThemeColor("gitDecoration.deletedResourceForeground")
          : new vscode.ThemeColor("gitDecoration.modifiedResourceForeground");

    return {
      badge: letter,
      color,
      propagate: true,
      tooltip: `Review Hub: ${pending} hunk${pending === 1 ? "" : "s"} pending (+${added} −${removed}) — click to review`,
    };
  }

  private changeFor(fsPath: string): ReturnType<ChangeStore["findChangeByPath"]> {
    for (const ws of this.getWorkspaces()) {
      const root = ws.replace(/[\\/]+$/, "");
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

  dispose(): void {
    this.emitter.dispose();
  }
}
