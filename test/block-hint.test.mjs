import test from "node:test";
import assert from "node:assert/strict";
import { blockHint, codeFacts } from "../extensions/gate.ts";

// A block reason is the only thing the agent sees before it rewrites; without the counts it guesses.
test("the hint names every machine count", () => {
  const hint = blockHint({ lines: 3, placeholder_markers: 2, empty_bodies: 1, ellipsis_only_lines: 0 });
  assert.match(hint, /1 empty bodies/);
  assert.match(hint, /2 placeholder markers/);
  assert.match(hint, /0 ellipsis-only lines/);
});

test("the hint reads the same facts the judge saw", () => {
  const code = "function f() {}\n// TODO wire it\n";
  assert.match(blockHint(codeFacts(code)), /1 empty bodies, 1 placeholder markers/);
});
