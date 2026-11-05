import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFileEdits, changedContext } from "../mcp/batch-changes";

test("batch edits compose sequentially, preserve CRLF and insert replacement tokens literally", () => {
  const result = applyFileEdits("hello\r\nworld\r\n", [
    { old_string: "hello", new_string: "hi\nthere" },
    { old_string: "there\nworld", new_string: "$&\n$'" },
  ]);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.content, "hi\r\n$&\r\n$'\r\n");
});

test("failed later edit reports original staged context, never intermediate edits", () => {
  const result = applyFileEdits("one\ntwo\n", [
    { old_string: "one", new_string: "changed" },
    { old_string: "missing", new_string: "three" },
  ]);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.failed_edit, 1);
    assert.equal(result.error.code, "match_not_found");
    assert.equal(result.error.context.excerpts[0].content, "one\ntwo\n");
  }
});

test("ambiguous and empty matches fail; explicit replace_all works", () => {
  for (const [needle, code] of [["same", "ambiguous_match"], ["", "empty_match"]]) {
    const result = applyFileEdits("same same", [{ old_string: needle, new_string: "next" }]);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.code, code);
  }
  assert.deepEqual(applyFileEdits("same same", [{ old_string: "same", new_string: "next", replace_all: true }]),
    { success: true, content: "next next" });
});

test("missing match locates relevant distant context without guessing a replacement", () => {
  const content = Array.from({ length: 100 }, (_, i) => `// line ${i}`).join("\n") + "\ntimeout: 2000\n";
  const result = applyFileEdits(content, [{ old_string: "timeout: 1000", new_string: "timeout: 3000" }]);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.code, "match_not_found");
    assert.match(result.error.context.excerpts[0].content, /timeout: 2000/);
    assert.equal(result.error.context.excerpts[0].start_line, 99);
  }
});

test("changed excerpts locate distant changes and bound large single-line output", () => {
  const before = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 40", "changed 40").replace("line 90", "changed 90");
  const context = changedContext(before, after);
  assert.equal(context.excerpts.length, 2);
  assert.match(context.excerpts[0].content, /changed 40/);
  assert.match(context.excerpts[1].content, /changed 90/);
  assert.equal(context.excerpts[0].start_line, 39);
  const large = changedContext("old", "a".repeat(10000));
  assert.equal(large.excerpts[0].content.length, 2000);
  assert.equal(large.excerpts[0].truncated, true);
});
