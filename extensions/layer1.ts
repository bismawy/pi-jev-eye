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

// --- Cloudflare Workers AI route (Clef). Pure string building: the base is fine to commit, an account id is not. ---
// --- Cloudflare Workers AI pricing (Clef). Pure lookups: the panel needs the real rate, not a guess. ---
// Verified against developers.cloudflare.com/workers-ai/platform/pricing (last updated 2026-10-09).
// Cloudflare bills no output tokens for the Clef models, only input tokens.
export const CLEF_USD_PER_MTOK: Record<string, number> = { clef: 0.24, "clef-flash": 0.038, "clef-omni": 0.15 };
/** What the free tier is actually spent in: neurons billed per million input tokens. */
export const CLEF_NEURONS_PER_MTOK: Record<string, number> = { clef: 21818, "clef-flash": 3455, "clef-omni": 13636 };
/** The allowance is per account, not per model, and resets at 00:00 UTC. */
export const CLEF_FREE_NEURONS_PER_DAY = 10000;
/** Beyond the free allowance Cloudflare charges $0.011 per 1,000 neurons on the Workers Paid plan. */
export const CLEF_USD_PER_KN = 0.011;
/** A credential with no model recorded falls back to the cheaper one. */
export const DEFAULT_CLEF_MODEL = "clef-flash";

/** Rate lookup that never throws on an unknown model id: it charges the cheaper model's price. */
export function clefUsdPerMTok(model: string): number {
  return CLEF_USD_PER_MTOK[model] ?? CLEF_USD_PER_MTOK[DEFAULT_CLEF_MODEL];
}

/** Neurons per million input tokens for a model, defaulting to the cheaper model's rate. */
export function clefNeuronsPerMTok(model: string): number {
  return CLEF_NEURONS_PER_MTOK[model] ?? CLEF_NEURONS_PER_MTOK[DEFAULT_CLEF_MODEL];
}

/** Neurons an input-token count costs on a model. This is what the daily free allowance pays for. */
export function clefNeuronsFor(model: string, inputTokens: number): number {
  return ((Number(inputTokens) || 0) * clefNeuronsPerMTok(model)) / 1e6;
}

/** A 32-char lowercase hex string is the only shape Cloudflare account ids come in. */
export const isCloudflareAccountId = (value: string): boolean => /^[0-9a-f]{32}$/i.test(value);

/** One Clef route: the model is the path segment, the account id comes from whoever stores the credential. */
export const cfRunUrl = (accountId: string, model: string): string =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;

/**
 * The Clef answer inside a Workers AI response. The REST route wraps it in `{ result, success, errors }`,
 * so unwrapping has to happen in one place: a missed envelope reads as "model said nothing" and silently
 * fails the gate open. Returns undefined when Cloudflare reported a failure.
 */
export function clefBody(json: any): { model?: string; answers?: Record<string, any>; usage?: Record<string, any> } | undefined {
  if (!json || typeof json !== "object") return undefined;
  if (json.success === false) return undefined;
  const result = "result" in json ? json.result : json;
  return result && typeof result === "object" ? result : undefined;
}

/** Cloudflare's error list as one line, for a message that says why the request failed. */
export function clefError(json: any): string {
  const messages = Array.isArray(json?.errors) ? json.errors.map((e: any) => e?.message).filter(Boolean) : [];
  return messages.length > 0 ? messages.join("; ") : "no result";
}

// --- Usage-ledger math (pure: no fs, no network, so `npm test` can check it) ---
// This package's ledger and the older pi-typesafe one count the same requests under different names.
export interface DayTotals {
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Free-tier units spent (Cloudflare neurons). Absent on entries written before this counter existed. */
  neurons?: number;
  /** Per-provider split, so one panel can separate Jev from Clef. Absent on entries written before it existed. */
  providers?: Record<string, ProviderTotals>;
}

/** One provider's share of a period. Neurons are metered only by Cloudflare; other providers stay at 0. */
export interface ProviderTotals {
  requests: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  neurons: number;
}

/** The numeric counters, named once: every fold iterates this rather than Object.keys(DayTotals). */
const DAY_COUNTERS = ["requests", "ok", "failed", "inputTokens", "outputTokens", "cost"] as const;
const PROVIDER_COUNTERS = [...DAY_COUNTERS, "neurons"] as const;

