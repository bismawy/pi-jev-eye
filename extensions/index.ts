import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Input, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  DESTRUCTIVE_BASH_PATTERNS,
  EMPTY_TOTALS,
  SECRET_PATTERNS,
  USD_PER_MTOK,
  VERIFICATION_COMMAND_PATTERNS,
  legacyTotals,
  mergeTotals,
  normalizeTotals,
  sumDays,
  wipeTarget,
  type DayTotals,
} from "./layer1.ts";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

interface PendingModelRevert {
  model: any;
  thinking?: ThinkingLevel;
}

interface EyeState {
  enabled: boolean;
  modifiedFilesThisTurn: boolean;
  verifiedThisTurn: boolean;
  pendingRevert?: PendingModelRevert;
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
    compactions: number;
  };
  pendingReview?: string;
}

const state: EyeState = {
  enabled: true,
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
    compactions: 0,
  },
};

// --- Layer 1 (local regex rules) lives in ./layer1.ts so it can be checked with `npm test`. ---

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
const LEGACY_USAGE_PATH = join(homedir(), ".pi", "agent", "pi-typesafe", "usage.json");

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

/**
 * One screen for the routing targets, keybind-driven: type to filter, `space` assigns the
 * highlighted model as the light target, `ctrl+h` as the heavy target, `enter` saves,
 * `esc` discards. Rows carry `✓ (light)` / `✓ (heavy)` so both slots stay visible at once.
 */
const modelRef = (model: any): string => `${model.provider}/${model.id}`;

/** Human label shared by the routing screen and the status block: model name plus the capitalized
 *  provider, without repeating a vendor the display name already carries. */
function modelLabel(model: any): string {
  const name = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : model.id;
  const providerRaw = String(model.provider ?? "").trim();
  const provider = providerRaw ? providerRaw[0].toUpperCase() + providerRaw.slice(1) : "unknown";

  // Model display names often already carry the vendor/provider in parentheses or suffix
  // e.g. "Claude Sonnet 4.6 (Antigravity)" -> avoid "Claude Sonnet 4.6 (Antigravity) (Antigravity)"
  if (name.toLowerCase().includes(provider.toLowerCase())) {
    return name;
  }
  return `${name} (${provider})`;
}

/** Raw `provider/modelId` ref → human label; the ref itself when the registry does not list it. */
const modelLabelFor = (models: any[], ref: string): string => {
  const model = models.find((m) => modelRef(m) === ref);
  return model ? modelLabel(model) : ref;
};

class RoutingPicker {
  private pending: Routing;
  private query = "";
  private index = 0;
  private readonly models: any[];
  private readonly theme: any;
  private readonly done: (value: Routing | null) => void;
  private static readonly WINDOW = 10;

  constructor(theme: any, models: any[], initial: Routing, focus: "light" | "heavy", done: (value: Routing | null) => void) {
    this.theme = theme;
    this.models = models;
    this.pending = { ...initial };
    this.done = done;
    const preferred = focus === "light" ? initial.light : initial.heavy;
    const at = models.findIndex((m) => modelRef(m) === preferred);
    this.index = at >= 0 ? at : 0;
  }

