import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser/lib/esm/main.js";
import { reviewToolAllowed, ompReviewHook, claudeReviewHook } from "../vscode/src/agents/review-policy";
import { configureClaudeReviewHook, installRequiredReview, quoteHookArgument } from "../vscode/src/agents/required-review";
import { registerDetectedAgents } from "../vscode/src/agents/mcp-registration";

for (const client of ["claude", "omp"] as const) {
  test(client + " required review rejects native executors and unknown tools", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "Agent", "Task", "edit", "ast_edit", "write", "bash", "python", "eval", "task", "debug", "browser", "computer", "apply_patch", "mcp__other__propose_write", "unknown"]) {
      assert.equal(reviewToolAllowed(client, name, { path: "/tmp/source.ts", command: "echo changed > source.ts" }), false, name);
    }
    assert.equal(reviewToolAllowed(client, undefined, {}), false);
  });
  test(client + " required review allows proposals, rejects user review actions and prefix tricks", () => {
    const prefix = client === "omp" ? "mcp__review_hub_" : "mcp__review_hub__";
    for (const action of ["propose_changes", "propose_edit", "propose_write", "propose_delete", "read_file", "list_changes", "get_change"]) assert.equal(reviewToolAllowed(client, prefix + action, {}), true);
    for (const action of ["accept", "reject", "set_checkpoint", "clear_checkpoint", "propose_write_extra", "propose_edit/../../bash"]) assert.equal(reviewToolAllowed(client, prefix + action, {}), false);
  });
}

test("OMP permits only exact approved XDEV devices, rejects normalization/bypass paths", () => {
  assert.equal(reviewToolAllowed("omp", "write", { path: "xd://mcp__review_hub_propose_write" }), true);
  for (const path of ["xd://mcp__review_hub_accept", "xd://bash", "xd://mcp__other_propose_write", "xd://mcp__review_hub_propose_write/../accept", "xd://mcp__review_hub_propose_write/", "./xd://mcp__review_hub_propose_write", "proc://123", "cfg://config", "file.ts", "XD://mcp__review_hub_propose_write"]) assert.equal(reviewToolAllowed("omp", "write", { path }), false, path);
  assert.equal(reviewToolAllowed("omp", "read", { path: "xd://" }), true);
  assert.equal(reviewToolAllowed("omp", "read", { path: "omp://tools/write.md" }), true);
  for (const path of ["mcp://unknown", "ssh://host/code", "http://localhost/action", "source.ts"]) assert.equal(reviewToolAllowed("omp", "read", { path }), false);
});

test("generated OMP hook blocks before execution in main and child factories", async () => {
  const factory = (await import("data:text/javascript;base64," + Buffer.from(ompReviewHook()).toString("base64"))).default;
  for (const kind of ["main", "sub"]) {
    let callback: any;
    factory({ on: (event: string, handler: any) => { assert.equal(event, "tool_call"); callback = handler; } });
    assert.equal(callback({ toolName: "bash", input: { command: "touch /tmp/forbidden" } }, { agent: { kind } }).block, true);
    assert.equal(callback({ toolName: "mcp__review_hub_propose_edit", input: {} }, { agent: { kind } }), undefined);
  }
});

test("generated Claude hook protocol blocks invalid input, shell, self-accept; allows proposals", () => {
  for (const [name, status] of [["Bash", 2], ["mcp__review_hub__accept", 2], ["mcp__review_hub__propose_edit", 0], ["Read", 0], ["ToolSearch", 0], ["ToolSearchExecute", 2], ["mcp__other__propose_delete", 2]] as const) {
    const result = spawnSync(process.execPath, ["-e", claudeReviewHook()], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: name, tool_input: {} }) });
    assert.equal(result.status, status, result.stderr.toString());
  }
  for (const input of ["{broken", "{}", JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" })]) assert.equal(spawnSync(process.execPath, ["-e", claudeReviewHook()], { input }).status, 2);
});

