import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseJsonc } from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml } from "smol-toml";
import {
  detectAgents, addMcpEntry, registerAgent, registerDetectedAgents, SUPPORTED_AGENTS,
  type AgentEnvironment, type DetectedAgent,
} from "../vscode/src/agents/mcp-registration";

async function setup(): Promise<AgentEnvironment> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-agent-"));
  return { homeDir, env: { PATH: "" }, platform: "linux", globalStorageDir: path.join(homeDir, "profile", "globalStorage"), installedExtensions: [] };
}
async function write(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
function agent(context: AgentEnvironment, format: "jsonc" | "toml" = "jsonc"): DetectedAgent {
  return { id: format === "toml" ? "codex" : "claudeCode", label: "Test agent", configPath: path.join(context.homeDir, format === "toml" ? "config.toml" : ".claude.json"), format, section: format === "toml" ? "mcp_servers" : "mcpServers" };
}

test("detection does not create configs for agents absent from this host", async () => {
  const context = await setup();
  assert.deepEqual(await detectAgents(context), []);
  assert.deepEqual(await fs.readdir(context.homeDir), []);
});

test("detects all supported agents from known config directories and active-profile extensions", async () => {
  const context = await setup();
  for (const directory of [".claude", ".codex", ".cursor", ".codeium/windsurf", ".config/opencode", ".gemini/antigravity"]) await fs.mkdir(path.join(context.homeDir, directory), { recursive: true });
  await write(path.join(context.homeDir, ".gemini/settings.json"), "{}");
  context.installedExtensions = ["Saoudrizwan.Claude-Dev", "RooVeterinaryInc.roo-cline"];
  const detected = await detectAgents(context);
  assert.deepEqual(detected.map(a => a.id).sort(), SUPPORTED_AGENTS.map(a => a.id).sort());
  assert.equal(detected.find(a => a.id === "cline")!.configPath, path.join(context.globalStorageDir, "saoudrizwan.claude-dev/settings/cline_mcp_settings.json"));
  assert.equal(detected.find(a => a.id === "rooCode")!.configPath, path.join(context.globalStorageDir, "rooveterinaryinc.roo-cline/settings/mcp_settings.json"));
  assert.equal(detected.find(a => a.id === "opencode")!.section, "mcp");
});

test("PATH detection finds agents without launching their processes", async () => {
  const context = await setup();
  const bin = path.join(context.homeDir, "bin");
  const marker = path.join(context.homeDir, "must-not-run");
  await write(path.join(bin, "claude"), "#!/bin/sh\ntouch " + JSON.stringify(marker));
  await fs.chmod(path.join(bin, "claude"), 0o755);
  context.env.PATH = bin;
  assert.deepEqual((await detectAgents(context)).map(a => a.id), ["claudeCode"]);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("respects CODEX_HOME, XDG_CONFIG_HOME and existing OpenCode JSONC", async () => {
  const context = await setup();
  context.env.CODEX_HOME = path.join(context.homeDir, "custom-codex");
  context.env.XDG_CONFIG_HOME = path.join(context.homeDir, "custom-config");
  await fs.mkdir(context.env.CODEX_HOME);
  const openConfig = path.join(context.env.XDG_CONFIG_HOME, "opencode/opencode.jsonc");
  await write(openConfig, "// OpenCode config\n{}");
  const detected = await detectAgents(context);
  assert.equal(detected.find(a => a.id === "codex")!.configPath, path.join(context.env.CODEX_HOME, "config.toml"));
  assert.equal(detected.find(a => a.id === "opencode")!.configPath, openConfig);
  context.env.OPENCODE_CONFIG = path.join(context.homeDir, "other-opencode.json");
  assert.equal((await detectAgents(context)).find(a => a.id === "opencode")!.configPath, context.env.OPENCODE_CONFIG);
});

test("JSONC updates preserve comments, other MCP servers, BOM, CRLF and settings", async () => {
  const context = await setup();
  const target = agent(context);
  const original = '\uFEFF{\r\n  // Keep my preferences\r\n  "theme": "dark",\r\n  "mcpServers": { "weather": { "url": "http://example.invalid" } },\r\n}\r\n';
  await write(target.configPath, original);
  assert.equal((await registerAgent(target, "linux")).status, "registered");
  const updated = await fs.readFile(target.configPath, "utf8");
  assert.ok(updated.startsWith("\uFEFF"));
  assert.ok(updated.includes("// Keep my preferences\r\n"));
  assert.ok(!updated.replace(/\r\n/g, "").includes("\n"));
  const parsed = parseJsonc(updated.slice(1));
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.mcpServers.weather.url, "http://example.invalid");
  assert.deepEqual(parsed.mcpServers["review-hub"], { type: "stdio", command: "npx", args: ["-y", "review-hub-mcp"] });
  assert.equal(await fs.readFile(target.configPath + ".review-hub.bak", "utf8"), original);
  const before = await fs.stat(target.configPath);
  assert.equal((await registerAgent(target, "linux")).status, "already-configured");
  assert.equal((await fs.stat(target.configPath)).mtimeMs, before.mtimeMs);
});

test("Codex TOML appends a table while preserving models, projects and existing servers", async () => {
  const target = agent(await setup(), "toml");
  const original = '# My model\nmodel = "custom-model"\n[mcp_servers.weather]\ncommand = "weather"\n[projects."/project"]\ntrust_level = "trusted"\n';
  await write(target.configPath, original);
  assert.equal((await registerAgent(target, "linux")).status, "registered");
  const updated = await fs.readFile(target.configPath, "utf8");
  assert.ok(updated.startsWith(original));
  const parsed = parseToml(updated) as any;
  assert.equal(parsed.model, "custom-model");
  assert.equal(parsed.projects["/project"].trust_level, "trusted");
  assert.equal(parsed.mcp_servers.weather.command, "weather");
  assert.deepEqual({ ...parsed.mcp_servers["review-hub"] }, { command: "npx", args: ["-y", "review-hub-mcp"] });
  assert.equal((await registerAgent(target, "linux")).status, "already-configured");
});

for (const format of ["jsonc", "toml"] as const) {
  test("keeps existing custom or disabled review-hub registration: " + format, async () => {
    const target = agent(await setup(), format);
    const original = format === "toml" ? '[mcp_servers."review-hub"]\nurl = "https://example.invalid/mcp"\nenabled = false\n' : '{"mcpServers":{"review-hub":{"command":"custom-launcher","disabled":true}}}';
    await write(target.configPath, original);
    assert.equal((await registerAgent(target, "linux")).status, "already-configured");
    assert.equal(await fs.readFile(target.configPath, "utf8"), original);
    await assert.rejects(fs.stat(target.configPath + ".review-hub.bak"), { code: "ENOENT" });
  });
  test("invalid configuration is never rewritten and parse errors do not expose secrets: " + format, async () => {
    const target = agent(await setup(), format);
    const original = format === "toml" ? 'api_key = "TOP_SECRET\n' : '{"api_key":"TOP_SECRET", broken';
    await write(target.configPath, original);
    const result = await registerAgent(target, "linux");
    assert.equal(result.status, "error");
    assert.ok(!result.message?.includes("TOP_SECRET"));
    assert.equal(await fs.readFile(target.configPath, "utf8"), original);
    await assert.rejects(fs.stat(target.configPath + ".review-hub.bak"), { code: "ENOENT" });
  });
}

test("OpenCode uses local command arrays; Windows agents use cmd to launch npx", async () => {
  const target = { ...agent(await setup()), id: "opencode" as const, section: "mcp" as const };
  const entry = parseJsonc(addMcpEntry(target, '{"model":"test/model"}', "win32")!).mcp["review-hub"];
  assert.deepEqual(entry, { type: "local", command: ["cmd", "/d", "/c", "npx", "-y", "review-hub-mcp"], enabled: true });
  const standard = parseJsonc(addMcpEntry({ ...target, id: "cline", section: "mcpServers" }, "{}", "win32")!).mcpServers["review-hub"];
  assert.equal(standard.disabled, false);
  assert.equal(standard.command, "cmd");
});

test("Cline/Roo detection follows this profile and does not touch other profiles", async () => {
  const context = await setup();
  context.installedExtensions = ["saoudrizwan.claude-dev"];
  const results = await registerDetectedAgents(context, () => true);
  assert.deepEqual(results.map(r => r.status), ["registered"]);
  const config = parseJsonc(await fs.readFile(results[0].configPath, "utf8"));
  assert.equal(config.mcpServers["review-hub"].disabled, false);
  await assert.rejects(fs.stat(path.join(context.homeDir, ".config/Code/User/globalStorage")), { code: "ENOENT" });
});

test("disabled or unchecked agents create no files; changing the setting cancels pending writes", async () => {
  const context = await setup();
  const target = agent(context);
  assert.equal((await registerAgent(target, "linux", () => false)).status, "disabled");
  assert.deepEqual(await fs.readdir(context.homeDir), []);
  let checks = 0;
  assert.equal((await registerAgent(target, "linux", () => ++checks < 2)).status, "disabled");
  assert.deepEqual(await fs.readdir(context.homeDir), []);
  await fs.mkdir(path.join(context.homeDir, ".cursor"));
  const results = await registerDetectedAgents(context, id => id !== "cursor");
  assert.equal(results[0].status, "disabled");
  await assert.rejects(fs.stat(results[0].configPath), { code: "ENOENT" });
});

test("registration preserves a symlink and file permissions", { skip: process.platform === "win32" }, async () => {
  const context = await setup();
  const target = agent(context);
  const real = path.join(context.homeDir, "dotfiles/claude.json");
  await write(real, '{"other":true}');
  await fs.chmod(real, 0o640);
  await fs.symlink(real, target.configPath);
  assert.equal((await registerAgent(target, "linux")).status, "registered");
  assert.equal((await fs.lstat(target.configPath)).isSymbolicLink(), true);
  assert.equal((await fs.stat(real)).mode & 0o777, 0o640);
  assert.equal((await fs.stat(real + ".review-hub.bak")).mode & 0o777, 0o600);
  assert.equal(parseJsonc(await fs.readFile(real, "utf8")).other, true);
});

test("a malformed agent config does not prevent registration for another detected agent", async () => {
  const context = await setup();
  await write(path.join(context.homeDir, ".claude.json"), "invalid-json");
  await fs.mkdir(path.join(context.homeDir, ".cursor"));
  const results = await registerDetectedAgents(context, () => true);
  assert.deepEqual(results.map(r => [r.id, r.status]), [["claudeCode", "error"], ["cursor", "registered"]]);
  assert.equal(await fs.readFile(path.join(context.homeDir, ".claude.json"), "utf8"), "invalid-json");
});
