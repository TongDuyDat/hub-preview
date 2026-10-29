/**
 * Thin stdio MCP server. Harnesses (Claude Code, opencode, dsh, Cline, Roo) spawn
 * this per session; it forwards every tool call to the Review Hub HTTP server run by
 * the VS Code extension, discovered via ~/.review-hub/hub.json.
 *
 * It never edits files itself. If the hub is not running it fails fast with a clear
 * message so the agent falls back to native tools (whose writes the FS watcher still
 * catches). It must never hang.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRegistry, defaultBaseDir, pidAlive } from "../src/server/registry";
import type { HubEntry } from "../src/server/registry";

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
      "Review Hub is not running. Open the Review Hub panel in VS Code, or fall back to your normal edit tools (the changes will still be captured by the file watcher).",
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
      throw new Error("Review Hub did not respond in time. Is the VS Code window still open?");
    }
    if (e?.message === "fetch failed" || e?.name === "TypeError") {
      throw new Error(
        "Review Hub is not reachable. Open the Review Hub panel in VS Code, or fall back to your normal edit tools (the file watcher still records those changes).",
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which project this agent is working in.
 *
 * A harness spawns this server once, with a working directory fixed for the whole session,
 * but the agent may be editing any project the user has open — so `process.cwd()` is only
 * a hint, not the answer. Resolution order:
 *
 *   1. `REVIEW_HUB_WORKSPACE` — set explicitly by a harness or by the user.
 *   2. The workspace that contains the agent's own path (absolute or relative), chosen
 *      from the workspaces the hub reports. This is the reliable case.
 *   3. `process.cwd()`, if it is one of the hub's workspaces.
 *   4. The cwd anyway, so an unconfigured single-project setup still works.
 *
 * We never fall back to the hub's own workspace: one shared hub serves many projects, so
 * that would route edits into whichever window happened to win the registry.
 */
let workspaceCache: { at: number; list: string[] } | undefined;
/**
 * The workspace a relative path resolved to most recently. A session works in one project
 * at a time, so once a path has identified the project, later bare paths should follow it
 * rather than re-probing (and possibly landing on a different project that also has the
 * file). Cleared whenever an absolute path names a different workspace.
 */
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
    // An absolute path names its workspace directly; longest match wins.
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) {
      const hit = known.filter((ws) => isInside(ws, path)).sort((a, b) => b.length - a.length)[0];
      if (hit) {
        stickyWorkspace = hit;
        return hit;
      }
    } else {
      // A relative path is ambiguous when several projects have the same file. Prefer the
      // project this session already resolved to; only probe the rest if that misses.
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
  if (known.includes(cwd)) {
    return cwd;
  }
  return stickyWorkspace ?? cwd;
}

/** Synchronous best-effort variant for tools that already carry a changeId. */
function workspaceOf(): string {
  return process.env.REVIEW_HUB_WORKSPACE ?? stickyWorkspace ?? process.cwd();
}

/**
 * The SDK's `registerTool` generics instantiate too deeply under this TS/zod combo
 * (TS2589). We keep the zod schemas for runtime validation but erase the generics at
 * the call boundary, which is safe because every handler is a thin forwarder.
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
  connect(transport: unknown): Promise<void>;
}

const server = new McpServer({ name: "review-hub", version: "0.1.0" }) as unknown as TypedServer;

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

server.registerTool(
  "propose_edit",
  {
    title: "Propose edit",
    description:
      "Stage an edit to a file for human review instead of writing it. Mirrors the native Edit tool (old_string/new_string). The user sees a diff and accepts or rejects each hunk; nothing is written until they accept. Prefer this over Edit/Write so the user can review your change.",
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
    const count = countOccurrences(src, old_string);
    if (count === 0) {
      return fail(`old_string not found in ${path}`);
    }
    if (count > 1 && !replace_all) {
      return fail(`old_string occurs ${count} times in ${path}; pass replace_all or add more context`);
    }
    const next = replace_all ? src.split(old_string).join(new_string) : src.replace(old_string, () => new_string);
    const result = await callHub<{ changeId: string; hunks: unknown[] }>("/changes/propose", {
      method: "POST",
      body: { workspace, path, content: next },
    });
    return ok({
      status: "staged_for_review",
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Edit staged for review. Nothing was written to disk: the user sees it in the Review Hub panel and each hunk is written only when they accept it. Reading the file with your own tools will therefore show the OLD content — that is expected, not a failure. Use the `read_file` tool to see the staged content. This is success: do not retry with another tool and do not ask for confirmation. Continue with your task.",
    });
  },
);

server.registerTool(
  "propose_write",
  {
    title: "Propose write",
    description:
      "Stage a full file write (new or replaced) for human review instead of writing it directly. Nothing is written until the user accepts.",
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
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Write staged for review. Nothing was written to disk: the user sees it in the Review Hub panel and each hunk is written only when they accept it. Reading the file with your own tools will therefore show the OLD content — that is expected, not a failure. Use the `read_file` tool to see the staged content. This is success: do not retry with another tool and do not ask for confirmation. Continue with your task.",
    });
  },
);

server.registerTool(
  "propose_delete",
  {
    title: "Propose delete",
    description:
      "Stage a file deletion for human review instead of deleting it directly. Nothing is deleted until the user accepts.",
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
      changeId: result.changeId,
      path,
      hunks: result.hunks.length,
      note:
        "Deletion staged for review. Nothing was deleted from disk: the user sees it in the Review Hub panel and the file is deleted only when they accept it.",
    });
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read file",
    description: "Read a workspace file through the hub (same content the user reviews).",
    inputSchema: { path: z.string().describe("Workspace-relative path.") },
  },
  async (args) => {
    const { path } = args as { path: string };
    const workspace = await resolveWorkspace(path);
    const read = await callHub<{ exists: boolean; content: string; binary: boolean }>("/file/read", {
      query: { workspace, path },
    });
    if (!read.exists) {
      return fail(`file not found: ${path}`);
    }
    return ok({ path, binary: read.binary, content: read.content });
  },
);

server.registerTool(
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

server.registerTool(
  "accept",
  {
    title: "Accept change",
    description: "Accept all hunks (or specific hunk ids) of a staged change, writing them to disk.",
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
    // changeId alone is enough (the hub finds it); a path needs the right workspace.
    const workspace = changeId ? workspaceOf() : await resolveWorkspace(path);
    const result = await callHub("/changes/accept", { method: "POST", body: { workspace, path, changeId, hunkIds } });
    return ok(result);
  },
);

server.registerTool(
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

server.registerTool(
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
    return ok({ workspace, ...(result as object) });
  },
);

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


async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`review-hub mcp server failed: ${String(err?.stack ?? err)}\n`);
  process.exit(1);
});
