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

/** Theme slot for a thinking level. Pi defines one `thinking*` token per level in every theme, so the
 *  border follows the theme instead of a hardcoded palette. A level the theme lacks falls back to `off`. */
export function thinkingColorSlot(level: string | undefined): string {
  switch ((level ?? "off").toLowerCase()) {
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    case "max":
      return "thinkingMax";
    default:
      return "thinkingOff";
  }
}

// --- Status-panel rows (pure: the caller paints, this only lays the columns out) ---
/** Painter for one status row: a theme token plus its text. Handed in, so the layout stays pure. */
export type StatusPainter = (token: string, text: string) => string;

/**
 * One `/jev-eye status` row: `Label · STATUS | detail · detail`.
 *
 * The label is padded to `column` so every `·` divider lands in the same column, exactly like the
 * list menus. The status word carries its own token (`success` on, `muted` idle, `warning` broken),
 * so a glance down the left column answers "is it on?" without reading the details.
 */
export function statusRow(
  label: string,
  status: string,
  details: (string | false | undefined)[],
  paint: StatusPainter = (_token, text) => text,
  statusToken = "muted",
  column = 14
): string {
  const divider = paint("dim", "·");
  const head = `${paint("dim", label.padEnd(Math.max(label.length, column)))}${divider} `;
  const body = details.filter(Boolean).join(paint("dim", " · "));
  const tail = body ? `${paint("dim", "|")} ${body}` : "";
  return `${head}${paint(statusToken, status)}${tail ? ` ${tail}` : ""}`;
}

// --- Arnative box chrome (pure: hand the theme's fg function in, so `npm test` needs no pi-tui) ---
// Same glyphs as `@bismawy/pi-arnative` lib/box.ts: round corners, one content row per item. Border
// colour is a parameter because arnative themes have a soft token while built-in themes only have accent.
export type BoxTheme = { fg(color: string, text: string): string };

/**
 * The first token of `tokens` the theme actually defines, or undefined when it defines none. Every
 * `theme.fg` throws on an unknown token (`Unknown theme color: tint`), so a token has to be probed
 * before it is used — `accentSoft` and `tint` exist only in arnative themes, and the live theme
 * picker makes the built-in ones reachable.
 */
function firstToken(fg: (color: string, text: string) => string, tokens: string[]): string | undefined {
  return tokens.find((token) => {
    try {
      fg(token, "");
      return true;
    } catch {
      return false;
    }
  });
}

/** A painter for one probed token; identity when the theme defines none of them. */
const tokenPainter = (theme: BoxTheme | null | undefined, tokens: string[]): ((text: string) => string) => {
  const fg = theme?.fg?.bind(theme);
  const token = fg ? firstToken(fg, tokens) : undefined;
  return token && fg ? (text) => fg(token, text) : (text) => text;
};

/**
 * The box border: the arnative soft tint where the theme has it, otherwise the session's thinking
 * slot. `thinking*` exists in every theme (`ThemeColor`), so a built-in theme keeps a coloured frame
 * that still follows the reasoning effort; with no theme at all the border is uncoloured. */
export function borderPainter(theme: BoxTheme | null | undefined, thinkingLevel?: string): (text: string) => string {
  return tokenPainter(theme, ["accentSoft", thinkingColorSlot(thinkingLevel), "accent"]);
}

/**
 * Painter for a chosen row's body — the arnative rule: the `→` marker keeps the accent, the text moves
 * to the soft tint. `accentSoft` is arnative-only, so fall back to `thinkingText` (which every theme
 * defines, unlike `tint`) and then to `accent`. */
export function chosenRowPainter(theme: BoxTheme | null | undefined): (text: string) => string {
  return tokenPainter(theme, ["accentSoft", "thinkingText", "accent"]);
}

/** `╭───╮` / `╰───╯`. Width holds at 1-2 because a line shorter than the frame beats a downshifted one. */
export function boxEdge(left: string, right: string, width: number, paint: (text: string) => string = (text) => text): string {
  return paint(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
}

/**
 * `│ text │` for one already-styled row. Visible width is computed from the already-styled string
 * because layer1 must stay free of pi-tui imports.
 */
export function boxRow(content: string, width: number, paint: (text: string) => string = (text) => text): string {
  // Two walls, two spaces and one content column need four; below that a blank line beats an overflowing one.
  if (width < 4) return "";
  return `${paint("│")} ${content}${" ".repeat(Math.max(0, width - visibleWidth(content) - 3))}${paint("│")}`;
}

/**
 * Wrap already-styled rows in the rounded frame: one top edge, one row per line, one bottom edge.
 * Rows must already be truncated to `width - 4`; this only adds the walls.
 */
export function boxFrame(rows: string[], width: number, paint: (text: string) => string = (text) => text): string[] {
  return [boxEdge("╭", "╮", width, paint), ...rows.map((row) => boxRow(row, width, paint)), boxEdge("╰", "╯", width, paint)];
}

/**
 * Word-wrap plain text to `width` columns. An explicit newline stays a break (so a caller can pass a
 * pre-composed multi-line hint), and a word wider than the row stays whole for the caller to truncate
 * rather than being cut here. Always returns at least one row, so a line in the frame is never lost.
 */
export function wrapWords(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const paragraph of String(text).split("\n")) {
    let row = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = row ? `${row} ${word}` : word;
      if (row && visibleWidth(candidate) > width) {
        rows.push(row);
        row = word;
        continue;
      }
      row = candidate;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Pack footer pairs into rows that fit `width` columns, two spaces between pairs and never inside one.
 * A legend longer than the screen wraps onto the next row instead of being truncated — a key that is
 * advertised but invisible is a key the operator never learns.
 */
export function packPairs(pairs: string[], width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const pair of pairs) {
    const candidate = row ? `${row}  ${pair}` : pair;
    if (row && visibleWidth(candidate) > width) {
      rows.push(row);
      row = pair;
      continue;
    }
    row = candidate;
  }
  if (row) rows.push(row);
  return rows;
}

/** ANSI escape sequences (CSI, OSC, and single-character escapes) — they occupy no terminal columns. */
const ANSI_ESCAPE = /\x1b(?:\[[0-9;:?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Terminal columns of a styled string: strip ANSI, then count full-width glyphs as two (East Asian W/F). */
export function visibleWidth(text: string): number {
  let wide = 0;
  for (const char of text.replace(ANSI_ESCAPE, "")) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x20000 && code <= 0x3fffd))) wide += 1;
  }
  return [...text.replace(ANSI_ESCAPE, "")].length + wide;
}
