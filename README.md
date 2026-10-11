# Jev Eye

Ultra-lean supervisor. Three-layer guardrails. Semantic gate for Pi.

> **Keywords:** `clef`, `Cloudflare Workers AI`, `workers-ai`, `clef-flash`, `Jev`, `TypeSafe`, `OpenRouter`, `semantic gate`, `guardrails`.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-jev-eye)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-jev-eye.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-jev-eye)
[![license](https://shieldcn.dev/github/bismawy/pi-jev-eye/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-jev-eye)

<img src="https://raw.githubusercontent.com/bismawy/pi-jev-eye/main/assets/banner.webp" alt="Jev Eye: three-layer supervisor, regex guardrails, and TypeSafe Jev semantic gate" width="100%">

## Overview

pi-jev-eye is an ultra-lean, zero-dependency supervisor for [pi](https://github.com/earendil-works/pi-coding-agent). It protects your workspace from destructive commands, prevents credential leaks, enforces testing verification, routes models per-turn, and runs a semantic gate through [TypeSafe Jev](https://typesafe.ai/), OpenRouter, or [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/clef/) (Clef) to catch code slop before disk writes.

- **Instant Regex Gate:** 0 ms, 0 token barrier blocking wipes (`rm -rf /`, `DROP DATABASE`), protected branch force-pushes, and hardcoded secrets (`sk-...`, `ghp_...`, SSH keys).
- **Done-Check Verification:** Warns when the agent claims done after editing files without running verification suites (`npm test`, `cargo test`, `pytest`).
- **Targeted Jev Semantic Gate:** Evaluates diffs ≥ 10 lines via TypeSafe Jev (`has_slop`) to reject placeholder stubs and unfulfilled TODOs.
- **Three Decision Backends:** TypeSafe Jev, OpenRouter, or **Cloudflare Workers AI (Clef / `clef-flash`)** — same gated pipeline, chosen once at `/jev-eye login`. Clef runs inside Cloudflare's free daily allowance of 10,000 neurons, so the gate costs nothing for most sessions.
- **Jev + Clef Usage Panel (`/jev-eye usage`):** One compact table shows Jev and Clef side by side (requests, input tokens, cost for the month), three period totals, and the Cloudflare free-neuron budget with its reset time and overage cost. Periods that predate the split are reported as an explicit `Earlier` row rather than silently dropping out of the table.
- **Reviewed Turns (`jev` / `@jev`):** Calibrated review contract with machine facts, Jev scoring tables, and single-flight prompt alignment (`answers_request`).
- **Per-Turn Model Routing:** Routes light chores (git commit, push, status) to a fast model and complex engineering tasks to a heavy model with independent reasoning controls.
- **Fail-Open Reliability:** Network timeouts or offline provider APIs gracefully degrade so coding sessions never stall or freeze.

## Install

```bash
pi install npm:@bismawy/pi-jev-eye
```

Supply your Jev API key via `/jev-eye login` (TypeSafe, OpenRouter, or Cloudflare Workers AI), or export `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`. For Cloudflare Clef, export `CLOUDFLARE_ACCOUNT_ID` **and** `CLOUDFLARE_API_TOKEN` — a token alone cannot build the account-scoped route.

Credentials you store live side by side: `~/.pi/agent/pi-jev-eye/auth.json` (mode 0600) holds one entry per provider, so logging in with Clef no longer discards a stored TypeSafe key. `/jev-eye logout` then lets you pick which backend to remove. A credential that comes from the environment is reported but never deleted — a process cannot unset a variable it does not own.

To test locally without installing:
```bash
pi -e ./extensions/index.ts
```

## Shortcuts & Commands

| Trigger | Scope | Action |
| --- | --- | --- |
| `ctrl+shift+e` | Keybinding | Cycle supervisor mode: **ON** → **REVIEW** → **OFF** |
| `ctrl+shift+u` | Keybinding | Cycle Jev folder gate: **Enable all** → **This folder** → **Disabled** |
| `/jev-eye` | Global | Interactive menu: Login, Logout, Status, Routing (`/eye` is an alias) |
| `/jev-eye login` | Setup | Authenticate with TypeSafe, OpenRouter, or Cloudflare Workers AI (Clef); verified against the live route, mode 0600 |
| `/jev-eye logout` | Setup | Remove stored credentials — pick **Jev**, **Clef**, or **All** when several backends are logged in |
| `/jev-eye status` | Inspect | Five-line live state: supervisor, gate key, rules, routing, block counts. Spend lives in `usage` |
| `/jev-eye usage` | Inspect | Spend breakdown: Jev vs Clef side by side, period totals, and the Cloudflare free-neuron budget |
| `/jev-eye routing` | Routing | Interactive TUI model router for light and heavy task slots |
| `jev` · `@jev` in prompt | Prompt | Trigger calibrated review format and task alignment check |

### Providers

| Provider | Credential | Model | Cost |
| --- | --- | --- | --- |
| TypeSafe | `$TYPESAFE_API_KEY` or `/jev-eye login` | `jev-latest` | Per-token, ledger-based |
| OpenRouter | `$OPENROUTER_API_KEY` or `/jev-eye login` | `typesafe/jev-1.13` | Reported by the provider |
| Cloudflare Workers AI | `$CLOUDFLARE_ACCOUNT_ID` + `$CLOUDFLARE_API_TOKEN`, or `/jev-eye login` (asks for both) | `clef-flash` (default) or `clef` | Clef: $0.24/M input; clef-flash: $0.038/M input; output free; 10,000 free neurons/day at 00:00 UTC |

### Why Clef

Clef is Cloudflare's decision model (`@cf/cloudflare/clef`). It answers the same typed System One questions the gate already asks (`noul` / `choice` / `score`), so switching the backend changes no gate logic — only the route and the credential. Two properties make it the cheapest way to run the gate per write:

- **Free for normal sessions.** Every account gets 10,000 neurons per day, reset at 00:00 UTC. `clef-flash` bills 3,455 neurons per million input tokens, so a typical session stays inside the allowance; `/jev-eye usage` shows the exact figure and the overage cost (`$0.011/1,000` neurons) once it does not.
- **No output-token billing.** Clef charges input tokens only, so its cost is a function of the diff you send, not of the model's reasoning length.

The credential is the account id **plus** a Workers AI token (`Workers AI: Read`) — a token alone cannot build the account-scoped route. The account id is checked as 32 hex characters and the credential is probed against the real run route before anything is saved.

The Cloudflare route is `…/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash`; the account id is validated (32 hex chars) and the credential is probed against that exact route before it is saved. Clef interprets the same typed questions (`noul` / `choice` / `score`), so no gate logic changes per provider.

> **Notes:**
> - **pi-arnative status bar:** Shows real-time mode indicator as `Jev: ● ON` / `● REVIEW` / `○ OFF`.
> - **Why these chords:** neither `ctrl+shift+e` nor `ctrl+shift+u` is bound by pi. `ctrl+shift+g` used to carry the gate, but it is pi's own `tui.altScreen.searchPrevious`, so pi warns about the clash at boot.

### Modes

```
Ctrl+Shift+E ──► ON ──► REVIEW ──► OFF ──┐
                 ▲                     │
                 └─────────────────────┘
```

| Mode | Footer | Regex & Done-Check | Jev Semantic Gate | Review Contract | When Review Triggers |
| --- | --- | --- | --- | --- | --- |
| **ON** | `● ON` | Active | Active (diffs ≥ 10 lines) | Optional | Only when prompt contains `jev` / `@jev` |
| **REVIEW** | `● REVIEW` | Active | Active (diffs ≥ 10 lines) | Injected every turn | Every prompt automatically |
| **OFF** | `○ OFF` | Disabled | Disabled | Disabled | Never |

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
- **Independent Thinking:** Set custom reasoning effort for both slots (`off` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`).
- **Context Guard:** Prevents overflow by staying on the heavy/current model if context exceeds 30k tokens or 50% window.
- **Theme-Adaptive TUI:** Automatically matches active Pi theme tokens (`accent`, `muted`, `dim`, `success`).

| Key | Action |
| --- | --- |
| `type` | Filter models by id, provider, or display name |
| `↑` `↓` | Navigate list |
| `space` | Assign highlighted model to **Light** slot |
| `ctrl+h` · `ctrl+q` | Assign highlighted model to **Heavy** slot |
| `ctrl+r` | Toggle routing on / off |
| `ctrl+t` | Cycle **Light** model thinking level |
| `ctrl+shift+t` | Cycle **Heavy** model thinking level |
| `enter` | Save configuration (`~/.pi/agent/pi-jev-eye/routing.json`) |
| `esc` | Cancel and exit without changes |

</details>

<details>
<summary><b>Usage & Telemetry Ledger</b></summary>

Tracks detailed usage in `~/.pi/agent/pi-jev-eye/usage.json` (plus legacy migration from `~/.pi/agent/pi-typesafe/usage.json`):

- Each day keeps the overall counters and an optional per-provider map, so `/jev-eye usage` can split Jev (TypeSafe/OpenRouter) from Clef without reading a second file. Entries written before this field read as 0 and are never invented.
- Cloudflare is billed in **neurons**, not dollars only: the panel shows today's neuron count against the 10,000/day free allowance (reset 00:00 UTC) and the overage at `$0.011/1,000` neurons. The rate is per model — `clef` 21,818 neurons/M input, `clef-flash` 3,455, `clef-omni` 13,636 — and output tokens are not billed.

- **Daily & Monthly Telemetry:** Request counts (success/fail), token counters (input/output), and estimated dollar cost.
- **Provider Balance:** Live credit lookup for OpenRouter accounts (`/api/v1/key`, cached 5m).
- **Interception Stats:** Cumulative counts of Layer 1 regex blocks, Layer 2 done-check reminders, Layer 3 slop rejections, and reviewed turns.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test    # Run Node.js native test suite (23 assertions, offline)
npm run dev # Test extension locally in active session
```

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
