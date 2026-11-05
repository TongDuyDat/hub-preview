import { ReviewFeedback, REVIEW_FEEDBACK_INSTRUCTION } from "./review-feedback";
/**
 * Thin stdio MCP server. Harnesses (Claude Code, opencode, dsh, Cline, Roo) spawn
 * this per session; it forwards every tool call to the Review Hub HTTP server run by
 * the VS Code extension or JetBrains plugin, discovered via ~/.review-hub/hub.json.
 *
 * It never edits files itself. If the hub is not running it fails fast with a clear
 * message so the agent can reconnect. Direct writes outside MCP are not reviewed.
 * It must never hang.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRegistry, defaultBaseDir, pidAlive } from "../core/src/registry";
import type { HubEntry } from "../core/src/registry";
import type { ChangeSet, Hunk, ReviewUpdates } from "../core/src/types";
import * as nodePath from "node:path";
import { resolveInside, toPosix } from "../core/src/file-snapshot";
import { applyFileEdits, changedContext, type FileEdit } from "./batch-changes";

interface HubTarget {
  url: string;
  token: string;
  /** The workspace the hub is serving, used only as a last-resort fallback. */
  workspace?: string;
}

function resolveTarget(): HubTarget | null {
  const envUrl = process.env.REVIEW_HUB_URL;
  const envToken = process.env.REVIEW_HUB_TOKEN;
  if (envUrl && envToken) {
    return { url: envUrl.replace(/\/$/, ""), token: envToken };
  }
  const entry: HubEntry | undefined = createRegistry(process.env.REVIEW_HUB_DIR ?? defaultBaseDir()).readEntry();
  if (!entry) {
    return null;
  }
  if (!pidAlive(entry.pid)) {
    return null;
  }
  return { url: entry.url.replace(/\/$/, ""), token: entry.token, workspace: entry.workspace };
}

