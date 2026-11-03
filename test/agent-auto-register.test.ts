import { test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "./vscode-stub";
import { startAgentAutoRegistration } from "../vscode/src/agents/auto-register";
import type { AgentEnvironment, AgentId, RegistrationResult } from "../vscode/src/agents/mcp-registration";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const logger = { info() {}, warn() {} };
const context = { globalStorageUri: vscode.Uri.file("/tmp/profile/globalStorage/review-hub.review-hub-vscode") };
function fireSettings() {
  const callback = vscode.__listeners.find(listener => listener.event === "configuration")!.cb;
  (callback as (event: unknown) => void)({ affectsConfiguration: (key: string) => key === "review-hub.autoRegisterMcp" });
}

test("auto-registration is opt-in, reacts immediately to checkbox changes and disposes listeners", async () => {
  const previous = process.env.VSCODE_STUB_CONFIG;
  process.env.VSCODE_STUB_CONFIG = "{}";
  const scans: { environment: AgentEnvironment; cline: boolean; codex: boolean }[] = [];
  const scan = async (environment: AgentEnvironment, enabled: (id: AgentId) => boolean): Promise<RegistrationResult[]> => {
    scans.push({ environment, cline: enabled("cline"), codex: enabled("codex") });
    return [];
  };
  const service = startAgentAutoRegistration(context as never, logger, scan);
  try {
    await tick();
    assert.equal(scans.length, 0);
    process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: true, "agents.codex": false });
    fireSettings();
    await tick();
    assert.equal(scans.length, 1);
    assert.equal(scans[0].cline, true);
    assert.equal(scans[0].codex, false);
    assert.equal(scans[0].environment.globalStorageDir, "/tmp/profile/globalStorage");
    process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: false });
    fireSettings();
    await tick();
    assert.equal(scans.length, 1);
    const command = vscode.__commands.get("review-hub.scanAgents")!.at(-1)!;
    await (command as () => Promise<void>)();
    assert.equal(scans.length, 1, "manual scans also respect the checkbox");
  } finally {
    service.dispose();
    if (previous === undefined) delete process.env.VSCODE_STUB_CONFIG; else process.env.VSCODE_STUB_CONFIG = previous;
  }
  assert.equal(vscode.__listeners.some(listener => listener.event === "configuration"), false);
});

test("settings toggled during a scan use the newest values and do not overlap scans", async () => {
  const previous = process.env.VSCODE_STUB_CONFIG;
  process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: true });
  let complete: () => void = () => {};
  let scans = 0;
  let active = 0;
  let firstEnabled: ((id: AgentId) => boolean) | undefined;
  const service = startAgentAutoRegistration(context as never, logger, async (_, enabled) => {
    assert.equal(active++, 0);
    scans++;
    if (scans === 1) {
      firstEnabled = enabled;
      await new Promise<void>(resolve => { complete = resolve; });
    }
    active--;
    return [];
  });
  try {
    process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: true, "agents.codex": false });
    fireSettings();
    assert.equal(firstEnabled!("codex"), false);
    assert.equal(scans, 1);
    complete();
    await tick();
    assert.equal(scans, 2);
    process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: false });
    fireSettings();
    assert.equal(firstEnabled!("cline"), false);
  } finally {
    complete();
    service.dispose();
    if (previous === undefined) delete process.env.VSCODE_STUB_CONFIG; else process.env.VSCODE_STUB_CONFIG = previous;
  }
});
