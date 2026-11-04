import * as fs from "node:fs/promises";
import * as path from "node:path";
import { constants } from "node:fs";
import { updateConfigurationFile } from "./config-file";
import { installClaudeInstructions, type ClaudeInstructionsResult } from "./claude-instructions";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { parse as parseToml } from "smol-toml";
import { parseDocument, isSeq } from "yaml";

export const SUPPORTED_AGENTS = [
  { id: "claudeCode", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
  { id: "windsurf", label: "Windsurf" },
  { id: "opencode", label: "OpenCode" },
  { id: "cline", label: "Cline" },
  { id: "rooCode", label: "Roo Code" },
  { id: "geminiCli", label: "Gemini CLI" },
  { id: "antigravity", label: "Antigravity" },
  { id: "deepseekHarness", label: "DeepSeek Harness" },
  { id: "ohMyPi", label: "Oh My Pi" },
] as const;
export type AgentId = typeof SUPPORTED_AGENTS[number]["id"];

export interface AgentEnvironment {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Parent of this extension's globalStorageUri; follows the active VS Code profile. */
  globalStorageDir: string;
  installedExtensions: readonly string[];
}
export interface DetectedAgent {
  id: AgentId;
  label: string;
  configPath: string;
  format: "jsonc" | "toml" | "yaml";
  section: "mcpServers" | "mcp" | "mcp_servers" | "cordis";
}
export interface RegistrationOptions {
  /** Separate opt-in; checked again immediately before writing the Claude rules. */
  claudeInstructions?: () => boolean;
}
export interface RegistrationResult {
  id: AgentId;
  label: string;
  configPath: string;
  status: "registered" | "already-configured" | "disabled" | "error";
  instructions?: ClaudeInstructionsResult;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
async function executable(name: string, context: AgentEnvironment, additionalDirs: readonly string[] = []): Promise<boolean> {
  const extensions = context.platform === "win32"
    ? ["", ...(context.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").flatMap(s => [s.toLowerCase(), s.toUpperCase()])]
    : [""];
  const dirs = (context.env.PATH || context.env.Path || "").split(context.platform === "win32" ? ";" : path.delimiter).filter(Boolean);
  for (const dir of new Set([...dirs, ...additionalDirs])) {
    for (const suffix of extensions) {
      const candidate = path.join(dir.replace(/^"|"$/g, ""), name + suffix);
      try {
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, context.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch { /* Only inspect PATH entries; never launch an agent during detection. */ }
    }
  }
  return false;
}

/** Probe known config paths and PATH, rather than crawling the user's home directory. */
export async function detectAgents(context: AgentEnvironment): Promise<DetectedAgent[]> {
  const home = context.homeDir;
  const codexHome = context.env.CODEX_HOME || path.join(home, ".codex");
  const configHome = context.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const opencodeRoot = path.join(configHome, "opencode");
  const opencodeConfig = context.env.OPENCODE_CONFIG || (await exists(path.join(opencodeRoot, "opencode.jsonc"))
    ? path.join(opencodeRoot, "opencode.jsonc") : path.join(opencodeRoot, "opencode.json"));
  const dshHome = context.env.DSH_HOME || path.join(home, ".dsh");
  const ompRoot = path.join(home, context.env.PI_CONFIG_DIR || ".omp");
  const profile = (context.env.OMP_PROFILE ?? context.env.PI_PROFILE ?? "").trim();
  // Profiles are path components, never relative paths. Invalid names must not write elsewhere.
  const validProfile = !profile || profile === "default" ||
    (/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(profile) && !profile.endsWith(".") &&
      !/^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(profile));
  const ompDir = profile && profile !== "default"
    ? path.join(ompRoot, "profiles", profile, "agent")
    : context.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[/\\])/, home) || path.join(ompRoot, "agent");
  const ompConfig = !(await exists(path.join(ompDir, "mcp.json"))) && await exists(path.join(ompDir, ".mcp.json"))
    ? path.join(ompDir, ".mcp.json") : path.join(ompDir, "mcp.json");
  const extensions = new Set(context.installedExtensions.map(id => id.toLowerCase()));
  const definitions: (DetectedAgent & { probes: string[]; binary?: string; binaryDirs?: string[]; extensionIds?: string[] })[] = [
    { id: "claudeCode", label: "Claude Code", configPath: context.env.CLAUDE_CONFIG_DIR
      ? path.join(context.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json"),
      format: "jsonc", section: "mcpServers", probes: [context.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), path.join(home, ".claude.json")], binary: "claude", binaryDirs: context.platform === "win32" ? [] : [path.join(home, ".local", "bin")], extensionIds: ["anthropic.claude-code"] },
    { id: "codex", label: "Codex", configPath: path.join(codexHome, "config.toml"), format: "toml", section: "mcp_servers", probes: [codexHome], binary: "codex", extensionIds: ["openai.chatgpt"] },
    { id: "cursor", label: "Cursor", configPath: path.join(home, ".cursor", "mcp.json"), format: "jsonc", section: "mcpServers", probes: [path.join(home, ".cursor")], binary: "cursor" },
    { id: "windsurf", label: "Windsurf", configPath: path.join(home, ".codeium", "windsurf", "mcp_config.json"), format: "jsonc", section: "mcpServers", probes: [path.join(home, ".codeium", "windsurf")], binary: "windsurf" },
    { id: "opencode", label: "OpenCode", configPath: opencodeConfig, format: "jsonc", section: "mcp", probes: [opencodeRoot, opencodeConfig], binary: "opencode" },
    { id: "cline", label: "Cline", configPath: path.join(context.globalStorageDir, "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"), format: "jsonc", section: "mcpServers", probes: [path.join(context.globalStorageDir, "saoudrizwan.claude-dev")], extensionIds: ["saoudrizwan.claude-dev"] },
    { id: "rooCode", label: "Roo Code", configPath: path.join(context.globalStorageDir, "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"), format: "jsonc", section: "mcpServers", probes: [path.join(context.globalStorageDir, "rooveterinaryinc.roo-cline")], extensionIds: ["rooveterinaryinc.roo-cline"] },
    { id: "geminiCli", label: "Gemini CLI", configPath: path.join(home, ".gemini", "settings.json"), format: "jsonc", section: "mcpServers", probes: [path.join(home, ".gemini", "settings.json")], binary: "gemini" },
    { id: "antigravity", label: "Antigravity", configPath: path.join(home, ".gemini", "antigravity", "mcp_config.json"), format: "jsonc", section: "mcpServers", probes: [path.join(home, ".gemini", "antigravity")], binary: "antigravity" },
    { id: "deepseekHarness", label: "DeepSeek Harness", configPath: path.join(dshHome, "cordis.patch.yml"), format: "yaml", section: "cordis", probes: [dshHome], binary: "dsh", extensionIds: ["deepseek-harness.deepseek-harness-vscode"] },
    ...(validProfile ? [{ id: "ohMyPi" as const, label: "Oh My Pi", configPath: ompConfig, format: "jsonc" as const, section: "mcpServers" as const, probes: [ompDir], binary: "omp" }] : []),
  ];
  const detected: DetectedAgent[] = [];
  for (const definition of definitions) {
    let found = definition.extensionIds?.some(id => extensions.has(id)) ?? false;
    for (const probe of definition.probes) { if (!found) found = await exists(probe); }
    if (!found && definition.binary) found = await executable(definition.binary, context, definition.binaryDirs);
    if (found) {
      const { probes, binary, binaryDirs, extensionIds, ...agent } = definition;
      detected.push(agent);
    }
  }
  return detected;
}

function launchCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "cmd", args: ["/d", "/c", "npx", "-y", "review-hub-mcp"] }
    : { command: "npx", args: ["-y", "review-hub-mcp"] };
}

/** Cordis patches are a sequence of operations, not a generic mcpServers map. */
function addHarnessEntry(text: string, launch: { command: string; args: string[] }, eol: string): string | undefined {
  const document = parseDocument(text);
  if (document.errors.length || (document.contents !== null && !isSeq(document.contents))) {
    throw new Error("Invalid Cordis YAML patch list; configuration left unchanged.");
  }
  // YAML's JS tags stay inert. Inspect data only; never evaluate configuration expressions.
  let operations: unknown;
  try { operations = document.toJS({ maxAliasCount: 100 }); }
  catch { throw new Error("Could not inspect Cordis YAML safely; configuration left unchanged."); }
  const seen = new Set<object>();
  const containsReviewHub = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (isRecord(value) && (value.id === "mcp-review-hub" ||
      (value.name === "@deepseek-ai/dsh-mcp-client" && isRecord(value.config) && value.config.serverName === "review-hub"))) return true;
    return Object.values(value).some(containsReviewHub);
  };
  if (containsReviewHub(operations)) return undefined;
  const addition = [
    "- insert:",
    "    - id: mcp-review-hub",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        serverName: review-hub",
    "        transport: stdio",
    "        command: " + JSON.stringify(launch.command),
    "        args: " + JSON.stringify(launch.args),
    "",
  ].join(eol);
  // Append without rewriting existing comments, expressions, or plugin settings.
  // Empty sequence documents need an AST append to avoid producing invalid YAML.
  let updated: string;
  if (isSeq(document.contents) && document.contents.items.length === 0) {
    document.contents.add(parseDocument(addition).toJS()[0]);
    updated = document.toString().replace(/\n/g, eol);
  } else {
    updated = text + (text && !text.endsWith("\n") ? eol : "") + addition;
  }
  const validation = parseDocument(updated);
  if (validation.errors.length || !isSeq(validation.contents)) {
    throw new Error("This Cordis YAML layout cannot be extended safely; configuration left unchanged.");
  }
  return updated;
}

