<div align="center">

# pi-jev-eye

Ultra-lean, high-precision supervisor for [pi](https://github.com/earendil-works/pi-coding-agent) — catches destructive commands, blocks credential leaks, enforces real verification, and filters code slop using [TypeSafe Jev](https://typesafe.ai/).

[GitHub](https://github.com/bismawy/pi-jev-eye) · [Issues](https://github.com/bismawy/pi-jev-eye/issues)

![size](https://img.shields.io/badge/size-%3C%2012%20KB-blue)
![deps](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

## What it does

pi-jev-eye supervises the agent in the background across three lean layers:

- **Layer 1 — Instant Regex Gate (0 ms, 0 Token):** Catches irreversible bash actions (`rm -rf /`, `git push --force (main|master)`, `git reset --hard`, `DROP DATABASE`, `mkfs`) and blocks hardcoded API keys (`sk-...`, `ghp_...`, private keys) before they run or touch disk.
- **Layer 2 — Done-Check Tracker (0 Token, Pure Code):** Tracks modified files during the turn. If the agent claims "done" or "selesai" without running test/lint commands (`npm test`, `cargo test`, `pytest`, `typecheck`), a reminder is triggered.
- **Layer 3 — Targeted Jev Semantic Gate:** Evaluates code diffs $\ge 10$ lines using TypeSafe Jev (`has_slop`) to block lazy function stubs and unfulfilled TODOs before writing.
- **Zero-Config Key Sharing:** Automatically reads `TYPESAFE_API_KEY` or reuses the key from `~/.pi/agent/pi-typesafe/auth.json`.
- **Fail-Open Safety:** Network timeouts or offline Jev API calls gracefully fall back to allow work to continue without freezing the agent.

## Install

From npm:

```bash
pi install npm:@bismawy/pi-jev-eye
```

From GitHub:

```bash
pi install git:github.com/bismawy/pi-jev-eye
```

Or from a local clone:

```bash
pi install /run/media/bisma/DATA/Pi/pi-jev-eye
```

Or try once without installing:

```bash
pi -e /run/media/bisma/DATA/Pi/pi-jev-eye/extensions/index.ts
```

## Commands

| Command | Action |
| :--- | :--- |
| `/jev-eye` | Interactive menu: **Log in/out** · **Enable all folder** · **Enable this folder** · **Disabled** · Show status (`/eye` is a working alias) |
| `/jev-eye login` | Store a Jev key: **TypeSafe account** or **OpenRouter account** |
| `/jev-eye logout` | Delete the key stored by `/jev-eye login` |
| `/jev-eye status` | Status: supervisor, account, gate value, usage today/month, balance, interception stats |
| `/jev-eye routing` | Routing menu: **Light model** · **Heavy model** · **Routing on/off** |
| `/jev-eye routing light` / `routing heavy` | Open the model picker for that target directly; `routing on` / `routing off` sets it without the picker |
| `ctrl+shift+e` | Toggle the supervisor on/off; the footer status line flips instantly |
| `jev` in a prompt (or `@jev`, `/jev-review`) | Reviewed turn: report-format contract + `answers_request` judgment on the next write |
| `/jev-eye` → **Routing** | Per-turn model routing: light model for chores, heavy model for review |

The `on`/`off` subcommands are gone — the keybinding replaces them, and the footer carries both the state and the action: `supervisor ON · ctrl+shift+e disables supervisor`. The footer is repainted at session start, at every turn start, and on every `/jev-eye` invocation, so another extension clearing statuses cannot leave it blank.

### Accounts (pi-typesafe is optional)

`/jev-eye login` asks where your Jev key comes from, hides it while you type, verifies it with one small request, and only then writes `~/.pi/agent/pi-jev-eye/auth.json` (owner-only, `0600`).

| Choice | Endpoint | Model | Key from |
| :--- | :--- | :--- | :--- |
| TypeSafe account | `api.typesafe.ai/v1/systemone` | `jev-latest` | console.typesafe.ai → API Keys |
| OpenRouter account | `openrouter.ai/api/alpha/decisions` | `typesafe/jev-1.13` | openrouter.ai/settings/keys |

Key lookup order: `TYPESAFE_API_KEY` → `OPENROUTER_API_KEY` → the `/jev-eye login` store → a key already stored by **pi-typesafe** (`~/.pi/agent/pi-typesafe/auth.json`), so an existing install keeps working without logging in again. An exported env var wins on purpose (headless runs, CI), and login says so when it is set. `/jev-eye logout` deletes only pi-jev-eye's own key and tells you what still applies.

### Jev gate value: three values only

Chosen from the menu and stored in `~/.pi/agent/pi-jev-eye/consent.json`:

- **Enable all folder** — the Jev gate runs in every folder. This is the same meaning the optional `pi-typesafe` package gives its own `PI_TYPESAFE_ENABLED=1` consent flag (that env var belongs to that package, not to TypeSafe's API).
- **Enable this folder** — only the listed folders (and their subfolders) run the Jev gate; picking it again toggles the current folder, and removing the last one falls back to Disabled.
- **Disabled** — Jev gate off, layers 1–2 (local, zero cost) stay on.

Values written by older versions (`folders`, `off`) migrate on read. The `typesafe_evaluate` tool belongs to the optional `pi-typesafe` package and has its own per-session gate; pi-jev-eye never touches it or reads its files for display (`/jev-eye status` shows only pi-jev-eye's own state).

### Reviewed turns: write `jev` in a prompt

Write `jev` (or `@jev`, or `/jev-review`) anywhere in a prompt and that turn becomes a reviewed turn. `pi-jev-eye` then:

- injects a visible message telling the model to answer in the report format this workflow already uses — machine-verified facts first, then a Jev table with `value (probability)` and level labels, then the threshold line, in the operator's language;
- remembers the prompt and adds a **third judgment** to the next write gate request: `answers_request` (does this code actually answer what was asked?). It rides along in the same API call, so a review costs no extra request, and a low confidence that the request was answered blocks the write;
- counts the turn in `/jev-eye status` (`… · N reviewed turns`).

Word-boundary guard: `pi-jev-eye` and `jev-eye` never trigger it. The request is one-shot — it covers the turn it was written in, and the prompt text (up to 600 chars) leaves the machine only for that turn.

### Model routing (optional)

Menu entry **Routing** picks two targets from pi's own authenticated model list (`ctx.modelRegistry.getAvailable()`). The picker is one searchable screen (`SelectList`, the same shape `/vision-watcher` uses): type to filter, `✓` marks the target already stored, each row shows its `[provider]`, and the footer lists the keys:

```
pi-jev-eye · light turn model
Routing OFF · light (unset) · heavy (unset)
  ✓ deepseek-v4.1-flash:free  [tokenharbor]   currently light
    gemini-3.8-flash  [antigravity]
    (none)                                     clear the light target
↑↓ move · type to filter · enter assign · esc cancel · 3 models available
```

Without a TUI it falls back to a plain `ui.select` list of `provider/modelId` refs.


- **Light model** — chores. A prompt that is plainly a repository chore (`commit`, `push`, `pull`, `status`, `log`, `diff`, `stash`, `branch`, …) is routed here with **zero Jev requests**.
- **Heavy model** — turns that need real review. One Jev `choice` judgment on the prompt decides `light` / `heavy` / `unclear`; `unclear` keeps whatever model is active.

Stored in `~/.pi/agent/pi-jev-eye/routing.json`; the switch happens in `before_agent_start` via `pi.setModel()`, and the already-active model is never re-set. Classification has its own 20-per-session budget, separate from the write gate's, and routing stays off until both targets are set. Layer 3 still judges the finished code with Jev.

> Per-turn cheap/strong routing also ships in `@alexlikevibe/pi-jev` (`/jev` → Routing). Install that one if you want routing *and* Jev-driven compaction together; this menu exists so a single package can do gate + routing without pulling another dependency in.

### Usage stats

`/jev-eye status` is built only from pi-jev-eye's own ledger (`~/.pi/agent/pi-jev-eye/usage.json`) — nothing is read from other packages:

- **Today** and **Month** (calendar month, summed from the daily ledger): requests with ok/failed, input/output tokens, total cost. Cost is the provider's real `usage.cost` when it reports one (OpenRouter), otherwise estimated at the TypeSafe input-only rate (0.042 $/Mtok).
- **Balance**: remaining account credit. OpenRouter is queried live (`/api/v1/key`, cached 5 minutes, falling back to `/api/v1/credits`); TypeSafe's API exposes no balance route, so the line says exactly that instead of guessing.
- Session Jev budget, current model context size, and the session's interception counters.

## How it works

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

<details>
<summary><b>Why pi-jev-eye instead of pi-warden?</b></summary>

| Metric | `pi-warden` | `pi-jev-eye` |
| :--- | :--- | :--- |
| **Package Size** | ~900 KB (dozens of files) | **< 12 KB (1 file TypeScript)** |
| **Dependencies** | Multiple external dependencies | **0 external dependencies** |
| **Destructive Prevention** | AST parsing + LLM reasoning | **Deterministic regex (0 ms, 0 token)** |
| **Jev Quota Consumption** | Heavy (burns session quota fast) | **Ultra-frugal** (only runs on diffs $\ge 10$ lines) |
| **Security Handling** | Cloud-assisted review | **Local zero-leak regex block** |

</details>

<details>
<summary><b>Key Detection Patterns</b></summary>

- **Destructive Bash:** `rm -rf /`, `rm -rf $HOME`, `git push --force (main|master)`, `git reset --hard`, `DROP DATABASE`, `DROP TABLE`, `mkfs`, raw writes to `/dev/sd*`.
- **Secret Leaks:** OpenAI keys (`sk-...`), GitHub tokens (`ghp_...`, `gho_...`), Google AI keys (`AIza...`), and private SSH/RSA/DSA/EC keys.
- **Verification Commands:** `npm test`, `pnpm test`, `bun test`, `cargo test`, `cargo check`, `pytest`, `mypy`, `ruff check`, `go test`, `vitest`.

</details>

## License

Distributed under the **MIT** license.

## Developer

Developed and maintained by [Bisma](https://github.com/bismawy).
