import { test } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "./vscode-stub";
import { startAgentAutoRegistration } from "../vscode/src/agents/auto-register";
import type { AgentEnvironment, AgentId, RegistrationResult, RegistrationOptions } from "../vscode/src/agents/mcp-registration";

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

function setupContext() {
  const values = new Map<string, unknown>();
  return { ...context, globalState: {
    get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  } };
}
async function withSetupEnvironment(config: Record<string, unknown>, choice: string | undefined, run: () => Promise<void>) {
  const names = ["VSCODE_STUB_CONFIG", "VSCODE_STUB_INFO_CHOICE", "VSCODE_STUB_CONFIG_UPDATE_ERROR"];
  const previous = names.map(name => process.env[name]);
  process.env.VSCODE_STUB_CONFIG = JSON.stringify(config);
  if (choice === undefined) delete process.env.VSCODE_STUB_INFO_CHOICE; else process.env.VSCODE_STUB_INFO_CHOICE = choice;
  delete process.env.VSCODE_STUB_CONFIG_UPDATE_ERROR;
  try { await run(); } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    });
  }
}

test("a fresh machine offers setup once and dismissal never registers agents", async () => {
  await withSetupEnvironment({}, undefined, async () => {
    const fresh = setupContext();
    const before = vscode.__messages.length;
    let scans = 0;
    const scan = async () => { scans++; return []; };
    const first = startAgentAutoRegistration(fresh as never, logger, scan);
    await tick();
    first.dispose();
    assert.equal(scans, 0);
    assert.match(vscode.__messages[before], /off on this machine/);
    const after = vscode.__messages.length;
    const reopened = startAgentAutoRegistration(fresh as never, logger, scan);
    try { await tick(); assert.equal(vscode.__messages.length, after); assert.equal(scans, 0); }
    finally { reopened.dispose(); }
  });
});

test("first-run Enable and Scan saves the machine opt-in and scans selected agents immediately", async () => {
  await withSetupEnvironment({ "agents.codex": false }, "Enable and Scan", async () => {
    const scans: boolean[] = [];
    const service = startAgentAutoRegistration(setupContext() as never, logger, async (_, enabled) => {
      assert.equal(enabled("claudeCode"), true);
      scans.push(enabled("codex"));
      return [];
    });
    try {
      await tick();
      assert.deepEqual(scans, [false]);
      assert.equal(JSON.parse(process.env.VSCODE_STUB_CONFIG!).autoRegisterMcp, true);
    } finally { service.dispose(); }
  });
});

test("an explicit off setting is respected without a first-run prompt", async () => {
  await withSetupEnvironment({ autoRegisterMcp: false }, "Enable and Scan", async () => {
    const before = vscode.__messages.length;
    let scans = 0;
    const service = startAgentAutoRegistration(setupContext() as never, logger, async () => { scans++; return []; });
    try {
      await tick();
      assert.equal(scans, 0);
      assert.equal(vscode.__messages.length, before);
      assert.equal(JSON.parse(process.env.VSCODE_STUB_CONFIG!).autoRegisterMcp, false);
    } finally { service.dispose(); }
  });
});

test("a manual scan can enable setup on a second machine without opening Settings", async () => {
  await withSetupEnvironment({ autoRegisterMcp: false }, "Enable and Scan", async () => {
    let scans = 0;
    const service = startAgentAutoRegistration(context as never, logger, async () => { scans++; return []; });
    try {
      const command = vscode.__commands.get("review-hub.scanAgents")!.at(-1)!;
      await (command as () => Promise<void>)();
      assert.equal(scans, 1);
      assert.equal(JSON.parse(process.env.VSCODE_STUB_CONFIG!).autoRegisterMcp, true);
    } finally { service.dispose(); }
  });
});

test("failure to save the opt-in does not register agents", async () => {
  await withSetupEnvironment({ autoRegisterMcp: false }, "Enable and Scan", async () => {
    process.env.VSCODE_STUB_CONFIG_UPDATE_ERROR = "1";
    let scans = 0;
    const service = startAgentAutoRegistration(context as never, logger, async () => { scans++; return []; });
    try {
      const command = vscode.__commands.get("review-hub.scanAgents")!.at(-1)!;
      await (command as () => Promise<void>)();
      assert.equal(scans, 0);
      assert.equal(JSON.parse(process.env.VSCODE_STUB_CONFIG!).autoRegisterMcp, false);
      assert.match(vscode.__messages.at(-1)!, /could not save Auto Register MCP/);
    } finally { service.dispose(); }
  });
});

test("Claude instruction setup follows its own checkbox and disposal immediately", async () => {
  await withSetupEnvironment({ autoRegisterMcp: true }, undefined, async () => {
    let options: RegistrationOptions | undefined;
    const service = startAgentAutoRegistration(context as never, logger, async (_, __, current) => {
      options = current;
      return [];
    });
    try {
      await tick();
      assert.equal(options?.claudeInstructions?.(), true);
      process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: true, "claude.installInstructions": false });
      assert.equal(options?.claudeInstructions?.(), false);
      process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: true, "agents.claudeCode": false });
      assert.equal(options?.claudeInstructions?.(), false);
      process.env.VSCODE_STUB_CONFIG = JSON.stringify({ autoRegisterMcp: true });
      service.dispose();
      assert.equal(options?.claudeInstructions?.(), false);
    } finally { service.dispose(); }
  });
});

test("instruction installation errors are reported even when MCP is already configured", async () => {
  await withSetupEnvironment({ autoRegisterMcp: true }, undefined, async () => {
    const before = vscode.__messages.length;
    const logs: string[] = [];
    const service = startAgentAutoRegistration(context as never, { info() {}, warn(message) { logs.push(message); } }, async () => [{
      id: "claudeCode", label: "Claude Code", configPath: "/home/test/.claude.json", status: "already-configured",
      instructions: { path: "/home/test/.claude/CLAUDE.md", status: "error", message: "Cannot update file" },
    }]);
    try {
      await tick();
      assert.ok(logs.some(message => message.includes("CLAUDE.md") && message.includes("Cannot update file")));
      assert.ok(vscode.__messages.slice(before).some(message => message.includes("MCP is configured, but Claude instructions could not be installed")));
    } finally { service.dispose(); }
  });
});
