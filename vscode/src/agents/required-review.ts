import * as fs from "node:fs/promises";
import * as path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser/lib/esm/main.js";
import { updateConfigurationFile } from "./config-file";
import { claudeReviewHook, ompReviewHook } from "./review-policy";

export interface RequiredReviewResult {
  path: string;
  status: "installed" | "already-installed" | "removed" | "disabled" | "unsupported" | "error";
  message?: string;
}
const MARKER = " review-hub-require-review";
const HEADER = "// review-hub:require-review v1";

/** POSIX shell quoting: command paths must never become shell syntax. */
export function quoteHookArgument(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid hook command path.");
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function configureClaudeReviewHook(original: string, command: string, required: boolean): string | undefined {
  const errors: ParseError[] = [];
  const data = parse(original, errors, { allowTrailingComma: true, allowEmptyContent: true });
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (errors.length || (data !== undefined && !record(data))) throw new Error("Invalid Claude settings; left unchanged.");
  if (data?.hooks !== undefined && !record(data.hooks)) throw new Error("Invalid Claude hooks; left unchanged.");
  const before = data?.hooks?.PreToolUse ?? [];
  if (!Array.isArray(before)) throw new Error("Invalid Claude PreToolUse hooks; left unchanged.");
  const entries: Record<string, unknown>[] = [];
  for (const group of before) {
    if (!record(group) || !Array.isArray(group.hooks)) throw new Error("Invalid Claude hook group; left unchanged.");
    const hooks = group.hooks.filter((hook: unknown) => !(record(hook) && hook.type === "command" && typeof hook.command === "string" && hook.command.endsWith(MARKER)));
    if (hooks.length) entries.push({ ...group, hooks });
  }
  if (required) entries.push({ matcher: "*", hooks: [{ type: "command", command: command + MARKER, timeout: 10 }] });
  if (JSON.stringify(entries) === JSON.stringify(before)) return undefined;
  if (!required && !before.length) return undefined;
  return applyEdits(original, modify(original, ["hooks", "PreToolUse"], entries, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes("\r\n") ? "\r\n" : "\n" },
  }));
}

/** Installs only our hooks; arbitrary plugin/host code is outside this tool-dispatch boundary. */
export async function installRequiredReview(
  agent: string, directory: string, platform: NodeJS.Platform,
  required: () => boolean, enabled: () => boolean, nodeCommand: string = "node",
): Promise<RequiredReviewResult> {
  const file = agent === "ohMyPi" ? path.join(directory, "hooks", "pre", "review-hub-required.ts") : path.join(directory, "review-hub", "require-review.cjs");
  if (!enabled()) return { path: file, status: "disabled" };
  if (!["claudeCode", "ohMyPi"].includes(agent) || platform === "win32") return { path: directory, status: "unsupported", message: "Required review currently supports Claude Code and OMP on Linux/macOS only; MCP registration alone does not enforce review." };
  try {
    const wanted = required();
    const guard = () => enabled() && required() === wanted;
    if (agent === "ohMyPi") {
      const existing = await fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (existing !== undefined && !existing.startsWith(HEADER)) throw new Error("Hook path contains an unmanaged file; left unchanged.");
      if (!wanted && existing === undefined) return { path: file, status: "disabled" };
      const result = await updateConfigurationFile(file, () => wanted ? ompReviewHook() : HEADER + "\nexport default function() {}\n", guard);
      return { path: file, status: result === "disabled" ? "disabled" : !wanted ? "removed" : result === "changed" ? "installed" : "already-installed" };
    }
    if (wanted) {
      const result = await updateConfigurationFile(file, original => {
        if (original && !original.startsWith(HEADER)) throw new Error("Hook path contains an unmanaged file; left unchanged.");
        return claudeReviewHook();
      }, guard);
      if (result === "disabled") return { path: file, status: "disabled" };
    }
    const settings = path.join(directory, "settings.json");
    // No settings file should be created by a scan with required review turned off.
    if (!wanted) { try { await fs.access(settings); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: settings, status: "disabled" }; throw error; } }
    const result = await updateConfigurationFile(settings, original => configureClaudeReviewHook(original,
      quoteHookArgument(nodeCommand) + " " + quoteHookArgument(file), wanted), guard);
    return { path: settings, status: result === "disabled" ? "disabled" : !wanted ? "removed" : result === "changed" ? "installed" : "already-installed" };
  } catch (error) {
    return { path: file, status: "error", message: error instanceof Error ? error.message : "Could not configure required review." };
  }
}