/** Add only a missing review-hub entry. Existing entries, comments and settings survive. */
export function addMcpEntry(agent: DetectedAgent, original: string, platform: NodeJS.Platform): string | undefined {
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = original.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const launch = launchCommand(platform);
  if (agent.format === "yaml") {
    const updated = addHarnessEntry(text, launch, eol);
    return updated === undefined ? undefined : bom + updated;
  }
  if (agent.format === "toml") {
    let parsed: Record<string, unknown>;
    try { parsed = parseToml(text); } catch { throw new Error("Invalid TOML; configuration left unchanged."); }
    const servers = parsed[agent.section];
    if (servers !== undefined && !isRecord(servers)) throw new Error("MCP configuration must be a table; left unchanged.");
    if (isRecord(servers) && Object.hasOwn(servers, "review-hub")) return undefined;
    const addition = ["[mcp_servers.\"review-hub\"]", "command = " + JSON.stringify(launch.command), "args = " + JSON.stringify(launch.args), ""].join(eol);
    const updated = text + (text && !text.endsWith("\n") ? eol : "") + (text ? eol : "") + addition;
    try { parseToml(updated); } catch { throw new Error("This TOML layout cannot be extended automatically; configuration left unchanged."); }
    return bom + updated;
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length || (parsed !== undefined && !isRecord(parsed))) throw new Error("Invalid JSON/JSONC object; configuration left unchanged.");
  const servers = isRecord(parsed) ? parsed[agent.section] : undefined;
  if (servers !== undefined && !isRecord(servers)) throw new Error("MCP configuration must be an object; left unchanged.");
  if (isRecord(servers) && Object.hasOwn(servers, "review-hub")) return undefined;
  const entry = agent.id === "opencode"
    ? { type: "local", command: [launch.command, ...launch.args], enabled: true }
    : agent.id === "claudeCode" ? { type: "stdio", ...launch }
    : agent.id === "cline" || agent.id === "rooCode" ? { ...launch, disabled: false }
    : launch;
  const tab = /\n\t/.test(text);
  const spaces = text.match(/\n( +)\S/)?.[1].length ?? 2;
  const updated = applyEdits(text, modify(text, [agent.section, "review-hub"], entry, {
    formattingOptions: { insertSpaces: !tab, tabSize: spaces, eol },
  }));
  const validation: ParseError[] = [];
  parseJsonc(updated, validation, { allowTrailingComma: true });
  if (validation.length) throw new Error("Could not update JSON/JSONC safely; configuration left unchanged.");
  return bom + updated + (updated.endsWith("\n") ? "" : eol);
}

