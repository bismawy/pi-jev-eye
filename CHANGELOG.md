# Changelog

## [Unreleased]

### Added
- **Cloudflare Workers AI (Clef) as a third Jev provider.** `/jev-eye login` now offers `Cloudflare Workers AI (Clef)` alongside TypeSafe and OpenRouter. Clef speaks the same System One request shape (`noul` / `choice` / `score`), so the write gate, the reviewed-turn `answers_request` dimension, and per-turn routing all work against it unchanged.
- A Clef credential is an account id plus a Workers AI token: the account id is asked for first (or read from `$CLOUDFLARE_ACCOUNT_ID`), then verified against the real `…/accounts/{id}/ai/run/@cf/cloudflare/clef-flash` route before anything is saved. The model is chosen at login (`clef-flash` — cheapest, the default — or `clef`).
- `clefBody` / `clefError` in `extensions/layer1.ts`: the Workers AI route wraps the answer in `{ result, success, errors }`, and unwrapping it is now a tested pure function instead of an inline assumption.
- `cfRunUrl` / `isCloudflareAccountId`: the account id is validated (32 hex chars) before it reaches a URL, and the account-less base stays safe to commit.

### Changed
- A stored Cloudflare key without an account id is treated as "not logged in", so the gate says `run /jev-eye login` instead of failing every request. `/jev-eye status` explains the specific case.
- Ledger cost for Clef uses the real `$0.24/M` input rate instead of the generic TypeSafe estimate.
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
