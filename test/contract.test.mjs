import test from "node:test";
import assert from "node:assert/strict";
import { REVIEW_CONTRACT } from "../extensions/review.ts";
import { JEV_MIN_DIFF_LINES } from "../extensions/gate.ts";

// The contract is injected verbatim, so any wording change ships straight to the model. Nothing else in
// this repo read it, which is exactly how a rule drifts from the code it describes: the closing line
// promised a gate for every code edit while the gate itself skips writes under 10 lines and folders the
// operator never granted. These checks pin the statements that must stay true, not the style.

const has = (needle) => assert.ok(REVIEW_CONTRACT.includes(needle), `contract lost: ${needle}`);

test("the language rule is general, not a list of examples", () => {
  has("operator's language");
  assert.equal(/Indonesian|Chinese|回答/.test(REVIEW_CONTRACT), false, "language examples were removed: a rule stated by example leaves every other language to inference");
});

test("the scale is described as a rule, not as translated samples", () => {
  has("plain words in the operator's language");
  has("never a terse");
});

test("an absent premise has a stated handling", () => {
  has("premise that does not exist");
  has("is itself a machine fact");
});

test("the closing line matches what the write gate actually does", () => {
  // Read from gate.ts: a changed threshold must fail here instead of leaving the contract and the gate
  // disagreeing about the scope they both state.
  has(`${JEV_MIN_DIFF_LINES} or more lines`);
  has("in a folder you granted");
  has("is not judged");
  assert.equal(/will be evaluated against/.test(REVIEW_CONTRACT), false, "the unscoped promise is gone: it claimed every edit was judged");
});

test("machine facts stay first and stay non-fabricated", () => {
  const facts = REVIEW_CONTRACT.indexOf("Machine-verified facts first");
  const table = REVIEW_CONTRACT.indexOf("One table where every item");
  assert.ok(facts > 0 && table > facts, "facts come before the table");
  has("never invent data");
});
