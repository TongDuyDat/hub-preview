/** Deliberately self-contained: embedded into the installed client hooks. */
export function reviewToolAllowed(client: "claude" | "omp", name: unknown, input: unknown): boolean {
  if (typeof name !== "string") return false;
  const actions = ["propose_changes", "propose_edit", "propose_write", "propose_delete", "read_file", "list_changes", "get_change", "get_review_updates", "list_workspaces", "get_checkpoint"];
  const prefixes = client === "omp" ? ["mcp__review_hub_"] : ["mcp__review_hub__", "mcp__review-hub__"];
  const tools = prefixes.flatMap(prefix => actions.map(action => prefix + action));
  if (tools.includes(name)) return true;
  if (client === "claude") return ["Read", "Glob", "Grep", "ToolSearch", "AskUserQuestion", "TodoWrite"].includes(name);
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (name === "write") {
    // Exact XDEV tool identity, never a file path, generic MCP dispatcher or alias.
    return typeof args.path === "string" && tools.some(tool => args.path === "xd://" + tool);
  }
  if (name === "read") {
    // Other internal handlers/URLs can execute code. Use Hub read_file for source files.
    return typeof args.path === "string" && (args.path === "xd://" ||
      tools.some(tool => args.path === "xd://" + tool) || /^omp:\/\/[a-zA-Z0-9_./-]*$/.test(args.path));
  }
  return ["glob", "grep", "ask", "todo"].includes(name);
}

export const REVIEW_REQUIRED_REASON = "Review Hub requires human review. Prefer review-hub propose_changes for batched changes, or propose_edit/propose_write/propose_delete, and read_file for staged content. Direct writes, shell/Python/eval, delegated execution, other MCP tools and automatic Accept/Reject/checkpoints are blocked. If Hub is unavailable, stop and report it. Run builds/tests yourself in a terminal.";

export function ompReviewHook(): string {
  return "// review-hub:require-review v1\nconst allowed = " + reviewToolAllowed.toString() + ";\n" +
    "export default function(pi) { pi.on('tool_call', event => { if (!allowed('omp', event.toolName, event.input)) return {block:true,reason:" + JSON.stringify(REVIEW_REQUIRED_REASON) + "}; }); }\n";
}

export function claudeReviewHook(): string {
  return "// review-hub:require-review v1\nconst allowed = " + reviewToolAllowed.toString() + ";\n" +
    "let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { data += chunk; });\n" +
    "process.stdin.on('end', () => { try { const event = JSON.parse(data); if (event.hook_event_name !== 'PreToolUse' || !allowed('claude', event.tool_name, event.tool_input)) throw Error('blocked'); } catch { console.error(" + JSON.stringify(REVIEW_REQUIRED_REASON) + "); process.exitCode = 2; } });\n";
}
