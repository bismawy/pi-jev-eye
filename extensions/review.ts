// The reviewed-turn contract: what the operator asked for, restated for the write gate.

// Word-boundary guard: `pi-jev-eye` and `jev-eye` must NOT trigger this.
export const REVIEW_TRIGGER = /(?<![-\w])@?jev(?![\w-])|\/jev-review\b/i;

// The injected contract is what makes the reply arrive in the report shape this workflow already uses.
// Deliberately self-contained: the package never reads a skill file, so it works for anyone who installs it.
// The same wording rules also live in ~/.pi/agent/skills/arnative-jev (section 6) — change that one too.
export const REVIEW_CONTRACT = [
  "[pi-jev-eye] Reviewed turn contract:",
  "- Language precedence: explicit operator instruction > AGENTS.md > prompt language > English fallback (preserve code, paths, and technical terms verbatim).",
  "- Required report format:",
  "  1. Machine-verified facts first (tool outputs, counts, exit codes; state explicitly if none run; never invent data; use stable IDs e.g. i1, i2).",
  "  2. One Jev table where every item named anywhere in the report has a row: resolved items plus every open item, even ones only classified by threshold. If an item exists only as a score, add its row. Header spells scale in plain words (never terse `P(ya)` — ID `Peluang jawaban \"ya\" (0-1) · tinggi = sinyal kuat`, EN `Chance the answer is \"yes\" (0-1) · higher = stronger`, ZH `回答\"是\"的概率 (0-1) · 越高越强`); each cell carries `value (probability)` plus its level label.",
  "  3. Final action column: the last column states the decided action for each row (`DONE` / `BLOCKED` for items already handled — their gate verdicts stay visible there, not in extra prose; `NEXT` for items the threshold says to work next).",
  "  4. Threshold line: state decision boundary (e.g. `Ambang: p ≥ 0.85 → <aksi>`).",
  "  5. Priority conclusion: order open items by priority using the exact IDs already given a row in step 2 (no new analysis, no item that appears only here).",
  "  6. Exactly one confirmation question: ask which item(s) to handle next (`lanjut` / `continue` keeps plan; single question, never a paragraph).",
  "- Every ID in the conclusion MUST repeat an ID visible in the table above it; the reader never scrolls up to resolve a reference.",
  "- No preamble. If nothing needs judgment, state so in one line and still end with the confirmation question.",
  "- Write gate: code edits will be evaluated against this turn's request text.",
].join("\n");
