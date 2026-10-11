# Changelog

## [Unreleased]

### Changed
- **`/jev-eye status` rows are a table, not sentences.** Every row now reads `Label · status | detail` — `Supervisor ENABLED | Review prompt trigger`, `Scope folders ON | All Folders`, `Gate READY | TypeSafe · jev-latest`, `Rules ACTIVE | …`, `Routing OFF | …`, `Blocked STATS | …`, `Context USED | …` — with the status word coloured by state, so one pass down the left column answers "is it on?".
- **Mode toggle is `Ctrl+Shift+e`** — one shortcut, no alias. `Alt+Shift+J` is gone, and so is `Ctrl+Shift+s`: in the same terminal where `Ctrl+Shift+e` cycles the mode, `Ctrl+Shift+s` produced no event at all, so it was advertised but never arrived. `Ctrl+Shift+e` also has no built-in pi binding, unlike `Ctrl+Shift+g`. Every hint reads from one `KEY_SETS` table, so the footer, the notifications and the shortcut registration cannot drift apart.
- `/jev-eye status` footer advertises `[←] Back` next to `[Ctrl+Shift+s] Supervisor`, and the read-only usage footer does the same.

### Added
- **`/jev-eye` screens now use the Arnative rounded-box template**, and the template itself is the default in the `arnative-pi` skill: title with a description underneath, chosen row in `accentSoft`, `·` dividers in `dim`, keybind legend in brackets (`[Enter] Choose`), and **`[←] Back`** inside extension menus to reopen the previous one.
- **Thinking-adaptive box border.** Every `/jev-eye` screen derives its border from the session's thinking level via `thinkingColorSlot` (`thinkingOff`…`thinkingMax`), and prefers `accentSoft` where the theme defines it. `thinking*` exists in every theme, so a built-in theme no longer loses the frame.
- `[←] Back` in an extension menu returns to the previous menu, while `[Esc]` closes the screen — two different exits, never merged. `/jev-eye`'s root menu reopens after Login, Logout, Status, Usage and Routing leave with `[←]`; the root itself carries no `[←]`, because nothing is behind it.
- `[Home]`/`[End]` jump to the ends of a rounded-box list.

### Changed
- Picker rows are split into a label and a note, and every label is padded to the widest one, so all `·` dividers land in a single column (`Login    ·  …` / `Routing  ·  …`) instead of drifting with the label length.
- Keybind legends follow one style everywhere: explicitly bracketed keys, action capitalized, `dim` paint.
- **Every `/jev-eye` menu is now a rounded box.** The root `/jev-eye` menu, the logout picker, and the Clef model picker were still `ctx.ui.select`, which Pi renders itself with two full-width rules, so no frame could reach them. A shared `pickRow` helper now drives all of them: the rounded box in TUI mode, `ctx.ui.select` over RPC and headless. This is what the earlier frame change missed — the screens it converted were the custom ones, and the menus were not custom.
- `ListPicker` in `extensions/index.ts`: one list component for every menu (title, optional subtitle, pre-styled rows, footer), so a new menu does not re-implement the frame or the key handling.
- **The three `/jev-eye` screens are drawn inside an Arnative box** — `╭───╮ … ╰───╯` with one row per line, matching `/arnative`. The old top-and-bottom dashed rules became a real frame for `login`, `routing`, `status`, and `usage`.
- `boxBorderPainter`, `boxEdge`, `boxRow`, `visibleWidth` in `extensions/layer1.ts`: the frame math is pure (theme `fg` handed in as an argument), so `npm test` covers it without importing `pi-tui`. Border colour probes `accentSoft` once and falls back to `accent`, which is the only token a built-in theme has.
- A row wider than the frame is truncated before it is wrapped, so a styled wide-glyph row still lands exactly on the frame width; a component handed a 1–3 column width degrades instead of shifting the screen.
- Every custom screen (`login` picker, `routing`, `status`, `usage`) now guards on `ctx.mode === "tui"`. In RPC mode `ctx.ui.custom` is a documented no-op that resolves `undefined` without drawing, so the old `typeof ctx.ui.custom === "function"` test passed and then silently did nothing — login was cancelled and status/usage printed a blank panel over RPC.

---

## [0.1.17] - 2026-10-11

