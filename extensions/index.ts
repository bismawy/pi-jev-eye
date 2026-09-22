import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Input, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

interface EyeState {
  enabled: boolean;
  semanticGate: boolean;
  modifiedFilesThisTurn: boolean;
  verifiedThisTurn: boolean;
  stats: {
    destructiveBlocked: number;
    secretsBlocked: number;
    slopBlocked: number;
    verificationReminders: number;
    jevRequests: number;
    jevRoutingCalls: number;
    lightTurns: number;
    heavyTurns: number;
    reviewTurns: number;
  };
  pendingReview?: string;
}

const state: EyeState = {
  enabled: true,
  semanticGate: true,
  modifiedFilesThisTurn: false,
  verifiedThisTurn: false,
  stats: {
    destructiveBlocked: 0,
    secretsBlocked: 0,
    slopBlocked: 0,
    verificationReminders: 0,
    jevRequests: 0,
    jevRoutingCalls: 0,
    lightTurns: 0,
    heavyTurns: 0,
    reviewTurns: 0,
  },
};

// --- Layer 1: Local Regex Patterns (0 ms, 0 Token) ---
// A wipe is judged per path argument, not by "the command mentions / somewhere": the old all-absolute-paths rule
// blocked `rm -rf /tmp/scratch` while a regex quirk made it block `git push --force origin feature/x` too.
// Catastrophic = root, a whole top-level dir (/usr, /tmp, /home), a system dir near the top (/var/log),
// home in any form (~, ~/x, $HOME/x), a parent hop, or a top-level glob (/home/*). Everything deeper is scoped.
const SYSTEM_ROOT_DIRS = new Set(["etc", "usr", "var", "boot", "bin", "sbin", "lib", "lib64", "opt", "srv", "root", "sys", "proc", "dev"]);