export const EMPTY_TOTALS: DayTotals = { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
export const EMPTY_PROVIDER_TOTALS: ProviderTotals = {
  requests: 0,
  ok: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
  neurons: 0,
};
export const USD_PER_MTOK = 0.042; // mirrors pi-typesafe's default input-token rate

export function normalizeProviderTotals(raw: any): ProviderTotals {
  const totals = { ...EMPTY_PROVIDER_TOTALS };
  for (const key of PROVIDER_COUNTERS) totals[key] = Number(raw?.[key]) || 0;
  return totals;
}

/** The per-provider map of one period, or undefined when the entry predates provider attribution. */
export function normalizeProviders(raw: any): Record<string, ProviderTotals> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const providers: Record<string, ProviderTotals> = {};
  for (const [id, value] of Object.entries(raw)) providers[id] = normalizeProviderTotals(value);
  return Object.keys(providers).length > 0 ? providers : undefined;
}

/** Fold one provider's patch into a period map. Used on write, and when ledgers or days are merged. */
export function addProviderTotals(
  into: Record<string, ProviderTotals> | undefined,
  id: string,
  value: Partial<ProviderTotals>,
): Record<string, ProviderTotals> {
  const next = { ...(into ?? {}) };
  const current = next[id] ?? { ...EMPTY_PROVIDER_TOTALS };
  const patch: Record<string, number> = {};
  for (const key of PROVIDER_COUNTERS) patch[key] = current[key] + (Number(value[key]) || 0);
  next[id] = normalizeProviderTotals(patch);
  return next;
}

/** A missing counter reads as 0; an entry written before the cost field existed is estimated instead of shown as free. */
export function normalizeTotals(raw: any): DayTotals {
  const totals: DayTotals = { ...EMPTY_TOTALS };
  for (const key of DAY_COUNTERS) totals[key] = Number(raw?.[key]) || 0;
  if (raw?.cost === undefined && totals.inputTokens > 0) totals.cost = (totals.inputTokens * USD_PER_MTOK) / 1e6;
  if (Number.isFinite(Number(raw?.neurons))) totals.neurons = Number(raw.neurons);
  const providers = normalizeProviders(raw?.providers);
  if (providers) totals.providers = providers;
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
  const merged: DayTotals = { ...a };
  for (const key of DAY_COUNTERS) merged[key] = a[key] + b[key];
  if (a.neurons !== undefined || b.neurons !== undefined) merged.neurons = (a.neurons ?? 0) + (b.neurons ?? 0);
  for (const [id, totals] of Object.entries(b.providers ?? {})) {
    merged.providers = addProviderTotals(merged.providers, id, totals);
  }
  return merged;
}

/** Every entry of `days` whose date starts with `period` (a day "2026-09-20", a month "2026-09", or "" for all time), summed. */
export function sumDays(days: any, period: string, mapper: (raw: any) => DayTotals): DayTotals | undefined {
  if (!days || typeof days !== "object") return undefined;
  let found = false;
  const totals: DayTotals = { ...EMPTY_TOTALS };
  for (const [date, value] of Object.entries(days)) {
    if (!date.startsWith(period)) continue;
    found = true;
    const day = mapper(value);
    for (const key of DAY_COUNTERS) totals[key] += day[key];
    if (day.neurons !== undefined) totals.neurons = (totals.neurons ?? 0) + day.neurons;
    for (const [id, provider] of Object.entries(day.providers ?? {})) {
      totals.providers = addProviderTotals(totals.providers, id, provider);
    }
  }
  return found ? totals : undefined;
}

/** Clef is one provider id on disk under two model names; the panel labels it as one backend. */
export const CLEF_PROVIDER_ID = "cloudflare";

/**
 * Split a period's per-provider map into the two backends the panel shows side by side: Clef
 * (Cloudflare) and every other Jev provider (TypeSafe, OpenRouter, legacy). One pass, no second read.
 */
export function backendTotals(
  providers: Record<string, ProviderTotals> | undefined,
): { clef: ProviderTotals; jev: ProviderTotals } {
  let clef = { ...EMPTY_PROVIDER_TOTALS };
  let jev = { ...EMPTY_PROVIDER_TOTALS };
  for (const [id, raw] of Object.entries(providers ?? {})) {
    const totals = normalizeProviderTotals(raw);
    const target = id === CLEF_PROVIDER_ID ? clef : jev;
    for (const key of PROVIDER_COUNTERS) target[key] += totals[key];
  }
  return { clef, jev };
}

