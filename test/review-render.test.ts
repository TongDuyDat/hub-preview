import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

test("the review renderer keeps every decision bar when hunks collapse at EOF", () => {
  class Node {
    children: Node[] = [];
    className = "";
    id = "";
    textContent = "";
    title = "";
    appendChild(child: Node) { this.children.push(child); }
    addEventListener() {}
  }
  const root = new Node();
  let receive: (event: unknown) => void = () => {};
  runInNewContext(fs.readFileSync(path.join(process.cwd(), "vscode/resources/webview/review-tab/review.js"), "utf8"), {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { getElementById: () => root, createElement: () => new Node(), documentElement: { scrollTop: 0 } },
    window: { scrollY: 0, scrollTo() {}, addEventListener: (_: string, cb: typeof receive) => { receive = cb; } },
  });
  receive({ data: { type: "update", state: {
    name: "empty.txt", added: 0, removed: 2, binary: false, status: "resolved", lines: [],
    hunks: [
      { id: "deleted", line: 0, decision: "accepted", added: 0, removed: 1 },
      { id: "insertion", line: 0, decision: "rejected", added: 1, removed: 0 },
    ],
  } } });
  assert.deepEqual(root.children.filter((node) => node.className === "hunkbar").map((node) => node.id),
    ["hunk-deleted", "hunk-insertion"]);
});
