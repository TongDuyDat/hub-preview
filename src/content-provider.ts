/**
 * Virtual documents for the diff view. `review-hub://baseline/<changeId>` and
 * `review-hub://proposed/<changeId>` serve the two sides of a change, so VS Code's
 * built-in diff can render them. Mirrors Antigravity's jetski-diff scheme.
 */
import * as vscode from "vscode";
import type { ChangeStore } from "./change-store";
import { splitContent } from "./hunk-diff";
import { buildMergedView } from "./merged-diff";

export const SCHEME = "review-hub";

export class ChangeContentProvider implements vscode.TextDocumentContentProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  /**
   * The property name is load-bearing: VS Code discovers a content provider's change
   * event as `onDidChange`, not `onDidChangeTextDocument` (that is the *workspace* event).
   * With the wrong name the provider still serves content, but VS Code never re-queries it,
   * so an open merged/side-by-side view keeps showing the pre-decision content — the
   * "Accept does nothing, it just sits there" symptom.
   */
  readonly onDidChange = this.emitter.event;

  constructor(private store: ChangeStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const side = uri.authority;
    const changeId = uri.path.replace(/^\//, "");
    const cs = this.store.findById(changeId);
    if (!cs) {
      return "";
    }
    if (side === "merged") {
      return this.mergedText(changeId);
    }
    if (side === "baseline") {
      return cs.binary ? "(binary file)" : cs.baseline;
    }
    if (cs.binary) {
      return "(binary file)";
    }
    return cs.proposed;
  }

  /**
   * The inline review document: context lines with each hunk's removed (baseline) lines
   * followed by its added (proposed) lines, so old and new code are visible together.
   * Decisions change what a hunk shows — see `buildMergedView`.
   */
  mergedText(changeId: string): string {
    const cs = this.store.findById(changeId);
    if (!cs) {
      return "";
    }
    if (cs.binary) {
      return "(binary file — accept or reject the whole file from the Changes view)";
    }
    const base = splitContent(cs.baseline);
    return buildMergedView(base.lines, cs.hunks).lines.join("\n");
  }

  baselineUri(changeId: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://baseline/${changeId}`);
  }

  proposedUri(changeId: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://proposed/${changeId}`);
  }

  mergedUri(changeId: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://merged/${changeId}`);
  }

  /** Notify VS Code that every side changed so open views re-render. */
  refresh(changeId: string): void {
    this.emitter.fire(this.baselineUri(changeId));
    this.emitter.fire(this.proposedUri(changeId));
    this.emitter.fire(this.mergedUri(changeId));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