  private filtered(): any[] {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.models;
    return this.models.filter((m) => {
      const haystack = `${m.id} ${m.provider} ${m.name ?? ""}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }

  private move(delta: number): void {
    const rows = this.filtered();
    if (rows.length === 0) return;
    this.index = (this.index + delta + rows.length) % rows.length;
  }

  private assign(slot: "light" | "heavy"): void {
    const row = this.filtered()[this.index];
    if (!row) return;
    const ref = modelRef(row);
    this.pending = { ...this.pending, [slot]: this.pending[slot] === ref ? "" : ref };
  }

  /** Walks off → minimal → low → medium → high → xhigh → max → off for one slot only. */
  private cycleThinking(slot: "light" | "heavy"): void {
    const field = slot === "light" ? "lightThinking" : "heavyThinking";
    const current = (this.pending[field as keyof Routing] as ThinkingLevel | undefined) ?? (slot === "light" ? "low" : "high");
    const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(current) + 1) % THINKING_LEVELS.length];
    this.pending = { ...this.pending, [field]: next };
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.space) || data === " ") return this.assign("light");
    // ctrl+h is the documented heavy key; ctrl+q is kept as an alias for terminals that eat it.
    if (matchesKey(data, "ctrl+h") || matchesKey(data, "ctrl+q")) return this.assign("heavy");
    if (matchesKey(data, "ctrl+r")) {
      this.pending = { ...this.pending, enabled: !this.pending.enabled };
      return;
    }
    // Two separate thinking keys: ctrl+t walks the light level, ctrl+shift+t the heavy one.
    if (matchesKey(data, "ctrl+shift+t")) return this.cycleThinking("heavy");
    if (matchesKey(data, "ctrl+t")) return this.cycleThinking("light");
    if (matchesKey(data, Key.backspace)) {
      this.query = this.query.slice(0, -1);
      this.index = 0;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      // Without both targets there is nothing to route between, so routing does not stay on.
      const both = !!this.pending.light && !!this.pending.heavy;
      return this.done({ ...this.pending, enabled: this.pending.enabled && both });
    }
    if (matchesKey(data, Key.escape)) return this.done(null);
    if (data.length === 1 && data >= " ") {
      this.query += data;
      this.index = 0;
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const rows = this.filtered();
    const lines: string[] = [];
    // Framing follows the same rule as the vision-watcher panel: a full-width border in the theme accent.
    const border = () => t.fg("accent", "─".repeat(Math.max(1, width)));

    lines.push(border());
    lines.push(t.fg("accent", t.bold("Jev Eye · Routing")));
    lines.push(
      t.fg("muted", "Route light chores to a cheap model and real review to the strongest one. ctrl+r turns routing on/off.")
    );
    lines.push("");
    lines.push(`${t.fg("accent", "> ")}${this.query}${this.query ? "" : t.fg("dim", "type to filter")}`);
    lines.push("");

    const start = Math.max(0, Math.min(this.index - Math.floor(RoutingPicker.WINDOW / 2), Math.max(0, rows.length - RoutingPicker.WINDOW)));
    const slice = rows.slice(start, start + RoutingPicker.WINDOW);
    if (slice.length === 0) lines.push(t.fg("warning", "  no model matches this filter"));

    for (const model of slice) {
      const ref = modelRef(model);
      const cursor = rows[this.index] === model;
      const slots = [this.pending.light === ref ? "light" : "", this.pending.heavy === ref ? "heavy" : ""].filter(Boolean);
      const mark = slots.length ? t.fg("success", ` ✓ (${slots.join(", ")})`) : "";
      // The whole highlighted row — arrow, id and provider tag — takes the accent colour, like the reference panel.
      const prefix = cursor ? t.fg("accent", "→ ") : "  ";
      const name = t.fg(cursor ? "accent" : "text", model.id);
      const provider = t.fg(cursor ? "accent" : "muted", `[${model.provider}]`);
      lines.push(`${prefix}${name} ${provider}${mark}`);
    }

    const position = rows.length === 0 ? 0 : Math.min(this.index + 1, rows.length);
    lines.push(t.fg("muted", `  (${position}/${rows.length})`));
    lines.push("");
    lines.push(
      `${t.fg("dim", "Routing: ")}${this.pending.enabled ? t.fg("success", "ON") : t.fg("muted", "off")}${
        this.pending.enabled && (!this.pending.light || !this.pending.heavy) ? t.fg("warning", "  (needs both targets)") : ""
      }`
    );
    lines.push(
      `${t.fg("dim", "Light model: ")}${this.pending.light ? t.fg("text", modelLabelFor(this.models, this.pending.light)) : t.fg("muted", "(unset)")} ${t.fg("muted", `[thinking: ${this.pending.lightThinking ?? "low"}]`)}`
    );
    lines.push(
      `${t.fg("dim", "Heavy model: ")}${this.pending.heavy ? t.fg("text", modelLabelFor(this.models, this.pending.heavy)) : t.fg("muted", "(unset)")} ${t.fg("muted", `[thinking: ${this.pending.heavyThinking ?? "high"}]`)}`
    );
    lines.push("");
    const count = `${this.models.length} models`;
    const legend = [
      "[Enter] Done",
      "[Space] Light",
      "[Ctrl+h] Heavy",
      "[Ctrl+r] Routing",
      "[Ctrl+t] Light Think",
      "[Ctrl+Shift+t] Heavy Think",
      "[Esc] Cancel",
    ].join("  ");
    lines.push(`${t.fg("accent", count)}${t.fg("dim", ` · ${legend}`)}`);
    lines.push(border());
    return lines;
  }

  invalidate(): void {}
}

/** `/jev-eye status` panel: the same framing as the routing picker and the vision-watcher screen, with
 *  both advertised keybindings live so the footer never promises a key that does nothing here. */
class StatusPanel {
  private lines: string[];
  private readonly theme: any;
  private readonly actions: {
    rebuild: () => string[];
    toggleSupervisor: () => void;
    cycleGate: () => void;
  };
  private readonly done: (value?: void) => void;

  constructor(
    theme: any,
    lines: string[],
    actions: { rebuild: () => string[]; toggleSupervisor: () => void; cycleGate: () => void },
    done: (value?: void) => void
  ) {
    this.theme = theme;
    this.lines = lines;
    this.actions = actions;
    this.done = done;
  }

  /** A toggle changes state, so the body is rebuilt in place; the caller re-renders after input. */
  private apply(mutate: () => void): void {
    mutate();
    this.lines = this.actions.rebuild();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, TOGGLE_KEY)) {
      this.apply(this.actions.toggleSupervisor);
      return;
    }
    if (matchesKey(data, GATE_KEY)) {
      this.apply(this.actions.cycleGate);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    // Framing follows the same rule as the routing picker: a full-width border in the theme accent.
    const border = () => t.fg("accent", "─".repeat(Math.max(1, width)));
    const lines = [
      border(),
      // Same nesting Pi's own headers use (fg outside bold) — tmux capture-pane did not show the
      // colour, the raw render bytes do.
      t.fg("accent", t.bold(STATUS_TITLE)),
      t.fg("muted", STATUS_DESC),
      "",
      ...this.lines,
      "",
      t.fg("dim", statusFooter(state.enabled)),
      border(),
    ];
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  invalidate(): void {}
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

// Our own usage ledger, plus pi-typesafe's older one so days that predate the switch are not shown as empty.
// The counters and the math live in ./layer1.ts (pure, covered by `npm test`).
const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

/** One period across both ledgers: today, or the current calendar month. */
function readUsage(period: string): DayTotals | undefined {
  return mergeTotals(
    sumDays(readJsonFile(OWN_USAGE_PATH)?.days, period, normalizeTotals),
    sumDays(readJsonFile(LEGACY_USAGE_PATH)?.days, period, legacyTotals)
  );
}

const readOwnUsage = (): DayTotals | undefined => readUsage(today());
const readMonthUsage = (): DayTotals | undefined => readUsage(today().slice(0, 7));

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
// Deliberately self-contained: the package never reads a skill file, so it works for anyone who installs it.
// The same wording rules also live in ~/.pi/agent/skills/arnative-jev (section 6) — change that one too.
const REVIEW_CONTRACT = [
  "[pi-jev-eye] Reviewed turn contract:",
  "- Language precedence: explicit operator instruction > AGENTS.md > prompt language > English fallback (preserve code, paths, and technical terms verbatim).",
  "- Required report format:",
  "  1. Machine-verified facts first (tool outputs, counts, exit codes; state explicitly if none run; never invent data; use stable IDs e.g. i1, i2).",
  "  2. One short Jev table: header spells scale in plain words (never terse `P(ya)` — ID `Peluang jawaban \"ya\" (0-1) · tinggi = sinyal kuat`, EN `Chance the answer is \"yes\" (0-1) · higher = stronger`, ZH `回答\"是\"的概率 (0-1) · 越高越强`); cells use `value (probability)` + level label.",
  "  3. Threshold line: state decision boundary (e.g. `Ambang: p ≥ 0.85 → <aksi>`).",
  "  4. Priority conclusion: list only unresolved items in priority order using facts IDs (no new analysis, no re-listing).",
  "  5. Exactly one confirmation question: ask which item(s) to handle next (`lanjut` / `continue` keeps plan; single question, never a paragraph).",
  "- No preamble. If nothing needs judgment, state so in one line and still end with the confirmation question.",
  "- Write gate: code edits will be evaluated against this turn's request text.",
].join("\n");

// Compaction adds no engine of its own: Pi already auto-compacts (threshold + `compaction.*` in
// settings.json) and exposes `ctx.compact`. This is only the must-keep list for a Jev report,
// passed as `customInstructions` so the summary stays readable by the same IDs and thresholds.
const JEV_COMPACT_INSTRUCTIONS = [
  "Keep, so the next Jev report stays readable:",
  "- Stable fact IDs (i1, i2, ...) together with the exact machine-checked numbers attached to them (counts, exit codes, paths).",
  "- Any printed decision line (`Ambang: p >= ...`) and the Jev probabilities or labels already agreed on.",
  "- Decisions taken (with #tags), what is still open, and the pending confirmation question.",
  "Drop raw tool output and full file dumps; keep only the conclusions drawn from them.",
].join("\n");

// --- Per-turn model routing: cheap model for chores, best model for real review ---
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface Routing {
  enabled: boolean;
  light: string; // "provider/modelId" as listed by ctx.modelRegistry.getAvailable()
  heavy: string;
  lightThinking?: ThinkingLevel;
  heavyThinking?: ThinkingLevel;
}

const ROUTING_PATH = join(EYE_DIR, "routing.json");
const JEV_MAX_ROUTING_CALLS = 20; // own session budget, so routing cannot eat the write gate's quota

function readRouting(): Routing {
  const raw = readJsonFile(ROUTING_PATH);
  return {
    enabled: raw?.enabled === true,
    light: typeof raw?.light === "string" ? raw.light : "",
    heavy: typeof raw?.heavy === "string" ? raw.heavy : "",
    lightThinking: THINKING_LEVELS.includes(raw?.lightThinking) ? raw.lightThinking : "low",
    heavyThinking: THINKING_LEVELS.includes(raw?.heavyThinking) ? raw.heavyThinking : "high",
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

/** all folders → this folder (cwd added) → disabled → all folders. */
function nextConsent(consent: Consent, cwd: string): Consent {
  if (consent.mode === "all") return { mode: "folder", folders: [...new Set([...consent.folders, cwd])] };
  if (consent.mode === "folder") return { mode: "disabled", folders: consent.folders };
  return { mode: "all", folders: consent.folders };
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
// Second keybinding for the gate value (all folders / this folder / disabled), announced in the same footer.
const GATE_KEY = "ctrl+shift+g";

// Panel chrome for `/jev-eye status`: title, one-line description, and the footer the panel renders.
const STATUS_TITLE = "Jev Eye · Status";
const STATUS_DESC = "Supervisor, Jev gate, model routing, interception and usage for this Pi session.";
// Keycap hint, not a code constant: `ctrl+shift+e` → `Ctrl+Shift+e`.
const keycap = (key: string) =>
  key
    .split("+")
    .map((part) => (part.length > 1 ? part[0].toUpperCase() + part.slice(1) : part))
    .join("+");
const statusFooter = (enabled: boolean) =>
  `[Enter] Done  [Esc] Cancel  [${keycap(TOGGLE_KEY)}] Supervisor (${enabled ? "ON" : "OFF"})  [${keycap(GATE_KEY)}] Grant folder`;

// The live state and both keybindings live in the `/jev-eye status` panel footer, not in Pi's status bar.
const EYE_SUBCOMMANDS = [
  { value: "status", label: "status", description: "Show supervisor status, account, usage, and interception stats" },
  { value: "login", label: "login", description: "Store a Jev key: TypeSafe account or OpenRouter account" },
  { value: "logout", label: "logout", description: "Delete the key stored by /jev-eye login" },
  { value: "routing", label: "routing", description: "Routing models menu, or direct: routing light | routing heavy | routing on | routing off" },
  { value: "compact", label: "compact", description: "Pi's own compaction, pre-filled with this workflow's must-keep list (add your own instructions after it)" },
];

export default function (pi: ExtensionAPI) {

  // Route the turn before the agent loop starts: chores to the cheap model, real work to the best one.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!state.enabled) return;
    const prompt = String(event?.prompt ?? "");

    // Reviewed turn: remember the request for the gate and inject the report contract for the model.
    // Set here and cleared by the next prompt — never in message_end: that fires before this turn's tool
    // calls run, so clearing it there wiped the request before the write gate could ever read it.
    const reviewed = REVIEW_TRIGGER.test(prompt);
    state.pendingReview = reviewed ? prompt.slice(0, 600) : undefined;
    if (reviewed) {
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
    const targetThinking = target === "light" ? (routing.lightThinking ?? "low") : (routing.heavyThinking ?? "high");

    if (current === ref) {
      if (typeof pi.setThinkingLevel === "function") {
        pi.setThinkingLevel(targetThinking);
      }
      if (target === "light") state.stats.lightTurns++;
      else state.stats.heavyTurns++;
      return contract;
    }

    // Context guard: if routing to light, ensure session context won't overflow the light model
    // or trigger auto-compacting and dump large context tokens onto a rate-limited model.
    if (target === "light") {
      const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : undefined;
      const currentTokens = Number(usage?.tokens ?? 0);
      const targetWindow = Number(model.contextWindow ?? 128_000);

      if (currentTokens > 0 && (currentTokens > 30_000 || currentTokens > targetWindow * 0.5)) {
        ctx.ui.notify(
          `[pi-jev-eye] Context too large (${currentTokens.toLocaleString()} tokens) for light model; keeping ${current || "current model"}.`,
          "info"
        );
        return contract;
      }
    }

    const previousModel = ctx?.model;
    const previousThinking = typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined;

    const switched = await pi.setModel(model);
    if (switched) {
      if (typeof pi.setThinkingLevel === "function") {
        pi.setThinkingLevel(targetThinking);
      }
      if (target === "light") {
        state.stats.lightTurns++;
        if (previousModel && `${previousModel.provider}/${previousModel.id}` !== ref) {
          state.pendingRevert = { model: previousModel, thinking: previousThinking };
        }
      } else {
        state.stats.heavyTurns++;
      }
      ctx.ui.notify(`[pi-jev-eye] ${target === "light" ? "Light" : "Heavy"} turn → ${ref} (${targetThinking} thinking)`, "info");
    }

    return contract;
  });

  // Restore model after a light turn so the session does not stay stuck on the chore model
  pi.on("agent_end", async (_event: any, ctx: any) => {
    if (!state.enabled || !state.pendingRevert) return;
    const { model, thinking } = state.pendingRevert;
    state.pendingRevert = undefined;
    try {
      const restored = await pi.setModel(model);
      if (restored) {
        if (thinking && typeof pi.setThinkingLevel === "function") {
          pi.setThinkingLevel(thinking);
        }
        ctx.ui.notify(`[pi-jev-eye] Light turn finished → restored ${model.provider}/${model.id}`, "info");
      }
    } catch {
      // Non-fatal
    }
  });

  pi.registerShortcut(TOGGLE_KEY, {
    description: "Toggle the pi-jev-eye supervisor",
    handler: async (ctx: any) => {
      state.enabled = !state.enabled;
      ctx.ui.notify(
        `[pi-jev-eye] Supervisor ${state.enabled ? "enabled" : "disabled"}. Toggle again with ${TOGGLE_KEY}.`,
        state.enabled ? "info" : "warning"
      );
    },
  });

  pi.registerShortcut(GATE_KEY, {
    description: "Cycle the Jev gate value: all folders / this folder / disabled",
    handler: async (ctx: any) => {
      const next = nextConsent(readConsent(), ctx.cwd);
      writeConsent(next);
      ctx.ui.notify(
        `[pi-jev-eye] Jev gate: ${consentLabel(next)} · this folder ${consentAllows(ctx.cwd, next) ? "ON" : "off"}. ${GATE_KEY} cycles again.`,
        next.mode === "disabled" ? "warning" : "info"
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
          // No `terminate`: the reason goes back to the model, which retries a scoped command on its own.
          reason: `[pi-jev-eye] Command blocked for safety: "${cmd}". Destructive actions require explicit user confirmation.`,
        };
      }

      // Detect secret leaks in the command arguments
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(cmd)) {
          state.stats.secretsBlocked++;
          ctx.ui.notify("[pi-jev-eye] BLOCKED: API key/secret leak in bash command!", "error");
          return {
            block: true,
            reason: "[pi-jev-eye] Command blocked: an API key or private credential was detected on the command line. Re-run without embedding the secret.",
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
      if (consentAllows(ctx.cwd, consent) && contentToCheck.split("\n").length >= JEV_MIN_DIFF_LINES) {
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

  // --- `/jev-eye` command ---
  /** Status body only: plain text in headless mode, colourised when the panel hands over a theme.
   *  Synchronous on purpose — the balance is fetched once by {@link showStatus} and passed in, so the
   *  panel never has a pending state to render. */
  const buildStatus = (ctx: any, balance: string, theme?: any): string[] => {
    const auth = resolveJevAuth();
    const consent = readConsent();
    const n = (value: number) => value.toLocaleString("en-US");
    const usd = (value: number) => `$${value.toFixed(6)}`;
    const paint = (color: string, value: string) => (theme ? theme.fg(color, value) : value);
    // A zero count is the healthy value, so only a non-zero one draws the eye.
    const count = (value: number) => paint(value > 0 ? "warning" : "text", String(value));
    const window = (label: string, period: string, totals: DayTotals | undefined) =>
      totals
        ? `${paint("dim", label.padEnd(8))}${period} | ${totals.requests} requests (${totals.ok} ok / ${totals.failed} failed) | ${n(totals.inputTokens)} in / ${n(totals.outputTokens)} out | ${usd(totals.cost)}`
        : `${paint("dim", label.padEnd(8))}${period} | no requests`;

    const routing = readRouting();
    const models: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
    const thisFolderOn = consentAllows(ctx.cwd, consent);
    // One line, one state: this folder, all folders, or off. The folder list itself never renders.
    const scopeValue =
      consent.mode === "folder" ? "This folder" : consent.mode === "all" ? "All folders" : "Disabled";
    const scopeState =
      consent.mode === "folder"
        ? ` (${paint(thisFolderOn ? "success" : "muted", thisFolderOn ? "ON" : "off")})`
        : "";
    const classified = Math.min(state.stats.jevRoutingCalls, JEV_MAX_ROUTING_CALLS);
    const lines = [
      `${paint("dim", "Supervisor: ")}${paint(state.enabled ? "success" : "warning", state.enabled ? "ENABLED" : "DISABLED")}`,
      `${paint("dim", "Routing: ")}${paint(routing.enabled ? "success" : "muted", routing.enabled ? "ON" : "off")} | ${paint("dim", "Light: ")}${modelLabelFor(models, routing.light) || "unset"} | ${paint("dim", "Heavy: ")}${modelLabelFor(models, routing.heavy) || "unset"} | ${state.stats.lightTurns} light / ${state.stats.heavyTurns} heavy turns | ${classified}/${JEV_MAX_ROUTING_CALLS} classified`,
      `${paint("dim", "Jev Gate: ")}${
        auth
          ? `${paint("success", "READY")} | ${auth.provider.label} (key from ${auth.source})`
          : `${paint("warning", "OFFLINE (no key)")} — run \`/jev-eye login\``
      }`,
      `${paint("dim", "Gate Scope: ")}${paint(consent.mode === "disabled" ? "warning" : "text", scopeValue)}${scopeState}`,
      // Named prefix + a plain-word gloss, so the numbers below stop being a riddle.
      `${paint("dim", "Gate Rules: ")}block when Jev's chance of slop or an unfinished TODO is p≥${JEV_BLOCK_THRESHOLD} | checked only on diffs ≥${JEV_MIN_DIFF_LINES} lines | ${Math.min(state.stats.jevRequests, JEV_MAX_REQUESTS)}/${JEV_MAX_REQUESTS} Jev requests used this session`,
      "",
      paint("accent", "Usage"),
      window("Today", today(), readOwnUsage()),
      window("Month", today().slice(0, 7), readMonthUsage()),
      `${paint("dim", "Balance ")}${paint("muted", balance)}`,
      "",
      paint("accent", "Interception (this session)"),
      `${paint("dim", "Blocked: ")}${count(state.stats.destructiveBlocked)} dangerous | ${paint("dim", "Secrets: ")}${count(state.stats.secretsBlocked)} | ${paint("dim", "Jev slop: ")}${count(state.stats.slopBlocked)} | ${paint("dim", "Unverified-done warnings: ")}${count(state.stats.verificationReminders)} | ${paint("dim", "Reviewed turns: ")}${count(state.stats.reviewTurns)} | ${paint("dim", "Compactions: ")}${state.stats.compactions}`,
    ];

    const contextTokens = ctx?.getContextUsage?.()?.tokens;
    if (typeof contextTokens === "number") lines.push(`${paint("dim", "Model context: ")}${n(contextTokens)} tokens`);
    return lines;
  };

  /** `/jev-eye status`: the framed panel, falling back to the same body as plain text without a TUI. */
  const showStatus = async (ctx: any): Promise<void> => {
    const balance = await balanceText(resolveJevAuth());

    if (typeof ctx.ui.custom !== "function") {
      ctx.ui.notify([STATUS_TITLE, STATUS_DESC, "", ...buildStatus(ctx, balance), "", statusFooter(state.enabled)].join("\n"), "info");
      return;
    }

    await ctx.ui.custom<void>((tui: any, theme: any, _kb: any, done: (value?: void) => void) => {
      const panel = new StatusPanel(
        theme,
        buildStatus(ctx, balance, theme),
        {
          rebuild: () => buildStatus(ctx, balance, theme),
          toggleSupervisor: () => {
            state.enabled = !state.enabled;
          },
          cycleGate: () => writeConsent(nextConsent(readConsent(), ctx.cwd)),
        },
        done
      );
      return {
        render: (width: number) => panel.render(width),
        invalidate: () => panel.invalidate(),
        handleInput: (data: string) => {
          panel.handleInput(data);
          tui.requestRender();
        },
      };
    });
  };

  const saveRouting = (ctx: any, next: Routing): void => {
    writeRouting(next);
    ctx.ui.notify(
      `[pi-jev-eye] Routing ${next.enabled ? "ON" : "OFF"} · light ${next.light || "(unset)"} · heavy ${next.heavy || "(unset)"}${
        next.enabled ? "" : " — routing stays off until both targets are set"
      }.`,
      next.enabled ? "info" : "warning"
    );
  };

  /** The whole routing screen: one keybind-driven picker for both targets. */
  const openRoutingMenu = async (ctx: any, focus: "light" | "heavy" = "light"): Promise<void> => {
    const available: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
    if (available.length === 0) {
      ctx.ui.notify("[pi-jev-eye] No authenticated models found to route to.", "error");
      return;
    }

    const current = readRouting();

    if (typeof ctx.ui.custom !== "function") {
      // Headless fallback keeps the same semantics with two plain lists.
      const refs = ["(none)", ...available.map((m: any) => `${m.provider}/${m.id}`)];
      const light = await ctx.ui.select("Light model", refs);
      if (light === undefined) return;
      const heavy = await ctx.ui.select("Heavy model", refs);
      if (heavy === undefined) return;
      const next = { light: light === "(none)" ? "" : light, heavy: heavy === "(none)" ? "" : heavy, enabled: current.enabled };
      saveRouting(ctx, { ...next, enabled: next.enabled && !!next.light && !!next.heavy });
      return;
    }

    const result = await ctx.ui.custom<Routing | null>((tui: any, theme: any, _kb: any, done: (value: Routing | null) => void) => {
      const picker = new RoutingPicker(theme, available, current, focus, done);
      return {
        render: (width: number) => picker.render(width),
        invalidate: () => picker.invalidate(),
        handleInput: (data: string) => {
          picker.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (!result) {
      ctx.ui.notify("[pi-jev-eye] Routing unchanged.", "info");
      return;
    }
    saveRouting(ctx, result);
  };

  // Interactive menu: login, logout, status, routing
  const openMenu = async (ctx: any): Promise<void> => {
    const auth = resolveJevAuth();
    const routing = readRouting();
    const routingDesc = routing.enabled
      ? `ON · ${routing.light || "unset"} → ${routing.heavy || "unset"}`
      : "off · configure light & heavy targets";

    const options = [
      `Login    ·  ${auth ? `switch key (current: ${auth.provider.label})` : "TypeSafe or OpenRouter API key"}`,
      `Logout   ·  ${auth ? `remove key from ${auth.source}` : "no active key stored"}`,
      `Status   ·  supervisor, gate scope, usage & metrics`,
      `Routing  ·  ${routingDesc}`,
    ];

    const choice = await ctx.ui.select("Jev Eye · Menu", options);
    if (!choice) return;

    if (choice === options[0]) {
      await loginFlow(ctx);
      return;
    }

    if (choice === options[1]) {
      await logoutFlow(ctx);
      return;
    }

    if (choice === options[2]) {
      await showStatus(ctx);
      return;
    }

    if (choice === options[3]) {
      await openRoutingMenu(ctx);
      return;
    }
  };

  const eyeHandler = async (args: string, ctx: any) => {
    const raw = args.trim();
    const sub = raw.toLowerCase();

    if (sub === "") {
      await openMenu(ctx);
      return;
    }

    if (sub === "routing" || sub.startsWith("routing ")) {
      const value = sub.slice("routing".length).trim();
      if (value === "light" || value === "heavy") {
        await openRoutingMenu(ctx, value);
        return;
      }
      if (value === "on" || value === "off") {
        const routing = readRouting();
        writeRouting({ ...routing, enabled: value === "on" });
        const missing = value === "on" && (!routing.light || !routing.heavy);
        ctx.ui.notify(
          value === "on"
            ? `[pi-jev-eye] Routing ON · light ${routing.light || "(unset)"} · heavy ${routing.heavy || "(unset)"}${
                missing ? " — set both targets with `/jev-eye routing`" : ""
              }.`
            : "[pi-jev-eye] Routing OFF; turns keep the current model.",
          missing ? "warning" : value === "on" ? "info" : "warning"
        );
        return;
      }
      await openRoutingMenu(ctx);
      return;
    }

    // `compact [extra instructions]`: Pi's own compaction, increment only by this must-keep list.
    // Instructions keep the operator's original casing, so `raw` (not `sub`) is sliced.
    if (sub === "compact" || sub.startsWith("compact ")) {
      const extra = raw.slice("compact".length).trim();
      if (typeof ctx.compact !== "function") {
        ctx.ui.notify("[pi-jev-eye] No ctx.compact in this Pi build; use Pi's own `/compact [instructions]`.", "warning");
        return;
      }
      // Same guard the built-in `/compact` uses: never compact under a streaming turn.
      if (typeof ctx.waitForIdle === "function") await ctx.waitForIdle();
      ctx.compact({
        customInstructions: extra ? `${JEV_COMPACT_INSTRUCTIONS}\n\nExtra operator instructions:\n${extra}` : JEV_COMPACT_INSTRUCTIONS,
        onComplete: (result: any) => {
          state.stats.compactions++;
          const before = Number(result?.tokensBefore ?? 0);
          ctx.ui.notify(
            `[pi-jev-eye] Compacted${before ? ` (${before.toLocaleString("en-US")} tokens before)` : ""}; asked the summarizer to keep fact IDs, numbers and threshold lines.`,
            "info"
          );
        },
        onError: (error: any) =>
          ctx.ui.notify(`[pi-jev-eye] Compaction failed: ${error instanceof Error ? error.message : String(error)}`, "error"),
      });
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
        `[pi-jev-eye] Unknown argument "${sub}". Use: status | login | logout | routing [on|off] | compact [instructions], or no argument for the menu (supervisor on/off is ${TOGGLE_KEY}).`,
        "warning"
      );
      return;
    }

    await showStatus(ctx);
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
}
