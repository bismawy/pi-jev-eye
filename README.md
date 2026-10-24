# Jev Eye

Ultra-lean supervisor. Three-layer guardrails. Semantic gate for Pi.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-jev-eye)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-jev-eye.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-jev-eye)
[![license](https://shieldcn.dev/github/bismawy/pi-jev-eye/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-jev-eye)

<img src="https://raw.githubusercontent.com/bismawy/pi-jev-eye/main/assets/banner.webp" alt="Jev Eye: three-layer supervisor, regex guardrails, and TypeSafe Jev semantic gate" width="100%">
- **Accounts / Models / Status / Usage / Routing (`/jev-eye`):** `Accounts` stores and removes credentials, `Models` chooses which backend answers every Jev/Clef call and which one takes over when it cannot.
- **Pick the active backend and its fallback (`/jev-eye models`):** One list of every backend this session can call — TypeSafe `jev-latest`, OpenRouter `typesafe/jev-1.13`, and each Clef model by tier (`clef`, `clef (flash)`) — with `[Space]` making the highlighted row the active backend and `[Ctrl+f]` its fallback. Routing and the write gate both call the same chain, so a stalled or rate-limited primary costs one timeout instead of losing the judgment.
- **Failover, counted not guessed:** The active backend answers first; the fallback is tried only after a non-OK response, a rejected envelope, a timeout, or a network error. `/jev-eye status` reports how many calls needed it. A ref the catalog no longer lists reads as unset — a stale `backends.json` cannot aim the gate at a route this build cannot build.
- **A Clef model list straight from Cloudflare:** the extension asks the account's model-discovery route once per session and caches it, so a `clef-*` model published later appears in `Models` without a package release. If the request fails, the shipped list answers.
- **The footer names the backend that is judging your writes:** the cell leads with U+F21B and the state marker is `●` for ON and REVIEW (accent, or amber for REVIEW) and `○` for OFF. `Eye: ● ON (Clef Flash)` when a Clef model answers, and `Eye: ● ON (Jev)` when TypeSafe or OpenRouter does — they are the same decision backend, so they share one word. The backend suffix is dimmed while `Eye:` and the state keep their tiers, so one cell answers "is the supervisor on?" and "which model is judging my writes?" at a glance. The name comes from the active backend, not a literal.
- **Per-Turn Model Routing:** Routes light chores (git commit, push, status) to a fast model and complex engineering tasks to a heavy model with independent reasoning controls.

## Overview

pi-jev-eye is an ultra-lean, zero-dependency supervisor for [pi](https://github.com/earendil-works/pi-coding-agent). It protects your workspace from destructive commands, prevents credential leaks, enforces testing verification, routes models per-turn, and runs a semantic gate through [TypeSafe Jev](https://typesafe.ai/), OpenRouter, or [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/clef/) (Clef) to catch code slop before disk writes.

- **Instant Regex Gate:** 0 ms, 0 token barrier blocking wipes (`rm -rf /`, `DROP DATABASE`), protected branch force-pushes, and hardcoded secrets (`sk-...`, `ghp_...`, SSH keys).
- **Done-Check Verification:** Warns when the agent claims done after editing files without running verification suites (`npm test`, `cargo test`, `pytest`).
- **Targeted Jev Semantic Gate:** Evaluates diffs ≥ 10 lines via TypeSafe Jev (`has_slop`) to reject placeholder stubs and unfulfilled TODOs.
- **Three Decision Backends:** TypeSafe Jev, OpenRouter, or **Cloudflare Workers AI (Clef / `clef-flash`)** — same gated pipeline, with the active one chosen in `/jev-eye models`. Clef runs inside Cloudflare's free daily allowance of 10,000 neurons, so the gate costs nothing for most sessions.
- **Jev + Clef Usage Panel (`/jev-eye usage`):** One compact table shows Jev and Clef side by side (requests, input tokens, cost for the month), three period totals, and the Cloudflare free-neuron budget with its reset time and overage cost. Periods that predate the split are reported as an explicit `Earlier` row rather than silently dropping out of the table.
- **Reviewed Turns (`jev` / `@jev` / `/eye`):** Calibrated review contract with machine facts, Jev scoring tables, and single-flight prompt alignment (`answers_request`). The flat `/eye <task>` form opens it without a prose token; so does writing `/eye` inside a sentence, because the marker is read from the prompt text and not only from the command.
- **Shipped skill (`/skill:eye-judgment`):** The calibrated judgment workflow travels inside the package as a Pi skill — every install gets it, no separate download. Backend-agnostic in name (the package carries Jev, Clef, and whatever comes next), Jev-taught in method: the request recipe (`POST /v1/systemone`), the batching limits (≤ 32 questions per request), and the question-writing rules for triage, ranking, rubric scoring, A/B comparison, and probability estimation.
- **Fail-Open Reliability:** Network timeouts or offline provider APIs gracefully degrade so coding sessions never stall or freeze.
- **Account Management in Place:** One Accounts screen lists every backend with its stored state — `[Enter]` stores a key, `[Ctrl+d]` removes one after a second confirming press, so switching backends never requires a separate logout menu.
- **Rounded Arnative Screens:** Every `/jev-eye` screen — menu, accounts, models, status, usage, routing, the key prompt, and the confirm dialog — draws inside one rounded frame with a soft-accent border derived from the live theme, a bold soft-accent chosen row, a padded `·` column, and a footer that advertises only the keys it handles.

## Install

```bash
pi install npm:@bismawy/pi-jev-eye
```

Supply your Jev API key via `/jev-eye accounts` (TypeSafe, OpenRouter, or Cloudflare Workers AI), or export `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`. For Cloudflare Clef, export `CLOUDFLARE_ACCOUNT_ID` **and** `CLOUDFLARE_API_TOKEN` — a token alone cannot build the account-scoped route.

Credentials you store live side by side: `~/.pi/agent/pi-jev-eye/auth.json` (mode 0600) holds one entry per provider, so logging in with Clef no longer discards a stored TypeSafe key. `/jev-eye accounts` opens the Accounts screen, where `[Ctrl+d]` removes the highlighted backend. A credential that comes from the environment is reported but never deleted — a process cannot unset a variable it does not own.

Which backend answers is a separate choice from which keys exist: `/jev-eye models` writes `~/.pi/agent/pi-jev-eye/backends.json` (`{ "primary": "cloudflare:clef-flash", "fallback": "typesafe:jev-latest" }`). Either slot may be empty, in which case the credential precedence above applies. The fallback is called only after the active backend fails outright — a non-OK response, a rejected envelope, a timeout, or a network error — and `/jev-eye status` counts how often that happened.

The per-session caps default to 20 gate requests and 20 routing classifications. Set PI_JEV_EYE_MAX_REQUESTS or PI_JEV_EYE_MAX_ROUTING_CALLS to a positive integer before starting Pi to change them; any other value keeps 20.

To test locally without installing:
```bash
pi -e ./extensions/index.ts
```

## Shortcuts & Commands

| Trigger | Scope | Action |
| --- | --- | --- |
| `ctrl+alt+e` | Keybinding | Cycle supervisor mode: **ON** → **REVIEW** → **OFF** |
| `ctrl+alt+u` | Keybinding | Cycle Jev folder gate: **Enable all** → **This folder** → **Disabled** |
| `/jev-eye` | Global | Interactive menu: Accounts, Models, Status, Usage, Routing |
| `/jev-eye accounts` | Setup | The Accounts screen: authenticate with TypeSafe, OpenRouter, or Cloudflare Workers AI (Clef) against the live route (mode 0600), and remove the highlighted stored key with `[Ctrl+d]` (press twice) |
| `/jev-eye models` | Setup | The Models screen: `[Space]` makes the highlighted backend the **active** one, `[Ctrl+f]` its **fallback**, saved to `backends.json` |
| `/jev-eye status` | Inspect | Live state: supervisor, active backend and its fallback, gate scope, rules, routing, block counts. Spend lives in `usage` |
| `/jev-eye usage` | Inspect | Spend breakdown: Jev vs Clef side by side, period totals, and the Cloudflare free-neuron budget |
| `/jev-eye routing` | Routing | Interactive TUI model router for light and heavy task slots (`routing light` / `routing heavy` open it focused, `routing on` / `routing off` flip it) |
| `jev` · `@jev` in prompt | Prompt | Trigger calibrated review format and task alignment check |
| `/eye <task>` | Prompt | Flat trigger: opens the same reviewed contract for that turn (the `/eye` is stripped, the task is answered normally) |
| `/eye` inside a prompt | Prompt | The same marker mid-sentence (`Hai, bantu saya /eye`) — pi only treats input as a command when the whole text starts with `/`, so the inline form reaches the review path too |
| `/skill:eye-judgment <task>` | Skill | Force-inject the shipped judgment workflow: the Jev HTTP recipe, batching limits, and question-writing rules for triage, ranking, rubric scoring, A/B, and probability tasks |

### The shipped skill

Installing the package installs the `eye-judgment` skill with it (pi discovers `skills/` in the package the
same way it discovers `extensions/`). The skill body is injected as a user message when invoked, so the
agent follows the exact request shape instead of guessing: one request with many questions
(`item × dimension ≤ 32`), pruned state, machine facts collected first, and the report format deferred to
the package's own `REVIEW_CONTRACT`. The description alone also routes judgment-shaped requests to it —
but a fast model may skip that, so `/skill:eye-judgment` is the guaranteed path.

### Providers

| Provider | Credential | Model | Cost |
| --- | --- | --- | --- |
| TypeSafe | `$TYPESAFE_API_KEY` or `/jev-eye accounts` | `jev-latest` | Per-token, ledger-based |
| OpenRouter | `$OPENROUTER_API_KEY` or `/jev-eye accounts` | `typesafe/jev-1.13` | Reported by the provider |
| Cloudflare Workers AI | `$CLOUDFLARE_ACCOUNT_ID` + `$CLOUDFLARE_API_TOKEN`, or `/jev-eye accounts` (asks for both) | `clef-flash` (default) or `clef` | Clef: $0.24/M input; clef-flash: $0.038/M input; output free; 10,000 free neurons/day at 00:00 UTC |

Which one is active is a choice, not a login side effect: the store keeps every key you have, and
`/jev-eye models` decides which one answers — with a fallback behind it for the turns where the active
backend cannot reply at all. The Clef model list is read from Cloudflare's model-discovery route once per
session, so a model published upstream (e.g. `clef-omni`) is selectable without a package release.

### Why Clef

Clef is Cloudflare's decision model (`@cf/cloudflare/clef`). It answers the same typed System One questions the gate already asks (`noul` / `choice` / `score`), so switching the backend changes no gate logic — only the route and the credential. Two properties make it the cheapest way to run the gate per write:

- **Free for normal sessions.** Every account gets 10,000 neurons per day, reset at 00:00 UTC. `clef-flash` bills 3,455 neurons per million input tokens, so a typical session stays inside the allowance; `/jev-eye usage` shows the exact figure and the overage cost (`$0.011/1,000` neurons) once it does not.
- **No output-token billing.** Clef charges input tokens only, so its cost is a function of the diff you send, not of the model's reasoning length.

The credential is the account id **plus** a Workers AI token (`Workers AI: Read`) — a token alone cannot build the account-scoped route. The account id is checked as 32 hex characters and the credential is probed against the real run route before anything is saved.

The Cloudflare route is `…/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash`; the account id is validated (32 hex chars) and the credential is probed against that exact route before it is saved. Clef interprets the same typed questions (`noul` / `choice` / `score`), so no gate logic changes per provider.

> **Notes:**
> - **pi-arnative status bar:** Shows the real-time mode and the active backend: `Eye: ● ON (Clef Flash)` / `Eye: ● REVIEW (Jev)` / `Eye: ○ OFF (Jev)`. The suffix follows `/jev-eye models`, so it changes without a reload.
> - **Why these chords:** `ctrl+alt+<letter>` is the portable shape. Legacy terminals send it as an ESC-prefixed ctrl code, the kitty protocol as a CSI-u sequence, and pi's parser accepts both. Ghostty binds no `ctrl+alt+<letter>` (its chords are `ctrl+alt+<arrow>` and `ctrl+alt+shift+j`), foot binds none, and pi binds only `ctrl+alt+]`. `ctrl+shift+<letter>` is the shape this package left behind: Ghostty owns `ctrl+shift+e` (`new_split:down`) and `ctrl+shift+t` (`new_tab`), and macOS maps Cmd+Shift+letter to `super+shift`. A terminal without the kitty protocol also reports a shifted chord as the plain ctrl code — `ctrl+shift+t` then never matches at all, which is the bug it looks like it has.

### Modes

```
Ctrl+Alt+E ──► ON ──► REVIEW ──► OFF ──┐
                 ▲                     │
                 └─────────────────────┘
```

| Mode | Footer | Regex & Done-Check | Jev Semantic Gate | Review Contract | When Review Triggers |
| --- | --- | --- | --- | --- | --- |
| **ON** | `Eye: ● ON (…)` | Active | Active (diffs ≥ 10 lines) | Optional | Only when the prompt contains `jev` / `@jev` / `/eye` |
| **REVIEW** | `Eye: ● REVIEW (…)` | Active | Active (diffs ≥ 10 lines) | Injected every turn | Every prompt automatically |
| **OFF** | `Eye: ○ OFF (…)` | Disabled | Disabled | Disabled | Never |

## Architecture

<details>
<summary><b>Three-Layer Guardrails</b></summary>

```
Agent Action (tool_call / message_end)
       │
       ▼
[Layer 1: Local Regex Gate]     ──► rm -rf / force-push / secret? ──► [BLOCKED INSTANTLY] (0 ms, 0 token)
       │ (Safe)
       ▼
[Layer 2: Done-Check Tracker]   ──► Files modified but claims done without test? ──► [WARNING NOTICE] (0 token)
       │ (Passed)
       ▼
[Layer 3: Jev Semantic Gate]    ──► New code diff ≥ 10 lines? ──► [JEV SLOP EVAL] (P ≥ 0.85 blocked)
```

- **Layer 1 (`extensions/layer1.ts`):** Pre-execution regex filter. Blocks destructive bash wipes (`rm -rf /`, `rm -rf $HOME`, `git reset --hard`, `DROP DATABASE`, `mkfs`), protected branch force-pushes (`main`/`master`, while safely permitting `--force-with-lease`), and secret leaks (`sk-...`, `ghp_...`, `AIza...`, private SSH keys).
- **Layer 2:** Turn monitor. Tracks file modifications during a turn and prompts the agent if it declares completion without invoking recognized test suites (`npm test`, `pnpm test`, `bun test`, `cargo test`, `cargo check`, `pytest`, `mypy`, `ruff`, `go test`, `vitest`).
- **Layer 3:** Post-generation gate. Submits code diffs ≥ 10 lines in opt-in folders to TypeSafe Jev as a single batch request (`has_slop`, `has_unfinished_todo`, and prompt alignment `answers_request` on reviewed turns). Blocks when `p ≥ 0.85` with actionable diagnostics.

</details>

<details>
<summary><b>Model Routing</b></summary>

Run `/jev-eye routing` to open the interactive model selector:

- **Light Model:** Routine chores (`status`, `commit`, `push`, `log`, `diff`) route to the light model with **zero Jev requests**.
- **Heavy Model:** Substantive coding and review tasks route to the heavy model.
- **Independent Thinking:** Each slot walks its own range — light `off` → `minimal` → `low` → `medium` → `high`, heavy `low` → `medium` → `high` → `xhigh` → `max` — so a chore can be silenced while a review is pinned deep.
- **Context Guard:** Prevents overflow by staying on the heavy/current model if context exceeds 30k tokens or 50% window.
- **Same backend chain as the gate:** Routing classification and the write gate both call the active backend from `/jev-eye models`, then its fallback — so a stalled provider delays one turn instead of losing the classification.
- **Theme-Adaptive TUI:** Automatically matches active Pi theme tokens (`accent`, `muted`, `dim`, `success`).

| Key | Action |
| --- | --- |
| `type` | Filter models by id, provider, or display name |
| `↑` `↓` | Navigate list |
| `space` | Assign highlighted model to **Light** slot; press it again on the same row to cycle that slot's thinking level |
| `ctrl+h` · `ctrl+q` | Assign highlighted model to **Heavy** slot; press it again on the same row to cycle that slot's thinking level |
| `ctrl+r` | Toggle routing on / off |
| `enter` | Save configuration (`~/.pi/agent/pi-jev-eye/routing.json`) |
| `esc` | Cancel and exit without changes |

</details>

<details>
<summary><b>Usage & Telemetry Ledger</b></summary>

Tracks detailed usage in `~/.pi/agent/pi-jev-eye/usage.json` (plus legacy migration from `~/.pi/agent/pi-typesafe/usage.json`):

- Each day keeps the overall counters and an optional per-provider map, so `/jev-eye usage` can split Jev (TypeSafe/OpenRouter) from Clef without reading a second file. Entries written before this field read as 0 and are never invented.
- Cloudflare is billed in **neurons**, not dollars only: the panel shows today's neuron count against the 10,000/day free allowance (reset 00:00 UTC) and the overage at `$0.011/1,000` neurons. The rate is per model — `clef` 21,818 neurons/M input, `clef-flash` 3,455, `clef-omni` 13,636 — and output tokens are not billed.

- **Daily & Monthly Telemetry:** Request counts (success/fail), token counters (input/output), and estimated dollar cost.
- **Provider Balance:** Live credit lookup for OpenRouter accounts (`/api/v1/key`).
- **Interception Stats:** Cumulative counts of Layer 1 regex blocks, Layer 2 done-check reminders, Layer 3 slop rejections, and reviewed turns.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test             # Pure logic, frame maths, and the failover path (offline, no dependencies)
npm run render-check # Renders the real screens and asserts the frame width, colour and legends
npm run dev          # Test extension locally in active session
```

`npm run render-check` drives `/jev-eye` through a fake TUI and asserts what a screenshot would show:
every line exactly on the terminal width, a coloured frame, a masked key, one divider column across every
list, and no advertised key lost to truncation. The legend check reads `KEY_SETS`, so a key that drifts
from the handler fails the command instead of lying in the footer. It needs the peer dependencies
resolvable, so run it where pi provides them, or link a checkout that has them:
`ln -s ../pi-arnative/node_modules node_modules`.

### Modules

`extensions/` is layered leaf-first; a file imports only the ones above it. `npm test` covers `layer1.ts`, `review.ts` (the trigger **and** the contract text, whose statements are pinned so they cannot drift from the gate they describe) and `providers.ts` (the failover path: `authChain` resolution and the chain walk, with a stubbed `fetch`); `npm run render-check` covers every screen and the `/eye` handler.

| File | Owns |
| --- | --- |
| `layer1.ts` | Pure maths: box chrome, regex gates, ledger folds. No pi import, covered by `npm test` |
| `pmr.ts` | Session state (a leaf: every layer touches it) |
| `review.ts` | The reviewed-turn trigger and the injected report contract (no pi import) |
| `core.ts` | Providers, the model catalog, on-disk paths, credential and backend stores, auth resolution and the failover chain |
| `providers.ts` | The credential probe, and the one call path every question takes: active backend first, fallback behind it |
| `ui.ts` | Arnative rounded-box chrome and every screen component |
| `supervisor.ts` | `KEY_SETS`, the mode cycle, the status-bar indicator |
| `gate.ts` | Layer 3 semantic write gate |
| `panels.ts` | `/jev-eye status` and `usage` bodies |
| `commands.ts` | `/jev-eye` menus and argument dispatch, plus the flat `/eye <task>` trigger |
| `index.ts` | Event wiring only: routing, consent, Layers 1-2, shortcuts |

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
