import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse as jsonc } from "jsonc-parser/lib/esm/main.js";
import { parse as toml } from "smol-toml";
import { parse as yaml } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { prepareMcpRuntime, type McpLaunch } from "../vscode/src/agents/mcp-runtime";
import { SUPPORTED_AGENTS, addMcpEntry, registerAgent, registerDetectedAgents, type AgentEnvironment, type DetectedAgent } from "../vscode/src/agents/mcp-registration";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "rh-agent-runtime-"));
function target(id: DetectedAgent["id"], root: string): DetectedAgent {
  const codex = id === "codex"; const dsh = id === "deepseekHarness";
  return { id, label: id, configPath: path.join(root, id + (codex ? ".toml" : dsh ? ".yml" : ".json")),
    format: codex ? "toml" : dsh ? "yaml" : "jsonc", section: codex ? "mcp_servers" : dsh ? "cordis" : id === "opencode" ? "mcp" : "mcpServers" };
}
function entry(agent: DetectedAgent, text: string): any {
  const data = agent.format === "toml" ? toml(text) : agent.format === "yaml" ? yaml(text) : jsonc(text);
  return agent.format === "yaml" ? data[0].insert[0].config : data[agent.section]["review-hub"];
}

for (const { id } of SUPPORTED_AGENTS) {
  test(id + " uses the bundled runtime and upgrades a generated npm registration", async () => {
    const root = await tmp(); const agent = target(id, root);
    const launch: McpLaunch = { command: process.execPath, args: [path.join(root, "bundled server.cjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
    const initial = addMcpEntry(agent, "", "linux")!;
    const updated = addMcpEntry(agent, initial, "linux", { launch })!;
    assert.ok(updated);
    const configured = entry(agent, updated);
    assert.deepEqual(configured.command, id === "opencode" ? [launch.command, ...launch.args] : launch.command);
    if (id !== "opencode") assert.deepEqual(configured.args, launch.args);
    assert.deepEqual({ ...configured[id === "opencode" ? "environment" : "env"] }, launch.env);
    assert.equal(addMcpEntry(agent, updated, "linux", { launch }), undefined, "idempotent");
    const fresh = entry(agent, addMcpEntry(agent, "", "linux", { launch })!);
    assert.deepEqual(fresh.command, configured.command);
  });
}

test("JSONC migrations preserve comments, environment and unrelated fields; disabled/custom/remote entries remain byte-identical", async () => {
  const root = await tmp(); const agent = target("cursor", root);
  const launch = { command: process.execPath, args: [path.join(root, "server.cjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const initial = '\uFEFF{\r\n // keep comment\r\n "mcpServers":{"other":{"url":"https://example.invalid"},"review-hub":{"command":"npx","args":["-y","review-hub-mcp"],"env":{"KEEP":"yes"},"timeout":300}}\r\n}\r\n';
  const updated = addMcpEntry(agent, initial, "linux", { launch })!;
  assert.ok(updated.startsWith("\uFEFF")); assert.ok(updated.includes("// keep comment\r\n"));
  const parsed = jsonc(updated.slice(1));
  assert.equal(parsed.mcpServers.other.url, "https://example.invalid");
  assert.equal(parsed.mcpServers["review-hub"].env.KEEP, "yes");
  assert.equal(parsed.mcpServers["review-hub"].timeout, 300);
  for (const patch of [{ disabled: true }, { enabled: false }, { command: "custom-launcher" }, { command: "/custom/npx" }, { url: "https://example.invalid/mcp" }]) {
    let warnings = 0;
    const text = JSON.stringify({ mcpServers: { "review-hub": { command: "npx", args: ["-y", "review-hub-mcp"], ...patch } } });
    assert.equal(addMcpEntry(agent, text, "linux", { launch, onCustom: () => warnings++ }), undefined);
    assert.equal(warnings, 1);
  }
});

test("only exact legacy runtime paths migrate, including OMP and Windows launchers", async () => {
  const root = await tmp(); const agent = target("ohMyPi", root);
  const legacy = path.join(root, "legacy", "mcp-server.cjs");
  const launch = { command: process.execPath, args: [path.join(root, "current.cjs")] };
  const text = JSON.stringify({ mcpServers: { "review-hub": { command: "node", args: [legacy], enabled: true } } });
  assert.equal(addMcpEntry(agent, text, "linux", { launch }), undefined);
  assert.deepEqual(entry(agent, addMcpEntry(agent, text, "linux", { launch, legacyPaths: [legacy] })!).args, launch.args);
  const winLaunch = { command: "C:\\Program Files\\VS Code\\Code.exe", args: ["C:\\Profile Storage\\mcp\\mcp-server.cjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const oldWindows = addMcpEntry(agent, "", "win32")!;
  assert.deepEqual(entry(agent, addMcpEntry(agent, oldWindows, "win32", { launch: winLaunch })!).args, winLaunch.args);
});

test("TOML migration keeps other tables, inline comments and env; unsupported multiline values stay unchanged", async () => {
  const root = await tmp(); const agent = target("codex", root);
  const launch = { command: process.execPath, args: [path.join(root, "new server.cjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const original = '# keep model\nmodel = "test"\n[mcp_servers."review-hub"]\ncommand = "npx" # keep launcher comment\nargs = ["-y", "review-hub-mcp"]\nenv = { KEEP = "yes" }\n[mcp_servers.weather]\ncommand = "weather"\n';
  const updated = addMcpEntry(agent, original, "linux", { launch })!;
  assert.match(updated, /# keep launcher comment/); assert.match(updated, /# keep model/);
  const data = toml(updated) as any;
  assert.equal(data.mcp_servers.weather.command, "weather"); assert.equal(data.model, "test");
  assert.equal(data.mcp_servers["review-hub"].env.KEEP, "yes");
  const multiline = '[mcp_servers."review-hub"]\ncommand="npx"\nargs=[\n"-y",\n"review-hub-mcp"\n]\n';
  let warnings = 0;
  assert.equal(addMcpEntry(agent, multiline, "linux", { launch, onCustom: () => warnings++ }), undefined);
  assert.equal(warnings, 1);
});

test("DeepSeek Harness migration preserves other plugins, comments and custom settings", async () => {
  const root = await tmp(); const agent = target("deepseekHarness", root);
  const initial = addMcpEntry(agent, '# keep\n- insert:\n    - id: weather\n      name: weather-plugin\n', "linux")!;
  const launch = { command: process.execPath, args: [path.join(root, "server.cjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
  const updated = addMcpEntry(agent, initial, "linux", { launch })!;
  assert.match(updated, /# keep/);
  const data = yaml(updated);
  assert.equal(data[0].insert[0].name, "weather-plugin");
  assert.deepEqual(data[1].insert[0].config.args, launch.args);
});

test("runtime preparation is opt-in, atomic, stable across versions and never depends on global npm", async () => {
  const root = await tmp(); const extension = path.join(root, "extension"); const storage = path.join(root, "storage");
  assert.equal(await prepareMcpRuntime(extension, storage, process.execPath, false, () => false), undefined);
  await assert.rejects(fs.stat(storage), { code: "ENOENT" });
  await fs.mkdir(path.join(extension, "dist"), { recursive: true });
  await fs.writeFile(path.join(extension, "dist/mcp-server.cjs"), "// version one\n");
  const first = (await prepareMcpRuntime(extension, storage, process.execPath, false, () => true))!;
  assert.deepEqual(first, { command: process.execPath, args: [path.join(storage, "mcp/mcp-server.cjs")] });
  const before = await fs.stat(first.args[0]);
  await prepareMcpRuntime(extension, storage, process.execPath, false, () => true);
  assert.equal((await fs.stat(first.args[0])).mtimeMs, before.mtimeMs);
  await fs.writeFile(path.join(extension, "dist/mcp-server.cjs"), "// version two\n");
  const second = (await prepareMcpRuntime(extension, storage, process.execPath, true, () => true))!;
  assert.deepEqual(second.args, first.args); assert.equal(second.env?.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(await fs.readFile(first.args[0], "utf8"), "// version two\n");
  let checks = 0;
  await fs.writeFile(path.join(extension, "dist/mcp-server.cjs"), "// disabled update\n");
  assert.equal(await prepareMcpRuntime(extension, storage, process.execPath, false, () => ++checks < 2), undefined);
  assert.equal(await fs.readFile(first.args[0], "utf8"), "// version two\n");
});

test("all 11 serialized agent launches expose proposal/delete/feedback tools using the shipped MCP server", async () => {
  const root = await tmp(); const extension = path.join(root, "extension"); const storage = path.join(root, "storage");
  await fs.mkdir(path.join(extension, "dist"), { recursive: true });
  await fs.copyFile(path.resolve("dist/mcp-server.cjs"), path.join(extension, "dist/mcp-server.cjs"));
  const launch = (await prepareMcpRuntime(extension, storage, process.execPath, false, () => true))!;
  for (const { id } of SUPPORTED_AGENTS) {
    const agent = target(id, root);
    const configured = entry(agent, addMcpEntry(agent, "", "linux", { launch })!);
    const command = id === "opencode" ? configured.command[0] : configured.command;
    const args = id === "opencode" ? configured.command.slice(1) : configured.args;
    const client = new Client({ name: "adapter-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({ command, args, stderr: "pipe" }));
      const names = (await client.listTools()).tools.map(tool => tool.name);
      for (const tool of ["propose_changes", "propose_edit", "propose_write", "propose_delete", "get_review_updates"]) assert.ok(names.includes(tool), id + ": " + tool);
    } finally { await client.close(); }
  }
});

test("registration upgrades known legacy paths only inside its supplied fake environment and preserves a backup", async () => {
  const homeDir = await tmp(); const config = path.join(homeDir, ".claude.json");
  const legacy = path.join(homeDir, ".review-hub/bin/mcp-server.cjs");
  const original = JSON.stringify({ mcpServers: { "review-hub": { type: "stdio", command: "node", args: [legacy] } } });
  await fs.writeFile(config, original);
  const env: AgentEnvironment = { homeDir, env: { PATH: "" }, platform: "linux", globalStorageDir: path.join(homeDir, "storage"), installedExtensions: [] };
  const launch = { command: process.execPath, args: [path.join(homeDir, "current.cjs")] };
  const result = await registerDetectedAgents(env, () => true, { mcpLaunch: launch });
  assert.equal(result[0].status, "registered");
  assert.equal(await fs.readFile(config + ".review-hub.bak", "utf8"), original);
  assert.deepEqual(JSON.parse(await fs.readFile(config, "utf8")).mcpServers["review-hub"].args, launch.args);
  const custom = target("cursor", homeDir);
  await fs.writeFile(custom.configPath, '{"mcpServers":{"review-hub":{"command":"custom","args":[]}}}');
  assert.equal((await registerAgent(custom, "linux", () => true, { launch })).customMcp, true);
});
