import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { ChangeStore } from "../core/src/change-store";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rh-apply-first-"));

for (const backend of ["json", "auto"] as const) {
  test(backend + ": an actual test process uses pending new code; reject restores the original after reload", () => {
    const workspace = tmp();
    const baseDir = tmp();
    const modulePath = path.join(workspace, "value.cjs");
    fs.writeFileSync(modulePath, "module.exports = 1;\n");
    fs.writeFileSync(path.join(workspace, "value.test.cjs"),
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert/strict');\n" +
      "test('new value', () => assert.equal(require('./value.cjs'), 2));\n");
    // A nested test process must not inherit the parent runner's IPC context.
    const testEnv = { ...process.env };
    delete testEnv.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, ["--test", "value.test.cjs"], { cwd: workspace, env: testEnv, encoding: "utf8" });
    assert.equal(run().status, 1, "the original code fails the regression test");
    const store = new ChangeStore({ baseDir, backend, mcpOnly: true });
    const cs = store.propose(workspace, "value.cjs", "module.exports = 2;\n");
    assert.equal(cs.applied, true);
    assert.ok(cs.hunks.every(hunk => hunk.decision === "pending"));
    const pendingRun = run();
    assert.equal(pendingRun.status, 0, pendingRun.stdout + pendingRun.stderr);
    store.dispose();

    const reloaded = new ChangeStore({ baseDir, backend, mcpOnly: true });
    try {
      assert.equal(reloaded.findById(cs.id)!.baseline, "module.exports = 1;\n");
      // Further edits keep the first original, not the previous proposal, for Reject.
      reloaded.propose(workspace, "value.cjs", "module.exports = 3;\n");
      assert.equal(fs.readFileSync(modulePath, "utf8"), "module.exports = 3;\n");
      reloaded.reject(cs.id);
      assert.equal(fs.readFileSync(modulePath, "utf8"), "module.exports = 1;\n");
      assert.equal(run().status, 1, "reject restores executable old code");
    } finally { reloaded.dispose(); }
  });

  test(backend + ": new empty files and deletions apply immediately and can be accepted or rejected", () => {
    const workspace = tmp();
    const store = new ChangeStore({ baseDir: tmp(), backend });
    try {
      for (const decision of ["accept", "reject"] as const) {
        const file = path.join(workspace, decision + ".txt");
        const created = store.propose(workspace, decision + ".txt", "");
        assert.equal(fs.existsSync(file), true);
        store[decision](created.id);
        assert.equal(fs.existsSync(file), decision === "accept");
        fs.writeFileSync(file, "original\r\n");
        const deleted = store.propose(workspace, decision + ".txt", "", { delete: true });
        assert.equal(fs.existsSync(file), false);
        store[decision](deleted.id);
        assert.equal(fs.existsSync(file), decision === "reject");
        if (decision === "reject") assert.equal(fs.readFileSync(file, "utf8"), "original\r\n");
      }
    } finally { store.dispose(); }
  });

  test(backend + ": binary deletion preserves byte-exact rollback", () => {
    const workspace = tmp();
    const baseDir = tmp();
    const file = path.join(workspace, "binary.bin");
    const bytes = Buffer.from([0, 255, 254, 1, 0, 128]);
    fs.writeFileSync(file, bytes);
    const store = new ChangeStore({ baseDir, backend });
    const cs = store.propose(workspace, "binary.bin", "", { delete: true });
    assert.equal(fs.existsSync(file), false);
    store.dispose();
    const reloaded = new ChangeStore({ baseDir, backend });
    try {
      reloaded.reject(cs.id);
      assert.deepEqual(fs.readFileSync(file), bytes);
      const deleted = reloaded.propose(workspace, "binary.bin", "", { delete: true });
      reloaded.accept(deleted.id);
      assert.equal(fs.existsSync(file), false);
    } finally { reloaded.dispose(); }
  });
}

test("proposal keeps executable permissions and reject restores BOM/CRLF/no-final-newline bytes", () => {
  const workspace = tmp();
  const file = path.join(workspace, "script.js");
  const original = "\uFEFFconst value = 1;\r\nconsole.log(value);";
  fs.writeFileSync(file, original, { mode: 0o755 });
  const store = new ChangeStore({ baseDir: tmp() });
  try {
    const cs = store.propose(workspace, "script.js", "const value = 2;\nconsole.log(value);\n");
    assert.equal(fs.readFileSync(file, "utf8"), cs.proposed);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o755);
    store.reject(cs.id);
    assert.deepEqual(fs.readFileSync(file), Buffer.from(original));
  } finally { store.dispose(); }
});

test("a failed disk write does not leave a phantom review", () => {
  const workspace = tmp();
  fs.writeFileSync(path.join(workspace, "parent"), "not a directory");
  const store = new ChangeStore({ baseDir: tmp() });
  try {
    assert.throws(() => store.propose(workspace, "parent/child.txt", "new"));
    assert.deepEqual(store.listChangeSets(workspace), []);
    assert.equal(fs.readFileSync(path.join(workspace, "parent"), "utf8"), "not a directory");
  } finally { store.dispose(); }
});
