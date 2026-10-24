// The reviewed-turn contract: what the operator asked for, restated for the write gate.

// The prose token: `jev` / `@jev` / `/jev-review` typed inside a sentence.
// Word-boundary guard: `pi-jev-eye` and `jev-eye` must NOT trigger this.
const PROSE_TRIGGER = /(?<![-\w])@?jev(?![\w-])|\/jev-review\b/i;

// The flat trigger: `/eye`.
//
// A TEXT marker, not only a registered command, because pi treats input as a command only when the
// WHOLE text starts with `/`: `Hai, bantu saya /eye` reaches the ordinary prompt path, where this regex
// is the only thing that can see it. The `/eye` command in `commands.ts` re-sends the operator's own
// text — marker included — so both spellings end at this one detection point and no extra state is kept.
// The leading guard keeps `x/eye` out; the trailing one keeps `/eyeline` and `/eye/foo` out.
export const EYE_MARKER = "/eye";
// The trailing guard also refuses a file extension (`/eye.md`) while still allowing the marker to close a
// sentence (`... /eye.`), which is what a prose marker looks like.
export const EYE_TRIGGER = new RegExp(`(?<![\\w/])${EYE_MARKER}(?![\\w/]|\\.[\\w])`, "i");

/** Either spelling opens the reviewed contract. */
export const REVIEW_TRIGGER = new RegExp(`${PROSE_TRIGGER.source}|${EYE_TRIGGER.source}`, "i");

// The injected contract is what makes the reply arrive in the report shape this workflow already uses.
// Deliberately self-contained: the package never reads a skill file, so it works for anyone who installs it.
// The same wording rules also ship inside this package as the `eye-judgment` skill (§6) — change that one too.
export const REVIEW_CONTRACT = [
  "[pi-jev-eye] Reviewed turn contract:",
  "- Language: write in the operator's language (explicit operator instruction > AGENTS.md > prompt language > English fallback); keep code, paths and technical terms verbatim.",
  "- Required report format:",
  "  1. Machine-verified facts first (tool outputs, counts, exit codes; state explicitly if none run; never invent data; use stable IDs e.g. i1, i2). A premise that does not exist — an absent file, an uninstalled command — is itself a machine fact: state it and report nothing about its contents.",
  "  2. One table where every item named anywhere in the report has a row: resolved items plus every open item, even ones only classified by threshold. If an item exists only as a score, add its row. The header spells the scale in plain words in the operator's language — the axis name, its range, and which direction means strong (never a terse `P(ya)`); each cell carries `value (probability)` plus its level label.",
  "  3. Final action column: the last column states the decided action for each row (`DONE` / `BLOCKED` for items already handled — their gate verdicts stay visible there, not in extra prose; `NEXT` for items the threshold says to work next).",
  "  4. Threshold line: state the decision boundary (e.g. `p ≥ 0.85 → <action>`).",
  "  5. Priority conclusion: order open items by priority using the exact IDs already given a row in step 2 (no new analysis, no item that appears only here).",
  "  6. Exactly one confirmation question: ask which item(s) to handle next (`lanjut` / `continue` keeps plan; single question, never a paragraph).",
  "- Every ID in the conclusion MUST repeat an ID visible in the table above it; the reader never scrolls up to resolve a reference.",
  "- No preamble. If nothing needs judgment, state so in one line and still end with the confirmation question.",
  "- Write gate: a write of 10 or more lines in a folder you granted is judged against this turn's request text; anything smaller, or in a folder you did not grant, is not judged.",
].join("\n");
