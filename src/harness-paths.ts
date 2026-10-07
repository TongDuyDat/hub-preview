/**
 * Resolves the config file paths and formats for each supported harness.
 */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export type ConfigFormat = "json" | "jsonc" | "yaml";

export interface HarnessTarget {
  id: string;
  label: string;
  file: string;
  format: ConfigFormat;
  /** The key that holds MCP servers, for diagnostics. */
  containerKey: string;
}

function home(): string {
  // ~/.claude is a symlink to the Windows side under WSL; resolve to the real path
  // so configs we write use paths valid wherever the harness actually runs.
  try {
    return fs.realpathSync(os.homedir());
  } catch {
    return os.homedir();
  }
}

export function harnessTargets(): HarnessTarget[] {
  const h = home();
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      file: path.join(h, ".claude.json"),
      format: "json",
      containerKey: "mcpServers",
    },
    {
      id: "opencode",
      label: "opencode",
      file: path.join(h, ".config", "opencode", "opencode.jsonc"),
      format: "jsonc",
      containerKey: "mcp",
    },
    {
      id: "dsh",
      label: "dsh (deepseek-harness)",
      file: path.join(h, ".dsh", "profiles", "web", "cordis.patch.yml"),
      format: "yaml",
      containerKey: "insert",
    },
    {
      id: "roo",
      label: "Roo Code",
      file: path.join(h, ".vscode-server", "data", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "mcp_settings.json"),
      format: "json",
      containerKey: "mcpServers",
    },
    {
      id: "cline",
      label: "Cline",
      file: path.join(h, ".cline", "data", "settings", "cline_mcp_settings.json"),
      format: "json",
      containerKey: "mcpServers",
    },
  ];
}

export interface McpLaunch {
  command: string;
  args: string[];
  /** Non-secret env passed to the server (the hub URL; never the token). */
  env: Record<string, string>;
}

/** Where the extension installs a stable copy of the bundled MCP server. */
export function installedServerPath(baseDir: string): string {
  return path.join(baseDir, "bin", "mcp-server.cjs");
}

export function nodeCommand(): string {
  const exec = process.execPath;
  // In the extension host process.execPath is the VS Code helper, not a usable node.
  if (exec && /node(\.exe)?$/i.test(exec)) {
    return exec;
  }
  return "node";
}