### Added
- **Cloudflare Workers AI (Clef) as a third Jev provider.** `/jev-eye login` now offers `Cloudflare Workers AI (Clef)` alongside TypeSafe and OpenRouter. Clef speaks the same System One request shape (`noul` / `choice` / `score`), so the write gate, the reviewed-turn `answers_request` dimension, and per-turn routing all work against it unchanged.
- **Multi-credential auth store and a logout picker.** `auth.json` is now version 2 — a `providers` map keyed by provider id — so TypeSafe, OpenRouter and Clef can stay logged in at the same time. `/jev-eye logout` offers **Jev**, **Clef**, or **All** when several are stored; with one stored it just confirms that one. A v1 single-key file is migrated on first read and the original is kept at `auth.json.v1.bak`.
- **`/jev-eye login` shows what is already stored.** Each provider row carries its state — `✓ stored` in the theme's `success` green, or a dim `• not configured` — read from `auth.json`, so the menu answers "what am I logged in with?" before a key is typed. Choosing a provider then prints its exact key source.
- Logging in now **adds** a credential instead of replacing the file, so switching backend no longer discards the previous key. An empty key is refused rather than overwriting a good credential.
- Keys supplied by the environment are reported by logout (`$TYPESAFE_API_KEY comes from the environment and cannot be removed here.`) because a process cannot unset a variable belonging to its caller.
- A Clef credential is an account id plus a Workers AI token: the account id is asked for first (or read from `$CLOUDFLARE_ACCOUNT_ID`), then verified against the real `…/accounts/{id}/ai/run/@cf/cloudflare/clef-flash` route before anything is saved. The model is chosen at login (`clef-flash` — cheapest, the default — or `clef`).
- **Compact `/jev-eye usage` panel** that reports **Jev and Clef side by side**: requests, input tokens and cost per backend for the month, three one-line period totals (today / month / all time), and the Clef free-neuron budget — model in use, neurons spent today against the 10,000/day free allowance, a fill bar, the reset time, and the `$0.011/1,000` neuron overage once it runs out. Real spend is separated from the free tier in 18 lines instead of 22.
- **`Usage` entry in the `/jev-eye` menu.** The menu lists `Usage · Jev/Clef spend, per-provider split & free-neuron budget` next to `Status`, opening the same panel as `/jev-eye usage`.
- An **`Earlier`** row appears only when some of the period predates provider attribution, showing exactly how many requests could not be split. Without it the table would look complete while covering a fraction of the month — an error would be invisible.
- `migrateAuthStore`, `putCredential`, `removeCredentials`, `storedProviderIds` in `extensions/layer1.ts`: the store folds are pure and covered by `npm test`.
- `backendTotals` in `extensions/layer1.ts`: one pass splits a period's provider map into Clef (Cloudflare) and every other Jev provider. It normalizes each entry first, so a partially written record contributes zeros instead of poisoning the sum with `NaN`.
- `clefBody` / `clefError` in `extensions/layer1.ts`: the Workers AI route wraps the answer in `{ result, success, errors }`, and unwrapping it is now a tested pure function instead of an inline assumption.
- `cfRunUrl` / `isCloudflareAccountId`: the account id is validated (32 hex chars) before it reaches a URL, and the account-less base stays safe to commit.
- `clefUsdPerMTok`, `clefNeuronsPerMTok`, `clefNeuronsFor`, `clefBudget`, `neuronsSpentOn` in `extensions/layer1.ts`: the real per-model rates (`clef` 21,818 neurons/M, `clef-flash` 3,455, `clef-omni` 13,636) instead of one flat rate. An unknown model id is charged as the cheaper model, never as free.
- The ledger now records `providers` (a per-provider counter map) and `neurons` as optional fields, so one panel can split Jev from Clef without a second file.

### Changed
- **The login picker renders the key-source tip live.** `ctx.ui.select` paints one fixed string per row, so the tip could not follow the cursor and sat in the list as dead filler. The menu is now a small custom component (`LoginPicker`) that re-renders on every move and shows the highlighted provider's key source and environment fallback underneath the list. Headless and RPC sessions, which have no `custom` UI, keep the plain select with the same rows. The store is re-read after the picker closes, so a key added elsewhere mid-flow is still counted when deciding which backends stayed logged in.
- **`/jev-eye status` no longer carries usage.** Spend had two homes after `/jev-eye usage` shipped. Status is now a nine-line live-state view (supervisor, gate key, rules, routing, block counts, context), and the balance lookup moved to `usage` — so status is instant and never waits on a network call.
- **Discoverability:** `package.json` `description` and `keywords` now name Cloudflare Workers AI, Clef, and `clef-flash`, and the README leads with a keyword line plus a "Why Clef" section — so a search for the Clef backend surfaces this package.
- Jev providers gained a short name (`short`) for one-line rows: `Cloudflare Workers AI (Clef)` reads as `Clef` in the status line, while the login menu keeps the full label.
- A stored Cloudflare key without an account id is treated as "not logged in", so the gate says `run /jev-eye login` instead of failing every request. `/jev-eye status` explains the specific case.
- Ledger cost for Clef uses the real per-model rate (`clef-flash` `$0.038/M`, `clef` `$0.24/M`) instead of the generic TypeSafe `$0.042/M` estimate, and the balance line reports free neurons left today.
- `StatusPanel` takes an optional title and description, so `/jev-eye usage` reuses the status frame instead of duplicating it.
- `/jev-eye login` now warns before overwriting when a `$TYPESAFE_API_KEY` / `$OPENROUTER_API_KEY` / `$CLOUDFLARE_API_TOKEN` is already exported and takes precedence.

### Fixed
- **Read-only `/jev-eye usage` footer.** The panel reused the status frame, so it advertised `[Alt+Shift+j] Mode` and `[Ctrl+Shift+g] Grant folder` and acted on those keys, though a spend view has nothing to toggle. It now shows `[Enter] Done  [Esc] Cancel` and ignores the toggle keys.

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
