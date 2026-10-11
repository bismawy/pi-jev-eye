import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, CURSOR_MARKER, Input, Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  DESTRUCTIVE_BASH_PATTERNS,
  EMPTY_TOTALS,
  SECRET_PATTERNS,
  USD_PER_MTOK,
  VERIFICATION_COMMAND_PATTERNS,
  addProviderTotals,
  backendTotals,
  boxEdge,
  boxRow,
  cfRunUrl,
  clefBody,
  clefBudget,
  clefError,
  clefNeuronsFor,
  clefUsdPerMTok,
  CLEF_PROVIDER_ID,
  isCloudflareAccountId,
  legacyTotals,
  mergeTotals,
  migrateAuthStore,
  neuronsSpentOn,
  normalizeTotals,
  putCredential,
  removeCredentials,
  storedProviderIds,
  sumDays,
  thinkingColorSlot,
  wipeTarget,
  type AuthStore,
  type DayTotals,
  type ProviderTotals,
  type StoredCredential,
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
  reviewMode: boolean;
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
  };
  pendingReview?: string;
}

const state: EyeState = {
  enabled: true,
  reviewMode: false,
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

// --- Layer 1 (local regex rules) lives in ./layer1.ts, covered by `npm test`. ---

// --- Layer 3: Jev accounts (pi-typesafe is optional; /jev-eye login owns its own key) ---
interface JevProvider {
  id: "typesafe" | "openrouter" | "cloudflare";
  label: string;
  /** Short name for one-line status rows and tables, where the login-menu label would not fit. */
  short: string;
  url: string;
  model: string;
  keyEnv: string;
  keyHint: string;
  accountEnv?: string; // Cloudflare only: the account is chosen separately from the token
  models?: string[]; // Cloudflare only: the model is chosen per provider
}

const JEV_PROVIDERS: JevProvider[] = [
  {
    id: "typesafe",
    label: "TypeSafe account",
    short: "TypeSafe",
    url: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    keyEnv: "TYPESAFE_API_KEY",
    keyHint: "console.typesafe.ai > API Keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter account",
    short: "OpenRouter",
    url: "https://openrouter.ai/api/alpha/decisions", // OpenRouter's System One route (same request/response shape)
    model: "typesafe/jev-1.13",
    keyEnv: "OPENROUTER_API_KEY",
    keyHint: "openrouter.ai/settings/keys",
  },
  {
    id: "cloudflare",
    label: "Cloudflare Workers AI (Clef)",
    short: "Clef",
    // The real route needs an account id, so it is built by cfRunUrl at request time; this stays the account-less display form.
    url: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash",
    model: "clef-flash", // cheaper than `clef` for the per-write gate; both are free inside the daily neuron allowance
    keyEnv: "CLOUDFLARE_API_TOKEN",
    keyHint: "dash.cloudflare.com > Account API tokens (Workers AI: Read)",
    accountEnv: "CLOUDFLARE_ACCOUNT_ID",
    models: ["clef-flash", "clef"],
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

/** A stored provider id as a readable name; an id this build no longer ships stays as it was stored. */
const providerLabelOf = (id: string): string => providerById(id)?.short ?? id;

// --- Credential store (v2: one entry per provider, so several backends stay logged in) ---
// The pure shapes and folds live in ./layer1.ts (covered by `npm test`); this is the file I/O around them.
const AUTH_BACKUP_PATH = `${AUTH_PATH}.v1.bak`;

/** Read the store, migrating a v1 file in place once (keeping a `.v1.bak` copy for rollback). */
function readAuthStore(): { store: AuthStore; migrated: boolean } {
  const raw = readJsonFile(AUTH_PATH, true);
  if (!raw) return { store: { version: 2, providers: {} }, migrated: false };
  const { store, migratedFromV1 } = migrateAuthStore(raw);
  if (migratedFromV1) {
    try {
      writeFileSync(AUTH_BACKUP_PATH, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
      writeAuthStore(store);
    } catch {
      // A read-only home must not stop the gate: the migrated store is still returned in memory.
    }
  }
  return { store, migrated: migratedFromV1 };
}

function writeAuthStore(store: AuthStore): void {
  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(AUTH_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** One provider's credential in the store, or undefined when that backend is not logged in. */
const storedCredential = (store: AuthStore, id: string): StoredCredential | undefined => store.providers[id];

interface JevAuth {
  provider: JevProvider;
  key: string;
  source: string; // where the key came from; shown in status, never the key itself
  model: string; // Cloudflare allows a per-account model choice; every other provider keeps its fixed one
  accountId?: string; // Cloudflare only: the account the run route targets
}

/** One provider's rate for input tokens. Cloudflare's depends on the model; the others are single-rate. */
const usdPerMTokFor = (auth: JevAuth): number =>
  auth.provider.id === "cloudflare" ? clefUsdPerMTok(auth.model) : USD_PER_MTOK;

/** The provider id stored in the ledger, so the usage panel can name what it was spent on. */
const providerIdOf = (auth: JevAuth): string => auth.provider.id;

/** The per-request route: only Cloudflare needs an id that the provider entry cannot carry. */
const authUrl = (auth: JevAuth): string =>
  auth.provider.id === "cloudflare" ? cfRunUrl(auth.accountId ?? "", auth.model) : auth.provider.url;

function resolveJevAuth(): JevAuth | undefined {
  // Environment first: an explicit export (headless run, CI, shared machine) must win over a stored key,
  // the same precedence pi-typesafe uses.
  for (const provider of JEV_PROVIDERS) {
    const fromEnv = process.env[provider.keyEnv]?.trim();
    if (!fromEnv) continue;
    const accountId = provider.accountEnv ? process.env[provider.accountEnv]?.trim() : undefined;
    if (provider.accountEnv && !accountId) continue; // a Clef token without its account id cannot build a route
    return { provider, key: fromEnv, source: `$${provider.keyEnv}`, model: provider.model, accountId };
  }

  const stored = readAuthStore().store;
  // The store holds one credential per provider. Prefer the order in JEV_PROVIDERS so TypeSafe keeps
  // winning when several are logged in, exactly as the environment loop above does.
  for (const provider of JEV_PROVIDERS) {
    const credential = storedCredential(stored, provider.id);
    if (!credential) continue;
    const model = provider.models?.includes(String(credential.model)) ? String(credential.model) : provider.model;
    // A Cloudflare entry without an account id is unusable; treat it as "not logged in" for that provider.
    if (provider.accountEnv && !credential.accountId) continue;
    return { provider, key: credential.apiKey, source: "/jev-eye login", model, accountId: credential.accountId };
  }

  // Back-compat: keep working for anyone who already logged in with pi-typesafe installed.
  const legacy = readJsonFile(LEGACY_AUTH_PATH, true);
  const legacyKey = typeof legacy?.apiKey === "string" ? legacy.apiKey.trim() : "";
  if (legacyKey) return { provider: JEV_PROVIDERS[0], key: legacyKey, source: "pi-typesafe login", model: JEV_PROVIDERS[0].model };

  return undefined;
}

/** What `/jev-eye status` has to explain when a Cloudflare credential is incomplete. */
const envAccountId = (provider: JevProvider): string | undefined =>
  provider.accountEnv ? process.env[provider.accountEnv]?.trim() || undefined : undefined;

const isPlausibleKey = (key: string): boolean =>
  key.length >= 16 && key.length <= 512 && !/\s/.test(key) && /^[\x21-\x7e]+$/.test(key);

/** Where a key can come from right now, and what to say when a Cloudflare token has no account id. */
function keySources(): { usable: string[]; cfTokenWithoutAccount: boolean } {
  const usable: string[] = [];
  let cfTokenWithoutAccount = false;
  for (const provider of JEV_PROVIDERS) {
    const key = process.env[provider.keyEnv]?.trim();
    if (!key) continue;
    if (provider.accountEnv && !envAccountId(provider)) cfTokenWithoutAccount = true;
    else usable.push(`$${provider.keyEnv}`);
  }
  return { usable, cfTokenWithoutAccount };
}

/**
 * Border painter for a screen: the session's thinking level colours the box, as in `/arnative`.
 * `thinking*` exists in every theme, `accentSoft` only in arnative themes, so the soft token is probed
 * once and the box falls back to the thinking tint of the level. */
const borderPainterFor = (theme: any, ctx?: any) => {
  const level = thinkingColorSlot(ctx?.thinkingLevel);
  const fg = theme?.fg?.bind(theme);
  if (!fg) return (text: string) => text;
  try {
    fg("accentSoft", "");
    return (text: string) => fg("accentSoft", text);
  } catch {
    return (text: string) => fg(level, text);
  }
};

/**
 * The login menu, as a real component rather than `ctx.ui.select`.
 *
 * `select` renders one fixed string per row, so it can show state but cannot react to the highlighted
 * row — the tip was stuck as static filler. This picker re-renders on every move and shows the key
 * source for whatever is under the cursor, which is the whole point of the tip.
 */
class LoginPicker {
  private readonly options: { label: string; status: "stored" | "unset"; provider: JevProvider }[];
  private readonly theme: any;
  private readonly done: (value: JevProvider | null) => void;
  private index = 0;

  constructor(theme: any, store: AuthStore, done: (value: JevProvider | null) => void) {
    this.theme = theme;
    this.done = done;
    this.options = JEV_PROVIDERS.map((provider) => ({
      label: provider.label,
      status: storedCredential(store, provider.id) ? "stored" : "unset",
      provider,
    }));
  }

  /** Set when the operator pressed [←]; the caller then reopens the menu instead of leaving.
   *  Kept as a plain field: `ctx.ui.custom` resolves one value, and `null` already means "cancelled". */
  wentBack = false;

  /** Exposed so the caller can drive it from tests and from the headless fallback. */
  get providers(): JevProvider[] {
    return this.options.map((o) => o.provider);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.index = (this.index - 1 + this.options.length) % this.options.length;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = (this.index + 1) % this.options.length;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.options[this.index]?.provider ?? null);
      return;
    }
    if (matchesKey(data, Key.escape)) this.done(null);
    if (matchesKey(data, Key.left)) {
      this.wentBack = true;
      this.done(null);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = this.paint;
    const inner = width - 4; // two walls, two spaces
    const row = (content: string) => boxRow(truncateToWidth(content, inner, ""), width, paint);
    const lines = [
      t.fg("accent", t.bold("Jev Eye · Login")),
      t.fg("muted", "Pick the backend for the Jev gate. A stored key is reused until replaced."),
      "",
    ];
    for (const [i, option] of this.options.entries()) {
      const cursor = i === this.index;
      const mark = option.status === "stored" ? t.fg("success", "✓ stored") : t.fg("dim", "• not configured");
      lines.push(`${cursor ? t.fg("accent", "→ ") : "  "}${t.fg(cursor ? "accent" : "text", option.label)}  ${mark}`);
    }
    // The live tip: whatever is highlighted, not a static caption.
    const current = this.options[this.index];
    lines.push("");
    if (current) {
      lines.push(t.fg("dim", `Tips: key from ${current.provider.keyHint}`));
      const hint = current.provider.accountEnv ?? `$${current.provider.keyEnv}`;
      lines.push(t.fg("dim", `Or export ${hint}${current.provider.accountEnv ? ` + $${current.provider.keyEnv}` : ""}`));
    }
    lines.push("");
    lines.push(t.fg("dim", "[↑↓] Move  [Enter] Choose  [←] Back  [Esc] Cancel"));
    // Arnative frame: round corners, one content row per line, so a short terminal clips cleanly.
    return [boxEdge("╭", "╮", width, paint), ...lines.map(row), boxEdge("╰", "╯", width, paint)];
  }

  invalidate(): void {}
}

/**
 * Rounded-box list picker: same frame as `@bismawy/pi-arnative`'s ListPicker and the screens beside it.
 * `ctx.ui.select` renders itself with two full-width rules, so a menu that must be rounded has to own its
 * component. `rows` are pre-styled one-liners; the arrow is the only thing this class adds.
 */
/** `done()` value meaning the user pressed [←] Back rather than choosing or cancelling. */
const BACK = -2;

class ListPicker {
  private readonly rows: { label: string; note: string }[];
  private readonly title: string;
  private readonly subtitle: string;
  private readonly footer: string;
  private readonly theme: any;
  private readonly paint: (text: string) => string;
  private readonly onBack: (() => void) | undefined;
  private readonly done: (value: number | null) => void;
  private index = 0;

  constructor(
    theme: any,
    title: string,
    rows: { label: string; note: string }[],
    subtitle: string,
    done: (value: number | null) => void,
    paint: (text: string) => string,
    onBack?: () => void,
  ) {
    this.theme = theme;
    this.title = title;
    this.rows = rows;
    this.subtitle = subtitle;
    this.done = done;
    this.paint = paint;
    this.onBack = onBack;
    // A menu inside an extension goes back to the previous menu with [←]; the root has nowhere to go.
    this.footer = onBack ? "[↑↓] Move  [Enter] Choose  [←] Back  [Esc] Cancel" : "[↑↓] Move  [Enter] Choose  [Esc] Cancel";
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.index = (this.index - 1 + this.rows.length) % this.rows.length;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = (this.index + 1) % this.rows.length;
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.index = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.index = this.rows.length - 1;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.index);
      return;
    }
    // [←] steps back to the previous menu, [Esc] closes the screen — different exits. The root menu
    // has nothing behind it, so [←] is ignored there rather than quietly closing the screen.
    if (matchesKey(data, Key.left)) {
      if (this.onBack) this.done(BACK);
      return;
    }
    if (matchesKey(data, Key.escape)) this.done(null);
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = this.paint;
    const inner = width - 4; // two walls, two spaces
    const row = (content: string) => boxRow(truncateToWidth(content, inner, ""), width, paint);
    const lines = [t.fg("accent", t.bold(this.title)), t.fg("muted", this.subtitle), ""];
    // Every label is padded to the widest one, so all `·` dividers land in one column (as in `menuLabels`).
    const column = Math.max(...this.rows.map((item) => visibleWidth(item.label)));
    for (const [i, item] of this.rows.entries()) {
      const chosen = i === this.index;
      const label = chosen ? this.soft(item.label) : t.fg(item.note ? "text" : "muted", item.label);
      const pad = " ".repeat(Math.max(0, column - visibleWidth(item.label)));
      const note = item.note ? `${t.fg("dim", "  ·  ")}${t.fg("dim", item.note)}` : "";
      lines.push(`${chosen ? t.fg("accent", "→ ") : "  "}${label}${pad}${note}`);
    }
    lines.push("");
    lines.push(t.fg("dim", this.footer));
    return [boxEdge("╭", "╮", width, paint), ...lines.map(row), boxEdge("╰", "╯", width, paint)];
  }

  invalidate(): void {}

  /** Chosen rows take the soft accent when the theme has one, the thinking tint otherwise. */
  private soft(text: string): string {
    try {
      return this.theme.fg("accentSoft", text);
    } catch {
      return this.theme.fg("thinkingText", text);
    }
  }
}

/** Drive the same picker everywhere: TUI gets the rounded box, RPC and headless keep `ctx.ui.select`. */
async function pickRow(
  ctx: any,
  title: string,
  rows: { label: string; note: string }[],
  subtitle: string,
  options: { onBack?: () => void } = {},
): Promise<number | "back" | null> {
  if (ctx.mode !== "tui") {
    const labels = rows.map((row) => (row.note ? `${row.label} · ${row.note}` : row.label));
    const choice = await ctx.ui.select(title, labels);
    return choice ? labels.indexOf(choice) : null;
  }
  const picked = await ctx.ui.custom<number | null>((tui: any, theme: any, _kb: any, done: (value: number | null) => void) => {
    const picker = new ListPicker(theme, title, rows, subtitle, done, borderPainterFor(theme, ctx), options.onBack);
    return {
      render: (width: number) => picker.render(width),
      invalidate: () => picker.invalidate(),
      handleInput: (data: string) => {
        picker.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return picked === BACK ? "back" : picked;
}

/**
 * The login menu's options as plain strings, for the headless path where `custom` UI does not exist.
 * The tip is appended as an extra, non-selectable row for the highlighted provider only.
 */
const loginOptionLabels = (store: AuthStore): string[] =>
  JEV_PROVIDERS.map((provider) => `${provider.label} ${storedCredential(store, provider.id) ? "✓ stored" : "• not configured"}`);

/** One line naming where a provider's key comes from, used wherever that cannot be rendered in place. */
const providerTip = (provider: JevProvider): string => `Tips: key from ${provider.keyHint}`;

// --- Cloudflare Workers AI envelope: the REST route wraps the System One answer in { result, success } ---
type ClefAnswer = { model?: string; answers?: Record<string, any>; usage?: { input_tokens?: number; output_tokens?: number } };

const workersAiBody = (json: any): ClefAnswer | undefined => clefBody(json) as ClefAnswer | undefined;
const workersAiError = clefError;

/** One tiny request: proves the key AND that the route works, before anything is saved. */
async function probeJev(provider: JevProvider, key: string, url = provider.url, model = provider.model): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
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
    if (res.status === 404) {
      return { ok: false, detail: `HTTP 404 from ${url} — check the Cloudflare account id` };
    }
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${url}` };
    const json: any = await res.json();
    const body = workersAiBody(json);
    if (!body) return { ok: false, detail: `Cloudflare rejected the request: ${workersAiError(json)}` };
    if (typeof body?.answers?.reachable?.noul !== "number") return { ok: false, detail: "unexpected answer shape" };
    return { ok: true, detail: `answer received from ${body?.model ?? model}` };
  } catch (error) {
    return { ok: false, detail: `could not reach ${url} (${(error as Error)?.message ?? "network error"})` };
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
  private readonly paint: (text: string) => string;
  private static readonly WINDOW = 10;

  constructor(
    theme: any,
    models: any[],
    initial: Routing,
    focus: "light" | "heavy",
    done: (value: Routing | null) => void,
    paint: (text: string) => string,
  ) {
    this.theme = theme;
    this.models = models;
    this.pending = { ...initial };
    this.done = done;
    this.paint = paint;
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
    if (matchesKey(data, KEY_SETS.routingToggle)) {
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
    if (matchesKey(data, Key.left)) return this.done(BACK);
    if (matchesKey(data, Key.escape)) return this.done(null);
    if (data.length === 1 && data >= " ") {
      this.query += data;
      this.index = 0;
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = this.paint;
    const inner = width - 4; // two walls, two spaces
    const row = (content: string) => boxRow(truncateToWidth(content, inner, ""), width, paint);
    const rows = this.filtered();
    const lines: string[] = [
      t.fg("accent", t.bold("Jev Eye · Routing")),
      t.fg("muted", "Route light chores to a cheap model and real review to the strongest one. ctrl+r turns routing on/off."),
      "",
      // The query is one line, but a stray paste must never break the frame: spread it first.
      ...`${t.fg("accent", "> ")}${this.query}${this.query ? "" : t.fg("dim", "type to filter")}`.split("\n"),
      "",
    ];

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
      "[↑↓] Move",
      "[Enter] Done",
      "[Space] Light",
      "[Ctrl+h] Heavy",
      "[Ctrl+r] Routing",
      "[Ctrl+t] Light Think",
      "[Ctrl+Shift+t] Heavy Think",
      "[←] Back",
      "[Esc] Cancel",
    ].join("  ");
    lines.push(`${t.fg("accent", count)}${t.fg("dim", ` · ${legend}`)}`);
    return [boxEdge("╭", "╮", width, paint), ...lines.map(row), boxEdge("╰", "╯", width, paint)];
  }

  invalidate(): void {}
}

/** `/jev-eye status` panel: the same framing as the routing picker and the vision-watcher screen, with
 *  both advertised keybindings live so the footer never promises a key that does nothing here. */
class StatusPanel {
  private lines: string[];
  private readonly paint: (text: string) => string;
  private readonly theme: any;
  private readonly actions: {
    rebuild: () => string[];
    cycleMode: () => void;
    cycleGate: () => void;
  };
  private readonly done: (value?: void) => void;
  private readonly title: string;
  private readonly desc: string;
  /** Read-only screens (usage) must not advertise, or act on, the status toggles. */
  private readonly controls: boolean;

  constructor(
    theme: any,
    lines: string[],
    actions: { rebuild: () => string[]; cycleMode: () => void; cycleGate: () => void },
    done: (value?: void) => void,
    title: string = STATUS_TITLE,
    desc: string = STATUS_DESC,
    controls = true,
    paint: (text: string) => string = borderPainterFor(theme)
  ) {
    this.theme = theme;
    this.paint = paint;
    this.lines = lines;
    this.actions = actions;
    this.done = done;
    this.title = title;
    this.desc = desc;
    this.controls = controls;
  }

  /** A toggle changes state, so the body is rebuilt in place; the caller re-renders after input. */
  private apply(mutate: () => void): void {
    mutate();
    this.lines = this.actions.rebuild();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left)) {
      this.done(BACK);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, TOGGLE_KEY) || matchesKey(data, LEGACY_TOGGLE_KEY)) {
      if (this.controls) this.apply(this.actions.cycleMode);
      return;
    }
    if (matchesKey(data, GATE_KEY)) {
      if (this.controls) this.apply(this.actions.cycleGate);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = this.paint;
    const inner = width - 4; // two walls, two spaces
    const row = (content: string) => boxRow(truncateToWidth(content, inner, ""), width, paint);
    // Same round frame as the routing and login pickers; the controls line stays live.
    const lines = [
      // Same nesting Pi's own headers use (fg outside bold) — tmux capture-pane did not show the
      // colour, the raw render bytes do.
      t.fg("accent", t.bold(this.title)),
      t.fg("muted", this.desc),
      "",
      ...this.lines,
      "",
      t.fg("dim", this.controls ? statusFooter(state.enabled, state.reviewMode) : PANEL_FOOTER),
    ];
    return [boxEdge("╭", "╮", width, paint), ...lines.map(row), boxEdge("╰", "╯", width, paint)];
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

/** Cloudflare needs the account id next to the token; it is not a secret, so it is typed in the clear. */
async function promptForAccountId(ctx: any, provider: JevProvider): Promise<string | undefined> {
  const hint = provider.accountEnv
    ? `${provider.accountEnv} is not set. Paste the 32-char account id from dash.cloudflare.com (Workers AI > Use REST API). Enter confirms, Esc cancels.`
    : "Paste the account id. Enter confirms, Esc cancels.";
  const entered = await ctx.ui.input("Cloudflare account ID", hint);
  if (entered === undefined) return undefined;
  const accountId = String(entered).trim();
  if (!isCloudflareAccountId(accountId)) {
    ctx.ui.notify("[pi-jev-eye] A Cloudflare account id is 32 hexadecimal characters. Nothing was saved.", "error");
    return undefined;
  }
  return accountId;
}

/** Clef has two models; the choice is per credential, so it is asked while the credential is set up. */
async function promptForModel(ctx: any, provider: JevProvider): Promise<string | undefined> {
  const models = provider.models ?? [provider.model];
  const rows = models.map((m) => ({
    label: m,
    note: m === "clef-flash" ? "cheapest, best for the per-write gate" : "strongest, costs about 6x more",
  }));
  const index = await pickRow(ctx, "Jev Eye · Clef model", rows, "Per credential: the cheaper model suits the per-write gate.", { onBack: () => {} });
  return typeof index === "number" ? models[index] : undefined;
}

/** Resolves `"back"` when the operator pressed [←] on the provider picker, so the menu reopens. */
const loginFlow = async (ctx: any): Promise<void | "back"> => {
  // A key already exported in the environment is described, never overwritten by a stored one.
  const sources = keySources();
  if (sources.usable.length > 0 || sources.cfTokenWithoutAccount) {
    const parts = [`Keys already active from the environment: ${sources.usable.join(", ") || "none"}.`];
    if (sources.cfTokenWithoutAccount) {
      parts.push(`$CLOUDFLARE_API_TOKEN is set but $CLOUDFLARE_ACCOUNT_ID is not, so Clef stays unavailable.`);
    }
    parts.push("An exported key always takes precedence over the one stored here. Continue anyway?");
    const proceed = await ctx.ui.confirm("pi-jev-eye · keys already in the environment", parts.join(" "));
    if (!proceed) return;
  }

  // Pi's selector renders one fixed string per row, so it cannot show a tip that follows the cursor.
  // The custom picker can; RPC and headless sessions keep the same choices as plain rows, because
  // `ctx.ui.custom` is a documented no-op there (rpc-extension-ui.md).
  const { store } = readAuthStore();
  let provider: JevProvider | null;
  let back = false;
  if (ctx.mode === "tui") {
    let picker: LoginPicker | undefined;
    provider = await ctx.ui.custom<JevProvider | null>((tui: any, theme: any, _kb: any, done: (value: JevProvider | null) => void) => {
      picker = new LoginPicker(theme, store, done);
      return {
        render: (width: number) => picker!.render(width),
        invalidate: () => picker!.invalidate(),
        handleInput: (data: string) => {
          picker!.handleInput(data);
          tui.requestRender();
        },
      };
    });
    // `custom` resolves one value, so the Back flag is read from the component instance afterwards.
    back = picker?.wentBack === true;
  } else {
    const labels = loginOptionLabels(store);
    const choice = await ctx.ui.select("pi-jev-eye · where is your Jev key from?", labels);
    provider = choice ? JEV_PROVIDERS[labels.indexOf(choice)] ?? null : null;
  }
  if (!provider) return back ? "back" : undefined;
  ctx.ui.notify(`[pi-jev-eye] ${providerTip(provider)}`, "info");

  // Clef cannot be reached without an account id, so collect it before the secret.
  let accountId: string | undefined;
  if (provider.accountEnv) {
    const envId = envAccountId(provider);
    accountId = envId ?? (await promptForAccountId(ctx, provider));
    if (!accountId) return;
  }

  const entered = await promptForSecret(ctx, provider);
  if (entered === undefined) return;

  const key = entered.trim();
  if (!isPlausibleKey(key)) {
    ctx.ui.notify("[pi-jev-eye] That does not look like an API key (16-512 chars, no spaces). Nothing was saved.", "error");
    return;
  }

  const model = provider.models ? await promptForModel(ctx, provider) : provider.model;
  if (!model) return;

  // Final check on the exact route the gate will use, not on a generic credential probe.
  const url = provider.accountEnv ? cfRunUrl(accountId ?? "", model) : provider.url;
  ctx.ui.notify(`[pi-jev-eye] Checking the key against ${provider.label}…`, "info");
  const probe = await probeJev(provider, key, url, model);
  if (!probe.ok) {
    ctx.ui.notify(`[pi-jev-eye] Login failed: ${probe.detail}. Nothing was saved.`, "error");
    return;
  }

  // Additive: another backend's stored key stays usable. The probe above must pass before this line.
  // Re-read the store here: the picker above may have run a while ago, and it never writes.
  const { store: current, migrated } = readAuthStore();
  const others = storedProviderIds(current).filter((id) => id !== provider.id);
  writeAuthStore(putCredential(current, provider.id, { apiKey: key, model, ...(accountId ? { accountId } : {}) }));
  const shadows = process.env[provider.keyEnv]?.trim() ? ` Note: $${provider.keyEnv} is set and takes precedence over this stored key.` : "";
  const keptNote = others.length > 0 ? ` ${others.map(providerLabelOf).join(", ")} stayed logged in.` : "";
  const migrationNote = migrated ? ` Migrated the old single-key store (backup: ${AUTH_BACKUP_PATH}).` : "";
  ctx.ui.notify(
    `[pi-jev-eye] Logged in via ${provider.label} (${model}): ${probe.detail}. Stored in ${AUTH_PATH} (0600).${keptNote}${shadows}${migrationNote}`,
    "info"
  );
};

/**
 * `/jev-eye logout`: pick which backend to remove, or all of them.
 * The store holds one credential per provider, so a picker is possible; environment-supplied keys are
 * reported instead, because a process cannot unset a variable that belongs to its caller.
 */
const logoutFlow = async (ctx: any): Promise<void | "back"> => {
  const { store } = readAuthStore();
  const storedIds = storedProviderIds(store);
  const fromEnv = JEV_PROVIDERS.filter((p) => process.env[p.keyEnv]?.trim()).map((p) => `$${p.keyEnv}`);
  const envNote = fromEnv.length ? ` ${fromEnv.join(", ")} comes from the environment and cannot be removed here.` : "";

  if (storedIds.length === 0) {
    ctx.ui.notify(`[pi-jev-eye] Nothing stored by /jev-eye login to remove.${envNote}`, "warning");
    return;
  }

  // "Jev" is every non-Clef provider (TypeSafe / OpenRouter); Clef is Cloudflare.
  const jevIds = storedIds.filter((id) => id !== CLEF_PROVIDER_ID);
  const clefIds = storedIds.filter((id) => id === CLEF_PROVIDER_ID);
  const names = (ids: string[]) => ids.map(providerLabelOf).join(", ");

  const choices: { label: string; ids: string[] }[] = [];
  if (jevIds.length > 0) choices.push({ label: `Jev (${names(jevIds)})`, ids: jevIds });
  if (clefIds.length > 0) choices.push({ label: `Clef (${names(clefIds)})`, ids: clefIds });
  choices.push({ label: `All (${names(storedIds)})`, ids: storedIds });

  // One backend logged in: no picker worth showing, just confirm that one.
  if (storedIds.length === 1) {
    const only = storedIds[0];
    const confirmed = await ctx.ui.confirm(`Log out of ${providerLabelOf(only)}?`, `Remove the stored key for ${providerLabelOf(only)} from ${AUTH_PATH}?${envNote}`);
    if (!confirmed) return;
    await removeStoredCredentials(ctx, [only], envNote);
    return;
  }

  const index = await pickRow(
    ctx,
    "Jev Eye · Logout",
    choices.map((c) => ({ label: c.label, note: c.ids.map(providerLabelOf).join(", ") })),
    `Stored in ${AUTH_PATH}.`,
    { onBack: () => {} },
  );
  if (index === "back") return "back";
  if (typeof index !== "number") return;
  const target = choices[index] ?? choices[choices.length - 1];
  const confirmed = await ctx.ui.confirm(`Log out of ${target.label}?`, `Remove ${target.ids.map(providerLabelOf).join(", ")} from ${AUTH_PATH}?${envNote}`);
  if (!confirmed) return;
  await removeStoredCredentials(ctx, target.ids, envNote);
};

/** Delete the given providers from the store; an emptied store removes the file so status reads OFFLINE. */
const removeStoredCredentials = async (ctx: any, ids: string[], envNote: string): Promise<void> => {
  try {
    const { store } = readAuthStore();
    const next = removeCredentials(store, ids);
    const removed = ids.map(providerLabelOf).join(", ");
    if (storedProviderIds(next).length === 0) {
      unlinkSync(AUTH_PATH);
      ctx.ui.notify(`[pi-jev-eye] Logged out of ${removed}; the store is now empty.${envNote}`, "info");
      return;
    }
    writeAuthStore(next);
    const left = storedProviderIds(next).map(providerLabelOf).join(", ");
    ctx.ui.notify(`[pi-jev-eye] Logged out of ${removed}. Still logged in: ${left}.${envNote}`, "info");
  } catch (error) {
    ctx.ui.notify(`[pi-jev-eye] Could not update ${AUTH_PATH}: ${(error as Error).message}`, "error");
  }
};

// Own ledger + pi-typesafe's older one, so days predating the switch are not shown as empty.
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

function recordOwnUsage(patch: Partial<DayTotals>, providerId?: string): void {
  try {
    const file = readJsonFile(OWN_USAGE_PATH) ?? { version: 1, days: {} };
    const days = file.days && typeof file.days === "object" ? file.days : {};
    // A day started by an older version has tokens but no cost; seed the estimate once, or the total keeps
    // counting tokens while the cost stays behind.
    const stored = days[today()];
    const seeded =
      stored && stored.cost === undefined
        ? { ...stored, cost: ((Number(stored.inputTokens) || 0) * USD_PER_MTOK) / 1e6 }
        : stored;
    const current: DayTotals = { ...EMPTY_TOTALS, ...seeded };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "providers") continue;
      (current as any)[key] = (Number((current as any)[key]) || 0) + (Number(value) || 0);
    }
    // The same patch is folded into the provider's own bucket, so Jev and Clef never share a total.
    if (providerId) {
      current.providers = addProviderTotals(current.providers, providerId, patch as Partial<ProviderTotals>);
    }
    days[today()] = current;
    for (const day of Object.keys(days).sort().slice(0, -31)) delete days[day];
    mkdirSync(EYE_DIR, { recursive: true });
    writeFileSync(OWN_USAGE_PATH, `${JSON.stringify({ version: 1, days }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Stats must never break a judgment call.
  }
}

// Account balance: OpenRouter exposes one directly, Cloudflare has no remaining-neuron route, TypeSafe has none at all.
// Only `/jev-eye usage` reads it; `/jev-eye status` stays offline and instant.
async function fetchBalanceText(auth: JevAuth): Promise<string> {
  const usd = (value: number) => `$${value.toFixed(4)}`;
  const get = (path: string) =>
    fetch(`https://openrouter.ai/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${auth.key}` },
      signal: AbortSignal.timeout(4000),
    });

  if (auth.provider.id !== "openrouter") return "no balance route for this provider";

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
  "  2. One Jev table where every item named anywhere in the report has a row: resolved items plus every open item, even ones only classified by threshold. If an item exists only as a score, add its row. Header spells scale in plain words (never terse `P(ya)` — ID `Peluang jawaban \"ya\" (0-1) · tinggi = sinyal kuat`, EN `Chance the answer is \"yes\" (0-1) · higher = stronger`, ZH `回答\"是\"的概率 (0-1) · 越高越强`); cells use `value (probability)` + level label.",
  "  3. Final action column: the last column states the decided action for each row (`DONE` / `BLOCKED` for items already handled — their gate verdicts stay visible there, not in extra prose; `NEXT` for items the threshold says to work next).",
  "  4. Threshold line: state decision boundary (e.g. `Ambang: p ≥ 0.85 → <aksi>`).",
  "  5. Priority conclusion: order open items by priority using the exact IDs already given a row in step 2 (no new analysis, no item that appears only here).",
  "  6. Exactly one confirmation question: ask which item(s) to handle next (`lanjut` / `continue` keeps plan; single question, never a paragraph).",
  "- Every ID in the conclusion MUST repeat an ID visible in the table above it; the reader never scrolls up to resolve a reference.",
  "- No preamble. If nothing needs judgment, state so in one line and still end with the confirmation question.",
  "- Write gate: code edits will be evaluated against this turn's request text.",
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
    const res = await fetch(authUrl(auth), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.key}` },
      body: JSON.stringify({
        model: auth.model,
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
    const body = workersAiBody(await res.json());
    const choice = body?.answers?.weight?.choice;
    return choice === "light" || choice === "heavy" || choice === "unclear" ? choice : null;
  } catch {
    return null; // Fail-open: keep the current model
  }
}

// --- Jev gate consent, three values: Enable all folder / Enable this folder / Disabled ---
type ConsentMode = "all" | "folder" | "disabled";
interface Consent {
  mode: ConsentMode;
  folders: string[];
}

const CONSENT_PATH = join(EYE_DIR, "consent.json");

// Legacy values ("folders"/"off") migrate on read; anything unknown falls back to "all",
// which is also what PI_TYPESAFE_ENABLED=1 means for the built-in tool.
function readConsent(): Consent {
  try {
    const parsed = JSON.parse(readFileSync(CONSENT_PATH, "utf8"));
    const raw = String(parsed?.mode ?? "all");
    const mode: ConsentMode = raw === "disabled" || raw === "off" ? "disabled" : raw === "folder" || raw === "folders" ? "folder" : "all";
    const folders = Array.isArray(parsed?.folders) ? parsed.folders.filter((f: unknown) => typeof f === "string") : [];
    // "this folder" with no folder left reads as Disabled, not as a puzzling empty list.
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
      model: auth.model,
      state: {
        code: codeSnippet.slice(0, JEV_MAX_STATE_CHARS),
        facts: codeFacts(codeSnippet),
        ...(request ? { request: { text: request } } : {}),
      },
      questions,
    };

    state.stats.jevRequests++;
    const res = await fetch(authUrl(auth), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });

    if (!res.ok) {
      recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
      return null;
    }
    const body = workersAiBody(await res.json());
    if (!body) {
      recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
      return null;
    }
    const inputTokens = Number(body.usage?.input_tokens) || 0;
    // Cloudflare reports a model-specific price and meters neurons; the others fall back to the flat rate.
    const isClef = auth.provider.id === "cloudflare";
    const reportedCost = Number((body.usage as any)?.cost) || (isClef ? (inputTokens * clefUsdPerMTok(auth.model)) / 1e6 : NaN);
    recordOwnUsage(
      {
        requests: 1,
        ok: 1,
        inputTokens,
        outputTokens: Number(body.usage?.output_tokens) || 0,
        cost: Number.isFinite(reportedCost) ? reportedCost : (inputTokens * USD_PER_MTOK) / 1e6,
        // Only Cloudflare bills in neurons; storing 0 for the rest keeps the panel's math uniform.
        neurons: isClef ? clefNeuronsFor(auth.model, inputTokens) : 0,
      },
      providerIdOf(auth)
    );
    return {
      has_slop: body.answers?.has_slop?.noul ?? null,
      has_unfinished_todo: body.answers?.has_unfinished_todo?.noul ?? null,
      answers_request: body.answers?.answers_request?.noul ?? null,
    };
  } catch {
    recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
    return null; // Fail-open when Jev times out or is offline
  }
}

// ON -> REVIEW -> OFF -> ON
/**
 * Keycaps are fixed: `matchesKey` must compare against a literal, and the `[Key] Mode` column in the
 * footer is measured from the strings themselves. One line per value so a writer can grep it.
 */
const KEY_SETS = {
  /** Cycle ON → REVIEW → OFF. */
  toggle: "ctrl+shift+s",
  /** Legacy alias, still registered so an existing muscle memory keeps working. */
  toggleLegacy: "ctrl+shift+e",
  /** Cycle the Jev gate value: all folders / this folder / disabled. */
  gate: "ctrl+shift+g",
  /** Cycle the model router on/off inside the routing screen. */
  routingToggle: "ctrl+r",
} as const;

const TOGGLE_KEY = KEY_SETS.toggle;
const LEGACY_TOGGLE_KEY = KEY_SETS.toggleLegacy;
// Gate scope cycle, announced in the same footer.
const GATE_KEY = KEY_SETS.gate;

// `/jev-eye status` panel chrome: title, one-line description, footer.
const STATUS_TITLE = "Jev Eye · Status";
const STATUS_DESC = "Supervisor, gate, routing and interception for this Pi session.";
// Keycap hint only: `ctrl+shift+e` -> `Ctrl+Shift+e`.
const keycap = (key: string) =>
  key
    .split("+")
    .map((part) => (part.length > 1 ? part[0].toUpperCase() + part.slice(1) : part))
    .join("+");


const eyeMode = (enabled: boolean, reviewMode: boolean): "ON" | "REVIEW" | "OFF" =>
  !enabled ? "OFF" : reviewMode ? "REVIEW" : "ON";

const statusFooter = (enabled: boolean, reviewMode: boolean) =>
  `[Enter] Done  [Esc] Cancel  [←] Back  [${keycap(TOGGLE_KEY)}] Supervisor  [${keycap(GATE_KEY)}] Grant folder`;

// Read-only screens (usage) advertise no key that would not act on them.
const PANEL_FOOTER = "[Enter] Done  [Esc] Cancel  [←] Back";

function cycleEyeState(ctx?: any): "ON" | "REVIEW" | "OFF" {
  if (!state.enabled) {
    state.enabled = true;
    state.reviewMode = false;
  } else if (!state.reviewMode) {
    state.enabled = true;
    state.reviewMode = true;
  } else {
    state.enabled = false;
    state.reviewMode = false;
  }
  if (ctx) syncEyeStatus(ctx);
  return eyeMode(state.enabled, state.reviewMode);
}

// Live state + keybindings render in the panel footer, not in Pi's status bar.
const EYE_SUBCOMMANDS = [
  { value: "status", label: "status", description: "Show supervisor status, account, usage, and interception stats" },
  { value: "usage", label: "usage", description: "Show Jev/Clef spend: per-provider totals and the Cloudflare free-neuron budget" },
  { value: "toggle", label: "toggle", description: "Cycle mode: ON -> REVIEW -> OFF" },
  { value: "on", label: "on", description: "Set mode to ON (supervisor active, prompt trigger)" },
  { value: "review", label: "review", description: "Set mode to REVIEW (all turns reviewed)" },
  { value: "off", label: "off", description: "Set mode to OFF (supervisor disabled)" },
  { value: "login", label: "login", description: "Store a Jev key: TypeSafe, OpenRouter, or Cloudflare Workers AI (Clef)" },
  { value: "logout", label: "logout", description: "Delete the key stored by /jev-eye login" },
  { value: "routing", label: "routing", description: "Routing models menu, or direct: routing light | routing heavy | routing on | routing off" },
];

// Live supervisor state for Pi's status bar (read by the pi-arnative footer):
// key "pi-jev-eye" present = extension active; ● ON / ○ OFF = supervisor state.
function syncEyeStatus(ctx: any): void {
	try {
		const ui = ctx?.ui;
		if (typeof ui?.setStatus !== "function") return;
		const theme = ui.theme;
		const paint = (color: string, text: string): string => {
			try {
				return theme?.fg ? theme.fg(color, text) : text;
			} catch {
				return text;
			}
		};
		const dot = !state.enabled ? paint("dim", "○") : state.reviewMode ? paint("warning", "●") : paint("accent", "●");
		const label = !state.enabled ? "OFF" : state.reviewMode ? "REVIEW" : "ON";
		ui.setStatus("pi-jev-eye", `${dot} ${paint("muted", "jev-eye: ")} ${paint("text", label)}`);
	} catch {
		// ui may already be disposed at session close: ignore
	}
}

export default function (pi: ExtensionAPI) {

  // Route the turn before the agent loop starts: chores to the cheap model, real work to the best one.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    if (!state.enabled) return;
    const prompt = String(event?.prompt ?? "");

    // Reviewed turn: remember the request for the gate and inject the report contract.
    // Set here, cleared by the next prompt — never in message_end: that fires before this turn's tool
    // calls run, so clearing it there wiped the request before the write gate could read it.
    const reviewed = state.reviewMode || REVIEW_TRIGGER.test(prompt);
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

    // Context guard: routing to light must not overflow the light model or trigger auto-compacting,
    // which would dump large context tokens onto a rate-limited model.
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

  // Restore model after a light turn so the session does not stay stuck on the chore model.
  // agent_settled, not agent_end: agent_end closes one low-level run while retries, recovery,
  // compaction, or queued follow-ups may still run after it. Settled means Pi will not continue.
  pi.on("agent_settled", async (_event: any, ctx: any) => {
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
    description: "Cycle pi-jev-eye mode: ON -> REVIEW -> OFF",
    handler: async (ctx: any) => {
      const mode = cycleEyeState(ctx);
      const desc = mode === "OFF" ? "supervisor disabled" : mode === "REVIEW" ? "all turns reviewed" : "prompt trigger";
      ctx.ui.notify(`[pi-jev-eye] Mode: ${mode} (${desc}). Cycle with ${TOGGLE_KEY}.`, mode === "OFF" ? "warning" : "info");
    },
  });

  pi.registerShortcut(LEGACY_TOGGLE_KEY, {
    description: `Cycle pi-jev-eye mode (alias for ${keycap(TOGGLE_KEY)})`,
    handler: async (ctx: any) => {
      const mode = cycleEyeState(ctx);
      const desc = mode === "OFF" ? "supervisor disabled" : mode === "REVIEW" ? "all turns reviewed" : "prompt trigger";
      ctx.ui.notify(`[pi-jev-eye] Mode: ${mode} (${desc}). Cycle with ${TOGGLE_KEY}.`, mode === "OFF" ? "warning" : "info");
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

  // Publish supervisor state to the status bar on every session start/reload.
  pi.on("session_start", async (_event: any, ctx: any) => {
    syncEyeStatus(ctx);
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
          // No `terminate`: the reason goes back to the model, which retries a scoped command itself.
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
  /** A stored Cloudflare key without an account id is invisible everywhere else: say why, in status. */
  const cloudflareHint = (paint: (color: string, text: string) => string): string[] => {
    const stored = readJsonFile(AUTH_PATH, true);
    if (stored?.provider !== "cloudflare" || typeof stored?.accountId === "string") return [];
    return [
      `${paint("warning", "Clef hint: ")}a Cloudflare key is stored without an account id, so it is ignored. Run \`/jev-eye login\` again, or export $CLOUDFLARE_ACCOUNT_ID.`,
    ];
  };

  // `/jev-eye usage` panel chrome.
  const USAGE_TITLE = "Jev Eye · Usage";
  const USAGE_DESC = "Jev and Clef spend, tokens and the free-neuron budget.";

  /** The provider balance line for the panel. Only OpenRouter exposes a real one; the Clef block above
   *  already reports its own neuron budget, and TypeSafe has no balance route at all. */
  const usageBalance = async (auth: JevAuth | undefined): Promise<string | undefined> => {
    if (auth?.provider.id !== "openrouter") return undefined;
    try {
      return await fetchBalanceText(auth);
    } catch {
      return "unavailable";
    }
  };

  /**
   * Usage body: one compact table holding Jev (TypeSafe/OpenRouter) and Clef side by side, so both
   * backends are read at a glance. Data is the same ledger `/jev-eye status` uses; nothing is estimated
   * except the dollar figure for a provider that does not report its own cost.
   */
  const buildUsage = (ctx: any, theme?: any, balance?: string): string[] => {
    const paint = (color: string, value: string) => (theme ? theme.fg(color, value) : value);
    const n = (value: number) => value.toLocaleString("en-US");
    const usd = (value: number) => (value >= 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(6)}`);
    const auth = resolveJevAuth();
    const days = readJsonFile(OWN_USAGE_PATH)?.days;

    // Column widths are fixed so the header and every row line up byte-for-byte.
    const W = { label: 9, req: 6, tok: 11, cost: 10 };
    const cell = (text: string, width: number, alignRight = true) => {
      const s = text.length > width ? `${text.slice(0, width - 1)}…` : text;
      return alignRight ? s.padStart(width) : s.padEnd(width);
    };
    const header = (label: string) =>
      paint("dim", cell(label, W.label, false) + cell("req", W.req) + cell("in tok", W.tok) + cell("cost", W.cost));
    const row = (label: string, t: ProviderTotals, extra = "", color = "text") =>
      paint(color, cell(label, W.label, false)) +
      paint("dim", cell(String(t.requests), W.req) + cell(n(t.inputTokens), W.tok) + cell(usd(t.cost), W.cost)) +
      extra;

    const lines: string[] = [];

    // 1. The two backends, side by side. This is the answer to "how much Jev vs Clef?" in two rows.
    lines.push(paint("accent", "Backends · this month"));
    const monthTotals = readUsage(today().slice(0, 7));
    const { clef, jev } = backendTotals(monthTotals?.providers);
    lines.push(header(""));
    lines.push(row("Jev", jev, `  ${paint("muted", auth && auth.provider.id !== "cloudflare" ? auth.provider.label : "TypeSafe / OpenRouter")}`));
    lines.push(
      row("Clef", clef, `  ${paint("muted", auth?.provider.id === "cloudflare" ? auth.model : "Cloudflare")} · ${clef.neurons >= 1 ? `${n(Math.round(clef.neurons))} neurons` : "no neurons"}`)
    );
    // Entries written before provider attribution existed cannot be split. Showing only the attributed
    // rows would make the table look complete while it covered a fraction of the period.
    const attributed = clef.requests + jev.requests;
    const unattributed = Math.max(0, (monthTotals?.requests ?? 0) - attributed);
    if (unattributed > 0) {
      const share = (total: number, known: number) => Math.max(0, total - known);
      lines.push(
        row(
          "Earlier",
          {
            requests: unattributed,
            ok: 0,
            failed: 0,
            inputTokens: share(monthTotals!.inputTokens, clef.inputTokens + jev.inputTokens),
            outputTokens: 0,
            cost: share(monthTotals!.cost, clef.cost + jev.cost),
            neurons: share(monthTotals!.neurons ?? 0, clef.neurons + jev.neurons),
          },
          `  ${paint("muted", `before the split · no provider data (${Math.round((unattributed / monthTotals!.requests) * 100)}%)`)}`
        )
      );
    }
    if (unattributed > 0 && attributed === 0) {
      lines.push(paint("muted", "the split is recorded from the next request on; the totals below are exact"));
    }
    lines.push("");

    // 2. One-line totals, so the panel still answers when the split is empty.
    lines.push(paint("accent", "Totals · both ledgers"));
    for (const [label, period] of [["Today", today()], ["Month", today().slice(0, 7)], ["All time", ""]] as const) {
      const t = readUsage(period);
      lines.push(
        t
          ? paint("dim", cell(label, W.label, false)) +
              paint("dim", cell(`${t.requests}`, W.req) + cell(n(t.inputTokens), W.tok) + cell(usd(t.cost), W.cost)) +
              paint("muted", `  ${t.ok} ok / ${t.failed} fail · out ${n(t.outputTokens)}`)
          : paint("dim", cell(label, W.label, false)) + paint("muted", "no requests")
      );
    }
    lines.push("");

    // 3. The Clef free budget is the one number that changes behaviour (the gate stops working if it is exhausted).
    const budget = clefBudget(neuronsSpentOn(days, today()));
    const barWidth = 20;
    const filled = Math.min(barWidth, Math.round((budget.used / budget.free) * barWidth));
    const exhausted = budget.used >= budget.free;
    lines.push(
      `${paint("accent", "Clef free tier")} ${paint(exhausted ? "warning" : "success", "█".repeat(filled))}${paint("dim", "░".repeat(barWidth - filled))} ${n(Math.round(budget.used))}/${n(budget.free)} neurons today${budget.overageUsd > 0 ? paint("warning", ` · over ${usd(budget.overageUsd)}`) : " · free"}`
    );
    lines.push(
      paint("dim", `  resets 00:00 UTC · ${n(Math.round(budget.remaining))} left · `) +
        paint("muted", auth?.provider.id === "cloudflare" ? `${auth.model} · $${clefUsdPerMTok(auth.model).toFixed(3)}/M in` : "Clef not the active gate key")
    );
    lines.push("");

    // 4. Session counters, one line each, no prose.
    const s = state.stats;
    lines.push(
      paint("accent", "Session ") +
        paint("dim", `gate ${Math.min(s.jevRequests, JEV_MAX_REQUESTS)}/${JEV_MAX_REQUESTS} · routing ${Math.min(s.jevRoutingCalls, JEV_MAX_ROUTING_CALLS)}/${JEV_MAX_ROUTING_CALLS} · reviewed ${s.reviewTurns}`)
    );
    lines.push(
      paint("accent", "Blocked ") +
        paint("dim", `${s.destructiveBlocked} dangerous · ${s.secretsBlocked} secret · ${s.slopBlocked} slop`) +
        (typeof ctx?.getContextUsage?.()?.tokens === "number" ? paint("dim", ` · context ${n(ctx.getContextUsage().tokens)} tok`) : "")
    );
    if (balance) lines.push(paint("accent", "Balance ") + paint("dim", balance));
    return lines;
  };

  /** `/jev-eye usage`: the same framed panel as status, with the spend breakdown. */
  const showUsage = async (ctx: any): Promise<void | "back"> => {
    const balance = await usageBalance(resolveJevAuth());
    // `custom` is a no-op in RPC (rpc-extension-ui.md): it resolves undefined without drawing anything,
    // so the text fallback must be chosen by mode, not by the method existing.
    if (ctx.mode !== "tui") {
      ctx.ui.notify([USAGE_TITLE, USAGE_DESC, "", ...buildUsage(ctx, undefined, balance)].join("\n"), "info");
      return;
    }
    const outcome = await ctx.ui.custom<number | null>((tui: any, theme: any, _kb: any, done: (value: number | null) => void) => {
      const panel = new StatusPanel(
        theme,
        buildUsage(ctx, theme, balance),
        { rebuild: () => buildUsage(ctx, theme, balance), cycleMode: () => cycleEyeState(ctx), cycleGate: () => writeConsent(nextConsent(readConsent(), ctx.cwd)) },
        done,
        USAGE_TITLE,
        USAGE_DESC,
        false, // read-only: no Mode / Grant-folder toggles on the usage screen
        borderPainterFor(theme, ctx)
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
    return outcome === BACK ? "back" : undefined;
  };

  /** Status body only: plain text in headless mode, colourised when the panel hands over a theme.
   *  Spend lives in `/jev-eye usage`; this screen answers "what is active right now" in five lines. */
  const buildStatus = (ctx: any, theme?: any): string[] => {
    const auth = resolveJevAuth();
    const consent = readConsent();
    const paint = (color: string, value: string) => (theme ? theme.fg(color, value) : value);
    const label = (text: string) => paint("dim", text.padEnd(14));
    // A zero count is the healthy value, so only a non-zero one draws the eye.
    const count = (value: number) => paint(value > 0 ? "warning" : "text", String(value));
    const dot = paint("dim", " · ");
    // Every row is `status · detail`, so one reading of the left column answers "is it on?".
    const row = (status: string, detail: (string | false | undefined)[], accent?: string) =>
      paint(accent ?? "muted", status) + paint("dim", " | ") + detail.filter(Boolean).join(dot);

    const routing = readRouting();
    const models: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
    const thisFolderOn = consentAllows(ctx.cwd, consent);
    const scope = consent.mode === "folder" ? `This folder (${thisFolderOn ? "ON" : "off"})` : consent.mode === "all" ? "All folders" : "Disabled";
    const s = state.stats;
    const gate = Math.min(s.jevRequests, JEV_MAX_REQUESTS);
    const classified = Math.min(s.jevRoutingCalls, JEV_MAX_ROUTING_CALLS);

    const lines = [
      label("Supervisor") +
        row(state.enabled ? "ENABLED" : "DISABLED", [state.reviewMode ? "Review all turns" : "Review prompt trigger"], state.enabled ? "success" : "warning"),
      label("Scope folders") + row(consent.mode === "disabled" ? "OFF" : "ON", [scope], consent.mode === "disabled" ? "warning" : "success"),
      label("Gate") +
        (auth
          ? row("READY", [`${auth.provider.short} · ${auth.model}`, `Key from ${auth.source}`], "success")
          : `${paint("warning", "OFFLINE")} | no key, run \`/jev-eye login\``),
      label("Rules") + row("ACTIVE", [`Block at p≥${JEV_BLOCK_THRESHOLD} on diffs ≥${JEV_MIN_DIFF_LINES} lines`, `gate ${gate}/${JEV_MAX_REQUESTS}`, `routing ${classified}/${JEV_MAX_ROUTING_CALLS}`], "success"),
      label("Routing") +
        row(
          routing.enabled ? "ON" : "OFF",
          [
            `light ${modelLabelFor(models, routing.light) || "unset"}`,
            `heavy ${modelLabelFor(models, routing.heavy) || "unset"}`,
            `${s.lightTurns} light / ${s.heavyTurns} heavy turns`,
          ],
          routing.enabled ? "success" : "muted",
        ),
      label("Blocked") +
        row("STATS", [
          `${count(s.destructiveBlocked)} dangerous`,
          `${count(s.secretsBlocked)} secrets`,
          `${count(s.slopBlocked)} slop`,
          `${count(s.verificationReminders)} unverified`,
          `${s.reviewTurns} reviewed turns`,
        ]),
      ...cloudflareHint(paint),
    ];

    const contextTokens = ctx?.getContextUsage?.()?.tokens;
    if (typeof contextTokens === "number") lines.push(label("Context") + row("USED", [`${contextTokens.toLocaleString("en-US")} tokens`]));
    return lines;
  };

  /** `/jev-eye status`: the framed panel, falling back to the same body as plain text without a TUI. */
  const showStatus = async (ctx: any): Promise<void | "back"> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify([STATUS_TITLE, STATUS_DESC, "", ...buildStatus(ctx), "", statusFooter(state.enabled, state.reviewMode)].join("\n"), "info");
      return;
    }

    const outcome = await ctx.ui.custom<number | null>((tui: any, theme: any, _kb: any, done: (value: number | null) => void) => {
      const panel = new StatusPanel(
        theme,
        buildStatus(ctx, theme),
        {
          rebuild: () => buildStatus(ctx, theme),
          cycleMode: () => {
            cycleEyeState(ctx);
          },
          cycleGate: () => writeConsent(nextConsent(readConsent(), ctx.cwd)),
        },
        done,
        STATUS_TITLE,
        STATUS_DESC,
        true,
        borderPainterFor(theme, ctx)
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
    return outcome === BACK ? "back" : undefined;
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
  const openRoutingMenu = async (ctx: any, focus: "light" | "heavy" = "light"): Promise<void | "back"> => {
    const available: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
    if (available.length === 0) {
      ctx.ui.notify("[pi-jev-eye] No authenticated models found to route to.", "error");
      return;
    }

    const current = readRouting();

    if (ctx.mode !== "tui") {
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
      const picker = new RoutingPicker(theme, available, current, focus, done, borderPainterFor(theme, ctx));
      return {
        render: (width: number) => picker.render(width),
        invalidate: () => picker.invalidate(),
        handleInput: (data: string) => {
          picker.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (result === BACK) return "back";
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

    const rows = [
      { label: "Login", note: auth ? `switch key (current: ${auth.provider.label})` : "TypeSafe, OpenRouter, or Cloudflare Workers AI (Clef) key" },
      { label: "Logout", note: auth ? `remove key from ${auth.source}` : "no active key stored" },
      { label: "Status", note: "supervisor, gate scope & metrics" },
      { label: "Usage", note: "Jev/Clef spend, per-provider split & free-neuron budget" },
      { label: "Routing", note: routingDesc },
    ];

    // The root menu has no previous screen, so it carries no [←] Back. Sub-screens that end with
    // [Esc] fall back here too, so the operator never lands in the editor with a half-open menu.
    while (true) {
      const index = await pickRow(ctx, "Jev Eye · Menu", rows, "Supervisor settings and live state for this session.");
      if (index === "back") return; // nothing behind the root
      if (index === null) return;
      let outcome: void | "back";
      if (index === 0) {
        outcome = await loginFlow(ctx);
      } else if (index === 1) {
        outcome = await logoutFlow(ctx);
      } else if (index === 2) {
        outcome = await showStatus(ctx);
      } else if (index === 3) {
        outcome = await showUsage(ctx);
      } else {
        outcome = await openRoutingMenu(ctx);
      }
      // Any screen that was left with [←] reopens this menu; anything else ends the command.
      if (outcome !== "back") return;
    }
  };

  const eyeHandler = async (args: string, ctx: any) => {
    const sub = args.trim().toLowerCase();

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

    if (sub === "toggle") {
      const mode = cycleEyeState(ctx);
      const desc = mode === "OFF" ? "supervisor disabled" : mode === "REVIEW" ? "all turns reviewed" : "prompt trigger";
      ctx.ui.notify(`[pi-jev-eye] Mode: ${mode} (${desc}). Cycle with ${TOGGLE_KEY}.`, mode === "OFF" ? "warning" : "info");
      return;
    }

    if (sub === "on") {
      state.enabled = true;
      state.reviewMode = false;
      syncEyeStatus(ctx);
      ctx.ui.notify(`[pi-jev-eye] Mode: ON (prompt trigger). Cycle with ${TOGGLE_KEY}.`, "info");
      return;
    }

    if (sub === "review") {
      state.enabled = true;
      state.reviewMode = true;
      syncEyeStatus(ctx);
      ctx.ui.notify(`[pi-jev-eye] Mode: REVIEW (all turns reviewed). Cycle with ${TOGGLE_KEY}.`, "info");
      return;
    }

    if (sub === "off") {
      state.enabled = false;
      state.reviewMode = false;
      syncEyeStatus(ctx);
      ctx.ui.notify(`[pi-jev-eye] Mode: OFF (supervisor disabled). Cycle with ${TOGGLE_KEY}.`, "warning");
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

    if (sub === "usage") {
      await showUsage(ctx);
      return;
    }

    if (sub !== "status") {
      ctx.ui.notify(
        `[pi-jev-eye] Unknown argument "${sub}". Use: status | usage | on | review | off | toggle | login | logout | routing [on|off], or no argument for the menu (cycle mode is ${TOGGLE_KEY}).`,
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
