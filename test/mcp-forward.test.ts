import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { HubServer } from "../core/src/hub-server";

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
  const notifications: Rpc[] = [];
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
        if (msg.id === undefined && msg.method) notifications.push(msg);
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
  return { proc, call, notify, notifications };
}

async function init(conn: ReturnType<typeof spawnMcp>) {
  const response = await conn.call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(response.error, undefined);
  const result = response.result as { instructions?: string };
  assert.equal(typeof result.instructions, "string", "MCP clients receive workflow instructions at initialization");
  for (const guidance of ["propose_changes", "delete:true", "get_review_updates", "review_decisions_changed", "fully reread", "Require Review", "Auto Open Diff"]) {
    assert.ok(result.instructions!.includes(guidance), `Missing MCP guidance: ${guidance}`);
  }
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
    assert.equal(payload.applied, true);
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hello there\n");
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

test("propose_changes composes staged edits, creates/deletes files and reports per-file failures", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-batch-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-batch-ws-"));
  fs.writeFileSync(path.join(workspace, "a.txt"), "hello\r\nworld\r\n");
  fs.writeFileSync(path.join(workspace, "remove.txt"), "remove me\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  const call = async (name: string, args: unknown) => {
    const response = await conn.call("tools/call", { name, arguments: args });
    const result = response.result as { content: Array<{ text: string }>; isError?: boolean };
    return { result, payload: JSON.parse(result.content[0].text) };
  };
  try {
    await init(conn);
    const { payload: batch } = await call("propose_changes", { changes: [
      { path: ".\\a.txt", edits: [
        { old_string: "hello\nworld", new_string: "hi\nworld" },
        { old_string: "world", new_string: "there" },
      ] },
      { path: "new.txt", content: "created\n" },
      { path: "remove.txt", delete: true },
      { path: "a.txt", content: "duplicate must not overwrite" },
      { path: "../outside.txt", content: "must not escape" },
      { path: "missing.txt", edits: [{ old_string: "absent", new_string: "x" }] },
    ] });
    assert.equal(batch.status, "partial_success");
    assert.deepEqual(batch.results.map((r: any) => r.status), [
      "staged_for_review", "staged_for_review", "staged_for_review", "error", "error", "error",
    ]);
    assert.equal(batch.results[0].path, "a.txt");
    assert.match(batch.results[0].context.excerpts[0].content, /hi\nthere/);
    assert.match(batch.results[3].message, /Duplicate/);
    assert.equal(batch.results[0].applied, true);
    assert.equal(fs.readFileSync(path.join(workspace, "a.txt"), "utf8"), "hi\r\nthere\r\n");
    assert.equal(fs.readFileSync(path.join(workspace, "new.txt"), "utf8"), "created\n");
    assert.equal(fs.existsSync(path.join(workspace, "remove.txt")), false);
    assert.equal((await call("read_file", { path: "a.txt" })).payload.content, "hi\nthere\n");

    // Failed second edit must not stage the successful first edit for this file.
    const { payload: failed } = await call("propose_changes", { changes: [
      { path: "a.txt", edits: [
        { old_string: "hi", new_string: "bad partial" },
        { old_string: "missing", new_string: "x" },
      ] },
    ] });
    assert.equal(failed.status, "error");
    assert.equal(failed.results[0].failed_edit, 1);
    assert.equal(failed.results[0].code, "match_not_found");
    assert.match(failed.results[0].context.excerpts[0].content, /hi\nthere/);
    assert.equal((await call("read_file", { path: "a.txt" })).payload.content, "hi\nthere\n");

    const { payload: followup } = await call("propose_changes", { include_context: false, changes: [
      { path: "a.txt", edits: [{ old_string: "there", new_string: "again" }] },
      { path: "new.txt", content: "created\n" },
    ] });
    assert.equal(followup.status, "staged_for_review");
    assert.equal(followup.results[0].context, undefined);
    assert.equal(followup.results[1].status, "unchanged");
    assert.equal((await call("read_file", { path: "a.txt" })).payload.content, "hi\nagain\n");
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("propose_changes rejects invalid operations before staging any file", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-batch-invalid-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-batch-invalid-ws-"));
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    for (const change of [
      { path: "a.txt" },
      { path: "a.txt", content: "x", delete: true },
      { path: "a.txt", edits: [] },
      { path: "a.txt", edits: [{ old_string: "", new_string: "x" }] },
    ]) {
      const response = await conn.call("tools/call", { name: "propose_changes", arguments: { changes: [
        { path: "valid.txt", content: "must not stage" }, change,
      ] } });
      assert.equal((response.result as { isError?: boolean }).isError, true);
      assert.equal(hub.store.findChangeByPath(workspace, "valid.txt"), undefined);
    }
  } finally {
    conn.proc.kill();
    await hub.stop();
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

test("propose_edit adapts CRLF/LF line endings gracefully", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-eol-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-eol-"));
  fs.writeFileSync(path.join(workspace, "crlf.txt"), "line 1\r\nline 2\r\nline 3\r\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "propose_edit",
      arguments: { path: "crlf.txt", old_string: "line 2\n", new_string: "line 2 modified\n" },
    });
    const text = (res.result as { content: { text: string }[] }).content[0].text;
    const payload = JSON.parse(text);
    assert.equal(payload.status, "staged_for_review");
    assert.equal(payload.hunks, 1);

    const readRes = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: "crlf.txt" },
    });
    const readPayload = JSON.parse((readRes.result as { content: { text: string }[] }).content[0].text);
    assert.match(readPayload.content, /line 2 modified/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("read_file supports start_line, end_line, and line_numbers", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-read-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-read-"));
  fs.writeFileSync(path.join(workspace, "lines.txt"), "A\nB\nC\nD\nE\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const res = await conn.call("tools/call", {
      name: "read_file",
      arguments: { path: "lines.txt", start_line: 2, end_line: 4, line_numbers: true },
    });
    const payload = JSON.parse((res.result as { content: { text: string }[] }).content[0].text);
    assert.equal(payload.total_lines, 6);
    assert.equal(payload.start_line, 2);
    assert.equal(payload.end_line, 4);
    assert.match(payload.content, /2 \| B/);
    assert.match(payload.content, /3 \| C/);
    assert.match(payload.content, /4 \| D/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("get_change returns detailed hunks and unified diff", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-diff-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-diff-"));
  fs.writeFileSync(path.join(workspace, "code.ts"), "const x = 1;\nconst y = 2;\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    await conn.call("tools/call", {
      name: "propose_edit",
      arguments: { path: "code.ts", old_string: "const x = 1;\n", new_string: "const x = 100;\n" },
    });
    const res = await conn.call("tools/call", {
      name: "get_change",
      arguments: { path: "code.ts" },
    });
    const payload = JSON.parse((res.result as { content: { text: string }[] }).content[0].text);
    assert.equal(payload.path, "code.ts");
    assert.equal(payload.hunksCount, 1);
    assert.ok(payload.hunks[0].id);
    assert.match(payload.diff, /-const x = 1;/);
    assert.match(payload.diff, /\+const x = 100;/);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("checkpoint tools (get_checkpoint, clear_checkpoint) and list_workspaces work", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-cp-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-cp-"));
  fs.writeFileSync(path.join(workspace, "f.txt"), "foo\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);
  await hub.store.setCheckpoint(workspace, { maxFileSize: 1e9, excludeGlobs: [] });

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const cpRes = await conn.call("tools/call", { name: "get_checkpoint", arguments: {} });
    const cpPayload = JSON.parse((cpRes.result as { content: { text: string }[] }).content[0].text);
    assert.ok(cpPayload.checkpoint);
    assert.equal(cpPayload.checkpoint.files, 1);

    const wsRes = await conn.call("tools/call", { name: "list_workspaces", arguments: {} });
    const wsPayload = JSON.parse((wsRes.result as { content: { text: string }[] }).content[0].text);
    assert.ok(Array.isArray(wsPayload.workspaces));

    const clearRes = await conn.call("tools/call", { name: "clear_checkpoint", arguments: {} });
    const clearPayload = JSON.parse((clearRes.result as { content: { text: string }[] }).content[0].text);
    assert.ok(clearPayload.ok === true || clearPayload.cleared === true);
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("resources and prompts are registered and callable", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-rp-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-ws-rp-"));
  fs.writeFileSync(path.join(workspace, "r.txt"), "resource test\n");
  const hub = new HubServer({ baseDir, token: "tok", excludeGlobs: [] });
  const addr = await hub.start(0);

  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  try {
    await init(conn);
    const resList = await conn.call("resources/list", {});
    const rList = resList.result as { resources: Array<{ uri: string }> };
    assert.ok(rList.resources.some((r) => r.uri === "review-hub://changes"));

    const promptList = await conn.call("prompts/list", {});
    const pList = promptList.result as { prompts: Array<{ name: string }> };
    assert.ok(pList.prompts.some((p) => p.name === "review_pending_changes"));
  } finally {
    conn.proc.kill();
    await hub.stop();
  }
});

test("review decisions reach MCP logs and tool responses; stale edits require full file reads", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-feedback-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rh-feedback-ws-"));
  const initial = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
  fs.writeFileSync(path.join(workspace, "a.ts"), initial);
  const hub = new HubServer({ baseDir, token: "tok", mcpOnly: true });
  const addr = await hub.start();
  const conn = spawnMcp({ REVIEW_HUB_URL: addr.url, REVIEW_HUB_TOKEN: "tok", REVIEW_HUB_WORKSPACE: workspace });
  const invoke = async (name: string, args: unknown) => {
    const response = await conn.call("tools/call", { name, arguments: args });
    const result = response.result as { isError?: boolean; content: Array<{ text: string }> };
    return { result, payload: JSON.parse(result.content[0].text) };
  };
  try {
    await init(conn);
    const { payload } = await invoke("propose_write", { path: "a.ts", content: initial.replace("line 2\n", "first changed\n").replace("line 24\n", "last changed\n") });
    const cs = hub.store.findById(payload.changeId)!;
    assert.equal(cs.hunks.length, 2);
    hub.store.accept(cs.id, [cs.hunks[0].id]);
    hub.store.reject(cs.id, [cs.hunks[1].id]);
    const deadline = Date.now() + 5000;
    while (!conn.notifications.some(message => message.method === "notifications/message") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const notification = conn.notifications.find(message => message.method === "notifications/message")!;
    assert.ok(notification, "MCP advisory notification received without a model prompt");
    const log = notification.params as { data: { type: string; events: unknown[] } };
    assert.equal(log.data.type, "review_decisions"); assert.equal(log.data.events.length, 2);
    const blocked = await invoke("propose_edit", { path: "a.ts", old_string: "line 24", new_string: "retry rejected" });
    assert.equal(blocked.result.isError, true); assert.equal(blocked.payload.code, "review_decisions_changed");
    assert.equal(blocked.payload.review_updates[0].events.length, 2, "logs did not consume feedback");
    assert.match(fs.readFileSync(path.join(workspace, "a.ts"), "utf8"), /line 24/);
    await invoke("read_file", { path: "a.ts", start_line: 1, end_line: 2 });
    assert.equal((await invoke("propose_edit", { path: "a.ts", old_string: "line 24", new_string: "retry rejected" })).payload.code, "review_decisions_changed");
    const read = await invoke("read_file", { path: "a.ts" });
    assert.match(read.payload.content, /first changed/); assert.match(read.payload.content, /line 24/);
    const next = await invoke("propose_edit", { path: "a.ts", old_string: "line 10", new_string: "independent follow-up" });
    assert.equal(next.result.isError, undefined);
    const history = await invoke("get_review_updates", { workspace, limit: 1 });
    assert.equal(history.payload.events.length, 1); assert.equal(history.payload.hasMore, true);
    const final = await invoke("get_review_updates", { workspace, after: history.payload.cursor });
    assert.equal(final.payload.events.length, 1); assert.equal(final.payload.events[0].decision, "rejected");
    assert.equal(final.payload.events[0].resolved, true);
    assert.equal((await invoke("get_review_updates", { workspace, after: final.payload.cursor })).payload.events.length, 0);
    const forbidden = await fetch(addr.url + "/review/events?workspace=" + encodeURIComponent(workspace));
    assert.equal(forbidden.status, 401);
    const badLimit = await fetch(addr.url + "/review/events?workspace=" + encodeURIComponent(workspace) + "&limit=200", { headers: { authorization: "Bearer tok" } });
    assert.equal(badLimit.status, 400);
  } finally { conn.proc.kill(); await hub.stop(); }
});
