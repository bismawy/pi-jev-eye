import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editContext, readSource } from "../extensions/gate.ts";

// A bare newText reads like a stub to the judge; these pin that an edit is judged in place, and that
// every path which cannot see the file still falls back to the fragments instead of judging nothing.
const file = Array.from({ length: 60 }, (_, i) => "line " + i).join("\n");

test("an edit is judged inside the 20 lines around it", () => {
  const lines = editContext(file, [{ oldText: "line 30", newText: "line 30 changed" }]).split("\n");
  assert.equal(lines[0], "line 10");
  assert.equal(lines.at(-1), "line 50");
  assert.ok(lines.includes("line 30 changed"));
});

test("without the file the fragments are judged", () => {
  const edits = [{ oldText: "a", newText: "one" }, { oldText: "b", newText: "two" }];
  assert.equal(editContext(null, edits), "one\ntwo");
});

test("an oldText the file does not hold falls back to the fragments", () => {
  assert.equal(editContext(file, [{ oldText: "absent", newText: "new" }]), "new");
});

test("an unreadable path is null, not a throw", () => {
  assert.equal(readSource(tmpdir(), "no-such-file-pi-jev-eye.ts"), null);
  assert.equal(readSource(tmpdir(), undefined), null);
});

test("a readable path returns the file, with a leading @ stripped", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-eye-"));
  try {
    writeFileSync(join(dir, "a.ts"), "const a = 1;\n");
    assert.equal(readSource(dir, "a.ts"), "const a = 1;\n");
    assert.equal(readSource(dir, "@a.ts"), "const a = 1;\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