async function callHub<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const target = resolveTarget();
  if (!target) {
    throw new Error(
      "Review Hub is not running. Open the workspace with Review Hub enabled in your IDE, or start the standalone daemon (node dist/hub-server.cjs), then reconnect. Direct writes outside MCP do not create reviews.",
    );
  }
  const url = new URL(target.url + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${target.token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = parsed?.error?.message ?? `hub returned ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError") {
      throw new Error("Review Hub did not respond in time. Is the IDE window or Hub daemon still running?");
    }
    if (e?.message === "fetch failed" || e?.name === "TypeError") {
      throw new Error(
        "Review Hub is not reachable. Check the hosting IDE window or standalone daemon and ensure the agent uses the same environment, then reconnect. Direct writes outside MCP do not create reviews.",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which project this agent is working in.
 */
let workspaceCache: { at: number; list: string[] } | undefined;
let stickyWorkspace: string | undefined;

async function hubWorkspaces(): Promise<string[]> {
  const now = Date.now();
  if (workspaceCache && now - workspaceCache.at < 2000) {
    return workspaceCache.list;
  }
  try {
    const res = await callHub<{ workspaces: string[] }>("/workspaces");
    workspaceCache = { at: now, list: res.workspaces ?? [] };
  } catch {
    workspaceCache = { at: now, list: [] };
  }
  return workspaceCache.list;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** True when `p` is `root` or sits inside it, case-insensitive on Windows. */
function isInside(root: string, p: string): boolean {
  const isWin = process.platform === "win32";
  const r = normalizePath(root);
  const target = normalizePath(p);
  const compR = isWin ? r.toLowerCase() : r;
  const compTarget = isWin ? target.toLowerCase() : target;
  return compTarget === compR || compTarget.startsWith(compR + "/");
}

async function resolveWorkspace(path?: string): Promise<string> {
  const explicit = process.env.REVIEW_HUB_WORKSPACE;
  if (explicit) {
    return explicit;
  }
  const known = await hubWorkspaces();
  if (path) {
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
      const hit = known.filter((ws) => isInside(ws, path)).sort((a, b) => b.length - a.length)[0];
      if (hit) {
        stickyWorkspace = hit;
        return hit;
      }
    } else {
      if (stickyWorkspace) {
        try {
          const probe = await callHub<{ exists: boolean }>("/file/read", {
            query: { workspace: stickyWorkspace, path },
          });
          if (probe.exists) {
            return stickyWorkspace;
          }
        } catch {
          // fall through to a full probe
        }
      }
      for (const ws of known) {
        try {
          const probe = await callHub<{ exists: boolean }>("/file/read", { query: { workspace: ws, path } });
          if (probe.exists) {
            stickyWorkspace = ws;
            return ws;
          }
        } catch {
          // try the next workspace
        }
      }
    }
  }
  const cwd = process.cwd();
  const isWin = process.platform === "win32";
  const norm = (s: string) => {
    const r = s.replace(/[\\/]+$/, "").replace(/\\/g, "/");
    return isWin ? r.toLowerCase() : r;
  };
  const compCwd = norm(cwd);
  const match = known.find((ws) => norm(ws) === compCwd);
  if (match) {
    stickyWorkspace = match;
    return match;
  }
  return stickyWorkspace ?? cwd;
}

/** Synchronous best-effort variant for tools that already carry a changeId. */
function workspaceOf(): string {
  return process.env.REVIEW_HUB_WORKSPACE ?? stickyWorkspace ?? process.cwd();
}

/**
 * The SDK's `registerTool` generics instantiate too deeply under this TS/zod combo (TS2589).
 */
interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
}
type ToolCallback = (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
interface TypedServer {
  registerTool(name: string, config: ToolConfig, cb: ToolCallback): unknown;
  registerResource(
    name: string,
    uriOrTemplate: string,
    config: unknown,
    readCallback: (uri: URL) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }>,
  ): unknown;
  registerPrompt(
    name: string,
    config: unknown,
    cb: (args: Record<string, unknown>) => Promise<{ messages: Array<{ role: "user" | "assistant"; content: { type: "text"; text: string } }> }>,
  ): unknown;
  connect(transport: unknown): Promise<void>;
  sendLoggingMessage(params: { level: "info"; logger: string; data: unknown }): Promise<void>;
}

const server = new McpServer({ name: "review-hub", version: "0.3.0" }, { capabilities: { logging: {} } }) as unknown as TypedServer;

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const feedback = new ReviewFeedback((workspace, after, latest) => callHub<ReviewUpdates>("/review/events", {
  query: { workspace, ...(after ? { after } : {}), ...(latest ? { latest: "true" } : {}) },
}));

/** Attach review feedback to normal tool results; stale proposals must first re-read. */
function registerTool(name: string, config: ToolConfig, callback: ToolCallback): void {
  server.registerTool(name, config, async args => {
    if (name === "get_review_updates") return callback(args);
    const candidates = name === "propose_changes" ? (args.changes as Array<{ path: string }>).map(change => change.path) : [typeof args.path === "string" ? args.path : undefined];
    const targets: Array<{ workspace: string; path?: string }> = [];
    const pages: ReviewUpdates[] = [];
    const checked = new Set<string>();
    for (const candidate of candidates) {
      const workspace = typeof args.workspace === "string" ? args.workspace : await resolveWorkspace(candidate);
      const absolute = candidate ? resolveInside(workspace, candidate) : undefined;
      const path = absolute ? toPosix(nodePath.relative(workspace, absolute)) : undefined;
      targets.push({ workspace, path });
      if (checked.has(workspace)) continue;
      checked.add(workspace);
      try {
        const page = await feedback.take(workspace);
        if (page.events.length || page.reset) pages.push(page);
      } catch { /* Older Hub compatibility: explicit get_review_updates reports unavailable. */ }
    }
    if (name.startsWith("propose_")) {
      for (const target of targets) {
        if (target.path && await feedback.requiresRead(target.workspace, target.path).catch(() => false)) {
          return { ...ok({ code: "review_decisions_changed", path: target.path, review_updates: pages, instruction: REVIEW_FEEDBACK_INSTRUCTION }), isError: true };
        }
      }
    }
    let result: ToolResult;
    try { result = await callback(args); }
    catch (error) { result = fail(error instanceof Error ? error.message : String(error)); }
    if (name === "read_file" && !result.isError && args.start_line === undefined && args.end_line === undefined) {
      for (const target of targets) if (target.path) await feedback.didRead(target.workspace, target.path).catch(() => undefined);
    }
    if (pages.length) {
      const update = { review_updates: pages, review_instruction: REVIEW_FEEDBACK_INSTRUCTION };
      try {
        const payload = JSON.parse(result.content[0].text);
        result = { ...result, content: [{ type: "text", text: JSON.stringify({ ...payload, ...update }, null, 2) }, ...result.content.slice(1)] };
      } catch { result = { ...result, content: [...result.content, { type: "text", text: JSON.stringify(update) }] }; }
    }
    return result;
  });
}

registerTool("get_review_updates", {
  title: "Get human review decisions",
  description: "Read persistent Accept/Reject events, including partial reviews and resolved files. Use cursor as after for the next page (hasMore). Omit after to replay recent history. Re-read affected files before edits and do not re-propose rejected changes without a new user request.",
  inputSchema: { workspace: z.string().optional(), path: z.string().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
}, async args => {
  const workspace = typeof args.workspace === "string" ? args.workspace : await resolveWorkspace(typeof args.path === "string" ? args.path : undefined);
  try {
    const result = await callHub<ReviewUpdates>("/review/events", { query: { workspace,
      ...(typeof args.after === "string" ? { after: args.after } : {}),
      ...(typeof args.limit === "number" ? { limit: String(args.limit) } : {}),
    } });
    return ok({ ...result, instruction: REVIEW_FEEDBACK_INSTRUCTION });
  } catch (error) { return fail("Review decision feedback unavailable. Install/reconnect the latest Review Hub and inspect get_change. " + String(error)); }
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Replaces `oldStr` with `newStr` inside `src`. Tolerates newline differences (CRLF vs LF)
 * so that AI agents editing Windows or cross-platform files do not fail on line endings.
 */
function adaptReplacement(
  src: string,
  oldStr: string,
  newStr: string,
  replaceAll?: boolean,
): { success: true; next: string } | { success: false; error: string } {
  // 1. Try exact match first
  let count = countOccurrences(src, oldStr);
  let effectiveOld = oldStr;
  let effectiveNew = newStr;

  if (count === 0) {
    // 2. Try newline-normalized match (e.g. file is CRLF but LLM passed LF, or vice versa)
    const isCrlf = src.includes("\r\n");
    const targetOld = isCrlf ? oldStr.replace(/\r?\n/g, "\r\n") : oldStr.replace(/\r\n/g, "\n");
    const targetNew = isCrlf ? newStr.replace(/\r?\n/g, "\r\n") : newStr.replace(/\r\n/g, "\n");
    const normalizedCount = countOccurrences(src, targetOld);
    if (normalizedCount > 0) {
      count = normalizedCount;
      effectiveOld = targetOld;
      effectiveNew = targetNew;
    }
  }

  if (count === 0) {
    return {
      success: false,
      error: `old_string not found in file. Check line numbers or current content with 'read_file'.`,
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      success: false,
      error: `old_string occurs ${count} times in file; pass replace_all: true or include more surrounding context to make it unique.`,
    };
  }

  const next = replaceAll ? src.split(effectiveOld).join(effectiveNew) : src.replace(effectiveOld, () => effectiveNew);
  return { success: true, next };
}

function formatHunksToDiff(hunks: Hunk[]): string {
  if (hunks.length === 0) {
    return "No diff hunks.";
  }
  return hunks
    .map((h) => {
      const header = `@@ -${h.oldStart + 1},${h.oldLines.length} +${h.newStart + 1},${h.newLines.length} @@ [${h.id}] (${h.decision})`;
      const oldPart = h.oldLines.map((l) => `-${l}`).join("\n");
      const newPart = h.newLines.map((l) => `+${l}`).join("\n");
      const parts = [header];
      if (oldPart) parts.push(oldPart);
      if (newPart) parts.push(newPart);
      return parts.join("\n");
    })
    .join("\n\n");
}

// ==========================================
// TOOLS
// ==========================================

registerTool(
  "propose_changes",
  {
    title: "Propose multiple file changes",
    description:
      "Prefer for one or many file changes. Reads latest content, applies each file's edits sequentially, normalizes paths/EOL, and writes code to disk immediately so builds/tests see it. Keeps a baseline for human hunk review: accept keeps code, reject restores it. Exactly one of edits/content/delete per file. Each file's edits validate together; other files continue on error. Retry only failed entries. Returns bounded changed excerpts or error context; truncated excerpts are not exact replacement input.",
    inputSchema: {
      changes: z.array(z.object({
        path: z.string().min(1),
        edits: z.array(z.object({
          old_string: z.string().min(1),
          new_string: z.string(),
          replace_all: z.boolean().optional(),
        })).min(1).max(100).optional(),
        content: z.string().optional(),
        delete: z.literal(true).optional(),
      }).strict().refine(change => [change.edits, change.content, change.delete].filter(value => value !== undefined).length === 1,
        "Provide exactly one of edits, content, delete.")).min(1).max(100),
      include_context: z.boolean().optional().describe("Return bounded changed excerpts (default true). Error context is always returned."),
    },
  },
  async args => {
    const { changes, include_context = true } = args as {
      changes: Array<{ path: string; edits?: FileEdit[]; content?: string; delete?: true }>;
      include_context?: boolean;
    };
    const results: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const change of changes) {
      let path = change.path;
      try {
        const workspace = await resolveWorkspace(path);
        const absolute = resolveInside(workspace, path);
        if (!absolute) throw new Error("Path must identify a file inside the workspace.");
        path = toPosix(nodePath.relative(workspace, absolute));
        const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
        if (seen.has(key)) throw new Error("Duplicate file entry. Combine sequential edits in one entry.");
        seen.add(key);
        const current = await callHub<{ exists: boolean; binary: boolean; content: string }>("/file/read", {
          query: { workspace, path },
        });
        if (current.binary && !change.delete) throw new Error("Cannot edit or replace a binary file.");
        if (!current.exists && (change.edits || change.delete)) throw new Error("File not found. Use content to create it.");
        let content = change.content ?? "";
        if (change.edits) {
          const applied = applyFileEdits(current.content, change.edits);
          if (!applied.success) {
            results.push({ path, status: "error", ...applied.error });
            continue;
          }
          content = applied.content;
        }
        if (!change.delete && current.exists && content === current.content) {
          results.push({ path, status: "unchanged" });
          continue;
        }
        const staged = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
          method: "POST", body: { workspace, path, content, delete: change.delete },
        });
        results.push({ path, status: "staged_for_review", applied: true, changeId: staged.changeId, hunks: staged.hunks.length,
          ...(include_context && !change.delete ? { context: changedContext(current.content, content) } : {}),
        });
      } catch (error) {
        results.push({ path, status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    }
    const errors = results.filter(result => result.status === "error").length;
    return ok({ status: errors ? (errors === results.length ? "error" : "partial_success") : "staged_for_review", results });
  },
);

registerTool(
  "propose_edit",
  {
    title: "Propose edit",
    description:
      "Edit a file through Hub (old_string/new_string, CRLF/LF matching). Writes immediately so tests use new code; preserves the baseline for per-hunk review. Accept keeps the edit, reject restores old code. Prefer propose_changes to batch edits.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path to the file."),
      old_string: z.string().describe("Exact text to replace (must be unique unless replace_all)."),
      new_string: z.string().describe("Replacement text."),
      replace_all: z.boolean().optional().describe("Replace every occurrence."),
    },
  },
  async (args) => {
    const { path, old_string, new_string, replace_all } = args as {
      path: string; old_string: string; new_string: string; replace_all?: boolean;
    };
    const workspace = await resolveWorkspace(path);
    const current = await callHub<{ exists: boolean; content: string; binary: boolean }>("/file/read", {
      query: { workspace, path },
    });
    if (current.binary) {
      return fail(`cannot propose an edit to a binary file: ${path}`);
    }
    const src = current.exists ? current.content : "";
    const replaced = adaptReplacement(src, old_string, new_string, replace_all);
    if (!replaced.success) {
      return fail(replaced.error);
    }
    const result = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
      method: "POST",
      body: { workspace, path, content: replaced.next },
    });
    return ok({
      status: "staged_for_review",
      applied: true,
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Written to disk, awaiting review. Run builds/tests on the new code. Accept keeps it; reject restores the baseline.",
    });
  },
);

registerTool(
  "propose_write",
  {
    title: "Propose write",
    description:
      "Create or replace a file through Hub. Writes immediately for builds/tests and preserves the baseline for review. Accept keeps it; reject restores the old file or removes a newly created file.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path."),
      content: z.string().describe("Full new content of the file."),
    },
  },
  async (args) => {
    const { path, content } = args as { path: string; content: string };
    const workspace = await resolveWorkspace(path);
    const result = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
      method: "POST",
      body: { workspace, path, content },
    });
    return ok({
      status: "staged_for_review",
      applied: true,
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Written to disk, awaiting review. Run builds/tests on the new code. Accept keeps it; reject restores the baseline.",
    });
  },
);

registerTool(
  "propose_delete",
  {
    title: "Propose delete",
    description:
      "Delete a file immediately through Hub, preserving its original content for review. Accept keeps it deleted; reject restores it.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path to the file to delete."),
    },
  },
  async (args) => {
    const { path } = args as { path: string };
    const workspace = await resolveWorkspace(path);
    const result = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
      method: "POST",
      body: { workspace, path, delete: true },
    });
    return ok({
      status: "staged_for_review",
      applied: true,
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Deleted from disk, awaiting review. Accept keeps it deleted; reject restores the original file.",
    });
  },
);

registerTool(
  "read_file",
  {
    title: "Read file",
    description:
      "Read a workspace file through Review Hub (returns the staged content currently under review). Optionally read a line range or add line numbers.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path."),
      start_line: z.number().int().positive().optional().describe("Optional 1-based start line number."),
      end_line: z.number().int().positive().optional().describe("Optional 1-based end line number (inclusive)."),
      line_numbers: z.boolean().optional().describe("Optional boolean to prefix lines with line numbers."),
    },
  },
  async (args) => {
    const { path, start_line, end_line, line_numbers } = args as {
      path: string;
      start_line?: number;
      end_line?: number;
      line_numbers?: boolean;
    };
    const workspace = await resolveWorkspace(path);
    const read = await callHub<{ exists: boolean; content: string; binary: boolean }>("/file/read", {
      query: { workspace, path },
    });
    if (!read.exists) {
      return fail(`file not found: ${path}`);
    }
    if (read.binary) {
      return ok({ path, binary: true, content: read.content });
    }

    const rawLines = read.content.split(/\r?\n/);
    const totalLines = rawLines.length;
    const start = start_line ? Math.max(1, Math.min(start_line, totalLines)) : 1;
    const end = end_line ? Math.max(start, Math.min(end_line, totalLines)) : totalLines;
    const sliced = (start_line !== undefined || end_line !== undefined) ? rawLines.slice(start - 1, end) : rawLines;

    let contentOut = sliced.join("\n");
    if (line_numbers) {
      const maxDigits = String(end).length;
      contentOut = sliced
        .map((line, idx) => `${String(start + idx).padStart(maxDigits, " ")} | ${line}`)
        .join("\n");
    }

    return ok({
      path,
      binary: false,
      total_lines: totalLines,
      start_line: start,
      end_line: end,
      content: contentOut,
    });
  },
);

registerTool(
  "list_changes",
  {
    title: "List pending changes",
    description:
      "List every file the agent has changed since the last accepted checkpoint, with hunk counts. Pass `path` when the session's working directory is not the project being edited.",
    inputSchema: {
      path: z.string().optional().describe("A file path inside the project, to disambiguate the workspace."),
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
    },
  },
  async (args) => {
    const { path, workspace: explicit } = args as { path?: string; workspace?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub<{ files: unknown[] }>("/changes/list", { query: { workspace } });
    return ok({ workspace, files: result.files });
  },
);

registerTool(
  "get_change",
  {
    title: "Get change details and diff",
    description:
      "Inspect detailed hunks, status, and formatted unified diff for a pending change. Useful to inspect hunk IDs before accepting/rejecting.",
    inputSchema: {
      path: z.string().optional().describe("Workspace-relative path to the file."),
      changeId: z.string().optional().describe("Unique identifier of the change set."),
      include_diff: z.boolean().optional().describe("Whether to include unified diff text (default: true)."),
    },
  },
  async (args) => {
    const { path, changeId, include_diff } = args as { path?: string; changeId?: string; include_diff?: boolean };
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const query: Record<string, string> = { workspace };
    if (changeId) query.changeId = changeId;
    if (path) query.path = path;
    const res = await callHub<{ changeSet: ChangeSet }>("/changes/get", { query });
    const cs = res.changeSet;
    const wantDiff = include_diff ?? true;
    return ok({
      changeId: cs.id,
      path: cs.path,
      workspace: cs.workspace,
      origin: cs.origin,
      applied: cs.applied,
      status: cs.status,
      binary: cs.binary,
      hunksCount: cs.hunks.length,
      hunks: cs.hunks,
      diff: wantDiff && !cs.binary ? formatHunksToDiff(cs.hunks) : undefined,
    });
  },
);

registerTool(
  "accept",
  {
    title: "Accept change",
    description: "Accept all hunks (or specific hunk ids), keeping the new code already on disk. Pending hunks remain applied; rejected hunks keep old code.",
    inputSchema: {
      path: z.string().optional().describe("Workspace-relative path (alternative to changeId)."),
      changeId: z.string().optional(),
      hunkIds: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    const { path, changeId, hunkIds } = args as {
      path?: string; changeId?: string; hunkIds?: string[];
    };
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const result = await callHub("/changes/accept", { method: "POST", body: { workspace, path, changeId, hunkIds } });
    return ok(result);
  },
);

registerTool(
  "reject",
  {
    title: "Reject change",
    description: "Reject all hunks (or specific hunk ids) of a change, restoring the baseline for them.",
    inputSchema: {
      path: z.string().optional().describe("Workspace-relative path (alternative to changeId)."),
      changeId: z.string().optional(),
      hunkIds: z.array(z.string()).optional(),
    },
  },
  async (args) => {
    const { path, changeId, hunkIds } = args as {
      path?: string; changeId?: string; hunkIds?: string[];
    };
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const result = await callHub("/changes/reject", { method: "POST", body: { workspace, path, changeId, hunkIds } });
    return ok(result);
  },
);

registerTool(
  "set_checkpoint",
  {
    title: "Set checkpoint",
    description:
      "Mark the current on-disk state as accepted, so future changes are measured against it. Use after the user has accepted the current state. Pass `workspace` (or a `path` inside it) when the session's working directory is not the project being edited.",
    inputSchema: {
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
      path: z.string().optional().describe("A file path inside the project, as an alternative to `workspace`."),
    },
  },
  async (args) => {
    const { workspace: explicit, path } = args as { workspace?: string; path?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub("/checkpoint/set", { method: "POST", body: { workspace } });
    return ok({ workspace, ok: true, cleared: true, ...(result as object) });
  },
);

registerTool(
  "get_checkpoint",
  {
    title: "Get checkpoint info",
    description: "Get information about the current checkpoint for a workspace (timestamp and tracked file count).",
    inputSchema: {
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
      path: z.string().optional().describe("A file path inside the project."),
    },
  },
  async (args) => {
    const { workspace: explicit, path } = args as { workspace?: string; path?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub<{ checkpoint: { workspace: string; setAt: number; files: number } | null }>("/checkpoint/info", {
      query: { workspace },
    });
    return ok({ workspace, checkpoint: result.checkpoint });
  },
);

registerTool(
  "clear_checkpoint",
  {
    title: "Clear checkpoint",
    description: "Clear the current checkpoint and reset tracking baseline for a workspace.",
    inputSchema: {
      workspace: z.string().optional().describe("Absolute project path. Defaults to the session's workspace."),
      path: z.string().optional().describe("A file path inside the project."),
    },
  },
  async (args) => {
    const { workspace: explicit, path } = args as { workspace?: string; path?: string };
    const workspace = explicit ?? (await resolveWorkspace(path));
    const result = await callHub("/checkpoint/clear", { method: "POST", body: { workspace } });
    return ok({ workspace, ...(result as object) });
  },
);

registerTool(
  "list_workspaces",
  {
    title: "List workspaces",
    description: "List all project workspaces tracked by Review Hub and currently active IDE windows.",
    inputSchema: {},
  },
  async () => {
    const current = workspaceOf();
    const result = await callHub<{ workspaces: string[]; activeFile?: string; focused?: string[] }>("/workspaces");
    return ok({
      currentWorkspace: current,
      workspaces: result.workspaces,
      activeFile: result.activeFile,
      focusedWorkspaces: result.focused,
    });
  },
);

// ==========================================
// RESOURCES
// ==========================================

server.registerResource(
  "changes",
  "review-hub://changes",
  {
    title: "Pending Changes",
    description: "Real-time list of all files with pending hunks awaiting review in Review Hub.",
    mimeType: "application/json",
  },
  async () => {
    const ws = await resolveWorkspace();
    const result = await callHub<{ files: unknown[] }>("/changes/list", { query: { workspace: ws } });
    return {
      contents: [
        {
          uri: "review-hub://changes",
          mimeType: "application/json",
          text: JSON.stringify({ workspace: ws, files: result.files }, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "workspaces",
  "review-hub://workspaces",
  {
    title: "Tracked Workspaces",
    description: "List of workspaces currently active in Review Hub.",
    mimeType: "application/json",
  },
  async () => {
    const wsList = await hubWorkspaces();
    return {
      contents: [
        {
          uri: "review-hub://workspaces",
          mimeType: "application/json",
          text: JSON.stringify({ current: workspaceOf(), workspaces: wsList }, null, 2),
        },
      ],
    };
  },
);

// ==========================================
// PROMPTS
// ==========================================

server.registerPrompt(
  "review_pending_changes",
  {
    title: "Review pending changes",
    description: "Analyze all pending code changes in Review Hub, provide feedback, and recommend accept/reject actions.",
    inputSchema: {
      workspace: z.string().optional().describe("Workspace path (optional)."),
    },
  },
  async (args) => {
    const ws = (args?.workspace as string) ?? (await resolveWorkspace());
    const result = await callHub<{
      files: Array<{ path: string; added: number; removed: number; pending: number }>;
    }>("/changes/list", { query: { workspace: ws } });
    const summary = result.files.length > 0
      ? result.files.map((f) => `- ${f.path} (+${f.added} -${f.removed}, ${f.pending} pending hunks)`).join("\n")
      : "No pending changes.";

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Please review all pending changes in Review Hub for workspace '${ws}':\n\n${summary}\n\nUse the get_change tool to inspect the detailed diff for each file, evaluate the quality, and recommend which hunks should be accepted or rejected.`,
          },
        },
      ],
    };
  },
);

// ==========================================
// MAIN
// ==========================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Logging is advisory; it does not trigger inference or consume tool feedback.
  const reviewTimer = setInterval(() => {
    void feedback.poll(page => server.sendLoggingMessage({ level: "info", logger: "review-hub", data: {
      type: "review_decisions", ...page, instruction: REVIEW_FEEDBACK_INSTRUCTION,
    } }));
  }, 1500);
  reviewTimer.unref();
  process.stdin.once("end", () => clearInterval(reviewTimer));
  process.stdin.once("close", () => clearInterval(reviewTimer));
}

main().catch((err) => {
  process.stderr.write(`review-hub mcp server failed: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