/**
 * Neurons already billed on a date. The free allowance is per calendar day, so only today's count
 * against it — a month total would show a budget that has already reset.
 */
export function neuronsSpentOn(days: any, date: string): number {
  return sumDays(days, date, normalizeTotals)?.neurons ?? 0;
}

/** How much of the free daily allowance is left, and what the overage would cost. */
export function clefBudget(neuronsToday: number): { used: number; free: number; remaining: number; overageUsd: number } {
  const used = Math.max(0, Number(neuronsToday) || 0);
  const remaining = Math.max(0, CLEF_FREE_NEURONS_PER_DAY - used);
  const over = Math.max(0, used - CLEF_FREE_NEURONS_PER_DAY);
  return { used, free: CLEF_FREE_NEURONS_PER_DAY, remaining, overageUsd: (over / 1000) * CLEF_USD_PER_KN };
}

/**
 * The on-disk credential store, version 2.
 *
 * v1 held exactly one credential at the top level (`{version:1, provider, apiKey, model?, accountId?}`),
 * and every login overwrote it — so logging in with Clef silently discarded a TypeSafe key. v2 keeps one
 * entry per provider id, which is what lets several backends stay logged in and lets logout target one.
 * A v1 file is migrated on read; nothing else in the file needs to change.
 */
export interface StoredCredential {
  apiKey: string;
  model?: string;
  accountId?: string;
}

export interface AuthStore {
  version: 2;
  providers: Record<string, StoredCredential>;
}

/** Keep only entries that carry a usable key, so a half-written store cannot resolve to an empty key. */
export function normalizeCredential(raw: any): StoredCredential | undefined {
  const apiKey = typeof raw?.apiKey === "string" ? raw.apiKey.trim() : "";
  if (!apiKey) return undefined;
  const credential: StoredCredential = { apiKey };
  if (typeof raw?.model === "string" && raw.model.trim()) credential.model = raw.model.trim();
  if (typeof raw?.accountId === "string" && raw.accountId.trim()) credential.accountId = raw.accountId.trim();
  return credential;
}

/**
 * Read a store of any known shape into v2. A v1 file's single credential becomes `providers[provider]`;
 * an unknown or broken shape reads as empty rather than throwing, so a corrupt file never wedges the gate.
 */
export function migrateAuthStore(raw: any): { store: AuthStore; migratedFromV1: boolean } {
  const providers: Record<string, StoredCredential> = {};
  const from = raw?.providers;
  if (from && typeof from === "object" && !Array.isArray(from)) {
    for (const [id, value] of Object.entries(from)) {
      const credential = normalizeCredential(value);
      if (credential) providers[id] = credential;
    }
    return { store: { version: 2, providers }, migratedFromV1: false };
  }
  const legacy = normalizeCredential(raw);
  const id = typeof raw?.provider === "string" && raw.provider.trim() ? raw.provider.trim() : "";
  if (legacy && id) providers[id] = legacy;
  return { store: { version: 2, providers }, migratedFromV1: Boolean(legacy && id) };
}

/** Add or replace one provider's credential, leaving every other provider untouched. */
export function putCredential(store: AuthStore, id: string, credential: StoredCredential): AuthStore {
  const normalized = normalizeCredential(credential);
  if (!normalized) return store;
  return { version: 2, providers: { ...store.providers, [id]: normalized } };
}

/** Remove the given provider ids; ids that are not stored are ignored. */
export function removeCredentials(store: AuthStore, ids: string[]): AuthStore {
  const providers = { ...store.providers };
  for (const id of ids) delete providers[id];
  return { version: 2, providers };
}

/** Provider ids that hold a credential, in store order (callers map them to labels). */
export const storedProviderIds = (store: AuthStore): string[] => Object.keys(store.providers);

export const VERIFICATION_COMMAND_PATTERNS = [
  /\b(npm|pnpm|bun|yarn)\s+(test|run\s+(test|typecheck|lint|build|check))\b/i,
  /\b(cargo\s+(test|check))\b/i,
  /\b(pytest|mypy|ruff\s+check)\b/i,
  /\b(go\s+(test|vet))\b/i,
  /\bvitest\b/i,
];
