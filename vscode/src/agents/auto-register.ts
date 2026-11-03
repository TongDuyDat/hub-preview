import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { registerDetectedAgents, type AgentId } from "./mcp-registration";

interface RegistrationLog { info(message: string): void; warn(message: string): void; }

/** Settings opt-in; scans stay on the extension host so agents can reach the same hub. */
export function startAgentAutoRegistration(
  context: vscode.ExtensionContext,
  logger: RegistrationLog,
  scan = registerDetectedAgents,
): vscode.Disposable {
  let disposed = false;
  let requested = false;
  let manualRequested = false;
  let running: Promise<void> | undefined;
  let lastReport = "";
  const isEnabled = (agent?: AgentId): boolean => {
    const config = vscode.workspace.getConfiguration("review-hub");
    return !disposed && config.get<boolean>("autoRegisterMcp", false) &&
      (!agent || config.get<boolean>("agents." + agent, true));
  };
  const request = (manual = false): Promise<void> => {
    requested = true;
    manualRequested ||= manual;
    if (running) return running;
    running = (async () => {
      while (requested && !disposed) {
        requested = false;
        const manual = manualRequested;
        manualRequested = false;
        if (!isEnabled()) {
          if (manual) void vscode.window.showInformationMessage("Review Hub: enable Auto Register MCP in extension Settings to register detected agents.");
          continue;
        }
        try {
          const storage = context.globalStorageUri;
          const results = await scan({
            homeDir: os.homedir(), env: process.env, platform: process.platform,
            globalStorageDir: storage ? path.dirname(storage.fsPath) : path.join(os.homedir(), ".config", "Code", "User", "globalStorage"),
            installedExtensions: (vscode.extensions?.all ?? []).map(extension => extension.id),
          }, id => isEnabled(id));
          if (!isEnabled()) continue;
          const report = JSON.stringify(results);
          const changed = report !== lastReport;
          if (changed || manual) {
            lastReport = report;
            logger.info("Agent MCP scan (" + (vscode.env.remoteName || "local") + "): " + results.length + " detected");
            for (const result of results) {
              const text = result.label + ": " + result.status + " — " + result.configPath + (result.message ? " — " + result.message : "");
              if (result.status === "error") logger.warn(text); else logger.info(text);
            }
          }
          const added = results.filter(result => result.status === "registered");
          const failed = results.filter(result => result.status === "error");
          if (added.length) void vscode.window.showInformationMessage("Review Hub MCP added to " + added.map(result => result.label).join(", ") + ". Reconnect MCP in those agents to load it.");
          if (failed.length && (changed || manual)) void vscode.window.showWarningMessage("Review Hub: could not configure " + failed.map(result => result.label).join(", ") + ". See Review Hub output for details; their configurations were kept.");
          if (manual && !added.length && !failed.length) void vscode.window.showInformationMessage(results.length
            ? "Review Hub: agent scan complete. Existing MCP registrations were kept. See Review Hub output for details."
            : "Review Hub: no supported agents detected on this host.");
        } catch {
          if (!disposed) {
            logger.warn("Agent MCP scan failed. Check access to agent configuration directories.");
            if (manual) void vscode.window.showWarningMessage("Review Hub: agent scan failed. Check access to the configuration directories.");
          }
        }
      }
    })().finally(() => { running = undefined; });
    return running;
  };
  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("review-hub.autoRegisterMcp") || event.affectsConfiguration("review-hub.agents")) void request();
  });
  const extensionListener = vscode.extensions?.onDidChange(() => { if (isEnabled()) void request(); });
  const command = vscode.commands.registerCommand("review-hub.scanAgents", () => request(true));
  const timer = setInterval(() => { if (isEnabled()) void request(); }, 60_000);
  timer.unref();
  void request();
  return { dispose() {
    disposed = true;
    clearInterval(timer);
    configListener.dispose(); extensionListener?.dispose(); command.dispose();
  } };
}
