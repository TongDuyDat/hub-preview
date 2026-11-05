import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";

test("native inline review updates each hunk without contaminating Auto Save", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-separate-"));
  process.env.REVIEW_HUB_DIR = path.join(root, "hub");
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  process.env.VSCODE_STUB_WORKSPACE = JSON.stringify([{ uri: { fsPath: ws }, name: "ws", index: 0 }]);
  process.env.VSCODE_STUB_CONFIG = JSON.stringify({ enabled: true, watchDirectWrites: false });
  const { activate, deactivate } = await import("../vscode/src/extension");
  const ctx = {
    subscriptions: [] as { dispose(): void }[],
    extension: { packageJSON: { version: "0.3.0" } },
    extensionUri: vscode.Uri.file(process.cwd()),
    asAbsolutePath: (p: string) => path.join(process.cwd(), p),
    globalState: { get: () => undefined, update: async () => {} },
  };
  await activate(ctx as never);
  const command = async (name: string, ...args: string[]) => {
    const fn = vscode.__commands.get(name)?.at(-1);
    assert.ok(fn);
    await fn(...args as never[]);
  };
  try {
    const store = new ChangeStore({ baseDir: process.env.REVIEW_HUB_DIR });
    for (const mode of ["off", "afterDelay", "onFocusChange", "onWindowChange"]) {
      process.env.VSCODE_STUB_CONFIG = JSON.stringify({ enabled: true, watchDirectWrites: false, autoSave: mode });
      const file = path.join(ws, `${mode}.txt`);
      const pad = "context\n".repeat(10);
      const old = `old\n${pad}keep\n`;
      fs.writeFileSync(file, old);
      const cs = store.propose(ws, path.basename(file), `new\nextra\n${pad}added\nkeep\n`);
      assert.equal(cs.hunks.length, 2);
      const doc = {
        uri: vscode.Uri.file(file), isDirty: false,
        getText: () => fs.readFileSync(file, "utf8"),
      };
      vscode.__textDocuments.push(doc);
      const open = vscode.__listeners.find((listener) => listener.event === "open");
      open?.cb(doc as never);
      await command("review-hub.openDiff", cs.id);
      const review = vscode.__shownEditors.at(-1)!.document;
      assert.equal(review.uri.authority, "inline");
      assert.ok(review.getText().includes("old\nnew\nextra\n"));
      assert.equal(review.isDirty, false);
      assert.equal(vscode.__panels.length, 0, "text review must use the native editor, not a webview");
      assert.equal(doc.getText(), cs.proposed, `${mode}: opening review keeps the applied new code`);
      for (const listener of vscode.__listeners.filter((listener) => listener.event === "willSave")) {
        listener.cb({ document: doc, waitUntil: () => assert.fail("review must not intercept Auto Save") } as never);
      }
      await command("review-hub.acceptHunk", cs.id, cs.hunks[0].id);
      assert.equal(doc.getText(), cs.proposed, `${mode}: accepting one hunk preserves pending new code`);
      assert.equal(store.findById(cs.id)!.hunks.filter(h => h.decision === "pending").length, 1);
      assert.ok(!review.getText().split("\n").includes("old"));
      assert.ok(review.getText().split("\n").includes("added"));
      await command("review-hub.rejectHunk", cs.id, cs.hunks[1].id);
      assert.equal(store.findById(cs.id)!.hunks.filter(h => h.decision === "pending").length, 0);
      assert.ok(!review.getText().split("\n").includes("added"));
      assert.equal(review.getText(), doc.getText());
      assert.equal(doc.getText(), `new\nextra\n${pad}keep\n`);
    }
    // File-level toolbar decisions must resolve the active native review URI.
    const toolbarFile = path.join(ws, "toolbar.txt");
    fs.writeFileSync(toolbarFile, "old\n");
    const toolbarChange = store.propose(ws, "toolbar.txt", "new\n");
    await command("review-hub.openDiff", toolbarChange.id);
    await command("review-hub.stagedRejectAll");
    assert.equal(store.findById(toolbarChange.id)!.status, "resolved");
    assert.equal(fs.readFileSync(toolbarFile, "utf8"), "old\n");

    // An actual incoming MCP proposal opens inline automatically, without opening a webview.
    const entryFile = path.join(root, "hub", "hub.json");
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(entryFile) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
    assert.ok(fs.existsSync(entryFile));
    const entry = JSON.parse(fs.readFileSync(entryFile, "utf8"));
    const autoFile = path.join(ws, "auto.py");
    fs.writeFileSync(autoFile, "print('old')\n");
    const response = await fetch(entry.url + "/changes/propose", {
      method: "POST", headers: { authorization: `Bearer ${entry.token}`, "content-type": "application/json" },
      body: JSON.stringify({ workspace: ws, path: "auto.py", content: "print('new')\n" }),
    });
    assert.equal(response.status, 200);
    await new Promise(r => setTimeout(r, 800));
    const opened = vscode.__shownEditors.at(-1)!;
    assert.equal(opened.document.uri.authority, "inline");
    assert.ok(opened.document.uri.path.endsWith("/auto.py"));
    assert.equal(opened.options.preserveFocus, true);
    assert.equal(vscode.__panels.length, 0);
    assert.equal(fs.readFileSync(autoFile, "utf8"), "print('new')\n");
  } finally {
    await deactivate();
    for (const subscription of ctx.subscriptions) subscription.dispose();
  }
});
