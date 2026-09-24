// --- Layer 1: Local Regex Patterns (0 ms, 0 Token) ---
// Pure rules + pure ledger math, kept out of index.ts so `npm test` (node --test test/) can check them.
// A wipe is judged per path argument, not by "the command mentions / somewhere".
// Catastrophic = root, a top-level dir (/usr, /tmp, /home), a top-level system dir (/var/log),
// home in any form (~, ~/x, $HOME/x), a parent hop, or a top-level glob (/home/*). Deeper paths are scoped.
const SYSTEM_ROOT_DIRS = new Set(["etc", "usr", "var", "boot", "bin", "sbin", "lib", "lib64", "opt", "srv", "root", "sys", "proc", "dev"]);

// Every rm in the command: a scoped `rm` early in the line must not hide a catastrophic one later.
const WIPE_INVOCATION = /\brm\s+([^;&|]*)/g;

/** Any recursive or forced flag, whatever the case or order: -rf, -R, -f -r, --recursive, --force. */
const DESTRUCTIVE_FLAG = /^(?:-[a-zA-Z]*[rf][a-zA-Z]*|--(?:recursive|force))$/i;

/** Returns the offending path argument when the command is a filesystem wipe, otherwise null. */
export function wipeTarget(command: string): string | null {
  for (const match of command.matchAll(WIPE_INVOCATION)) {
    const args = match[1].trim().split(/\s+/).filter(Boolean);
    if (!args.some((arg) => DESTRUCTIVE_FLAG.test(arg))) continue;

    for (const raw of args) {
      if (raw.startsWith("-")) continue; // a flag, or the `--` separator
      const target = raw.replace(/^["']|["']$/g, "");
      if (!target) continue;

      if (/^(?:~|\$\{?HOME\}?)(?:\/|$)/.test(target)) return target;
      if (/^\.\.(?:\/\.\.)*\/?$/.test(target)) return target;
      if (!target.startsWith("/")) continue;

      const segments = target.split("/").filter(Boolean);
      if (segments.length <= 1) return target; // / , /* , /usr , /tmp , /home
      if (SYSTEM_ROOT_DIRS.has(segments[0])) return target; // /var/log , /usr/lib/x — nothing inside a system dir is a scoped delete
      if (segments.length === 2 && segments[1] === "*") return target; // /home/* , /tmp/* — a named glob (/tmp/jev-req*) only matches its own files
    }
  }

  return null;
}

export const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+.*--no-preserve-root\b/i,
  /\bgit\s+push\s+.*--force(?!-with-lease).*(main|master)\b/i,
  /\bgit\s+push\s+-f\s+.*(main|master)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(DATABASE|TABLE)\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

export const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bghp_[a-zA-Z0-9]{20,}\b/,
  /\bgho_[a-zA-Z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z-_]{35}\b/,
  /-----BEGIN\s+(RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----/,
];

// --- Usage-ledger math (pure: no fs, no network, so `npm test` can check it) ---
// This package's ledger and the older pi-typesafe one count the same requests under different names.
export interface DayTotals {
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export const EMPTY_TOTALS: DayTotals = { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
export const USD_PER_MTOK = 0.042; // mirrors pi-typesafe's default input-token rate

/** A missing counter reads as 0; an entry written before the cost field existed is estimated instead of shown as free. */
export function normalizeTotals(raw: any): DayTotals {
  const totals = { ...EMPTY_TOTALS };
  for (const key of Object.keys(totals) as (keyof DayTotals)[]) totals[key] = Number(raw?.[key]) || 0;
  if (raw?.cost === undefined && totals.inputTokens > 0) totals.cost = (totals.inputTokens * USD_PER_MTOK) / 1e6;
  return totals;
}

/** pi-typesafe named the same counters differently and never stored a cost; map them onto ours. */
export function legacyTotals(raw: any): DayTotals {
  return normalizeTotals({
    requests: raw?.requestsStarted,
    ok: raw?.requestsSucceeded,
    failed: raw?.requestsFailed,
    inputTokens: raw?.inputTokens,
    outputTokens: raw?.outputTokens,
  });
}

/** Two ledgers, two sets of requests: the parts are added, never one replacing the other. */
export function mergeTotals(a: DayTotals | undefined, b: DayTotals | undefined): DayTotals | undefined {
  if (!a) return b;
  if (!b) return a;
  const merged = { ...a };
  for (const key of Object.keys(merged) as (keyof DayTotals)[]) merged[key] += b[key];
  return merged;
}

/** Every entry of `days` whose date starts with `period` (a day "2026-09-20" or a month "2026-09"), summed. */
export function sumDays(days: any, period: string, mapper: (raw: any) => DayTotals): DayTotals | undefined {
  if (!days || typeof days !== "object") return undefined;
  let found = false;
  const totals = { ...EMPTY_TOTALS };
  for (const [date, value] of Object.entries(days)) {
    if (!date.startsWith(period)) continue;
    found = true;
    const day = mapper(value);
    for (const key of Object.keys(totals) as (keyof DayTotals)[]) totals[key] += day[key];
  }
  return found ? totals : undefined;
}

export const VERIFICATION_COMMAND_PATTERNS = [
  /\b(npm|pnpm|bun|yarn)\s+(test|run\s+(test|typecheck|lint|build|check))\b/i,
  /\b(cargo\s+(test|check))\b/i,
  /\b(pytest|mypy|ruff\s+check)\b/i,
  /\b(go\s+(test|vet))\b/i,
  /\bvitest\b/i,
];
