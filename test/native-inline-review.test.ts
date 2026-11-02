import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../core/src/change-store";
import { ChangeContentProvider, reviewChangeId } from "../vscode/src/ui/editor/content-provider";
import { DiffView, HunkCodeLensProvider } from "../vscode/src/ui/editor/diff-view";
import { ChangeDecorator } from "../vscode/src/ui/editor/change-decorator";
import { buildStagedView } from "../vscode/src/ui/editor/staged-content";

function setup() {
  vscode.__visibleEditors.length = 0;
  vscode.__shownEditors.length = 0;
  vscode.__textDocuments.length = 0;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rh-native-"));
  const file = path.join(ws, "example.py");
  const pad = "context\n".repeat(10);
  const old = "old\n" + pad + "remove\n" + pad + "end\n";
  fs.writeFileSync(file, old);
  const store = new ChangeStore({ baseDir: fs.mkdtempSync(path.join(os.tmpdir(), "rh-native-store-")), mcpOnly: true });
  const cs = store.propose(ws, "example.py", "new\nextra\n" + pad + pad + "end\ninsert\n");
  const provider = new ChangeContentProvider(store);
  const registration = vscode.workspace.registerTextDocumentContentProvider("review-hub", provider);
  const lenses = new HunkCodeLensProvider(store);
  const view = new DiffView(store, provider, lenses, () => {});
  return { store, cs, provider, lenses, view, old, file, registration };
}

test("review opens in the native editor with old/new rows and a filename for language detection", async () => {
  const { store, cs, provider, lenses, view, old, file, registration } = setup();
  const before = vscode.__panels.length;
  try {
    assert.equal(cs.hunks.length, 3);
    await view.openInline(cs.id, cs.hunks[1].id);
    const shown = vscode.__shownEditors.at(-1)!;
    assert.equal(shown.document.uri.authority, "inline");
    assert.ok(shown.document.uri.path.endsWith("/example.py"));
    assert.equal(reviewChangeId(shown.document.uri), cs.id);
    assert.equal(shown.options.viewColumn, vscode.ViewColumn.Active);
    assert.equal(shown.options.preview, false);
    assert.equal(shown.options.selection.startLine, buildStagedView(cs)!.hunks[1].anchor);
    assert.equal(vscode.__panels.length, before);
    assert.ok(shown.document.getText().startsWith("old\nnew\nextra\n"));
    assert.equal(shown.document.isDirty, false);
    assert.equal(fs.readFileSync(file, "utf8"), old);
    const buttons = lenses.provideCodeLenses(shown.document as never);
    assert.equal(buttons.filter(l => l.command?.command === "review-hub.acceptHunk").length, 3);
    assert.equal(buttons.filter(l => l.command?.command === "review-hub.rejectHunk").length, 3);
    assert.equal(buttons[0].range.startLine, 0);
    assert.equal(buttons[3].range.startLine, buildStagedView(cs)!.hunks[1].anchor);
    let changed = "";
    provider.onDidChange(uri => { if (uri.authority === "inline") changed = uri.toString(); });
    store.accept(cs.id, [cs.hunks[0].id]);
    await view.refresh(cs.id);
    assert.equal(changed, provider.inlineUri(cs.id).toString());
    assert.ok(shown.document.getText().startsWith("new\nextra\n"));
    assert.ok(!shown.document.getText().split("\n").includes("old"));
    assert.equal(store.findById(cs.id)!.hunks.filter(h => h.decision === "pending").length, 2);
    store.reject(cs.id, [cs.hunks[1].id]);
    store.reject(cs.id, [cs.hunks[2].id]);
    assert.equal(shown.document.getText(), fs.readFileSync(file, "utf8"));
    assert.equal(shown.document.isDirty, false);
  } finally { registration.dispose(); provider.dispose(); view.dispose(); store.dispose(); }
});

test("native review paints real red/green rows and clears a decided block's colours", async () => {
  const { store, cs, provider, view, registration } = setup();
  const decorator = new ChangeDecorator(store);
  decorator.start();
  try {
    await view.openInline(cs.id);
    const editor = vscode.__shownEditors.at(-1)!;
    const latest = (color: string) => editor.decorations.filter(d => d.type.opts.backgroundColor?.id === color).at(-1)?.ranges ?? [];
    assert.ok(latest("diffEditor.removedLineBackground").some((d: any) => d.range.startLine === 0));
    assert.ok(latest("diffEditor.insertedLineBackground").some((d: any) => d.range.startLine === 1 && d.range.endLine === 2));
    store.accept(cs.id, [cs.hunks[0].id]);
    decorator.refreshAll();
    assert.ok(!latest("diffEditor.removedLineBackground").some((d: any) => d.range.startLine === 0));
    assert.ok(!latest("diffEditor.insertedLineBackground").some((d: any) => d.range.startLine === 0));
    assert.ok(latest("diffEditor.removedLineBackground").length > 0, "other pending deletions stay red");
    assert.ok(latest("diffEditor.insertedLineBackground").length > 0, "other pending additions stay green");
  } finally { decorator.dispose(); registration.dispose(); provider.dispose(); view.dispose(); store.dispose(); }
});

