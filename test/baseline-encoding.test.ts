import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { ChangeStore } from "../src/change-store";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rh-enc-"));
}

/** Same pattern as test/binary-decide.test.ts: a throwaway repo with an initial commit. */
function gitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-enc-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return dir;
}

const MAX = 1024;
// ~4.4 KB of valid utf8 with no NUL: definitely over MAX, definitely not binary.
const ORIGINAL = "alpha line\n".repeat(400);
const OVERSIZE_AGENT = "beta line\n".repeat(400);

/** A git-tracked text file larger than `MAX`, committed as ORIGINAL. */
function oversizeTextRepo(): { ws: string; file: string } {
  const ws = gitRepo();
  const file = path.join(ws, "big.txt");
  fs.writeFileSync(file, ORIGINAL);
  execFileSync("git", ["add", "big.txt"], { cwd: ws, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: ws, stdio: "pipe" });
  return { ws, file };
}

const COMMITTED = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x41]);

test("oversize text: reject after shrinking below maxFileSize restores the captured bytes (reviewer repro)", async () => {
  const { ws, file } = oversizeTextRepo();
  const store = new ChangeStore({ baseDir: tmp(), maxFileSize: MAX });

  // The agent writes a still-oversize version: the file takes the binary/oversize path,
  // and its baseline (git HEAD = ORIGINAL) is captured there.
  fs.writeFileSync(file, OVERSIZE_AGENT);
  const oversize = await store.observe(ws, "big.txt");
  assert.ok(oversize, "the oversize change is reported");
  assert.equal(oversize!.binary, true, "an oversize text file uses the binary/oversize path");

  // The agent then shrinks it below maxFileSize, so the text path handles it.
  fs.writeFileSync(file, "gamma line\n");
  const cs = await store.observe(ws, "big.txt");
  assert.ok(cs, "the shrunk text change is reported");

  const r = store.reject(cs!.id);
  assert.equal(r.resolved, true);
  assert.deepEqual(
    fs.readFileSync(file),
    Buffer.from(ORIGINAL),
    "the captured bytes are restored byte-for-byte (not base64, not truncated)",
  );
  assert.equal(await store.observe(ws, "big.txt"), undefined, "the rejected file must not reappear");
});

test("oversize text: accept after shrinking keeps the accepted text, not base64", async () => {
  const { ws, file } = oversizeTextRepo();
  const store = new ChangeStore({ baseDir: tmp(), maxFileSize: MAX });

  fs.writeFileSync(file, OVERSIZE_AGENT);
  await store.observe(ws, "big.txt");

  const accepted = "gamma line\n";
  fs.writeFileSync(file, accepted);
  const cs = await store.observe(ws, "big.txt");
  assert.ok(cs, "the shrunk text change is reported");

  const r = store.accept(cs!.id);
  assert.equal(r.resolved, true);
  assert.equal(fs.readFileSync(file, "utf8"), accepted, "accept keeps the agent's text");
  assert.ok(!fs.readFileSync(file, "utf8").startsWith("b64:"), "the disk never holds base64");
});

test("a binary baseline is tagged bin: in the checkpoint and decodes back byte-exact", async () => {
  const ws = gitRepo();
  const file = path.join(ws, "blob.bin");
  fs.writeFileSync(file, COMMITTED);
  execFileSync("git", ["add", "blob.bin"], { cwd: ws, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: ws, stdio: "pipe" });
  // Overwrite on disk without committing: the agent's direct write.
  fs.writeFileSync(file, Buffer.from([0x00, 0x09, 0x09, 0x7f, 0x00, 0x42, 0x43]));

  const store = new ChangeStore({ baseDir: tmp() });
  const cs = await store.observe(ws, "blob.bin");
  assert.ok(cs, "the changed binary is reported");
  assert.equal(cs!.binary, true);

  const cp = store.readCheckpoint(ws);
  const value = cp!.files["blob.bin"];
  assert.ok(value, "the binary baseline is recorded in the checkpoint");
  assert.ok(
    value.startsWith("bin:"),
    `the encoded checkpoint value must be tagged (got ${JSON.stringify(value.slice(0, 12))})`,
  );

  // Untagging is explicit, so a reader never has to guess an encoding.
  const reader = store as unknown as {
    baselineBytesForObserve(ws: string, rel: string): Promise<{ bytes: Buffer; exists: boolean }>;
  };
  const resolved = await reader.baselineBytesForObserve(ws, "blob.bin");
  assert.equal(resolved.exists, true);
  assert.deepEqual(resolved.bytes, COMMITTED, "the tagged value decodes back to the committed bytes");
});