test("Claude hook configuration is idempotent, preserves existing hooks, removes only ours", () => {
  const initial = '{\n// user comment\n"env":{"KEEP":"yes"},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"custom-check"}]}],"Stop":[]}}';
  const command = "'node' '/some path/require-review.cjs'";
  const installed = configureClaudeReviewHook(initial, command, true)!;
  assert.match(installed, /user comment/);
  assert.equal(parse(installed).hooks.PreToolUse.length, 2);
  assert.equal(configureClaudeReviewHook(installed, command, true), undefined);
  const removed = configureClaudeReviewHook(installed, command, false)!;
  assert.deepEqual(parse(removed), parse(initial));
  for (const broken of ['{broken', '{"hooks":[]}', '{"hooks":{"PreToolUse":{}}}', '{"hooks":{"PreToolUse":[{}]}}']) assert.throws(() => configureClaudeReviewHook(broken, command, true));
  assert.equal(configureClaudeReviewHook("", command, false), undefined);
});

test("POSIX hook command quoting protects spaces, quotes and shell substitutions", () => {
  const value = "/tmp/a' $(echo should-not-run) `echo neither`";
  const result = spawnSync("sh", ["-c", "printf %s " + quoteHookArgument(value)], { encoding: "utf8" });
  assert.equal(result.stdout, value);
  assert.throws(() => quoteHookArgument("a\nb"));
});

test("installers are opt-in, preserve backups/settings, and disable only managed policy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rh-required-"));
  const dir = path.join(root, "claude");
  assert.equal((await installRequiredReview("claudeCode", dir, "linux", () => false, () => true)).status, "disabled");
  assert.deepEqual(await fs.readdir(root), []);
  await fs.mkdir(dir); const original = '{"permissions":{"allow":["Read"]}}';
  await fs.writeFile(path.join(dir, "settings.json"), original);
  assert.equal((await installRequiredReview("claudeCode", dir, "linux", () => true, () => true, process.execPath)).status, "installed");
  assert.equal(await fs.readFile(path.join(dir, "settings.json.review-hub.bak"), "utf8"), original);
  assert.equal((await installRequiredReview("claudeCode", dir, "linux", () => true, () => true, process.execPath)).status, "already-installed");
  assert.equal((await installRequiredReview("claudeCode", dir, "linux", () => false, () => true)).status, "removed");
  const config = parse(await fs.readFile(path.join(dir, "settings.json"), "utf8"));
  assert.deepEqual(config.permissions, { allow: ["Read"] }); assert.deepEqual(config.hooks.PreToolUse, []);
  const omp = path.join(root, "omp");
  const installed = await installRequiredReview("ohMyPi", omp, "linux", () => true, () => true);
  assert.equal(installed.status, "installed"); assert.match(installed.path, /hooks\/pre\/.*\.ts$/);
  assert.match(await fs.readFile(installed.path, "utf8"), /tool_call/);
  await installRequiredReview("ohMyPi", omp, "linux", () => false, () => true);
  assert.doesNotMatch(await fs.readFile(installed.path, "utf8"), /tool_call/);
});

test("installer refuses custom hook file and unsupported adapters, honors live disabled state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rh-required-"));
  assert.equal((await installRequiredReview("ohMyPi", root, "linux", () => true, () => false)).status, "disabled");
  assert.equal((await installRequiredReview("codex", root, "linux", () => true, () => true)).status, "unsupported");
  assert.equal((await installRequiredReview("claudeCode", root, "win32", () => true, () => true)).status, "unsupported");
  const file = path.join(root, "hooks/pre/review-hub-required.ts"); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "user hook");
  assert.equal((await installRequiredReview("ohMyPi", root, "linux", () => true, () => true)).status, "error");
  assert.equal(await fs.readFile(file, "utf8"), "user hook");
});

test("registration reports unsupported enforcement separately from successful MCP connection", async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-required-reg-"));
  await fs.mkdir(path.join(homeDir, ".cursor"));
  const results = await registerDetectedAgents({ homeDir, env: { PATH: "" }, platform: "linux", globalStorageDir: path.join(homeDir, "storage"), installedExtensions: [] }, () => true, { requireReview: () => true });
  assert.equal(results[0].status, "registered");
  assert.equal(results[0].requiredReview?.status, "unsupported");
});
