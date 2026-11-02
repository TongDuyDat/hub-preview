/**
 * Virtual documents for the diff view. `review-hub://baseline/<changeId>` and
 * `review-hub://proposed/<changeId>` serve the two sides of a change, so VS Code's
 * built-in diff can render them. Mirrors Antigravity's jetski-diff scheme.
 */
import * as vscode from "vscode";
import type { ChangeStore } from "../../../../core/src/change-store";
import { joinContent, resolveLines, splitContent } from "../../../../core/src/hunk-diff";
import { buildStagedText } from "./staged-content";

export const SCHEME = "review-hub";

/** Review URIs may include the filename so VS Code detects syntax highlighting. */
export function reviewChangeId(uri: { path: string }): string {
  return uri.path.replace(/^\//, "").split("/")[0];
}

export class ChangeContentProvider implements vscode.TextDocumentContentProvider {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly inlineUris = new Map<string, vscode.Uri>();
  /**
   * The property name is load-bearing: VS Code discovers a content provider's change
   * event as `onDidChange`, not `onDidChangeTextDocument` (that is the *workspace* event).
   * With the wrong name the provider still serves content, but VS Code never re-queries it,
   * so an open side-by-side view keeps showing the pre-decision content — the
   * "Accept does nothing, it just sits there" symptom.
   */
  readonly onDidChange = this.emitter.event;

  constructor(private store: ChangeStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const side = uri.authority;
    const changeId = reviewChangeId(uri);
    const cs = this.store.findById(changeId);
    if (!cs) {
      return "";
    }
    if (cs.binary) {
      return "(binary file)";
    }
    if (side === "inline") {
      return buildStagedText(cs) ?? cs.proposed;
    }
    if (cs.hunks.length === 0) {
      return side === "baseline" ? cs.baseline : cs.proposed;
    }
    // Both sides include decisions already made. Only pending hunks differ, so each
    // Accept/Reject removes that hunk's diff immediately, without waiting for the file.
    const base = splitContent(cs.baseline);
    const frame = side === "baseline" ? "baseline" : "proposed";
    const lines = resolveLines(base.lines, cs.hunks, frame);
    const framing = !cs.baselineExists || cs.hunks.every((h) => h.decision === "accepted")
      ? { eol: cs.eol, bom: cs.bom, finalNewline: cs.finalNewline }
      : base;
    return joinContent(lines, framing);
  }

  inlineUri(changeId: string): vscode.Uri {
    let uri = this.inlineUris.get(changeId);
    if (!uri) {
      const name = this.store.findById(changeId)?.path.split("/").pop() ?? "review.txt";
      uri = vscode.Uri.parse(`${SCHEME}://inline/${changeId}/${encodeURIComponent(name)}`);
      this.inlineUris.set(changeId, uri);
    }
    return uri;
  }

  baselineUri(changeId: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://baseline/${changeId}`);
  }

  proposedUri(changeId: string): vscode.Uri {
    return vscode.Uri.parse(`${SCHEME}://proposed/${changeId}`);
  }

  /** Notify VS Code that every side changed so open views re-render. */
  refresh(changeId: string): void {
    this.emitter.fire(this.baselineUri(changeId));
    this.emitter.fire(this.proposedUri(changeId));
    this.emitter.fire(this.inlineUri(changeId));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
