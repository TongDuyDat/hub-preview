import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ChangeStore } from "../core/src/change-store";
import { HubServer } from "../core/src/hub-server";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rh-mcp-only-"));

for (const backend of ["json", "auto"] as const) {
  test(backend + ": MCP reviews ignore Git diffs and start from the current file", async () => {
    const workspace = tmp();
    const file = path.join(workspace, "file.txt");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(file, "committed\n");
    git("add", "file.txt");
    git("commit", "-qm", "initial");
    fs.writeFileSync(file, "user changes before MCP\n");
    const baseDir = tmp();
    const legacy = new ChangeStore({ baseDir, backend });
    const old = await legacy.observe(workspace, "file.txt");
    assert.ok(old);
    assert.equal(old.baseline, "committed\n");
    const store = new ChangeStore({ baseDir, backend, mcpOnly: true });
    try {
      assert.deepEqual(store.listChanges(workspace), []);
      assert.deepEqual(store.listChangeSets(workspace), []);
      assert.equal(store.findById(old.id), undefined);
      assert.equal(store.getChange(workspace, old.id), undefined);
      assert.equal(store.findChangeByPath(workspace, "file.txt"), undefined);
      assert.throws(() => store.accept(old.id), /unknown change/);
      assert.equal(await store.observe(workspace, "file.txt"), undefined);
      const cs = store.propose(workspace, "file.txt", "user changes before MCP\nAI addition\n");
      assert.equal(cs.origin, "mcp");
      assert.equal(cs.baseline, "user changes before MCP\n");
      assert.deepEqual(cs.hunks.flatMap(h => h.oldLines), []);
      assert.deepEqual(cs.hunks.flatMap(h => h.newLines), ["AI addition"]);
      assert.equal(fs.readFileSync(file, "utf8"), cs.proposed);
      store.reject(cs.id);
      assert.equal(fs.readFileSync(file, "utf8"), "user changes before MCP\n");
      // A later independent review must not use the previous checkpoint either.
      fs.writeFileSync(file, "later manual edits\n");
      const next = store.propose(workspace, "file.txt", "later manual edits\nnext AI addition\n");
      assert.equal(next.baseline, "later manual edits\n");
      store.reject(next.id);
      assert.equal(fs.readFileSync(file, "utf8"), "later manual edits\n");
    } finally { store.dispose(); legacy.dispose(); }
  });

  test(backend + ": sequential MCP proposals preserve their review baseline and decisions", () => {
    const workspace = tmp();
    const file = path.join(workspace, "file.txt");
    const pad = "context\n".repeat(10);
    const original = "old\n" + pad + "tail\n";
    fs.writeFileSync(file, original);
    const store = new ChangeStore({ baseDir: tmp(), backend, mcpOnly: true });
    try {
      const first = store.propose(workspace, "file.txt", "new\n" + pad + "new tail\n");
      store.accept(first.id, [first.hunks[0].id]);
      const second = store.propose(workspace, "file.txt", "new\n" + pad + "newer tail\n");
      assert.equal(second.baseline, original);
      assert.equal(second.hunks[0].decision, "accepted");
      assert.equal(second.hunks[1].decision, "pending");
      assert.equal(fs.readFileSync(file, "utf8"), "new\n" + pad + "newer tail\n");
    } finally { store.dispose(); }
  });
}

test("MCP-only hub ignores observe requests without replacing a pending proposal", async () => {
  const workspace = tmp();
  const file = path.join(workspace, "file.txt");
  fs.writeFileSync(file, "local\n");
  const hub = new HubServer({ baseDir: tmp(), token: "test", mcpOnly: true });
  const addr = await hub.start();
  const api = async (route: string, body: unknown) => {
    const res = await fetch(addr.url + route, { method: "POST", headers: {
      authorization: "Bearer test", "content-type": "application/json",
    }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    return res.json() as Promise<any>;
  };
  try {
    const proposed = await api("/changes/propose", { workspace, path: "file.txt", content: "AI\n" });
    fs.writeFileSync(file, "manual save\n");
    assert.deepEqual(await api("/changes/observe", { workspace, path: "file.txt" }), { change: null });
    const kept = hub.store.findById(proposed.changeId)!;
    assert.equal(kept.origin, "mcp");
    assert.equal(kept.baseline, "local\n");
    assert.equal(kept.proposed, "AI\n");
    assert.equal(kept.hunks[0].decision, "pending");
    assert.equal(fs.readFileSync(file, "utf8"), "manual save\n");
  } finally { await hub.stop(); }
});
