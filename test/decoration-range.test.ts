import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Real-file decorations. The disk holds the PROPOSED content, so:
 *   added  (green) — the new lines, while pending/accepted
 *   removed (red)  — the surviving baseline lines, once the hunk is rejected
 *   ghost          — the content of the baseline lines that were removed, shown as
 *                    injected text because those lines are no longer on disk. This is
 *                    what lets the user read what was deleted in the real file.
 *
 * Mirrors `ChangeDecorator.apply`, which needs the full editor surface to import.
 */

interface Hunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  decision: "pending" | "accepted" | "rejected";
}

interface Marks {
  added: [number, number][];
  removed: [number, number][];
  ghost: number[];
}

function marksFor(hunks: Hunk[], docLineCount: number): Marks {
  const lastLine = Math.max(0, docLineCount - 1);
  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  const out: Marks = { added: [], removed: [], ghost: [] };
  for (const h of hunks) {
    const rejected = h.decision === "rejected";
    if (!rejected && h.newLines.length > 0) {
      const start = clamp(h.newStart, 0, lastLine);
      const end = clamp(start + h.newLines.length - 1, start, lastLine);
      out.added.push([start, end]);
    }
    if (rejected) {
      const start = clamp(h.newStart, 0, lastLine);
      const span = Math.max(1, h.newLines.length || h.oldLines.length);
      const end = clamp(start + span - 1, start, lastLine);
      out.removed.push([start, end]);
    }
    if (!rejected && h.oldLines.length > 0) {
      out.ghost.push(clamp(h.newStart, 0, lastLine));
    }
  }
  return out;
}

test("a pure deletion shows its removed content as ghost text", () => {
  // baseline ["a","b","c"] -> proposed ["a","c"]: "b" is gone from disk.
  const h: Hunk = { oldStart: 1, oldLines: ["b"], newStart: 1, newLines: [], decision: "pending" };
  const m = marksFor([h], 2);
  assert.deepEqual(m.ghost, [1], "the deleted line is shown as ghost text at the join point");
  assert.deepEqual(m.added, [], "a pure deletion adds nothing green");
});

test("a modify shows the new line green and the old line as ghost text", () => {
  const h: Hunk = { oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B2"], decision: "pending" };
  const m = marksFor([h], 3);
  assert.deepEqual(m.added, [[1, 1]], "the replacement is green");
  assert.deepEqual(m.ghost, [1], "the replaced (old) line is also shown");
});

test("an insert shows only green, with no ghost", () => {
  const h: Hunk = { oldStart: 1, oldLines: [], newStart: 1, newLines: ["b"], decision: "pending" };
  const m = marksFor([h], 3);
  assert.deepEqual(m.added, [[1, 1]]);
  assert.deepEqual(m.ghost, [], "nothing was removed");
});

test("a rejected hunk is red on the restored lines and shows no ghost", () => {
  const h: Hunk = { oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B2"], decision: "rejected" };
  const m = marksFor([h], 3);
  assert.deepEqual(m.removed, [[1, 1]], "the baseline line is back on disk and marked red");
  assert.deepEqual(m.ghost, [], "no ghost once the old line is really on disk again");
  assert.deepEqual(m.added, []);
});

test("an accepted hunk is green with no ghost (the old line is intentionally gone)", () => {
  const h: Hunk = { oldStart: 1, oldLines: ["b"], newStart: 1, newLines: ["B2"], decision: "accepted" };
  const m = marksFor([h], 3);
  assert.deepEqual(m.added, [[1, 1]]);
  assert.deepEqual(m.ghost, [1], "still shown as ghost so the user can see what was replaced");
});

test("every removed line of a multi-line deletion is summarised", () => {
  const h: Hunk = {
    oldStart: 1,
    oldLines: ["x", "y", "z"],
    newStart: 1,
    newLines: [],
    decision: "pending",
  };
  const m = marksFor([h], 5);
  assert.equal(m.ghost.length, 1, "one ghost decoration covers the whole removed block");
});

// ---- ghost text formatting ---------------------------------------------------

test("ghost text shows a single removed line", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  assert.equal(ghostFor(["import sys"]), "  ⊖ import sys");
});

test("ghost text preserves indentation with non-breaking spaces", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  const out = ghostFor(["        return None"]);
  assert.equal(out, "  \u2296 \u2003\u2003\u2003\u2003return None");
});

test("ghost text summarises a multi-line deletion", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  const out = ghostFor(["first", "second", "third"]);
  assert.match(out, /first/);
  assert.match(out, /\+2 more deleted/);
});

test("ghost text truncates a very long line", async () => {
  const { ghostFor } = await import("../src/change-decorator");
  const out = ghostFor(["x".repeat(300)]);
  assert.ok(out.includes("…"), "long lines are truncated");
  assert.ok(out.length < 200);
});
