# Changelog

## [Unreleased]

### Fixed
- **Read-only `/jev-eye usage` footer.** The panel reused the status frame, so it advertised `[Alt+Shift+j] Mode` and `[Ctrl+Shift+g] Grant folder` and acted on those keys, though a spend view has nothing to toggle. It now shows `[Enter] Done  [Esc] Cancel` and ignores the toggle keys.

### Added
- **Compact `/jev-eye usage` panel** that reports **Jev and Clef side by side** in one table: requests, input tokens and cost per backend for the month, three one-line period totals (today / month / all time), and the Clef free-neuron budget with a fill bar and reset time. 22 lines became 18.
- `backendTotals` in `extensions/layer1.ts`: one pass splits a period's provider map into Clef (Cloudflare) and every other Jev provider. It normalizes each entry first, so a partially written record contributes zeros instead of poisoning the sum with `NaN`.
- An **`Earlier`** row appears only when some of the period predates provider attribution, showing exactly how many requests could not be split. Without it the table would look complete while covering a fraction of the month — an error would be invisible.
- **`Usage` entry in the `/jev-eye` menu.** The menu lists `Usage · Jev/Clef spend, per-provider split & free-neuron budget` next to `Status`, opening the same panel as `/jev-eye usage`.
- **Cloudflare Workers AI (Clef) as a third Jev provider.** `/jev-eye login` now offers `Cloudflare Workers AI (Clef)` alongside TypeSafe and OpenRouter. Clef speaks the same System One request shape (`noul` / `choice` / `score`), so the write gate, the reviewed-turn `answers_request` dimension, and per-turn routing all work against it unchanged.
- A Clef credential is an account id plus a Workers AI token: the account id is asked for first (or read from `$CLOUDFLARE_ACCOUNT_ID`), then verified against the real `…/accounts/{id}/ai/run/@cf/cloudflare/clef-flash` route before anything is saved. The model is chosen at login (`clef-flash` — cheapest, the default — or `clef`).
- `clefBody` / `clefError` in `extensions/layer1.ts`: the Workers AI route wraps the answer in `{ result, success, errors }`, and unwrapping it is now a tested pure function instead of an inline assumption.
- `cfRunUrl` / `isCloudflareAccountId`: the account id is validated (32 hex chars) before it reaches a URL, and the account-less base stays safe to commit.
- **`/jev-eye usage` panel.** Separates real spend from the free tier: totals for today / month / all time across both ledgers, a side-by-side Jev vs Clef table, and the Cloudflare Clef block — model in use, neurons spent today against the 10,000/day free allowance, a fill bar, and the overage cost at `$0.011/1,000` neurons once the allowance is used up.
- `clefUsdPerMTok`, `clefNeuronsPerMTok`, `clefNeuronsFor`, `clefBudget`, `neuronsSpentOn` in `extensions/layer1.ts`: the real per-model rates (`clef` 21,818 neurons/M, `clef-flash` 3,455, `clef-omni` 13,636) instead of one flat rate. An unknown model id is charged as the cheaper model, never as free.
- The ledger now records `providers` (a per-provider counter map) and `neurons` as optional fields, so one panel can split Jev from Clef without a second file.

### Changed
- **`/jev-eye status` no longer carries usage.** Spend had two homes after `/jev-eye usage` shipped. Status is now a nine-line live-state view (supervisor, gate key, rules, routing, block counts, context), and the balance lookup moved to `usage` — so status is instant and never waits on a network call.
- Jev providers gained a short name (`short`) for one-line rows: `Cloudflare Workers AI (Clef)` reads as `Clef` in the status line, while the login menu keeps the full label.
- **Discoverability:** `package.json` `description` and `keywords` now name Cloudflare Workers AI, Clef, and `clef-flash`, and the README leads with a keyword line plus a "Why Clef" section — so a search for the Clef backend surfaces this package.
- A stored Cloudflare key without an account id is treated as "not logged in", so the gate says `run /jev-eye login` instead of failing every request. `/jev-eye status` explains the specific case.
- Ledger cost for Clef uses the real per-model rate (`clef-flash` `$0.038/M`, `clef` `$0.24/M`) instead of the generic TypeSafe `$0.042/M` estimate, and the balance line reports free neurons left today.
- `StatusPanel` takes an optional title and description, so `/jev-eye usage` reuses the status frame instead of duplicating it.
- `/jev-eye login` now warns before overwriting when a `$TYPESAFE_API_KEY` / `$OPENROUTER_API_KEY` / `$CLOUDFLARE_API_TOKEN` is already exported and takes precedence.

---

## [0.1.16] - 2026-10-04

### Changed
- `package.json` `description` now leads with the README tagline ("Ultra-lean supervisor. Three-layer guardrails. Semantic gate for Pi.") followed by the capability summary, per the `/arnative-pi` manifest standard — pi.dev/packages renders this field verbatim as the package card description.

---

## [0.1.15] - 2026-10-04

### Fixed
- Reviewed-turn report no longer references items that have no table row. The contract now requires one Jev table covering every named ID (resolved and open) plus a final action column (`DONE` / `BLOCKED` / `NEXT`), so the conclusion never forces the reader to scroll up to resolve an ID.

### Changed
- Refined manifest description in `package.json` to adhere to `/arnative-pi` standard formatting.

---

## [0.1.14] - 2026-09-28

### Added
- Root `CHANGELOG.md` tracking repository releases according to Keep a Changelog standard.
- Added `CHANGELOG.md` to `files` in `package.json`.

---

## [0.1.13] - 2026-09-28

### Changed
- Banner image in `README.md` now uses `<img width="100%" ...>` for responsive edge-to-edge full width rendering.

---

## [0.1.12] - 2026-09-28

### Changed
- Removed obsolete comparison section from `README.md`.
- Aligned Architecture documentation with codebase facts: batched 3-dimension evaluation (`has_slop`, `has_unfinished_todo`, `answers_request`), and added Context Guard details under Model Routing.

---

## [0.1.11] - 2026-09-28

### Added
- Root `LICENSE` file (MIT) so GitHub API and shield badges detect repository license properly.
- Manifest `image` in `package.json` for pi.dev package gallery card preview.
- `npm run dev` script for conflict-free local live testing.

### Changed
- Redesigned `README.md` to follow Arnative structure (outline badges, punchy bullets, collapsible architecture accordion).

---

## [0.1.10] - 2026-09-28

### Added
- One key cycles three supervisor modes (`Alt+Shift+J`): `ON` -> `REVIEW` -> `OFF`.

### Fixed
- Model router restores pre-routing model on `agent_settled` instead of `agent_end`.
- Allow scoped globs (e.g. `/tmp/jev-req*.mjs`) in bash interception.