test("next/previous change navigation skips decided hunks and wraps", async () => {
  const { store, cs, provider, view, registration } = setup();
  try {
    await view.openInline(cs.id);
    const editor = vscode.__shownEditors.at(-1)!;
    view.navigate(1);
    assert.equal(editor.selection.active.line, buildStagedView(cs)!.hunks[1].anchor);
    store.accept(cs.id, [cs.hunks[0].id]);
    view.navigate(-1);
    assert.equal(editor.selection.active.line, buildStagedView(store.findById(cs.id)!)!.hunks[1].anchor);
    view.navigate(-1);
    assert.equal(editor.selection.active.line, buildStagedView(store.findById(cs.id)!)!.hunks[2].anchor);
  } finally { registration.dispose(); provider.dispose(); view.dispose(); store.dispose(); }
});

for (const kind of ["new", "deleted"] as const) {
  test("native review handles an " + kind + " file without needing it open on disk", async () => {
    const { store, provider, view, registration } = setup();
    const ws = path.dirname(vscode.Uri.file(path.join(os.tmpdir(), "placeholder")).fsPath);
    const root = fs.mkdtempSync(path.join(ws, "rh-native-empty-"));
    const file = path.join(root, "empty.py");
    if (kind === "deleted") fs.writeFileSync(file, "gone\n");
    const cs = store.propose(root, "empty.py", kind === "new" ? "added\n" : "", { delete: kind === "deleted" });
    try {
      await view.openInline(cs.id);
      const shown = vscode.__shownEditors.at(-1)!;
      assert.ok(shown.document.getText().includes(kind === "new" ? "added" : "gone"));
      store.accept(cs.id);
      assert.equal(shown.document.getText(), kind === "new" ? "added\n" : "");
      assert.equal(shown.document.isDirty, false);
      assert.equal(fs.existsSync(file), kind === "new");
    } finally { registration.dispose(); provider.dispose(); view.dispose(); store.dispose(); }
  });
}

for (const decision of ["accept", "reject", "mixed"] as const) {
  test("completed inline review returns to original: " + decision, async () => {
    const { store, cs, provider, view, file, registration } = setup();
    const descriptor = Object.getOwnPropertyDescriptor(vscode.window, "tabGroups")!;
    const closed: unknown[] = [];
    const review = { input: { uri: provider.inlineUri(cs.id) }, isActive: true };
    const unrelated = { input: { uri: vscode.Uri.file(file + ".other") }, isActive: false };
    Object.defineProperty(vscode.window, "tabGroups", { configurable: true, get: () => ({
      all: [{ tabs: [review, unrelated], isActive: true, viewColumn: 2 }],
      close: async (tab: unknown) => { closed.push(tab); return true; },
    }) });
    try {
      await view.openInline(cs.id);
      store[decision === "reject" ? "reject" : "accept"](cs.id, [cs.hunks[0].id]);
      await view.refresh(cs.id);
      assert.equal(closed.length, 0, "partial decision keeps review open");
      const remaining = cs.hunks.slice(1).map(h => h.id);
      store[decision === "accept" ? "accept" : "reject"](cs.id, remaining);
      await view.refresh(cs.id);
      assert.deepEqual(closed, [review]);
      const original = vscode.__shownEditors.at(-1)!;
      assert.equal(original.document.uri.scheme, "file");
      assert.equal(original.document.uri.fsPath, file);
      assert.equal(original.document.getText(), fs.readFileSync(file, "utf8"));
      assert.equal(original.options.viewColumn, 2);
      assert.equal(original.options.preserveFocus, false);
    } finally {
      Object.defineProperty(vscode.window, "tabGroups", descriptor);
      registration.dispose(); provider.dispose(); view.dispose(); store.dispose();
    }
  });
}

test("accepted deletion closes review without recreating the file", async () => {
  const { store, provider, view, file, registration } = setup();
  const cs = store.propose(path.dirname(file), path.basename(file), "", { delete: true });
  const descriptor = Object.getOwnPropertyDescriptor(vscode.window, "tabGroups")!;
  const closed: unknown[] = [];
  const review = { input: { uri: provider.inlineUri(cs.id) }, isActive: true };
  Object.defineProperty(vscode.window, "tabGroups", { configurable: true, get: () => ({
    all: [{ tabs: [review], isActive: true, viewColumn: 1 }],
    close: async (tab: unknown) => { closed.push(tab); return true; },
  }) });
  try {
    await view.openInline(cs.id);
    const shownBefore = vscode.__shownEditors.length;
    store.accept(cs.id);
    await view.refresh(cs.id);
    assert.deepEqual(closed, [review]);
    assert.equal(vscode.__shownEditors.length, shownBefore);
    assert.equal(fs.existsSync(file), false);
  } finally {
    Object.defineProperty(vscode.window, "tabGroups", descriptor);
    registration.dispose(); provider.dispose(); view.dispose(); store.dispose();
  }
});
