import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { addClaudeInstructions, installClaudeInstructions } from "../vscode/src/agents/claude-instructions";
import { registerDetectedAgents, type AgentEnvironment } from "../vscode/src/agents/mcp-registration";

async function environment(): Promise<AgentEnvironment> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-claude-rules-"));
  return { homeDir, env: { PATH: "" }, platform: "linux", globalStorageDir: path.join(homeDir, "storage"), installedExtensions: ["anthropic.claude-code"] };
}
const options = { claudeInstructions: () => true };

test("auto-adding Claude installs both the MCP connection and user-level editing instructions once", async () => {
  const env = await environment();
  const [first] = await registerDetectedAgents(env, () => true, options);
  assert.equal(first.status, "registered");
  assert.equal(first.instructions?.status, "installed");
  const file = path.join(env.homeDir, ".claude", "CLAUDE.md");
  assert.equal(first.instructions?.path, file);
  const text = await fs.readFile(file, "utf8");
  assert.match(text, /When the review-hub MCP server is available/);
  assert.match(text, /propose_edit/);
  assert.match(text, /staged_for_review/);
  assert.match(text, /Do not call Accept, Reject or checkpoint/);
  const config = JSON.parse(await fs.readFile(path.join(env.homeDir, ".claude.json"), "utf8"));
  assert.equal(config.mcpServers["review-hub"].command, "npx");
  const [second] = await registerDetectedAgents(env, () => true, options);
  assert.equal(second.status, "already-configured");
  assert.equal(second.instructions?.status, "already-installed");
  assert.equal(await fs.readFile(file, "utf8"), text);
  assert.equal(text.split("<!-- review-hub:start -->").length, 2);
  await assert.rejects(fs.stat(path.join(env.homeDir, ".claude", "settings.json")), { code: "ENOENT" });
});

test("only the managed section changes, preserving BOM, CRLF and all surrounding instructions", () => {
  const prefix = "\uFEFF# Personal rules\r\nKeep this exactly.\r\n\r\n";
  const suffix = "\r\n# More rules\r\nUse my formatter.\r\n";
  const original = prefix + "<!-- review-hub:start -->\r\nOld Hub guidance.\r\n<!-- review-hub:end -->\r\n" + suffix;
  const result = addClaudeInstructions(original);
  assert.ok(result.startsWith(prefix));
  assert.ok(result.endsWith(suffix));
  assert.equal(result.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(result.includes("Old Hub guidance."), false);
  assert.equal(addClaudeInstructions(result), result);
});

test("existing personal instructions get a separated section and an initial private backup", async () => {
  const env = await environment();
  const dir = path.join(env.homeDir, ".claude");
  await fs.mkdir(dir);
  const file = path.join(dir, "CLAUDE.md");
  const personal = "# Personal guidance\nDo not remove this.";
  await fs.writeFile(file, personal, { mode: 0o640 });
  assert.equal((await installClaudeInstructions(dir, () => true)).status, "installed");
  assert.ok((await fs.readFile(file, "utf8")).startsWith(personal + "\n\n"));
  assert.equal(await fs.readFile(file + ".review-hub.bak", "utf8"), personal);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o640);
    assert.equal((await fs.stat(file + ".review-hub.bak")).mode & 0o777, 0o600);
  }
});

test("MCP already connected still installs missing instructions without rewriting custom server settings", async () => {
  const env = await environment();
  const file = path.join(env.homeDir, ".claude.json");
  const original = '{"mcpServers":{"review-hub":{"command":"my-launcher","args":["custom"]}},"theme":"dark"}';
  await fs.writeFile(file, original);
  const [result] = await registerDetectedAgents(env, () => true, options);
  assert.equal(result.status, "already-configured");
  assert.equal(result.instructions?.status, "installed");
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("custom CLAUDE_CONFIG_DIR is used for both configuration and instructions", async () => {
  const env = await environment();
  const dir = path.join(env.homeDir, "claude-personal");
  env.env.CLAUDE_CONFIG_DIR = dir;
  const [result] = await registerDetectedAgents(env, () => true, options);
  assert.equal(result.configPath, path.join(dir, ".claude.json"));
  assert.equal(result.instructions?.path, path.join(dir, "CLAUDE.md"));
  assert.equal(result.instructions?.status, "installed");
  await assert.rejects(fs.stat(path.join(env.homeDir, ".claude")), { code: "ENOENT" });
});

test("instruction checkbox opt-out still registers MCP and creates no CLAUDE.md", async () => {
  const env = await environment();
  const [result] = await registerDetectedAgents(env, () => true, { claudeInstructions: () => false });
  assert.equal(result.status, "registered");
  assert.equal(result.instructions, undefined);
  await assert.rejects(fs.stat(path.join(env.homeDir, ".claude", "CLAUDE.md")), { code: "ENOENT" });
});

test("disabling Claude prevents both MCP and instruction writes", async () => {
  const env = await environment();
  const [result] = await registerDetectedAgents(env, () => false, options);
  assert.equal(result.status, "disabled");
  assert.equal(result.instructions, undefined);
  assert.deepEqual(await fs.readdir(env.homeDir), []);
});

test("incomplete or duplicate managed markers report an instruction error without altering existing rules or the MCP connection", async () => {
  for (const text of ["# My rules\n<!-- review-hub:start -->\nNever overwrite this", "<!-- review-hub:start --><!-- review-hub:end --><!-- review-hub:start --><!-- review-hub:end -->"]) {
    const env = await environment();
    const dir = path.join(env.homeDir, ".claude");
    await fs.mkdir(dir);
    const file = path.join(dir, "CLAUDE.md");
    await fs.writeFile(file, text);
    const [result] = await registerDetectedAgents(env, () => true, options);
    assert.equal(result.status, "registered");
    assert.equal(result.instructions?.status, "error");
    assert.equal(await fs.readFile(file, "utf8"), text);
    assert.ok(JSON.parse(await fs.readFile(result.configPath, "utf8")).mcpServers["review-hub"]);
  }
});

test("an instruction write failure does not roll back a successful MCP registration", async () => {
  const env = await environment();
  const dir = path.join(env.homeDir, ".claude", "CLAUDE.md");
  await fs.mkdir(dir, { recursive: true });
  const [result] = await registerDetectedAgents(env, () => true, options);
  assert.equal(result.status, "registered");
  assert.equal(result.instructions?.status, "error");
  assert.ok((await fs.stat(dir)).isDirectory());
});

test("turning off instructions while preparing an update cancels the write", async () => {
  const env = await environment();
  let checks = 0;
  const result = await installClaudeInstructions(path.join(env.homeDir, ".claude"), () => ++checks < 2);
  assert.equal(result.status, "disabled");
  assert.deepEqual(await fs.readdir(env.homeDir), []);
});

test("user-level instruction symlinks are preserved", { skip: process.platform === "win32" }, async () => {
  const env = await environment();
  const real = path.join(env.homeDir, "personal.md");
  const dir = path.join(env.homeDir, ".claude");
  await fs.mkdir(dir);
  await fs.writeFile(real, "Keep my dotfiles.");
  const link = path.join(dir, "CLAUDE.md");
  await fs.symlink(real, link);
  assert.equal((await installClaudeInstructions(dir, () => true)).status, "installed");
  assert.ok((await fs.lstat(link)).isSymbolicLink());
  assert.match(await fs.readFile(real, "utf8"), /^Keep my dotfiles\./);
  assert.equal(await fs.readFile(real + ".review-hub.bak", "utf8"), "Keep my dotfiles.");
});
