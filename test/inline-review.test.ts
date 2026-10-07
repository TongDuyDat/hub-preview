import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// `vscode` is aliased to test/vscode-stub.ts by the runner.
import * as vscode from "./vscode-stub";
import { ChangeStore } from "../src/change-store";
import { ChangeContentProvider } from "../src/content-provider";
import { HunkCodeLensProvider } from "../src/diff-view";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-inline-"));
}

const OLD = "from typing import List, Optional, Sequence, Tuple\nprint('old')\n";
const NEW = "from typing import List, Sequence, Tuple\nprint('new')\n";

test("the content provider exposes `onDidChange`, so VS Code re-queries the merged view", () => {
  // Regression guard: the property must be named `onDidChange` — that is the name VS Code
  // looks for on a TextDocumentContentProvider. Named `onDidChangeTextDocument` (the
  // *workspace* event), the provider still serves content but VS Code never re-queries it,
  // so Accept/Reject appears to do nothing and the merged view keeps the stale text.
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const provider = new ChangeContentProvider(store);
  assert.equal(typeof (provider as { onDidChange?: unknown }).onDidChange, "function", "onDidChange must be exposed");

  // Firing it must reach a listener (i.e. it is a real VS Code Event, not a bare value).
  let fired = 0;
  const sub = (provider.onDidChange as (l: () => void) => { dispose(): void })(() => {
    fired++;
  });
  provider.refresh(cs.id);
  assert.ok(fired > 0, "refresh() must fire onDidChange so the view re-renders");
  sub.dispose();
});

test("the merged review document shows the OLD lines above the NEW lines", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const provider = new ChangeContentProvider(store);
  const merged = provider.mergedText(cs.id).split("\n");

  const oldLine = "from typing import List, Optional, Sequence, Tuple";
  const newLine = "from typing import List, Sequence, Tuple";
  const iOld = merged.indexOf(oldLine);
  const iNew = merged.indexOf(newLine);

  assert.notEqual(iOld, -1, "the old code is present in the merged view");
  assert.notEqual(iNew, -1, "the new code is present in the merged view");
  assert.ok(iOld < iNew, "the old line is shown directly above the new line");
  assert.ok(merged.includes("print('old')"), "the old body line is present");
  assert.ok(merged.includes("print('new')"), "the new body line is present");
});

test("rejecting a hunk makes the merged view show only the old code again", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const provider = new ChangeContentProvider(store);
  store.reject(cs.id);

  // The merged view now reflects the rejected state: old lines only.
  const merged = provider.mergedText(cs.id);
  assert.ok(merged.includes("Optional"), "the old code is still shown after reject");
  assert.equal(merged.includes("Sequence, Tuple\nprint('new')"), false, "the new code is gone after reject");

  // And the file on disk is back to the original.
  assert.equal(fs.readFileSync(path.join(ws, "demo.py"), "utf8"), OLD);
});

test("a fully-resolved change stays readable but is read-only", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);
  store.reject(cs.id);

  // The resolved set is still on disk (so the tab is not blank)...
  const kept = store.findById(cs.id);
  assert.equal(kept?.status, "resolved");
  // ...but it is not listed as a pending change.
  assert.equal(store.listChanges(ws).length, 0);

  // Its lenses are informational only — no Accept/Reject to click again.
  const lenses = new HunkCodeLensProvider(store);
  const doc = {
    uri: vscode.Uri.parse(`review-hub://merged/${cs.id}`),
    lineCount: 100,
  } as unknown as vscode.TextDocument;
  const got = lenses.provideCodeLenses(doc);
  const commands = got.map((l) => (l.command as { command: string } | undefined)?.command);
  assert.equal(commands.includes("review-hub.acceptHunk"), false);
  assert.equal(commands.includes("review-hub.rejectHunk"), false);
  assert.ok(got.length > 0, "the resolved state is still shown");
});

test("accepting a hunk makes the merged view show only the new code", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const provider = new ChangeContentProvider(store);
  store.accept(cs.id);

  const merged = provider.mergedText(cs.id);
  assert.equal(merged.includes("Optional"), false, "the old code is gone after accept");
  assert.ok(merged.includes("from typing import List, Sequence, Tuple"), "the new code remains");
  assert.equal(fs.readFileSync(path.join(ws, "demo.py"), "utf8"), NEW);
});

test("the merged view carries Accept/Reject CodeLens for every hunk", () => {
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  fs.writeFileSync(path.join(ws, "demo.py"), OLD);
  const cs = store.propose(ws, "demo.py", NEW);

  const lenses = new HunkCodeLensProvider(store);
  const doc = {
    uri: vscode.Uri.parse(`review-hub://merged/${cs.id}`),
    lineCount: 100,
  } as unknown as vscode.TextDocument;

  const got = lenses.provideCodeLenses(doc);
  // 3 lenses per hunk (Accept, Reject, "hunk i/n").
  assert.equal(got.length, cs.hunks.length * 3);
  const commands = got.map((l) => (l.command as { command: string } | undefined)?.command);
  assert.ok(commands.includes("review-hub.acceptHunk"));
  assert.ok(commands.includes("review-hub.rejectHunk"));
});

test("a decided hunk looks decided: its buttons change, not just a label", () => {
  // Regression guard for "I click Accept and nothing happens". A pending hunk and an
  // accepted hunk used to render the SAME Accept/Reject buttons, so the click produced no
  // visible change and a second click did nothing. The decided hunk must now render a
  // static badge plus an Undo, so the state is visible and reversible.
  const ws = tmp();
  const store = new ChangeStore({ baseDir: tmp() });
  const pad = "pad\n".repeat(15);
  fs.writeFileSync(path.join(ws, "demo.py"), `A = 1\n${pad}B = 2\n`);
  const cs = store.propose(ws, "demo.py", `A = 111\n${pad}B = 222\n`);
  assert.equal(cs.hunks.length, 2, "two hunks, so one can stay pending");

  const lenses = new HunkCodeLensProvider(store);
  const doc = {
    uri: vscode.Uri.parse(`review-hub://merged/${cs.id}`),
    lineCount: 100,
  } as unknown as vscode.TextDocument;

  const titles = (): string[] =>
    lenses.provideCodeLenses(doc).map((l) => String((l.command as { title?: string } | undefined)?.title ?? ""));

  assert.ok(titles().some((t) => t.includes("$(check) Accept")), "pending shows the Accept button");
  assert.ok(!titles().some((t) => t.includes("Accepted")), "nothing is accepted yet");

  // Accept only the first hunk; the second stays pending, so the set is not resolved.
  store.accept(cs.id, [cs.hunks[0].id]);
  const after = titles();
  assert.ok(after.some((t) => t.includes("Accepted")), "the accepted hunk shows an 'Accepted' badge");
  assert.ok(after.some((t) => t.includes("Undo")), "the accepted hunk offers Undo");
  assert.ok(
    after.some((t) => t.includes("$(check) Accept")),
    "the still-pending hunk keeps its Accept button",
  );
});
