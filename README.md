<div align="center">

# pi-jev-eye

Ultra-lean, high-precision supervisor for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — catches destructive commands, blocks credential leaks, tracks verification state, routes per-turn models, and filters code slop using [TypeSafe Jev](https://typesafe.ai/).

[pi package](https://pi.dev/packages/@bismawy/pi-jev-eye) · [npm](https://www.npmjs.com/package/@bismawy/pi-jev-eye) · [Issues](https://github.com/bismawy/pi-jev-eye/issues)

![npm](https://img.shields.io/npm/v/@bismawy/pi-jev-eye)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

## What it does

- **Layer 1 — Instant Regex Gate (0 ms, 0 token):** Catches irreversible bash commands (`rm -rf /`, `git push --force (main|master)`, `git reset --hard`, `DROP DATABASE`, `mkfs`) and blocks hardcoded secrets (`sk-...`, `ghp_...`, `AIza...`, private keys) before execution or disk write. Supports safe overrides like `--force-with-lease`.
- **Layer 2 — Done-Check Tracker (0 token, pure code):** Tracks modified files during the turn. Triggers a warning if the agent claims done without running a verification suite (`npm test`, `cargo test`, `pytest`, `typecheck`).
- **Layer 3 — Targeted Jev Semantic Gate:** Evaluates diffs ≥ 10 lines with TypeSafe Jev (`has_slop`) to block placeholder functions, unfulfilled TODOs, and stubs before writing.
- **Per-Turn Model Routing:** Routes routine chores (`status`, `commit`, `push`, `log`, `diff`) to a light model with 0 Jev requests, and complex tasks to a heavy model classified by Jev, with independent thinking levels and zero external dependencies.
- **Reviewed Turns (`jev` / `@jev`):** Writing `jev` in a prompt enforces the structured review contract (machine facts, calibrated Jev score table, conclusion, and one confirmation question) and evaluates `answers_request` in the same write-gate request.
- **Three Modes, One Key (`Alt+Shift+J`):** Cycles **ON** (keyword-triggered review) → **REVIEW** (every turn reviewed, no extra Jev call) → **OFF** (all layers disabled). See [Modes](#modes-on--review--off).
- **Standalone Account & Key Lookup:** Reads `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, an existing `~/.pi/agent/pi-typesafe/auth.json`, or its own store managed via `/jev-eye login`.
- **Fail-Open Safety:** Network timeouts or offline Jev API calls gracefully fall back to allow work to continue without freezing the agent.

## Install

```bash
pi install npm:@bismawy/pi-jev-eye
```

Supply your Jev key via `/jev-eye login` (TypeSafe or OpenRouter), or export `TYPESAFE_API_KEY` / `OPENROUTER_API_KEY`.

Or test once in an active session without installing:

```bash
pi -e ./extensions/index.ts
```

## Commands & Keybindings

| Trigger | Scope | Action |
| :--- | :--- | :--- |
| `/jev-eye` | Global | Interactive menu: **Login** · **Logout** · **Status** · **Routing** (`/eye` is an alias) |
| `/jev-eye login` | Setup | Store a Jev key: **TypeSafe account** or **OpenRouter account** (verified before saving, `0600`) |
| `/jev-eye logout` | Setup | Delete the local key stored by `/jev-eye login` |
| `/jev-eye status` | Inspect | Real-time status: account, gate value, usage today/month, token cost, balance, and interception stats |
| `/jev-eye toggle` | Toggle | Cycle mode: **ON** → **REVIEW** → **OFF** |
| `/jev-eye on` / `review` / `off` | Mode | Set mode directly: **ON** (prompt trigger), **REVIEW** (all turns reviewed), or **OFF** (disabled) |
| `/jev-eye routing` | Routing | Interactive TUI model router: pick light/heavy models, cycle thinking levels, toggle routing |
| `/jev-eye routing on` / `off` | Routing | Enable or disable per-turn routing directly without opening picker |
| `/jev-eye routing light` / `heavy` | Routing | Open model picker for a specific target slot |
| `alt+shift+j` | Keybinding | Instantly cycle mode: **ON** → **REVIEW** → **OFF** (`ctrl+shift+e` kept as legacy alias) |
| `ctrl+shift+g` | Keybinding | Cycle Jev gate value: **Enable all folder** → **Enable this folder** → **Disabled** |
| `jev` / `@jev` in prompt | Prompt | Trigger reviewed turn with review contract and `answers_request` judgment |

> **Status bar design:** Nothing is written to Pi's shared status bar by this extension alone — the pi-arnative footer renders it as `Jev: ● ON` / `● REVIEW` / `○ OFF`. The live supervisor state, active gate value, and keybindings also appear in the `/jev-eye status` footer line:
> ```
> [Enter] Done · [Esc] Cancel · [Alt+Shift+J] Mode (ON) · [Ctrl+Shift+G] Grant folder
> ```

## Modes: ON · REVIEW · OFF

One key cycles all three states (`cycleEyeState`, `extensions/index.ts`). There is no fourth state: `REVIEW` is simply `enabled && reviewMode`.

```
Alt+Shift+J ──► ON ──► REVIEW ──► OFF ──┐
                 ▲                     │
                 └─────────────────────┘
```

| Mode | Footer | Layers 1–2 (regex / done-check) | Layer 3 (Jev gate) | Report contract | How review opens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **ON** | `● ON` | Active | Active on opt-in folders, diffs ≥ 10 lines | Off | Only when the prompt contains `jev` / `@jev` / `/jev-review` |
| **REVIEW** | `● REVIEW` | Active | Same as `ON` | **Injected on every turn** | Always — no keyword needed |
| **OFF** | `○ OFF` | Off | Off | Off | Never |

`ON` and `REVIEW` differ in one flag only (`reviewed`) — but it propagates: the flag both injects the contract and adds the `answers_request` dimension to the write gate. Layers 1–2 and every guard are identical in both.

### `ON` — Supervisor active, keyword-triggered review

All three layers run: dangerous `rm -rf` and force-pushes are blocked instantly (0 ms, 0 token), files written without verification earn a reminder, and diffs ≥ 10 lines on consent-granted folders go to the Jev semantic gate (block at `p ≥ 0.85`). Model routing follows `/jev-eye routing`. The report contract is injected only when the prompt says `jev`.

### `REVIEW` — Every turn reviewed

Same protections as `ON`, but `before_agent_start` injects the report contract (machine facts → one Jev table → threshold line → priority conclusion → one confirmation question) on **every** prompt, and the write gate compares code against that turn's request. **No extra Jev call** — `answers_request` rides along in the same batched request as `has_slop`.

Use it when the whole session needs a decision trail without typing `jev` each time.

### `OFF` — Supervisor fully disabled

`before_agent_start`, `tool_call`, and `message_end` return immediately. Regex guards, secret detection, done-check, Jev gate, report contract, and routing all stop — no notifications, no quota, no Jev requests. Use it for legitimate operations the guards would otherwise stop (cleaning `./dist`, force-pushing a work branch).

## How it works

### Three-Layer Architecture

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

1. **Layer 1 (`extensions/layer1.ts`):** Evaluates tools before execution. Blocks dangerous filesystem wipes (`rm -rf` targeting system directories, root, or home), blocks force pushes to protected branches (`main`/`master`) while allowing `--force-with-lease`, and prevents credentials from being written to files or executed in commands. It also holds the pure usage-ledger math (own + legacy days).
2. **Layer 2:** Monitors tool activity within the current turn. If files were modified on disk but the agent attempts to finalize the turn without running verification commands, a reminder is injected.
3. **Layer 3:** Intercepts write and edit operations. Changes under 10 lines pass freely. Larger changes are submitted to TypeSafe Jev as a single batch request to assess `has_slop`. If `P(has_slop) >= 0.85`, the change is rejected with actionable feedback.

### Key Detection & Verification Patterns

- **Destructive Bash Patterns:** `rm -rf /`, `rm -rf $HOME`, `git push --force (main|master)`, `git reset --hard`, `DROP DATABASE`, `DROP TABLE`, `mkfs`, raw partition writes.
- **Blocked Secrets:** OpenAI API keys (`sk-...`), GitHub tokens (`ghp_...`, `gho_...`), Google AI keys (`AIza...`), and private SSH/RSA/DSA/EC key headers.
- **Recognized Verification Commands:** `npm test`, `pnpm test`, `bun test`, `cargo test`, `cargo check`, `pytest`, `mypy`, `ruff check`, `go test`, `vitest`.

### Jev Gate Modes

Scope of the Jev semantic gate — independent of the supervisor [mode](#modes-on--review--off) above. Configured via `ctrl+shift+g` or `~/.pi/agent/pi-jev-eye/consent.json`:
- **Enable all folder:** Jev semantic gate runs across all workspaces.
- **Enable this folder:** Scoped exclusively to explicitly approved directories and their subdirectories.
- **Disabled:** Jev semantic gate is paused; Layers 1 & 2 remain active at zero token cost.

### Reviewed Turns (`jev`)

Include `jev` (or `@jev`, `/jev-review`) anywhere in your prompt to trigger a reviewed turn — or switch to **REVIEW** mode to review every turn without the keyword:
- **Strict Format Contract:** The agent formats output with machine-verified facts first, followed by a calibrated Jev score table (`value (probability)` with level tags), the threshold bar, a priority conclusion, and exactly one confirmation question.
- **Single-Flight Semantic Verification:** Stored prompt context is appended to the next Layer 3 check as an `answers_request` judgment, validating task completion in the same API call without extra quota overhead.
- Occurrences of `pi-jev-eye` and `jev-eye` are ignored to prevent accidental triggers.

### Model Routing

Run `/jev-eye routing` to open the interactive model picker:

```
────────────────────────────────────────────────────────────────────
Jev Eye - Routing
Route light chores to a cheap model and real review to the strongest one. ctrl+r turns routing on/off.

> type to filter

  gemini-3.1-flash-lite [antigravity]
  gemini-3-flash [antigravity] ✓ (light)
→ gemini-2.5-flash [antigravity] ✓ (heavy)
  claude-sonnet-4-6 [antigravity]
  (3/9)

Routing: ON
Light model: Gemini 3 Flash (Antigravity) [thinking: low]
Heavy model: Gemini 2.5 Flash (Antigravity) [thinking: high]

enter=done | space=select light models | ctrl+r=routing on/off | ctrl+h=select heavy models | ctrl+t=light thinking | ctrl+shift+t=heavy thinking | esc=cancel | total 9 models
────────────────────────────────────────────────────────────────────
```

- **Light Model (Chores):** Routine git operations (`status`, `commit`, `push`, `log`, `diff`) route to the light model with **zero Jev requests**.
- **Heavy Model (Review):** Substantive engineering tasks route to the heavy model via a single prompt evaluation.
- **Theme-Adaptive TUI:** Automatically adopts active Pi theme tokens (`accent`, `muted`, `dim`, `success`) without hardcoded colors.

| Key | Action |
| :--- | :--- |
| `type` | Filter models by id, provider, or display name |
| `↑` `↓` | Navigate list |
| `space` | Assign highlighted model to **Light** slot (toggle) |
| `ctrl+h` / `ctrl+q` | Assign highlighted model to **Heavy** slot (toggle) |
| `ctrl+r` | Toggle routing on / off |
| `ctrl+t` | Cycle **Light** model thinking level (`off` → `minimal` → `low` → `medium` → `high` → `xhigh` → `max`) |
| `ctrl+shift+t` | Cycle **Heavy** model thinking level independently |
| `enter` | Save configuration (`~/.pi/agent/pi-jev-eye/routing.json`) |
| `esc` | Cancel and exit without changes |

## Usage & Ledger

Status details in `/jev-eye status` are sourced from `~/.pi/agent/pi-jev-eye/usage.json`, plus the older `~/.pi/agent/pi-typesafe/usage.json` for days that predate the switch (its counters are renamed and its missing cost is estimated):
- **Daily & Monthly Telemetry:** Requests (success/fail), input/output tokens, and dollar cost calculated using actual provider usage receipts (OpenRouter) or standard TypeSafe token rates.
- **Live Account Balance:** Real-time credit checks for OpenRouter (`/api/v1/key`, cached 5m).
- **Session Interception Counters:** Accurate count of Layer 1 blocks, Layer 2 warnings, Layer 3 rejections, and reviewed turns.

## Comparison

| Metric | `pi-warden` | `pi-jev-eye` |
| :--- | :--- | :--- |
| **Package Size** | ~900 KB (dozens of files) | **~62 KB (2 TS files: `index.ts` + `layer1.ts`)** |
| **Dependencies** | Multiple external dependencies | **0 external dependencies** |
| **Destructive Prevention** | AST parsing + LLM reasoning | **Deterministic regex (0 ms, 0 token)** |
| **Jev Quota Consumption** | Heavy (runs on all interactions) | **Ultra-frugal** (only diffs ≥ 10 lines) |
| **Security Handling** | Cloud-assisted review | **Local zero-leak regex block** |

## Development

Run unit tests (no API key or network required):

```bash
npm test
```

Executes Node.js native test runner (`node --test`) covering 17 assertions across destructive wipe paths, flag permutations, branch force-pushes, and credential patterns.

## License

Distributed under the **MIT** license.

## Developer

Developed and maintained by [Bisma](https://github.com/bismawy).
