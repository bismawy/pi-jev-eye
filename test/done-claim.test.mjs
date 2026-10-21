import test from "node:test";
import assert from "node:assert/strict";
import { DONE_CLAIM } from "../extensions/layer2.ts";

// The done-check fires on a past-tense claim of completion; an instruction or a plan must stay quiet,
// or every "next: fix the parser" turns into a false unverified reminder.
const claims = [
  "Selesai, semua file sudah diubah.",
  "Sudah beres.",
  "Bug fixed in gate.ts.",
  "Implementation completed.",
  "Parser berhasil diperbaiki.",
  "Perubahan sudah diterapkan.",
];
const plans = ["Terapkan perubahan ini?", "Saya akan memperbaiki file berikutnya.", "Next: fix the parser"];

for (const text of claims) {
  test("a completion claim is detected: " + text, () => assert.equal(DONE_CLAIM.test(text), true));
}
for (const text of plans) {
  test("a plan or instruction is not a claim: " + text, () => assert.equal(DONE_CLAIM.test(text), false));
}
