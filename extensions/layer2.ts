// Layer 2: the done-check. Pure transitions over state, so npm test can replay the event order
// without loading index.ts, whose UI imports pull in pi-tui.

import { VERIFICATION_COMMAND_PATTERNS } from "./layer1.ts";
import { state } from "./pmr.ts";

// Past-tense completion only: an imperative such as terapkan is an instruction, not a claim of done.
export const DONE_CLAIM =
  /\b(?:selesai|beres|rampung|done|fixed|completed|finished|implemented|(?:berhasil|sudah) (?:diperbaiki|dibuat|diterapkan|ditambahkan|diubah))\b/i;

/** The Pi event that clears the tracking. index.ts subscribes resetTracking to it.
 *  Once per prompt run, not per turn: Pi starts a new turn for every assistant message, so the edit and
 *  the final "done" text always land in different turns and a per-turn reset hid every unverified claim. */
export const RESET_ON = "before_agent_start";

export function resetTracking(): void {
  state.modifiedFilesThisTurn = false;
  state.verifiedThisTurn = false;
}

export function noteBash(cmd: string): void {
  if (VERIFICATION_COMMAND_PATTERNS.some((p) => p.test(cmd))) state.verifiedThisTurn = true;
}

export function noteWrite(): void {
  state.modifiedFilesThisTurn = true;
}

/** True when an assistant message claims completion over unverified edits; counts the reminder. */
export function unverifiedDoneClaim(message: any): boolean {
  if (message?.role !== "assistant") return false;
  if (!state.modifiedFilesThisTurn || state.verifiedThisTurn) return false;
  const text = Array.isArray(message.content) ? message.content.map((c: any) => c.text || "").join(" ") : "";
  if (!DONE_CLAIM.test(text)) return false;
  state.stats.verificationReminders++;
  return true;
}
