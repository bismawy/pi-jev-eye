---
name: eye-judgment
description: 'Calibrated judgment workflow using Jev (TypeSafe) via HTTP `POST /v1/systemone` — triage, classification, ranking, rubric scoring, A/B comparison, and probability estimation. Use when a task needs a DECISION or judgment as a number (not prose), when scoring many items at once, when comparing two options, or when answers must be repeatable and comparable across runs. Ships with pi-jev-eye; needs a Jev key stored via /jev-eye accounts.'

metadata:
  keywords:
    - eye
    - pi-jev-eye
    - jev
    - typesafe
    - calibration
    - judgment
    - triage
    - classification
    - ranking
    - rubric
    - probability
    - score
    - calibrated judgment

license: MIT
---

# Eye Judgment

Eye = the judgment surface of pi-jev-eye: typed questions in, calibrated numbers out, whichever decision backend answers. The reference engine is **Jev (TypeSafe)** — send **state + typed questions**, receive **probabilities/positions**, not prose. ~0.2–0.4 seconds per request; all questions in 1 request run in parallel.

## 0. How to call Jev

Call Jev **directly via HTTP**, the same route the pi-jev-eye gate uses: `POST https://api.typesafe.ai/v1/systemone`, body `{ model, state, questions }`, header `Authorization: Bearer <key>`.

- Model: `jev-latest` (verified 2026-09-22: HTTP 200, reply `model: jev-1.13.0`).
- Key, lookup order: `$TYPESAFE_API_KEY` → `$OPENROUTER_API_KEY` → `~/.pi/agent/pi-jev-eye/auth.json` (written by `/jev-eye accounts`).
- **auth.json shape (v2, verified 2026-10-11):** the key lives at **`providers.typesafe.apiKey`**, not at root `apiKey`. The old format (root `apiKey`) is still read as a fallback. Reading root only → **HTTP 401**, with no message explaining why — so the snippet below reads `providers.typesafe.apiKey` first.
- **Never** print the key to chat/reports, and **never** put secrets in `state`.

Minimal snippet (key read from file, never shown):

```bash
node -e '
const fs=require("fs"),os=require("os"),home=os.homedir();
const read=p=>{try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch{return null}};
const a=read(home+"/.pi/agent/pi-jev-eye/auth.json");
const key=process.env.TYPESAFE_API_KEY??process.env.OPENROUTER_API_KEY??a?.providers?.typesafe?.apiKey??a?.apiKey;
if(!key){console.error("No key: store one via /jev-eye accounts");process.exit(1)}
fetch("https://api.typesafe.ai/v1/systemone",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},
body:JSON.stringify({model:"jev-latest",state:{},questions:{q:{type:"noul",instructions:"…"}}})}).then(r=>r.json()).then(j=>console.log(j.model,JSON.stringify(j.answers)))'
```

Cost/usage of the extension itself: `/jev-eye usage` (ledger `~/.pi/agent/pi-jev-eye/usage.json`). Measured: 1 request with 24 questions = 3,448 input tokens ≈ $0.00014; 1-question probe = 287 tokens ≈ $0.00001.

## 0b. How to invoke this skill

| Command | Behavior |
| :--- | :--- |
| `/skill:eye-judgment <task>` | **Most reliable way.** This file's body is injected directly as a user message (pi reads `SKILL.md`, strips the frontmatter, wraps it in a `<skill>` block), with your arguments appended after it. No extra tool call |
| Plain request in chat | Runs only **if the model chooses** to read the skill from the description list in the system prompt. Fast/cheap models often skip it — do not rely on this when you need a guaranteed result |

## 1. Use when / do not use when