/** Add the MCP entry independently of instruction-file setup. */
export async function registerAgent(
  agent: DetectedAgent,
  platform: NodeJS.Platform,
  enabled: () => boolean = () => true,
): Promise<RegistrationResult> {
  const base = { id: agent.id, label: agent.label, configPath: agent.configPath };
  try {
    const status = await updateConfigurationFile(agent.configPath, original => addMcpEntry(agent, original, platform), enabled);
    return { ...base, status: status === "changed" ? "registered" : status === "unchanged" ? "already-configured" : "disabled" };
  } catch (error) {
    return { ...base, status: "error", message: error instanceof Error ? error.message : "Could not update agent configuration." };
  }
}

export async function registerDetectedAgents(
  environment: AgentEnvironment,
  enabled: (agent: AgentId) => boolean,
  options: RegistrationOptions = {},
): Promise<RegistrationResult[]> {
  const agents = await detectAgents(environment);
  const results: RegistrationResult[] = [];
  for (const agent of agents) {
    const result = await registerAgent(agent, environment.platform, () => enabled(agent.id));
    if (agent.id === "claudeCode" && (result.status === "registered" || result.status === "already-configured") && options.claudeInstructions?.()) {
      result.instructions = await installClaudeInstructions(
        environment.env.CLAUDE_CONFIG_DIR || path.join(environment.homeDir, ".claude"),
        () => enabled(agent.id) && !!options.claudeInstructions?.(),
      );
    }
    results.push(result);
  }
  return results;
}
