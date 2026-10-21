import test from "node:test";
import assert from "node:assert/strict";
import { blockThreshold } from "../extensions/gate.ts";

// The override is operator input read once per session: a typo or a coin-flip value must fall back to the
// shipped 0.85 rather than silently turn the gate into one that blocks most legitimate writes.
const cases = [
  [undefined, 0.85],
  ["", 0.85],
  ["0.9", 0.9],
  ["1", 1],
  ["0.5", 0.85],
  ["1.2", 0.85],
  ["abc", 0.85],
];

for (const [raw, expected] of cases) {
  test("PI_JEV_EYE_BLOCK_THRESHOLD=" + JSON.stringify(raw) + " gives " + expected, () => assert.equal(blockThreshold(raw), expected));
}
