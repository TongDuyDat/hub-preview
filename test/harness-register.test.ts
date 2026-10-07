import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSON5 from "json5";
import { parseDocument } from "yaml";
import { buildPreview, applyPreview } from "../src/harness-register";
import type { HarnessTarget } from "../src/harness-paths";

const launch = { command: "node", args: ["/home/u/.review-hub/bin/mcp-server.cjs"], env: {} };

function target(file: string, format: HarnessTarget["format"], containerKey: string): HarnessTarget {
  return { id: "test", label: "Test", file, format, containerKey };
}

test("JSON: adds mcpServers entry and preserves unrelated keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, JSON.stringify({ other: 1, mcpServers: { exa: { type: "http", url: "x" } } }, null, 2));
  const p = buildPreview(target(file, "json", "mcpServers"), launch);
  const parsed = JSON.parse(p.after);
  assert.equal(parsed.other, 1);
  assert.equal(parsed.mcpServers.exa.url, "x");
  assert.ok(parsed.mcpServers["review-hub"]);
  assert.equal(parsed.mcpServers["review-hub"].command, "node");
});

test("JSONC: preserves comments and duplicate keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
  const file = path.join(dir, "opencode.jsonc");
  const original = `{
  // a comment that must survive
  "model": "a",
  "model": "b",
  "provider": {}
}
`;
  fs.writeFileSync(file, original);
  const p = buildPreview(target(file, "jsonc", "mcp"), launch);
  assert.ok(p.after.includes("// a comment that must survive"), "comment preserved");
  const parsed = JSON5.parse(p.after);
  assert.ok(parsed.mcp["review-hub"]);
  assert.equal(parsed.mcp["review-hub"].type, "local");
});

test("JSONC: creates the mcp container when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
  const file = path.join(dir, "opencode.jsonc");
  fs.writeFileSync(file, `{\n  "$schema": "x"\n}\n`);
  const p = buildPreview(target(file, "jsonc", "mcp"), launch);
  const parsed = JSON5.parse(p.after);
  assert.ok(parsed.mcp["review-hub"]);
  assert.equal(parsed["$schema"], "x");
});

test("YAML: appends a dsh insert entry and stays valid", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
  const file = path.join(dir, "cordis.patch.yml");
  fs.writeFileSync(file, `- insert:\n    - id: mcp-open-websearch\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n`);
  const p = buildPreview(target(file, "yaml", "insert"), launch);
  const doc = parseDocument(p.after);
  assert.equal(doc.errors.length, 0);
  assert.ok(p.after.includes("mcp-review-hub"));
  assert.ok(p.after.includes("review_hub"));
});

test("applyPreview writes a backup and the new file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, `{"mcpServers":{}}`);
  const p = buildPreview(target(file, "json", "mcpServers"), launch);
  const r = applyPreview(p);
  assert.equal(r.written, true);
  assert.ok(fs.existsSync(`${file}.reviewhub.bak`));
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(parsed.mcpServers["review-hub"]);
});

test("re-running is idempotent (no duplicate entries)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-reg-"));
  const file = path.join(dir, "cfg.json");
  fs.writeFileSync(file, `{"mcpServers":{}}`);
  applyPreview(buildPreview(target(file, "json", "mcpServers"), launch));
  const p2 = buildPreview(target(file, "json", "mcpServers"), launch);
  assert.equal(p2.alreadyRegistered, true);
  applyPreview(p2);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(parsed.mcpServers).filter((k) => k === "review-hub").length, 1);
});