| Use | Do not use |
| :--- | :--- |
| Scoring many items at once (retire your own judgment) | Arithmetic, exact lookup, date math |
| Triage, classification, picking one of several categories | Tasks that need step-by-step / multi-hop reasoning |
| Scoring against an already-written rubric | A single question that mixes several judgments |
| Comparing two options (A/B) | Deciding whether an action is allowed (that is the user's call) |
| The same question repeated many times (per file, per ticket, per row) | Judging whether your own answer is correct — Jev is not your supervisor |

Main reason: Jev is **not smarter than the main model** — it is **better calibrated, cheaper, and faster** when the same question repeats many times. If there is only one question, used once, answer it directly.

## 2. Hard limits — the most common cause of failure

- **20 gate requests per session.** That is the `pi-jev-eye` budget gate (its counter lives in the package, reset at session start); manual HTTP calls are not counted, but stay frugal. Therefore: **one request with many questions**, not many requests with one question each. Burning 20 requests on 20 items = failing midway.
- **32 questions per request**, **64 KiB JSON** per request.
  - **Batch capacity formula:** `item × dimension ≤ 32`. Example: 10 items × 3 dimensions = 30 questions (1 request); 8 items × 4 dimensions = 32 questions (1 request). Collect all items first, evaluate them together in 1 request.
- **No automatic retry.** Timeout 15 seconds. A failed request counts as an attempt → do not spam attempts.
- On **meaning**: `score`/`choice` return `probabilities` per level/category + `confidence`. `noul` returns `P(yes)`.

## 3. Correct request shape

Question-writing rules — this is the whole program; ambiguity shows up as mediocre probabilities, not errors:

1. **Pruning State (Signal-over-Noise):** Send only essential fields (`title`, `body_summary`, `error_snippet`, `repro_step`). Remove noisy metadata (internal UUIDs, raw HTML/CSS, long timestamps, session tokens, repeated stack traces). A clean state raises calibration accuracy (the model is not distracted by noise), cuts latency (<0.3s), and guarantees you stay under the 64 KiB limit.
2. **Pick the right question type:**
   - **`noul`**: Sharpest and cheapest for binary yes/no (`is_blocking`, `is_duplicate`, `is_reproducible`).
   - **`choice`**: Discrete classification. Always provide a no-match option (`other` / `unclear`).
   - **`score`**: Graded scale with 3–5 concrete-situation levels.
3. **Ask what the state says, not what you infer.** Bad: `"Is the bug reproducible from the text?"` (could mean "the reader can reproduce it"). Good: `"Does the reporter state the problem happens consistently?"`
4. **Score levels = checkable situations, not degrees.** Bad: `"medium"`. Good: `"Workaround exists"`. Use 3–5 ordered levels so probabilities stay dense, not diluted.
5. **Choice must have a no-match option** (`other` / `unclear`) if nothing might fit — the model cannot pick an option you did not list.
6. **One judgment per question.** Split independent dimensions, then batch them in one request (parallel & mutually invisible).
7. **Name state fields and reference them in the instructions** with backticks (`` `r1.body` ``) when the state has many parts. Required for multi-item cases.
8. **Send only data that is relevant & allowed to be sent.** Never include secrets/credentials. This tool sends to `api.typesafe.ai`.

Multi-item pattern (most common case):

```json
{
  "state": {
    "r1": { "title": "Login fails after update", "body": "..." },
    "r2": { "title": "Layout shifts in Safari", "body": "..." }
  },
  "questions": {
    "r1_area":   { "type": "choice", "instructions": "Which area does `r1` highlight?", "criteria": { "auth": "Sign-in/account", "ui": "Layout", "other": "Nothing fits" } },
    "r1_dup":    { "type": "noul",   "instructions": "Does `r1` report the same defect as `known_issue`?" },
    "r1_sev":    { "type": "score",  "instructions": "How severe is the defect in `r1`?", "criteria": ["Cosmetic", "Workaround exists", "Blocking"] },
    "r2_area":   { "type": "choice", "instructions": "Which area does `r2` highlight?", "criteria": { "auth": "Sign-in/account", "ui": "Layout", "other": "Nothing fits" } }
  }
}
```

One item = one question **per dimension**. Never one question that scores all items — the result is an unusable mix.

## 4. Machine verification first, Jev judges after

Jev **verifies nothing** — it judges what you send. So before any request, first collect the facts tools can check (grep/count/pdftotext/extract), then send those facts to Jev as `state`.

Consequence: **never** present a Jev score as a factual claim. The output block for facts and the output block for judgments must be physically separate (see §6).

Example: `grep -c "Photoshop"` = 0 → that is a machine fact; "ID design ad mismatch = 2.0" → that is a Jev judgment. Both are valuable, but they must not be mixed in one table.

## 5. Scale & legend

**Default display scale: 1–5, one decimal.** To avoid post-hoc conversion, write `score` rubrics with **5 ordered levels** — the returned score lands directly on 1–5.

- If the number of levels is not 5, state the conversion explicitly in the header (e.g. "converted to 1–5 scale") and do not change it mid-series.
- **Scale direction must be explicit from the dimension name: higher = better.** Bad: `Risk of ID↔EN language mismatch`. Good: `Safe from ID↔EN language mismatch`. A name with ambiguous direction makes the whole table misread.
- Each level label must be a checkable situation, not a degree (`"Workaround exists"` ✓, `"medium"` ✗).
- Keep the same level list across runs; otherwise Before/After is not comparable.

## 6. Output format

The report format follows the **official contract of the `pi-jev-eye` package** (`extensions/review.ts` → `REVIEW_CONTRACT`), which is also injected automatically on every *reviewed turn*. If this skill and the contract differ, **the package contract wins** — do not re-copy its contents here.

Required skeleton, language follows the user's language: **machine-fact block → one Jev table → threshold line → conclusion + exactly one confirmation question**.

```text
| Item | <Dimension A> (0–1 · higher = stronger signal) | <Dimension B> (0–1 · higher = stronger signal) | Action |
| :--- | :--- | :--- | :--- |
| i1. <done item> | yes (0.92) | yes (0.84) / no (0.16) | DONE |
| i8. <open item> | yes (0.74) | yes (0.51) | NEXT |

Threshold: p ≥ 0.85 → <action> · p < 0.5 → <action>
**Conclusion:** <fixes still to be done, same IDs as the fact block>
**Confirmation:** <exactly one question>
```

**One table for all items (MUST).** The table lists **every** ID named in the report — both finished ones (`DONE` / `BLOCKED`, their gate verdict stays in the Action column, not extra prose) and open ones. An item that appears only as a number in the conclusion without its own row = violation: the reader has to scroll up for context. Before printing, test: every ID in `Conclusion` already has its row in the table above it.

Content rules (also apply outside reviewed turns):
- **Machine facts**: `✅` met · `△` note · `❌` failed — always plus a concrete number, no opinion.
- **Choice**: `<option> (<p>)`; if split: `<option1> (<p1>) / <option2> (<p2>)`.
- **Noul**: `yes (<p>)` / `no (<p>)`.
- **Score**: `<score> – <level label>` (optionally `(confidence <c>)` when extreme).
- **Re-run**: add a `| Dimension | Before | After |` table; the level scale does not change mid-series.
- **No extra prose**: no long explanatory paragraph under the table unless requested or there is a fatal anomaly.

### Reporting rules
- **Adaptive language (MUST)**: Headers, columns, and Noul labels (`yes`/`no` and their equivalents) automatically follow the user's conversation language (precedence: explicit user instruction > AGENTS.md > request language > fallback EN). Technical identifiers, code, and paths stay as-is.
- **Machine facts without fabrication (MUST)**: Print tool output, counts, and exit codes. State explicitly if no machine verification was run; never invent tool runs or numbers. Use stable IDs (`i1`, `i2`, etc.).
- **Take action via numeric thresholds (deterministic)**: Do not write speculative prose about "what should be done". Use numeric threshold rules when the workflow needs automatic follow-up (example: `Severity > 1.4 AND Consistent > 0.8` → action `P0`).
- Always **number + probability/confidence**. Do not translate them into words ("likely", "maybe").
- `confidence` = how concentrated the distribution is, **not** proof of correctness.
- Strictly separate: **what Jev says** vs **what your interpretation is**.
- Terse & to the point: prefer tables, drop opening/closing filler.
- **Scale & units readable in the header (MUST)**: every numeric column writes **axis name + range + direction** in plain words in the user's language, not abbreviations. `P(yes)` is unreadable for non-technical readers (Jev: yes 0.28) — example form (EN): `Chance of a "yes" answer (0–1) · higher = stronger signal`. The yes/no words follow the user's language, not locked to one language.
- **Concise (MUST)**: no long-winded openings/closings. One fact block + one judgment table; if nothing needs judging, write one line and still close with one confirmation question. Get the data from tools/LLM first, then Jev judges briefly.
- **Never print a bare `P <number>` (MUST)**: Noul is always `yes (<p>)` / `no (<p>)`; if the result is in the middle, `yes (0.62) / no (0.38)`.
- **1-line legend for general audiences**: as soon as the report contains the terms `Noul`/`Choice`/`Score`/`p`/`confidence`, put it right under the table title — not prose: `Legend: Noul = yes/no question · p = chance of the answer (0–1) · Score 1–5 (higher = better)`.
- **Decision threshold printed once**: if numbers are used to decide, write a `Threshold: p ≥ X → <action>` line so non-technical readers know which numbers count as strong. Without a threshold, the numbers cannot be read.
- **Conclusion + confirmation (MUST)**: right after the table and threshold line, close with one short conclusion block — fixes still to be done, in priority order, using the same IDs from the fact block **and from the table above it** (no new analysis, no items that appear only here) — then **exactly one** confirmation question to the user, e.g. `Do i1 + i2 now, or pick something else?`. This is the only allowed closing: never close the report without that confirmation question.
- **Machine verification stays as raw numbers**: a level label does not replace the number, and the number does not replace the level label — print both side by side.

## 7. Checklist before sending a request

- [ ] Facts tools can check **have been** collected and put in state (not handed to Jev to "check").
- [ ] The answer really needs judgment, not counting/lookup.
- [ ] **State has been pruned:** contains only high-signal text (no UUIDs, raw HTML/CSS, or repeated logs).
- [ ] All independent questions are merged into **one** request (`item × dimension ≤ 32`).
- [ ] Each item in a multi-item case has a named field + that field is referenced in the instructions.
- [ ] Choice has a no-match option; Score uses 3–5 concrete-situation levels.
- [ ] Dimension names: higher = better, no ambiguous direction.
- [ ] Scale legend written & identical to the previous run.
- [ ] No secrets inside `state`.
- [ ] Frugal: manual HTTP calls are not counted by the `pi-jev-eye` gate, but still collect all items into one request.
