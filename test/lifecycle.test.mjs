import test from "node:test";
import assert from "node:assert/strict";
import { RESET_ON, noteBash, noteWrite, resetTracking, unverifiedDoneClaim } from "../extensions/layer2.ts";
import { state } from "../extensions/pmr.ts";

// Pi emits turn_start once per assistant message, so a run that edits and then reports looks like:
// before_agent_start, turn_start (tool calls), turn_start (final text). These tests replay that order.
const emit = (name) => {
  if (name === RESET_ON) resetTracking();
};
const claim = (text) => unverifiedDoneClaim({ role: "assistant", content: [{ type: "text", text }] });

test.beforeEach(() => {
  resetTracking();
  state.stats.verificationReminders = 0;
});

test("an edit in one turn and a done claim in the next turn is flagged", () => {
  emit("before_agent_start");
  emit("turn_start");
  noteWrite();
  emit("turn_start");
  assert.equal(claim("Sudah selesai."), true);
  assert.equal(state.stats.verificationReminders, 1);
});

test("a test run in an earlier turn of the same run still counts as verification", () => {
  emit("before_agent_start");
  emit("turn_start");
  noteWrite();
  emit("turn_start");
  noteBash("npm test");
  emit("turn_start");
  assert.equal(claim("Done."), false);
  assert.equal(state.stats.verificationReminders, 0);
});

test("a new prompt starts with clean tracking", () => {
  emit("before_agent_start");
  emit("turn_start");
  noteWrite();
  emit("before_agent_start");
  emit("turn_start");
  assert.equal(claim("Sudah selesai."), false);
});
