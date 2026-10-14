import test from "node:test";
import assert from "node:assert/strict";
import { EYE_MARKER, EYE_TRIGGER, REVIEW_TRIGGER } from "../extensions/review.ts";

// The flat trigger exists so the operator stops having to remember a prose token. What decides whether a
// turn is reviewed is this regex, so it is pinned here rather than described in a comment: a marker that
// fires inside `/eyeline`, or one that stops firing once a path precedes it, is a silent behaviour change.

const fires = [
  "/eye",
  "/eye tugas",
  "/EYE halo",
  "Hai, bantu saya /eye",
  "jalan /eye sekarang",
  "tolong /eye",
];

for (const text of fires) {
  test(`/eye is detected: ${JSON.stringify(text)}`, () => assert.equal(EYE_TRIGGER.test(text), true));
}

// Not a trigger: a longer word (`/eyeline`), a path segment (`src/eye`), an unrelated file (`/eye.md`),
// and the package's own name, which the prose half of the trigger must also leave alone.
const quiet = ["/eyeline", "/eyes", "src/eye", "/eye.md", "x/eye", "pi-jev-eye", "jev-eye"];

for (const text of quiet) {
  test(`/eye is not detected: ${JSON.stringify(text)}`, () => assert.equal(EYE_TRIGGER.test(text), false));
}

// The two spellings are one contract: the prose token keeps working, and both reach a reviewed turn.
for (const text of ["/eye", "jev", "@jev", "/jev-review", "tolong /eye"]) {
  test(`REVIEW_TRIGGER accepts ${JSON.stringify(text)}`, () => assert.equal(REVIEW_TRIGGER.test(text), true));
}
test("REVIEW_TRIGGER still ignores the package name", () => assert.equal(REVIEW_TRIGGER.test("pi-jev-eye"), false));
test("the command re-sends a text that the trigger accepts", () =>
  assert.equal(REVIEW_TRIGGER.test(`${EYE_MARKER} fix the parser`), true));
