/**
 * Reads and writes each harness's MCP config to register the Review Hub server.
 * Preserves formatting where it matters (JSONC comments, YAML comments/anchors).
 * Supports a dry-run preview so the user confirms before anything is written.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import JSON5 from "json5";
import { parseDocument } from "yaml";
import type { HarnessTarget, McpLaunch } from "./harness-paths";
import { harnessTargets } from "./harness-paths";

export interface RegisterPreview {
  target: HarnessTarget;
  exists: boolean;
  alreadyRegistered: boolean;
  before: string;
  after: string;
  /** Human-readable description of the change for the confirmation dialog. */
  summary: string;
}

export interface RegisterResult {
  target: HarnessTarget;
  written: boolean;
  backup?: string;
  error?: string;
}

const SERVER_NAME = "review-hub";

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Build the per-harness entry object from the launch spec. */
function entryFor(target: HarnessTarget, launch: McpLaunch): unknown {
  if (target.id === "claude-code") {
    return { type: "stdio", command: launch.command, args: launch.args, env: launch.env };
  }
  if (target.id === "opencode" || target.containerKey === "mcp") {
    return { type: "local", command: [launch.command, ...launch.args], environment: launch.env, enabled: true };
  }
  return { command: launch.command, args: launch.args, env: launch.env, disabled: false };
}

function isRegisteredJson(text: string, format: "json" | "jsonc", containerKey: string): boolean {
  if (!text.trim()) {
    return false;
  }
  try {
    const obj = format === "jsonc" ? JSON5.parse(text) : JSON.parse(text);
    return !!obj && typeof obj === "object" && !!obj[containerKey] && !!obj[containerKey][SERVER_NAME];
  } catch {
    return false;
  }
}

/**
 * Surgical JSON/JSONC insertion that preserves comments and existing formatting.
 * Finds the top-level container key; creates it if missing.
 */
function insertJsonc(text: string, containerKey: string, entry: unknown): string {
  const entryText = JSON.stringify({ [SERVER_NAME]: entry }, null, 2)
    .replace(/^\{\n/, "")
    .replace(/\n\}$/, "")
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n")
    .trimEnd()
    .replace(/,$/, "");

  const containerRe = new RegExp(`("${containerKey}"\\s*:\\s*)\\{`, "m");
  const match = containerRe.exec(text);
  if (match) {
    const insertAt = match.index + match[0].length;
    const body = text.slice(insertAt);
    const hasContent = /^\s*[^\s}]/.test(body);
    const prefix = hasContent ? `\n    ${entryText},` : `\n    ${entryText}`;
    return text.slice(0, insertAt) + prefix + text.slice(insertAt);
  }
  // No container key: insert a fresh one right after the first top-level '{'.
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) {
    throw new Error("not a JSON object");
  }
  const block = `\n  "${containerKey}": {\n    ${entryText}\n  },`;
  return text.slice(0, firstBrace + 1) + block + text.slice(firstBrace + 1);
}

function insertPlainJson(text: string, containerKey: string, entry: unknown): string {
  const obj = text.trim() ? JSON.parse(text) : {};
  obj[containerKey] = obj[containerKey] ?? {};
  obj[containerKey][SERVER_NAME] = entry;
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function insertYaml(text: string, launch: McpLaunch): string {
  const doc = parseDocument(text || "");
  const item = {
    insert: [
      {
        id: `mcp-${SERVER_NAME}`,
        name: "@deepseek-ai/dsh-mcp-client",
        config: {
          transport: "stdio",
          serverName: "review_hub",
          command: launch.command,
          args: launch.args,
          env: launch.env,
          failOnStartupError: false,
        },
      },
    ],
  };
  // Replace an existing review-hub insert if present, else append.
  const contents = doc.contents as unknown;
  let replaced = false;
  if (contents && typeof (contents as { items?: unknown[] }).items !== "undefined") {
    const items = (contents as { items: unknown[] }).items;
    for (let i = 0; i < items.length; i++) {
      const node = items[i] as { get?: (k: string) => unknown };
      const idNode = typeof node?.get === "function" ? node.get("id") : undefined;
      if (idNode === `mcp-${SERVER_NAME}`) {
        (items as unknown[])[i] = doc.createNode(item);
        replaced = true;
        break;
      }
    }
  }
  if (!replaced) {
    doc.add(item);
  }
  return doc.toString();
}

export function buildPreview(target: HarnessTarget, launch: McpLaunch): RegisterPreview {
  const before = readText(target.file);
  let after: string;
  try {
    if (target.format === "yaml") {
      after = insertYaml(before, launch);
    } else {
      const entry = entryFor(target, launch);
      after = target.format === "jsonc" ? insertJsonc(before, target.containerKey, entry) : insertPlainJson(before, target.containerKey, entry);
    }
  } catch (err) {
    after = before;
    return {
      target,
      exists: before.length > 0,
      alreadyRegistered: false,
      before,
      after,
      summary: `cannot update ${target.file}: ${String((err as Error).message)}`,
    };
  }
  const alreadyRegistered =
    target.format === "yaml"
      ? before.includes(`mcp-${SERVER_NAME}`)
      : isRegisteredJson(before, target.format as "json" | "jsonc", target.containerKey);
  return {
    target,
    exists: before.length > 0,
    alreadyRegistered,
    before,
    after,
    summary: alreadyRegistered ? `update ${SERVER_NAME} entry` : `add ${SERVER_NAME} entry`,
  };
}

export function buildAllPreviews(launch: McpLaunch): RegisterPreview[] {
  return harnessTargets().map((t) => buildPreview(t, launch));
}

export function applyPreview(preview: RegisterPreview): RegisterResult {
  const { target } = preview;
  try {
    if (!preview.exists && preview.before === preview.after) {
      return { target, written: false, error: "target config not found" };
    }
    let backup: string | undefined;
    if (preview.exists) {
      backup = `${target.file}.reviewhub.bak`;
      if (!fs.existsSync(backup)) {
        fs.copyFileSync(target.file, backup);
      }
    }
    fs.mkdirSync(path.dirname(target.file), { recursive: true });
    const tmp = `${target.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, preview.after);
    fs.renameSync(tmp, target.file);
    return { target, written: true, backup };
  } catch (err) {
    return { target, written: false, error: String((err as Error).message) };
  }
}
