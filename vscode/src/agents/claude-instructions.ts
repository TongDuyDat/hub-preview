import { REVIEW_HUB_WORKFLOW } from "../../../core/src/agent-instructions";
import * as path from "node:path";
import { updateConfigurationFile } from "./config-file";

const START = "<!-- review-hub:start -->";
const END = "<!-- review-hub:end -->";

export const CLAUDE_REVIEW_HUB_RULES = [
  START,
  "## Review Hub MCP editing workflow",
  "",
  "When the review-hub MCP server is available in this session, submit source-file changes",
  "through its tools so the user can review and accept or reject each hunk:",
  "",
  REVIEW_HUB_WORKFLOW,
  "",
  "If the connected Review Hub is unreachable, tell the user before switching to direct writes.",
  "If Review Hub MCP is not available in this session, these Review Hub-specific instructions do not apply; mandatory workspace review rules still take precedence.",
  END,
  "",
].join("\n");

export interface ClaudeInstructionsResult {
  path: string;
  status: "installed" | "already-installed" | "disabled" | "error";
  message?: string;
}

/** Replace only our managed section, keeping all user-written bytes outside it. */
export function addClaudeInstructions(original: string): string {
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = original.slice(bom.length);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = CLAUDE_REVIEW_HUB_RULES.replace(/\n/g, eol);
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 && end < 0) return bom + text + (text ? (text.endsWith("\n") ? eol : eol + eol) : "") + block;
  if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0 || text.indexOf(END, end + END.length) >= 0) {
    throw new Error("Ambiguous Review Hub markers in CLAUDE.md; instructions left unchanged.");
  }
  let after = end + END.length;
  if (text.slice(after, after + 2) === "\r\n") after += 2;
  else if (text[after] === "\n") after++;
  return bom + text.slice(0, start) + block + text.slice(after);
}

export async function installClaudeInstructions(
  configDir: string,
  enabled: () => boolean,
): Promise<ClaudeInstructionsResult> {
  const file = path.join(configDir, "CLAUDE.md");
  try {
    const result = await updateConfigurationFile(file, addClaudeInstructions, enabled);
    return { path: file, status: result === "changed" ? "installed" : result === "unchanged" ? "already-installed" : "disabled" };
  } catch (error) {
    return { path: file, status: "error", message: error instanceof Error ? error.message : "Could not install Claude instructions." };
  }
}
