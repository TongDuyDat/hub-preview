import * as fs from "node:fs/promises";
import * as path from "node:path";
import { updateConfigurationFile } from "./config-file";

export interface McpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
export interface McpRuntimeOptions {
  launch: McpLaunch;
  /** Only exact old Review Hub-owned paths may migrate automatically. */
  legacyPaths?: readonly string[];
  onCustom?: () => void;
}

/** Same server for every client. Runtime data is installed only when the caller explicitly enables preparation. */
export async function prepareMcpRuntime(
  extensionDir: string, storageDir: string, executable: string,
  electron: boolean, enabled: () => boolean,
): Promise<McpLaunch | undefined> {
  if (!enabled()) return undefined;
  const bundled = await fs.readFile(path.join(extensionDir, "dist", "mcp-server.cjs"), "utf8");
  const server = path.join(storageDir, "mcp", "mcp-server.cjs");
  const result = await updateConfigurationFile(server, () => bundled, enabled);
  if (result === "disabled") return undefined;
  return { command: executable, args: [server], ...(electron ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}) };
}

export function sameLaunch(entry: Record<string, unknown>, launch: McpLaunch, opencode = false): boolean {
  const command = opencode ? [launch.command, ...launch.args] : launch.command;
  const args = opencode ? undefined : launch.args;
  const env = entry[opencode ? "environment" : "env"] as Record<string, unknown> | undefined;
  return JSON.stringify(entry.command) === JSON.stringify(command) &&
    JSON.stringify(entry.args) === JSON.stringify(args) &&
    Object.entries(launch.env ?? {}).every(([key, value]) => env?.[key] === value);
}

/** Recognize exact generated launches, never arbitrary wrappers, URLs or disabled entries. */
export function canUpgradeLaunch(entry: Record<string, unknown>, options: McpRuntimeOptions, platform: NodeJS.Platform): boolean {
  if (entry.disabled === true || entry.enabled === false || entry.url !== undefined || entry.type === "remote") return false;
  let command = entry.command;
  let args = entry.args;
  if (Array.isArray(command)) { args = command.slice(1); command = command[0]; }
  if (typeof command !== "string" || !Array.isArray(args) || !args.every(value => typeof value === "string")) return false;
  const binary = command.replace(/\\/g, "/").split("/").at(-1)!.toLowerCase();
  if (["npx", "npx.cmd"].includes(command.toLowerCase()) && JSON.stringify(args) === JSON.stringify(["-y", "review-hub-mcp"])) return true;
  if (["cmd", "cmd.exe"].includes(command.toLowerCase()) && JSON.stringify(args).toLowerCase() === JSON.stringify(["/d", "/c", "npx", "-y", "review-hub-mcp"])) return true;
  const normalize = (value: string) => { const text = value.replace(/\\/g, "/"); return platform === "win32" ? text.toLowerCase() : text; };
  return ["node", "node.exe", "code", "code.exe", "code - insiders.exe", "electron", "electron.exe", "code helper (plugin)"].includes(binary) && args.length === 1 &&
    [options.launch.args[0], ...(options.legacyPaths ?? [])].some(file => typeof file === "string" && normalize(file) === normalize(args[0]));
}
