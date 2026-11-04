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
  "- Use `propose_edit` for edits (`path`, `old_string`, `new_string`, optional `replace_all`).",
  "- Use `propose_write` for new or replaced files (`path`, `content`).",
  "- Use `propose_delete` to delete a file (`path`).",
  "- Use `read_file` to read the current staged content and `list_changes` to inspect proposals.",
  "Use the tool names exposed by the connected review-hub server; their client prefix may vary.",
  "Do not use native Edit, Write, MultiEdit, apply_patch or shell commands to bypass this review workflow.",
  "A `staged_for_review` response is success. The proposal is visible in Review Hub; the file on disk",
  "can still contain the old content until the user accepts it. Do not repeat the edit with another tool.",
  "Do not call Accept, Reject or checkpoint tools unless the user explicitly asks you to.",
  "If the connected Review Hub is unreachable, tell the user before switching to direct writes.",
  "If Review Hub MCP is not available in this session, these Review Hub-specific instructions do not apply.",
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
