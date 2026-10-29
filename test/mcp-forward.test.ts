import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { HubServer } from "../src/server/hub-server";

const SERVER = path.resolve("dist/mcp-server.cjs");

interface Rpc {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

/** Spawn the bundled MCP server and drive it over stdio. */
function spawnMcp(env: Record<string, string>) {
  const proc = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  const pending = new Map<number, (msg: Rpc) => void>();
  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Rpc;
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON
      }
    }
  });
  let nextId = 1;
  const call = (method: string, params?: unknown): Promise<Rpc> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 8000);
    });
  };
  const notify = (method: string, params?: unknown) => {
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  return { proc, call, notify };
}

async function init(conn: ReturnType<typeof spawnMcp>) {
  await conn.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  conn.notify("notifications/initialized");
}

test("MCP server forwards propose_edit to a live hub", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-"));
  fs.writeFileSync(path.join(workspace, "a.txt"), "hello world\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "propose_edit",
      arguments: { path: "a.txt", old_string: "world", new_string: "there" },
    });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.ok(payload.changeId);
    assert.equal(payload.hunks, 1);
    assert.equal(payload.status, "staged_for_review");
    // Review-then-apply: the edit is staged, not written. `read_file` returns it (see Task 2).
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hello world\n");
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("MCP server fails fast with a clear error when the hub is down", async () => {
  const conn = spawnMcp({ REVIEW_HUB_URL: "http://127.0.0.1:1", REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: "/tmp" });
  try {
    await init(conn);
    const res = await conn.call("tools/call", { name: "list_changes", arguments: {} });
    const result = res.result as { isError?: boolean; content: { text: string }[] };
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Review Hub|not running|hub/i);
  } finally {
    conn.proc.kill();
  }
});

test("a relative path routes to the workspace that actually holds it, not the harness cwd", async () => {
  // The reported bug: the harness was launched in project A, but the agent edits project B
  // (which also has a README.md). `process.cwd()` would read A's README — the wrong file.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route-"));
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route-a-"));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route-b-"));
  fs.writeFileSync(path.join(projA, "README.md"), "# Project A\n");
  fs.writeFileSync(path.join(projB, "README.md"), "# Project B\n");

  // Both projects are open in the window; B is the one the user is looking at.
  const hub = new HubServer({
    baseDir,
    token: "tok",
    excludeGlobs: [],
    windowStates: () => [
      { pid: process.pid, folders: [projB], activeFile: path.join(projB, "README.md"), focusedAt: 2, updatedAt: 2 },
      { pid: process.pid, folders: [projA], focusedAt: 1, updatedAt: 1 },
    ],
  });
  const addr = await hub.start(0);

  // No REVIEW_HUB_WORKSPACE: the server must work it out. cwd is the repo, not either project.
  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok" });
  try {
    await init(conn);
    const res = await conn.call("tools/call", { name: "read_file", arguments: { path: "README.md" } });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.match(payload.content, /Project B/, "reads the focused project's README, not project A's");
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("an absolute path routes by containment", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route2-"));
  const projA = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route2-a-"));
  const projB = fs.mkdtempSync(path.join(os.tmpdir(), "rh-route2-b-"));
  fs.mkdirSync(path.join(projA, "src"));
  fs.mkdirSync(path.join(projB, "src"));
  fs.writeFileSync(path.join(projA, "src", "cfg.ts"), "export const who = 'A';\n");
  fs.writeFileSync(path.join(projB, "src", "cfg.ts"), "export const who = 'B';\n");

  const hub = new HubServer({
    baseDir,
    token: "tok",
    excludeGlobs: [],
    windowStates: () => [{ pid: process.pid, folders: [projA, projB], focusedAt: 1, updatedAt: 1 }],
  });
  const addr = await hub.start(0);
  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok" });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: path.join(projB, "src", "cfg.ts") },
    });
    const payload = JSON.parse((res.result as { content: { text: string }[] }).content[0].text);
    assert.match(payload.content, /'B'/, "the absolute path picks project B");
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});
