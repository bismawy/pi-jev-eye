import test from "node:test";
import assert from "node:assert/strict";
import { codeFacts } from "../extensions/gate.ts";

// Legal code must not count as a stub: these shapes once pushed has_slop past the block threshold.
const legal = [
  ["object literal", 'const a = {}; const b = { x: {} };'],
  ["default param", 'function f(opts = {}) { return opts; }'],
  ["arrow no-op", 'const noop = () => {};'],
  ["empty catch", 'try { run(); } catch {} try { run(); } catch (e) {}'],
];
for (const [name, code] of legal) {
  test("no empty body counted: " + name, () => assert.equal(codeFacts(code).empty_bodies, 0));
}

test("a TODO inside a string is data, not a marker", () =>
  assert.equal(codeFacts('const msg = "TODO later";').placeholder_markers, 0));

test("a real empty function and method still count", () => {
  assert.equal(codeFacts('function stub() {}').empty_bodies, 1);
  assert.equal(codeFacts('class A { run(): void {} }').empty_bodies, 1);
});

test("a TODO comment still counts", () => assert.equal(codeFacts('// TODO implement').placeholder_markers, 1));