/** Returns the offending path argument when the command is a filesystem wipe, otherwise null. */
function wipeTarget(command: string): string | null {
  const match = /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--recursive\s+--force\s+)+([^;&|]*)/.exec(command);
  if (!match) return null;

  for (const raw of match[1].trim().split(/\s+/)) {
    const target = raw.replace(/^["']|["']$/g, "");
    if (!target) continue;

    if (/^(?:~|\$\{?HOME\}?)(?:\/|$)/.test(target)) return target;
    if (/^\.\.(?:\/\.\.)*\/?$/.test(target)) return target;
    if (!target.startsWith("/")) continue;

    const segments = target.split("/").filter(Boolean);
    if (segments.length <= 1) return target; // / , /* , /usr , /tmp , /home
    if (SYSTEM_ROOT_DIRS.has(segments[0])) return target; // /var/log , /usr/lib/x — nothing inside a system dir is a scoped delete
    if (segments.length === 2 && segments[1].includes("*")) return target; // /home/* , /tmp/*
  }

  return null;
}

const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+.*--no-preserve-root\b/i,
  /\bgit\s+push\s+.*--force.*(main|master)\b/i,
  /\bgit\s+push\s+-f\s+.*(main|master)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(DATABASE|TABLE)\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bghp_[a-zA-Z0-9]{20,}\b/,
  /\bgho_[a-zA-Z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z-_]{35}\b/,
  /-----BEGIN\s+(RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----/,
];

const VERIFICATION_COMMAND_PATTERNS = [
  /\b(npm|pnpm|bun|yarn)\s+(test|run\s+(test|typecheck|lint|build|check))\b/i,
  /\b(cargo\s+(test|check))\b/i,
  /\b(pytest|mypy|ruff\s+check)\b/i,
  /\b(go\s+(test|vet))\b/i,
  /\bvitest\b/i,
];

// --- Layer 3: Jev accounts (pi-typesafe is optional; /jev-eye login owns its own key) ---
interface JevProvider {
  id: "typesafe" | "openrouter";
  label: string;
  url: string;
  model: string;
  keyEnv: string;
  keyHint: string;
}

const JEV_PROVIDERS: JevProvider[] = [
  {
    id: "typesafe",
    label: "TypeSafe account",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    keyEnv: "TYPESAFE_API_KEY",
    keyHint: "console.typesafe.ai > API Keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter account",
    url: "https://openrouter.ai/api/alpha/decisions", // OpenRouter's System One route (same request/response shape)
    model: "typesafe/jev-1.13",
    keyEnv: "OPENROUTER_API_KEY",
    keyHint: "openrouter.ai/settings/keys",
  },
];

const EYE_DIR = join(homedir(), ".pi", "agent", "pi-jev-eye");
const AUTH_PATH = join(EYE_DIR, "auth.json");
const OWN_USAGE_PATH = join(EYE_DIR, "usage.json");
const LEGACY_AUTH_PATH = join(homedir(), ".pi", "agent", "pi-typesafe", "auth.json");
const USD_PER_MTOK = 0.042; // mirrors pi-typesafe's default input-token rate

const providerById = (id: string): JevProvider | undefined => JEV_PROVIDERS.find((p) => p.id === id);

// Refuse a key file other local users can read, exactly like pi-typesafe does.
function keyFileIsPrivate(path: string): boolean {
  try {
    return process.platform === "win32" || (statSync(path).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** Key files must be owner-only; usage ledgers are not secrets and are read regardless of mode. */
function readJsonFile(path: string, requirePrivate = false): any | undefined {
  try {
    if (requirePrivate && !keyFileIsPrivate(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

interface JevAuth {
  provider: JevProvider;
  key: string;
  source: string; // where the key came from; shown in status, never the key itself
}

function resolveJevAuth(): JevAuth | undefined {
  // Environment first: an explicit export (headless run, CI, shared machine) must win over a stored key,
  // the same precedence pi-typesafe uses.
  for (const provider of JEV_PROVIDERS) {
    const fromEnv = process.env[provider.keyEnv]?.trim();
    if (fromEnv) return { provider, key: fromEnv, source: `$${provider.keyEnv}` };
  }

  const stored = readJsonFile(AUTH_PATH, true);
  const storedKey = typeof stored?.apiKey === "string" ? stored.apiKey.trim() : "";
  if (storedKey) {
    return { provider: providerById(String(stored.provider)) ?? JEV_PROVIDERS[0], key: storedKey, source: "/jev-eye login" };
  }

  // Back-compat: keep working for anyone who already logged in with pi-typesafe installed.
  const legacy = readJsonFile(LEGACY_AUTH_PATH, true);
  const legacyKey = typeof legacy?.apiKey === "string" ? legacy.apiKey.trim() : "";
  if (legacyKey) return { provider: JEV_PROVIDERS[0], key: legacyKey, source: "pi-typesafe login" };

  return undefined;
}

const isPlausibleKey = (key: string): boolean =>
  key.length >= 16 && key.length <= 512 && !/\s/.test(key) && /^[\x21-\x7e]+$/.test(key);

/** One tiny request: proves the key AND that the route works, before anything is saved. */
async function probeJev(provider: JevProvider, key: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: provider.model,
        state: { probe: "connectivity check from pi-jev-eye login" },
        questions: {
          reachable: {
            type: "noul",
            instructions: "Is `state.probe` a deliberate connectivity check rather than real user content?",
          },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, detail: `the provider rejected the key (HTTP ${res.status})` };
    }
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${provider.url}` };
    const json: any = await res.json();
    if (typeof json?.answers?.reachable?.noul !== "number") return { ok: false, detail: "unexpected answer shape" };
    return { ok: true, detail: `answer received from ${json?.model ?? provider.model}` };
  } catch (error) {
    return { ok: false, detail: `could not reach ${provider.url} (${(error as Error)?.message ?? "network error"})` };
  }
}

/** Single-line input that renders bullets instead of the typed key. */
class SecretInput extends Input {
  render(width: number): string[] {
    const length = [...this.getValue()].length;
    const bullets = "•".repeat(Math.min(length, Math.max(0, width - 2)));
    const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : "";
    return [truncateToWidth(bullets + cursor, width, "")];
  }
}

class SecretPrompt extends Container {
  private input = new SecretInput();
  isFocused = false;

  constructor(theme: any, title: string, hint: string, done: (value?: string) => void) {
    super();
    this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    this.addChild(new Text(theme.fg("muted", hint), 1, 0));
    this.addChild(this.input);
    this.input.onSubmit = (value) => done(value);
    this.input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.input.onEscape?.();
      return;
    }
    this.input.handleInput(data);
  }
}

async function promptForSecret(ctx: any, provider: JevProvider): Promise<string | undefined> {
  const title = `${provider.label} API key`;
  const hint = `Paste the key from ${provider.keyHint}. Enter verifies and saves, Esc cancels.`;
  if (typeof ctx.ui.custom === "function") {
    try {
      return await ctx.ui.custom((_tui: any, theme: any, _keys: any, done: (value?: string) => void) =>
        new SecretPrompt(theme, title, hint, done)
      );
    } catch {
      // Any custom-UI failure falls back to the plain dialog rather than losing the flow
    }
  }
  return ctx.ui.input(`${title} (visible while typing)`, hint);
}

const loginFlow = async (ctx: any): Promise<void> => {
  const labels = JEV_PROVIDERS.map((p) => `${p.label}  ·  key from ${p.keyHint}`);
  const choice = await ctx.ui.select("pi-jev-eye · where is your Jev key from?", labels);
  if (!choice) return;

  const provider = JEV_PROVIDERS[labels.indexOf(choice)] ?? JEV_PROVIDERS[0];
  const entered = await promptForSecret(ctx, provider);
  if (entered === undefined) return;

  const key = entered.trim();
  if (!isPlausibleKey(key)) {
    ctx.ui.notify("[pi-jev-eye] That does not look like an API key (16-512 chars, no spaces). Nothing was saved.", "error");
    return;
  }

  ctx.ui.notify(`[pi-jev-eye] Checking the key against ${provider.label}…`, "info");
  const probe = await probeJev(provider, key);
  if (!probe.ok) {
    ctx.ui.notify(`[pi-jev-eye] Login failed: ${probe.detail}. Nothing was saved.`, "error");
    return;
  }

  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(AUTH_PATH, `${JSON.stringify({ version: 1, provider: provider.id, apiKey: key }, null, 2)}\n`, {
    mode: 0o600,
  });
  const shadows = process.env[provider.keyEnv]?.trim() ? ` Note: $${provider.keyEnv} is set and takes precedence over this stored key.` : "";
  ctx.ui.notify(
    `[pi-jev-eye] Logged in via ${provider.label}: ${probe.detail}. Stored in ${AUTH_PATH} (0600).${shadows}`,
    "info"
  );
};

const logoutFlow = async (ctx: any): Promise<void> => {
  const stored = readJsonFile(AUTH_PATH, true);
  const fromEnv = JEV_PROVIDERS.filter((p) => process.env[p.keyEnv]?.trim()).map((p) => `$${p.keyEnv}`);
  const kept = fromEnv.length ? ` ${fromEnv.join(", ")} stays and keeps working.` : "";

  if (!stored?.apiKey) {
    ctx.ui.notify(`[pi-jev-eye] No key from /jev-eye login to remove.${kept}`, "warning");
    return;
  }

  const confirmed = await ctx.ui.confirm("Log out of pi-jev-eye?", `Delete ${AUTH_PATH}?${kept}`);
  if (!confirmed) return;

  try {
    unlinkSync(AUTH_PATH);
    ctx.ui.notify("[pi-jev-eye] Logged out; the stored key was deleted.", "info");
  } catch (error) {
    ctx.ui.notify(`[pi-jev-eye] Could not delete ${AUTH_PATH}: ${(error as Error).message}`, "error");
  }
};

// Our own usage ledger: pi-jev-eye stands alone, nothing is read from other packages for display.
type DayTotals = { requests: number; ok: number; failed: number; inputTokens: number; outputTokens: number; cost: number };
const EMPTY_TOTALS: DayTotals = { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0 };

const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** A missing counter reads as 0; an entry written before the cost field existed is estimated instead of shown as free. */
function normalizeTotals(raw: any): DayTotals {
  const totals = { ...EMPTY_TOTALS };
  for (const key of Object.keys(totals) as (keyof DayTotals)[]) totals[key] = Number(raw?.[key]) || 0;
  if (raw?.cost === undefined && totals.inputTokens > 0) totals.cost = (totals.inputTokens * USD_PER_MTOK) / 1e6;
  return totals;
}

function readOwnUsage(): DayTotals | undefined {
  const raw = readJsonFile(OWN_USAGE_PATH)?.days?.[today()];
  return raw ? normalizeTotals(raw) : undefined;
}

/** Every day in the ledger that belongs to the current calendar month. */
function readMonthUsage(): DayTotals | undefined {
  const days = readJsonFile(OWN_USAGE_PATH)?.days;
  if (!days || typeof days !== "object") return undefined;
  const prefix = today().slice(0, 7);
  const totals = { ...EMPTY_TOTALS };
  let found = false;
  for (const [date, value] of Object.entries(days)) {
    if (!date.startsWith(prefix)) continue;
    found = true;
    const dayTotals = normalizeTotals(value);
    for (const key of Object.keys(totals) as (keyof DayTotals)[]) totals[key] += dayTotals[key];
  }
  return found ? totals : undefined;
}

function recordOwnUsage(patch: Partial<DayTotals>): void {
  try {
    const file = readJsonFile(OWN_USAGE_PATH) ?? { version: 1, days: {} };
    const days = file.days && typeof file.days === "object" ? file.days : {};
    // A day started by an older version has tokens but no cost; seed the estimate once, or today's total
    // would keep counting tokens while the cost stays behind.
    const stored = days[today()];
    const seeded =
      stored && stored.cost === undefined
        ? { ...stored, cost: ((Number(stored.inputTokens) || 0) * USD_PER_MTOK) / 1e6 }
        : stored;
    const current: DayTotals = { ...EMPTY_TOTALS, ...seeded };
    for (const [key, value] of Object.entries(patch)) {
      (current as any)[key] = (Number((current as any)[key]) || 0) + (Number(value) || 0);
    }
    days[today()] = current;
    for (const day of Object.keys(days).sort().slice(0, -31)) delete days[day];
    mkdirSync(EYE_DIR, { recursive: true });
    writeFileSync(OWN_USAGE_PATH, `${JSON.stringify({ version: 1, days }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Stats must never break a judgment call.
  }
}

// Account balance: only OpenRouter exposes one; TypeSafe's API has no balance route (every /v1/* guess 404s).
let balanceCache: { provider: string; at: number; text: string } | undefined;

async function fetchBalanceText(auth: JevAuth): Promise<string> {
  const usd = (value: number) => `$${value.toFixed(4)}`;
  const get = (path: string) =>
    fetch(`https://openrouter.ai/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${auth.key}` },
      signal: AbortSignal.timeout(4000),
    });

  if (auth.provider.id !== "openrouter") return "not exposed by api.typesafe.ai (spend above is ledger-based)";

  try {
    const keyRes = await get("key");
    if (keyRes.ok) {
      const data: any = (await keyRes.json())?.data;
      const used = Number(data?.usage);
      const limit = data?.limit === null || data?.limit === undefined ? undefined : Number(data.limit);
      const remaining = data?.limit_remaining === null || data?.limit_remaining === undefined ? undefined : Number(data.limit_remaining);
      if (Number.isFinite(remaining)) {
        return `${usd(remaining as number)} left${Number.isFinite(limit) ? ` of ${usd(limit as number)}` : " on this key"}${Number.isFinite(used) ? ` (used ${usd(used)})` : ""}`;
      }
      if (Number.isFinite(used)) return `no per-key limit set; ${usd(used)} used on this key`;
    }

    const creditsRes = await get("credits");
    if (creditsRes.ok) {
      const data: any = (await creditsRes.json())?.data;
      const total = Number(data?.total_credits);
      const used = Number(data?.total_usage);
      if (Number.isFinite(total) && Number.isFinite(used)) return `${usd(total - used)} left of ${usd(total)} (used ${usd(used)})`;
    }

    return `unavailable (HTTP ${keyRes.status} from /api/v1/key)`;
  } catch (error) {
    return `unavailable (${(error as Error)?.message ?? "network error"})`;
  }
}

async function balanceText(auth: JevAuth | undefined): Promise<string> {
  if (!auth) return "no account — run `/jev-eye login`";
  const now = Date.now();
  if (balanceCache && balanceCache.provider === auth.provider.id && now - balanceCache.at < 300_000) {
    return balanceCache.text;
  }
  const text = await fetchBalanceText(auth);
  balanceCache = { provider: auth.provider.id, at: now, text };
  return text;
}

// --- Explicit review request: the operator writes `jev` (or @jev, /jev-review) to open one reviewed turn ---
// Word-boundary guard: `pi-jev-eye` and `jev-eye` must NOT trigger this.
const REVIEW_TRIGGER = /(?<![-\w])@?jev(?![\w-])|\/jev-review\b/i;

// The injected contract is what makes the reply arrive in the report shape this workflow already uses.
const REVIEW_CONTRACT = [
  "[pi-jev-eye] The operator asked for a Jev review of this turn.",
  "Answer in the report format already used in this workflow, in the operator's language:",
  "1. machine-verified facts first (tool output, counts, exit codes) with no judgment mixed in,",
  "2. then a Jev table: one row per item per dimension, every number as `value (probability)` plus its level label,",
  "3. then the threshold line that turns those numbers into a decision,",
  "4. keep judgment and fact in separate blocks; never present a Jev probability as proof.",
  "The write gate will also judge this turn's code against the request text.",
].join("\n");

// --- Per-turn model routing: cheap model for chores, best model for real review ---
interface Routing {
  enabled: boolean;
  light: string; // "provider/modelId" as listed by ctx.modelRegistry.getAvailable()
  heavy: string;
}

const ROUTING_PATH = join(EYE_DIR, "routing.json");
const JEV_MAX_ROUTING_CALLS = 20; // own session budget, so routing cannot eat the write gate's quota

function readRouting(): Routing {
  const raw = readJsonFile(ROUTING_PATH);
  return {
    enabled: raw?.enabled === true,
    light: typeof raw?.light === "string" ? raw.light : "",
    heavy: typeof raw?.heavy === "string" ? raw.heavy : "",
  };
}

function writeRouting(routing: Routing): void {
  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(ROUTING_PATH, `${JSON.stringify({ version: 1, ...routing }, null, 2)}\n`, { mode: 0o600 });
}

// Zero-request shortcut: chores need no judgment at all.
const LIGHT_TASK_PATTERNS = [
  /^\s*\/?(commit|push|pull|fetch|status|log|diff|show|branch|checkout|switch|stash|tag|remote|merge|rebase|add)\b/i,
  /\b(git\s+(commit|push|pull|fetch|status|log|diff|stash|branch|tag|remote))\b/i,
  /^\s*(tolong\s+)?(commit|push|pull|sinkron|unggah)\b/i,
];

const isLightByPattern = (prompt: string): boolean => LIGHT_TASK_PATTERNS.some((p) => p.test(prompt));

/** One judgment: is this turn a heavy review or a light chore? Unclear keeps the current model. */
async function classifyWeight(prompt: string, auth: JevAuth): Promise<"light" | "heavy" | "unclear" | null> {
  try {
    state.stats.jevRoutingCalls++;
    const res = await fetch(auth.provider.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.key}` },
      body: JSON.stringify({
        model: auth.provider.model,
        state: { request: { text: prompt.slice(0, 600) } },
        questions: {
          weight: {
            type: "choice",
            instructions:
              "Which kind of turn is `request.text`: a light repository chore, or a task that needs real review and reasoning?",
            criteria: {
              light: "Routine repository or housekeeping action, no design or review involved",
              heavy: "Code, design, debugging, or analysis that needs careful review",
              unclear: "Too short or too vague to tell",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json: any = await res.json();
    const choice = json?.answers?.weight?.choice;
    return choice === "light" || choice === "heavy" || choice === "unclear" ? choice : null;
  } catch {
    return null; // Fail-open: keep the current model
  }
}

// --- Jev gate consent, three values only: Enable all folder / Enable this folder / Disabled ---
type ConsentMode = "all" | "folder" | "disabled";
interface Consent {
  mode: ConsentMode;
  folders: string[];
}

const CONSENT_PATH = join(EYE_DIR, "consent.json");

// Values written by older versions ("folders"/"off") migrate on read; anything unknown falls back to "all",
// which is also what PI_TYPESAFE_ENABLED=1 means for the built-in tool.
function readConsent(): Consent {
  try {
    const parsed = JSON.parse(readFileSync(CONSENT_PATH, "utf8"));
    const raw = String(parsed?.mode ?? "all");
    const mode: ConsentMode = raw === "disabled" || raw === "off" ? "disabled" : raw === "folder" || raw === "folders" ? "folder" : "all";
    const folders = Array.isArray(parsed?.folders) ? parsed.folders.filter((f: unknown) => typeof f === "string") : [];
    // "this folder" with no folder left has nothing to run in, so it reads as Disabled instead of a puzzling empty list.
    return { mode: mode === "folder" && folders.length === 0 ? "disabled" : mode, folders };
  } catch {
    return { mode: "all", folders: [] };
  }
}

function writeConsent(consent: Consent): void {
  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(CONSENT_PATH, `${JSON.stringify({ version: 1, ...consent }, null, 2)}\n`, { mode: 0o600 });
}

function consentAllows(cwd: string, consent: Consent): boolean {
  if (consent.mode === "all") return true;
  if (consent.mode === "disabled") return false;
  return consent.folders.some((f) => cwd === f || cwd.startsWith(f.endsWith(sep) ? f : f + sep));
}

function consentLabel(consent: Consent): string {
  if (consent.mode === "all") return "Enable all folder";
  if (consent.mode === "disabled") return "Disabled";
  return `Enable this folder (${consent.folders.length})`;
}

// --- Layer 3 budget & thresholds (Jev usage discipline) ---
const JEV_MIN_DIFF_LINES = 10; // Skip tiny diffs: the same question repeated per write is what burns the quota
const JEV_BLOCK_THRESHOLD = 0.85; // P(yes) needed to block a write
const JEV_MAX_REQUESTS = 20; // Hard per-session cap: one request = all dimensions, never one per question
const JEV_MAX_STATE_CHARS = 4000; // Pruned state (signal over noise), far below the 64 KiB limit
const JEV_TIMEOUT_MS = 5000;

// Machine-checkable facts first: Jev judges, it does not verify.
function codeFacts(code: string) {
  return {
    lines: code.split("\n").length,
    placeholder_markers: (code.match(/\b(?:TODO|FIXME|XXX|not implemented|NotImplementedError)\b/gi) ?? []).length,
    empty_bodies: (code.match(/\{\s*\}/g) ?? []).length,
    ellipsis_only_lines: (code.match(/^\s*\.\.\.\s*$/gm) ?? []).length,
  };
}

interface JevVerdict {
  has_slop: number | null;
  has_unfinished_todo: number | null;
  answers_request: number | null;
}

// Two independent dimensions, batched into ONE request.
async function askJev(codeSnippet: string, auth: JevAuth): Promise<JevVerdict | null> {
  try {
    const request = state.pendingReview;
    const questions: Record<string, any> = {
      has_slop: {
        type: "noul",
        instructions:
          "Does `code` contain a lazy stub, an empty body, or a placeholder standing in for real logic? `facts` are machine-counted and are not proof either way.",
      },
      has_unfinished_todo: {
        type: "noul",
        instructions:
          "Does `code` leave work explicitly unfinished, such that callers of this code would hit a missing implementation? `facts.placeholder_markers` and `facts.ellipsis_only_lines` are machine-counted.",
      },
    };
    // A reviewed turn adds one dimension to the SAME request, so the review costs no extra call.
    if (request) {
      questions.answers_request = {
        type: "noul",
        instructions:
          "Does `code` plausibly fulfil `request.text` rather than only touching adjacent code? Treat `code` as the whole change under review.",
      };
    }

    const payload = {
      model: auth.provider.model,
      state: {
        code: codeSnippet.slice(0, JEV_MAX_STATE_CHARS),
        facts: codeFacts(codeSnippet),
        ...(request ? { request: { text: request } } : {}),
      },
      questions,
    };

    state.stats.jevRequests++;
    const res = await fetch(auth.provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });

    if (!res.ok) {
      recordOwnUsage({ requests: 1, failed: 1 });
      return null;
    }
    const json: any = await res.json();
    const inputTokens = Number(json?.usage?.input_tokens) || 0;
    const reportedCost = Number(json?.usage?.cost); // OpenRouter reports real cost; TypeSafe does not
    recordOwnUsage({
      requests: 1,
      ok: 1,
      inputTokens,
      outputTokens: Number(json?.usage?.output_tokens) || 0,
      cost: Number.isFinite(reportedCost) ? reportedCost : (inputTokens * USD_PER_MTOK) / 1e6,
    });
    return {
      has_slop: json?.answers?.has_slop?.noul ?? null,
      has_unfinished_todo: json?.answers?.has_unfinished_todo?.noul ?? null,
      answers_request: json?.answers?.answers_request?.noul ?? null,
    };
  } catch {
    recordOwnUsage({ requests: 1, failed: 1 });
    return null; // Fail-open when Jev times out or is offline
  }
}

// on/off moved out of the command: one keybinding toggles it and the footer shows the state live.
const TOGGLE_KEY = "ctrl+shift+e";

function updateStatusBar(ctx: any): void {
  try {
    ctx?.ui?.setStatus?.(
      "pi-jev-eye",
      state.enabled
        ? `supervisor ON · ${TOGGLE_KEY} disables supervisor`
        : `supervisor OFF · ${TOGGLE_KEY} enables supervisor`
    );
  } catch {
    // A session without a status bar must not break the toggle.
  }
}

const EYE_SUBCOMMANDS = [
  { value: "status", label: "status", description: "Show supervisor status, account, usage, and interception stats" },
  { value: "login", label: "login", description: "Store a Jev key: TypeSafe account or OpenRouter account" },
  { value: "logout", label: "logout", description: "Delete the key stored by /jev-eye login" },
];

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => updateStatusBar(ctx));

  // Route the turn before the agent loop starts: chores to the cheap model, real work to the best one.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!state.enabled) return;
    const prompt = String(event?.prompt ?? "");

    // Reviewed turn: remember the request for the gate and inject the report contract for the model.
    const reviewed = REVIEW_TRIGGER.test(prompt);
    if (reviewed) {
      state.pendingReview = prompt.slice(0, 600);
      state.stats.reviewTurns++;
      ctx.ui.notify("[pi-jev-eye] Reviewed turn: report contract injected; the write gate will compare code against this request.", "info");
    }

    const routing = readRouting();
    if (!routing.enabled || !routing.light || !routing.heavy) {
      return reviewed ? { message: { customType: "pi-jev-eye-review", content: REVIEW_CONTRACT, display: true } } : undefined;
    }
    let target: "light" | "heavy" | "unclear" | null = isLightByPattern(prompt) ? "light" : null;

    if (!target) {
      if (state.stats.jevRoutingCalls >= JEV_MAX_ROUTING_CALLS) {
        if (state.stats.jevRoutingCalls === JEV_MAX_ROUTING_CALLS) {
          state.stats.jevRoutingCalls++;
          ctx.ui.notify(
            `[pi-jev-eye] Routing budget used up (${JEV_MAX_ROUTING_CALLS} classifications); keeping the current model.`,
            "warning"
          );
        }
        return;
      }
      const auth = resolveJevAuth();
      if (!auth) return;
      target = await classifyWeight(prompt, auth);
    }

    const contract = reviewed ? { message: { customType: "pi-jev-eye-review", content: REVIEW_CONTRACT, display: true } } : undefined;
    if (target !== "light" && target !== "heavy") return contract;

    const ref = target === "light" ? routing.light : routing.heavy;
    const available: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
    const model = available.find((m) => `${m.provider}/${m.id}` === ref);

    if (!model) {
      ctx.ui.notify(`[pi-jev-eye] Routing target ${ref} is not an available model; keeping the current one.`, "warning");
      return;
    }

    const current = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    if (current === ref) {
      if (target === "light") state.stats.lightTurns++;
      else state.stats.heavyTurns++;
      return;
    }

    const switched = await pi.setModel(model);
    if (switched) {
      if (target === "light") state.stats.lightTurns++;
      else state.stats.heavyTurns++;
      ctx.ui.notify(`[pi-jev-eye] ${target === "light" ? "Light" : "Heavy"} turn → ${ref}`, "info");
    }

    return contract;
  });

  pi.registerShortcut(TOGGLE_KEY, {
    description: "Toggle the pi-jev-eye supervisor",
    handler: async (ctx: any) => {
      state.enabled = !state.enabled;
      updateStatusBar(ctx);
      ctx.ui.notify(
        `[pi-jev-eye] Supervisor ${state.enabled ? "enabled" : "disabled"}. Toggle again with ${TOGGLE_KEY}.`,
        state.enabled ? "info" : "warning"
      );
    },
  });

  // Reset turn tracking
  pi.on("turn_start", () => {
    state.modifiedFilesThisTurn = false;
    state.verifiedThisTurn = false;
  });

  // --- Layer 1 & 3: tool_call interception ---
  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled) return;

    // 1. Check bash
    if (event.toolName === "bash") {
      const cmd = typeof event.input?.command === "string" ? event.input.command : "";

      // Track whether a verification command ran
      if (VERIFICATION_COMMAND_PATTERNS.some((p) => p.test(cmd))) {
        state.verifiedThisTurn = true;
      }

      // Detect destructive actions: filesystem wipes first, then the fixed patterns
      const wiped = wipeTarget(cmd);
      const matched = wiped ? null : DESTRUCTIVE_BASH_PATTERNS.find((pattern) => pattern.test(cmd));
      if (wiped || matched) {
        state.stats.destructiveBlocked++;
        ctx.ui.notify(
          `[pi-jev-eye] BLOCKED: dangerous command detected (${wiped ? `wipe of ${wiped}` : matched})`,
          "error"
        );
        return {
          block: true,
          reason: `[pi-jev-eye] Command blocked for safety: "${cmd}". Destructive actions require explicit user confirmation.`,
          terminate: true,
        };
      }

      // Detect secret leaks in the command arguments
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(cmd)) {
          state.stats.secretsBlocked++;
          ctx.ui.notify("[pi-jev-eye] BLOCKED: API key/secret leak in bash command!", "error");
          return {
            block: true,
            reason: "[pi-jev-eye] Command blocked: an API key or private credential was detected on the command line.",
            terminate: true,
          };
        }
      }
    }

    // 2. Check write & edit
    if (event.toolName === "write" || event.toolName === "edit") {
      state.modifiedFilesThisTurn = true;

      const contentToCheck =
        event.toolName === "write"
          ? String(event.input?.content || "")
          : Array.isArray(event.input?.edits)
          ? event.input.edits.map((e: any) => e.newText || "").join("\n")
          : "";

      // Detect secret leaks in the content about to be written
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(contentToCheck)) {
          state.stats.secretsBlocked++;
          ctx.ui.notify("[pi-jev-eye] BLOCKED: hardcoded secret detected in file!", "error");
          return {
            block: true,
            reason:
              "[pi-jev-eye] File write blocked: never write API keys or credentials into source code. Use environment variables.",
          };
        }
      }

      // Layer 3: Jev semantic gate, only for diffs above the line threshold
      const consent = readConsent();
      if (state.semanticGate && consentAllows(ctx.cwd, consent) && contentToCheck.split("\n").length >= JEV_MIN_DIFF_LINES) {
        const auth = resolveJevAuth();
        if (auth) {
          if (state.stats.jevRequests >= JEV_MAX_REQUESTS) {
            if (state.stats.jevRequests === JEV_MAX_REQUESTS) {
              state.stats.jevRequests++; // notify once, then stay silent
              ctx.ui.notify(
                `[pi-jev-eye] Jev request budget for this session is used up (${JEV_MAX_REQUESTS}); semantic gate now fails open.`,
                "warning"
              );
            }
          } else {
            const verdict = await askJev(contentToCheck, auth);
            const hits = verdict
              ? ([
                  ["has_slop", verdict.has_slop],
                  ["has_unfinished_todo", verdict.has_unfinished_todo],
                  // Not answering the request is only a block signal, never a pass signal.
                  ["answers_request", verdict.answers_request === null ? null : 1 - verdict.answers_request],
                ] as const).filter(([, p]) => p !== null && p >= JEV_BLOCK_THRESHOLD)
              : [];

            if (hits.length > 0) {
              state.stats.slopBlocked++;
              const detail = hits.map(([dim, p]) => `${dim} p=${(p as number).toFixed(2)}`).join(", ");
              ctx.ui.notify(`[pi-jev-eye] JEV BLOCK: ${detail}`, "warning");
              return {
                block: true,
                reason: `[pi-jev-eye] Write blocked by a Jev model judgment (${detail}, threshold p≥${JEV_BLOCK_THRESHOLD}). This is a calibrated estimate, not proof. Finish the implementation before saving.`,
              };
            }
          }
        }
      }
    }
  });

  // --- Layer 2: "Done-Check" state tracker at turn end ---
  pi.on("message_end", async (event, ctx) => {
    if (!state.enabled) return;
    if (event.message.role !== "assistant") return;
    // One-shot: a review request covers the turn it was written in, never later writes.
    state.pendingReview = undefined;

    // Check whether the agent claims completion without verifying
    if (state.modifiedFilesThisTurn && !state.verifiedThisTurn) {
      const text = Array.isArray(event.message.content)
        ? event.message.content.map((c: any) => c.text || "").join(" ")
        : "";

      const claimsDone = /\b(selesai|sudah selesai|done|berhasil diperbaiki|berhasil dibuat|terapkan)\b/i.test(text);

      if (claimsDone) {
        state.stats.verificationReminders++;
        ctx.ui.notify(
          "[pi-jev-eye] Warning: files were modified but no verification (test/lint/build) ran!",
          "warning"
        );
      }
    }
  });

  // --- `/jev-eye` command (alias: `/eye`) ---
  const buildStatus = async (ctx: any): Promise<string> => {
    const auth = resolveJevAuth();
    const consent = readConsent();
    const n = (value: number) => value.toLocaleString("en-US");
    const usd = (value: number) => `$${value.toFixed(6)}`;
    const window = (label: string, period: string, totals: DayTotals | undefined) =>
      totals
        ? `${label.padEnd(8)}${period} · ${totals.requests} requests (${totals.ok} ok / ${totals.failed} failed) · ${n(totals.inputTokens)} in / ${n(totals.outputTokens)} out · ${usd(totals.cost)}`
        : `${label.padEnd(8)}${period} · no requests`;

    const routing = readRouting();
    const lines = [
      "=== pi-jev-eye status ===",
      `Supervisor: ${state.enabled ? "ENABLED" : "DISABLED"}`,
      `Routing: ${routing.enabled ? "ON" : "off"} · light ${routing.light || "unset"} · heavy ${routing.heavy || "unset"} · ${state.stats.lightTurns} light / ${state.stats.heavyTurns} heavy turns · ${Math.min(state.stats.jevRoutingCalls, JEV_MAX_ROUTING_CALLS)}/${JEV_MAX_ROUTING_CALLS} classified`,
      `Jev gate: ${auth ? `READY · ${auth.provider.label} · key from ${auth.source}` : "OFFLINE (no key) — run `/jev-eye login`"}`,
      `  value: ${consentLabel(consent)}${consent.mode === "folder" ? ` → ${consent.folders.join(", ") || "(none)"}` : ""} · this folder ${consentAllows(ctx.cwd, consent) ? "ON" : "off"}`,
      `  p≥${JEV_BLOCK_THRESHOLD} · min ${JEV_MIN_DIFF_LINES} lines · ${Math.min(state.stats.jevRequests, JEV_MAX_REQUESTS)}/${JEV_MAX_REQUESTS} requests this session`,
      "",
      "--- Jev usage ---",
      window("Today", today(), readOwnUsage()),
      window("Month", today().slice(0, 7), readMonthUsage()),
      `Balance ${await balanceText(auth)}`,
      "",
      "--- Interception (this session) ---",
      `blocked ${state.stats.destructiveBlocked} dangerous · ${state.stats.secretsBlocked} secrets · ${state.stats.slopBlocked} Jev slop · ${state.stats.verificationReminders} unverified-done warnings · ${state.stats.reviewTurns} reviewed turns`,
    ];

    const contextTokens = ctx?.getContextUsage?.()?.tokens;
    if (typeof contextTokens === "number") lines.push(`Model context: ${n(contextTokens)} tokens`);
    lines.push("", "Menu: `/jev-eye` · direct: status|login|logout");
    return lines.join("\n");
  };

  const openRoutingMenu = async (ctx: any): Promise<void> => {
    const routing = readRouting();
    const options = [
      `Routing ${routing.enabled ? "ON" : "OFF"}  ·  turn it ${routing.enabled ? "off" : "on"}`,
      `Light model  ·  ${routing.light || "(not set)"}`,
      `Heavy model  ·  ${routing.heavy || "(not set)"}`,
    ];

    const choice = await ctx.ui.select("pi-jev-eye · model routing", options);
    if (!choice) return;

    if (choice === options[0]) {
      const enabled = !routing.enabled;
      writeRouting({ ...routing, enabled });
      ctx.ui.notify(
        enabled
          ? `[pi-jev-eye] Routing ON · light ${routing.light || "(unset)"} · heavy ${routing.heavy || "(unset)"}.`
          : "[pi-jev-eye] Routing OFF; turns keep the current model.",
        enabled && (!routing.light || !routing.heavy) ? "warning" : "info"
      );
      return;
    }

    const slot = choice === options[1] ? "light" : "heavy";
    const models: string[] = (ctx?.modelRegistry?.getAvailable?.() ?? []).map((m: any) => `${m.provider}/${m.id}`);
    if (models.length === 0) {
      ctx.ui.notify("[pi-jev-eye] No authenticated models found to route to.", "error");
      return;
    }

    const picked = await ctx.ui.select(`${slot} turn model`, ["(none)", ...models]);
    if (!picked) return;

    const next: Routing = { ...routing, [slot]: picked === "(none)" ? "" : picked };
    // Without both targets there is nothing to route between, so routing does not stay on.
    if (!next.light || !next.heavy) next.enabled = false;
    writeRouting(next);
    ctx.ui.notify(
      `[pi-jev-eye] ${slot === "light" ? "Light" : "Heavy"} model: ${next[slot] || "(none)"}${
        next.enabled ? "" : " — routing stays off until both targets are set"
      }.`,
      next[slot] ? "info" : "warning"
    );
  };

  // Interactive menu: account · Enable all folder / Enable this folder / Disabled · status
  const openMenu = async (ctx: any): Promise<void> => {
    const consent = readConsent();
    const thisFolderOn = consent.mode === "folder" && consentAllows(ctx.cwd, consent);
    const auth = resolveJevAuth();
    const options = [
      auth
        ? `Log out              ·  ${auth.provider.label} key from ${auth.source}`
        : `Log in               ·  TypeSafe or OpenRouter API key`,
      `Enable all folder    ·  ${consent.mode === "all" ? "current" : "gate on in every folder"}`,
      `Enable this folder   ·  ${thisFolderOn ? "ON" : "off"} (${ctx.cwd})`,
      `Disabled             ·  ${consent.mode === "disabled" ? "current" : "gate off, layers 1-2 stay on"}`,
      `Routing              ·  ${readRouting().enabled ? `ON · ${readRouting().light || "unset"} → ${readRouting().heavy || "unset"}` : "off"}`,
      `Show status`,
    ];

    const choice = await ctx.ui.select("pi-jev-eye · account & Jev gate", options);
    if (!choice) return;

    if (choice === options[0]) {
      await (auth ? logoutFlow(ctx) : loginFlow(ctx));
      return;
    }

    if (choice === options[1]) {
      writeConsent({ mode: "all", folders: consent.folders });
      ctx.ui.notify("[pi-jev-eye] Jev gate: Enable all folder.", "info");
      return;
    }

    if (choice === options[2]) {
      const folders = thisFolderOn
        ? consent.folders.filter((f) => f !== ctx.cwd)
        : [...new Set([...consent.folders, ctx.cwd])];
      // No folder left means there is nothing to run in, so the value becomes Disabled.
      const next: Consent = { mode: folders.length > 0 ? "folder" : "disabled", folders };
      writeConsent(next);
      ctx.ui.notify(
        `[pi-jev-eye] Jev gate: ${ctx.cwd} is ${thisFolderOn ? "OFF" : "ON"} — value is now ${consentLabel(next)}.`,
        thisFolderOn ? "warning" : "info"
      );
      return;
    }

    if (choice === options[3]) {
      writeConsent({ mode: "disabled", folders: consent.folders });
      ctx.ui.notify(
        "[pi-jev-eye] Jev gate: Disabled (layers 1-2 still on). The built-in typesafe_evaluate tool has its own gate.",
        "warning"
      );
      return;
    }

    if (choice === options[4]) {
      await openRoutingMenu(ctx);
      return;
    }

    ctx.ui.notify(await buildStatus(ctx), "info");
  };

  const eyeHandler = async (args: string, ctx: any) => {
    const sub = args.trim().toLowerCase();

    if (sub === "") {
      await openMenu(ctx);
      return;
    }

    if (sub === "login") {
      await loginFlow(ctx);
      return;
    }

    if (sub === "logout") {
      await logoutFlow(ctx);
      return;
    }

    if (sub !== "status") {
      ctx.ui.notify(
        `[pi-jev-eye] Unknown argument "${sub}". Use: status | login | logout, or no argument for the menu (on/off moved to ${TOGGLE_KEY}).`,
        "warning"
      );
      return;
    }

    ctx.ui.notify(await buildStatus(ctx), "info");
  };

  const completions = (prefix: string): AutocompleteItem[] | null => {
    const items: AutocompleteItem[] = EYE_SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.toLowerCase()));
    return items.length > 0 ? items : null;
  };

  pi.registerCommand("jev-eye", {
    description: "pi-jev-eye supervisor: menu (login / gate), status, usage stats",
    getArgumentCompletions: completions,
    handler: eyeHandler,
  });
  pi.registerCommand("eye", {
    description: "pi-jev-eye supervisor (alias of /jev-eye)",
    getArgumentCompletions: completions,
    handler: eyeHandler,
  });
}
