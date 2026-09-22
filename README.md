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
| `/eye` or `/eye status` | View supervisor status, active layers, key state, and interception stats |
| `/eye on` | Enable supervisor |
| `/eye off` | Temporarily disable supervisor |

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
