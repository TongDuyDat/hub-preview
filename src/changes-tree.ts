/**
 * The Changes tree view: one node per changed file, grouped by workspace folder in
 * multi-root setups, plus a checkpoint header. Native TreeDataProvider (no webview).
 */
import * as vscode from "vscode";
import type { ChangeSummary, CheckpointInfo } from "./types";

export interface FileNode {
  kind: "file";
  summary: ChangeSummary;
  workspace: string;
}

export interface FolderNode {
  kind: "folder";
  label: string;
  workspace: string;
}

export interface CheckpointNode {
  kind: "checkpoint";
  info: CheckpointInfo | undefined;
}

export type TreeNode = FileNode | FolderNode | CheckpointNode;

export interface ChangesModel {
  checkpoint(workspace: string): CheckpointInfo | undefined;
  summaries(workspace: string): ChangeSummary[];
  workspaces(): string[];
}

export class ChangesTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private model: ChangesModel) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === "checkpoint") {
      const item = new vscode.TreeItem("Checkpoint");
      item.description = node.info
        ? `set ${timeAgo(node.info.setAt)} · ${node.info.files} files`
        : "none — changes are measured from now";
      item.iconPath = new vscode.ThemeIcon("history");
      item.contextValue = "reviewHub.checkpoint";
      item.tooltip = "Click 'Set Checkpoint' to accept the current state as the new baseline.";
      return item;
    }
    if (node.kind === "folder") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "reviewHub.folder";
      const count = this.model.summaries(node.workspace).length;
      item.description = count === 1 ? "1 file" : `${count} files`;
      item.tooltip = new vscode.MarkdownString(
        [
          `**${node.workspace}**`,
          "",
          `${count} file${count === 1 ? "" : "s"} with unreviewed changes.`,
          "",
          "Use the buttons to accept or reject every change in this project.",
        ].join("\n"),
      );
      return item;
    }
    const s = node.summary;
    const item = new vscode.TreeItem(basename(s.path), vscode.TreeItemCollapsibleState.None);
    item.description = describe(s);
    item.tooltip = tooltip(s);
    item.contextValue = "reviewHub.file";
    item.iconPath = new vscode.ThemeIcon(s.binary ? "file-binary" : statusIcon(s));
    item.command = {
      command: "review-hub.openDiff",
      title: "Open diff",
      arguments: [node],
    };
    item.resourceUri = vscode.Uri.file(s.path);
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    const workspaces = this.model.workspaces();
    if (!node) {
      // Always one folder node per project, so every project gets its own
      // Accept All / Reject All buttons — even when only one project is open.
      // Skip projects with nothing to show, to keep the list short.
      return workspaces
        .filter((ws) => this.model.summaries(ws).length > 0 || this.model.checkpoint(ws) !== undefined)
        .map((ws) => ({ kind: "folder", label: basename(ws), workspace: ws }));
    }
    if (node.kind === "folder") {
      const out: TreeNode[] = [{ kind: "checkpoint", info: this.model.checkpoint(node.workspace) }];
      for (const s of this.model.summaries(node.workspace)) {
        out.push({ kind: "file", summary: s, workspace: node.workspace });
      }
      return out;
    }
    return [];
  }
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function statusIcon(s: ChangeSummary): string {
  if (s.pending > 0) {
    return "diff-modified";
  }
  if (s.accepted > 0 && s.rejected > 0) {
    return "diff-mixed";
  }
  return "diff-added";
}

function describe(s: ChangeSummary): string {
  const counts = `+${s.added} −${s.removed}`;
  const origin = s.origin === "mcp" ? "staged" : "applied";
  const pending = s.pending > 0 ? ` · ${s.pending} pending` : "";
  return `${counts} · ${origin}${pending}`;
}

function tooltip(s: ChangeSummary): string {
  const lines = [
    s.path,
    `origin: ${s.origin === "mcp" ? "staged (not yet on disk)" : "direct write (already applied)"}`,
    `+${s.added} −${s.removed}`,
    `accepted: ${s.accepted}, rejected: ${s.rejected}, pending: ${s.pending}`,
  ];
  if (s.binary) {
    lines.push("binary file — whole-file accept/reject only");
  }
  return lines.join("\n");
}

function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  return `${Math.floor(hr / 24)} d ago`;
}
