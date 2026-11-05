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
  let setup: Promise<boolean> | undefined;
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
          }, id => isEnabled(id), {
            requireReview: () => vscode.workspace.getConfiguration("review-hub").get<boolean>("requireReview", false),
            claudeInstructions: () => isEnabled("claudeCode") && vscode.workspace.getConfiguration("review-hub").get<boolean>("claude.installInstructions", true),
          });
          if (!isEnabled()) continue;
          const report = JSON.stringify(results);
          const changed = report !== lastReport;
          if (changed || manual) {
            lastReport = report;
            logger.info("Agent MCP scan (" + (vscode.env.remoteName || "local") + "): " + results.length + " detected");
            for (const result of results) {
              const text = result.label + ": " + result.status + " — " + result.configPath + (result.message ? " — " + result.message : "");
              if (result.status === "error") logger.warn(text); else logger.info(text);
              if (result.requiredReview) {
                const hook = result.requiredReview;
                const message = result.label + " required review: " + hook.status + " — " + hook.path + (hook.message ? " — " + hook.message : "");
                if (hook.status === "error" || hook.status === "unsupported") logger.warn(message); else logger.info(message);
              }
              if (result.instructions) {
                const instructions = result.instructions;
                const message = result.label + " instructions: " + instructions.status + " — " + instructions.path + (instructions.message ? " — " + instructions.message : "");
                if (instructions.status === "error") logger.warn(message); else logger.info(message);
              }
            }
          }
          const hooksAdded = results.filter(result => result.requiredReview?.status === "installed");
          const hooksFailed = results.filter(result => ["error", "unsupported"].includes(result.requiredReview?.status ?? ""));
          if ((changed || manual) && hooksAdded.length) void vscode.window.showInformationMessage("Review Hub: required review hooks installed for " + hooksAdded.map(result => result.label).join(", ") + ". Start a new agent session. Shell/build/test commands and direct writes are blocked; accept changes in Hub.");
          if ((changed || manual) && hooksFailed.length) void vscode.window.showWarningMessage("Review Hub: required review is NOT enforced for " + hooksFailed.map(result => result.label).join(", ") + ". See Review Hub output for details.");
          const added = results.filter(result => result.status === "registered");
          const failed = results.filter(result => result.status === "error");
          const instructionsAdded = results.filter(result => result.instructions?.status === "installed");
          const instructionsFailed = results.filter(result => result.instructions?.status === "error");
          if (added.length || instructionsAdded.length) {
            const messages: string[] = [];
            if (added.length) messages.push("Review Hub MCP added to " + added.map(result => result.label).join(", ") + ". Reconnect MCP in those agents to load it.");
            if (instructionsAdded.length) messages.push("Claude Code instructions installed in " + instructionsAdded[0].instructions!.path + ". Start a new Claude session to load the Review Hub editing workflow.");
            void vscode.window.showInformationMessage(messages.join(" "));
          }
          if (instructionsFailed.length && (changed || manual)) void vscode.window.showWarningMessage("Review Hub: MCP is configured, but Claude instructions could not be installed. See Review Hub output for the file path and error.");
          if (failed.length && (changed || manual)) void vscode.window.showWarningMessage("Review Hub: could not configure " + failed.map(result => result.label).join(", ") + ". See Review Hub output for details; their configurations were kept.");
          if (manual && !added.length && !failed.length && !instructionsAdded.length && !instructionsFailed.length) void vscode.window.showInformationMessage(results.length
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
  // A new machine does not inherit this machine-scoped opt-in through Settings Sync.
  // Only the explicit Enable action changes the setting or permits configuration writes.
  const offerSetup = (): Promise<boolean> => {
    if (disposed) return Promise.resolve(false);
    if (isEnabled()) return Promise.resolve(true);
    if (setup) return setup;
    setup = (async () => {
      try {
        const choice = await vscode.window.showInformationMessage(
          "Review Hub: automatic MCP setup is off on this machine. Enable it to add Review Hub to installed agents and install Claude Code editing instructions?",
          "Enable and Scan", "Open Settings",
        );
        if (disposed) return false;
        if (choice === "Open Settings") {
          await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:review-hub.review-hub-vscode autoRegisterMcp");
          return false;
        }
        if (choice !== "Enable and Scan") return false;
        await vscode.workspace.getConfiguration("review-hub").update("autoRegisterMcp", true, vscode.ConfigurationTarget.Global);
        return isEnabled();
      } catch {
        if (!disposed) {
          logger.warn("Could not enable automatic MCP setup. Enable Auto Register MCP in Review Hub Settings on this machine.");
          void vscode.window.showWarningMessage("Review Hub: could not save Auto Register MCP. Enable it in extension Settings and run the agent scan again.");
        }
        return false;
      }
    })().finally(() => { setup = undefined; });
    return setup;
  };
  const scanManually = async (): Promise<void> => {
    if (await offerSetup()) await request(true);
  };
  const offerFirstRunSetup = async (): Promise<void> => {
    if (disposed || isEnabled() || !context.globalState) return;
    const configured = vscode.workspace.getConfiguration("review-hub").inspect<boolean>("autoRegisterMcp");
    if (configured?.globalValue !== undefined || context.globalState.get<boolean>("review-hub.agentMcpSetupOffered", false)) return;
    await context.globalState.update("review-hub.agentMcpSetupOffered", true);
    if (!disposed) await scanManually();
  };
  const configListener = vscode.workspace.onDidChangeConfiguration(event => {
    if (!setup && (event.affectsConfiguration("review-hub.autoRegisterMcp") || event.affectsConfiguration("review-hub.agents") || event.affectsConfiguration("review-hub.claude.installInstructions") || event.affectsConfiguration("review-hub.requireReview"))) void request();
  });
  const extensionListener = vscode.extensions?.onDidChange(() => { if (isEnabled()) void request(); });
  const command = vscode.commands.registerCommand("review-hub.scanAgents", scanManually);
  const timer = setInterval(() => { if (isEnabled()) void request(); }, 60_000);
  timer.unref();
  if (!isEnabled()) logger.info("Automatic MCP setup is off on this machine. Enable Auto Register MCP or run Scan and Register Detected Agents to set it up.");
  void request();
  void offerFirstRunSetup().catch(() => { if (!disposed) logger.warn("Could not show first-run MCP setup. Run Scan and Register Detected Agents to configure agents."); });
  return { dispose() {
    disposed = true;
    clearInterval(timer);
    configListener.dispose(); extensionListener?.dispose(); command.dispose();
  } };
}
