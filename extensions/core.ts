// Providers, on-disk paths, credential store and auth resolution.
// No UI concern: the pickers and flows above this file never touch the filesystem directly.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { USD_PER_MTOK, cfRunUrl, clefRowLabel, clefUsdPerMTok, migrateAuthStore, validBackendRef } from "./layer1.ts";
import type { AuthStore, Backends, StoredCredential } from "./layer1.ts";

export interface JevProvider {
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

export const JEV_PROVIDERS: JevProvider[] = [
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
    // Static catalog fallback; the live list comes from `MODELS.clef`, filled by the extension at
    // session start. `clef` leads: a row list reads cheap-to-expensive, the issue is only the default.
    models: ["clef", "clef-flash"],
  },
];

export const EYE_DIR = join(homedir(), ".pi", "agent", "pi-jev-eye");
export const AUTH_PATH = join(EYE_DIR, "auth.json");
export const OWN_USAGE_PATH = join(EYE_DIR, "usage.json");
/** The backends the operator picked in `/jev-eye models`, separate from the credentials that feed them. */
export const BACKENDS_PATH = join(EYE_DIR, "backends.json");
/** One ref separator. A provider id never carries a colon, so the first colon splits the model off. */
export const MODEL_SEPARATOR = ":";
const LEGACY_AUTH_PATH = join(homedir(), ".pi", "agent", "pi-typesafe", "auth.json");
export const LEGACY_USAGE_PATH = join(homedir(), ".pi", "agent", "pi-typesafe", "usage.json");

/** How long either model call may take before the caller fails open. Shared: the gate and the router
 *  must give up on the same clock, or one of them stalls a session the other would have released. */
export const JEV_TIMEOUT_MS = 5000;

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
export function readJsonFile(path: string, requirePrivate = false): any | undefined {
  try {
    if (requirePrivate && !keyFileIsPrivate(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A stored provider id as a readable name; an id this build no longer ships stays as it was stored. */
export const providerLabelOf = (id: string): string => providerById(id)?.short ?? id;

// The pure shapes and folds live in ./layer1.ts (covered by `npm test`); this is the file I/O around them.
export const AUTH_BACKUP_PATH = `${AUTH_PATH}.v1.bak`;

/** Read the store, migrating a v1 file in place once (keeping a `.v1.bak` copy for rollback). */
export function readAuthStore(): { store: AuthStore; migrated: boolean } {
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

export function writeAuthStore(store: AuthStore): void {
  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(AUTH_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

/** One provider's credential in the store, or undefined when that backend is not logged in. */
export const storedCredential = (store: AuthStore, id: string): StoredCredential | undefined => store.providers[id];

export interface JevAuth {
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
export const providerIdOf = (auth: JevAuth): string => auth.provider.id;

/** One catalog row: which provider and model, how it is named, and whether a key can reach it today. */
export interface BackendModel {
  ref: string;
  providerId: string;
  providerShort: string;
  model: string;
  /** How the row names this model on its own, without the provider tag. */
  label: string;
  configured: boolean;
}

export const backendRef = (providerId: string, model: string): string => `${providerId}${MODEL_SEPARATOR}${model}`;

/** Split a ref into its parts. A component this build no longer ships stays as it was written. */
export const backendRefParts = (ref: string): { providerId: string; model: string } => {
  const at = ref.indexOf(MODEL_SEPARATOR);
  return at < 0 ? { providerId: ref, model: "" } : { providerId: ref.slice(0, at), model: ref.slice(at + 1) };
};

/**
 * The Clef models this session may pick. Cloudflare publishes the live list on its model-discovery route,
 * so the extension fills this cache once at session start (`index.ts`) and every reader — the catalog, the
 * Accounts picker — sees the same list. Until then the shipped list in `JEV_PROVIDERS` answers, so a
 * headless or offline session still offers the two models the pricing table knows.
 */
let liveClefModels: string[] = [];
export const setClefModels = (ids: string[]): void => {
  liveClefModels = ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
};

/** The models a provider offers: Clef's live list, or the single fixed model every other provider ships. */
const providerModelList = (provider: JevProvider): string[] => {
  if (provider.id !== "cloudflare") return [provider.model];
  return liveClefModels.length > 0 ? liveClefModels : provider.models ?? [];
};

/** The catalog as this session sees it, against the credentials currently on disk. */
export function currentCatalog(store: AuthStore = readAuthStore().store): BackendModel[] {
  const entries: BackendModel[] = [];
  for (const provider of JEV_PROVIDERS) {
    const envKey = process.env[provider.keyEnv]?.trim();
    const envAccount = provider.accountEnv ? process.env[provider.accountEnv]?.trim() : undefined;
    const credential = storedCredential(store, provider.id);
    // A Clef credential is unusable without its account id, so the row reads `no key` in that case — the
    // same rule the gate applies, so the screen cannot promise a backend the gate would refuse.
    const configured = provider.accountEnv
      ? Boolean((envKey && envAccount) || credential?.accountId)
      : Boolean(envKey || credential);
    for (const model of providerModelList(provider)) {
      entries.push({
        ref: backendRef(provider.id, model),
        providerId: provider.id,
        providerShort: provider.short,
        model,
        label: provider.id === "cloudflare" ? clefRowLabel(model) : model,
        configured,
      });
    }
  }
  return entries;
}

/**
 * The stored backend choice, validated against the catalog. A ref the catalog does not list — a stale
 * file, a model removed upstream — reads as unset instead of pointing the gate at a route that cannot exist.
 */
export function readBackends(): Backends {
  const raw = readJsonFile(BACKENDS_PATH);
  const refs = currentCatalog().map((entry) => entry.ref);
  return { primary: validBackendRef(raw?.primary, refs), fallback: validBackendRef(raw?.fallback, refs) };
}

export function writeBackends(backends: Backends): void {
  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(BACKENDS_PATH, `${JSON.stringify({ version: 1, ...backends }, null, 2)}\n`, { mode: 0o600 });
}

/** One provider's credential from whichever source currently wins, or undefined when it has none. */
export function credentialsFor(providerId: string, store = readAuthStore().store): JevAuth | undefined {
  const provider = providerById(providerId);
  if (!provider) return undefined;
  // Environment first: an explicit export (headless run, CI, shared machine) wins over a stored key,
  // the same precedence pi-typesafe uses.
  const fromEnv = process.env[provider.keyEnv]?.trim();
  if (fromEnv) {
    const accountId = provider.accountEnv ? process.env[provider.accountEnv]?.trim() : undefined;
    if (provider.accountEnv && !accountId) return undefined; // a Clef token without its account id cannot build a route
    return { provider, key: fromEnv, source: `$${provider.keyEnv}`, model: provider.model, accountId };
  }
  const credential = storedCredential(store, provider.id);
  if (!credential) return undefined;
  if (provider.accountEnv && !credential.accountId) return undefined; // unusable: treat as not logged in
  const known = providerModelList(provider).includes(String(credential.model));
  return {
    provider,
    key: credential.apiKey,
    source: "/jev-eye accounts",
    model: known ? String(credential.model) : provider.model,
    accountId: credential.accountId,
  };
}

/** The credential a catalog ref resolves to right now, or undefined when that backend cannot be called. */
export function authFor(ref: string, store = readAuthStore().store): JevAuth | undefined {
  const { providerId, model } = backendRefParts(ref);
  const auth = credentialsFor(providerId, store);
  if (!auth) return undefined;
  const known = providerModelList(providerById(providerId)!).includes(model);
  return known ? { ...auth, model } : auth;
}

/**
 * Failover order for one call: the active backend first, then the fallback, then the default precedence
 * (`resolveJevAuth`) so a session with nothing configured still reaches whatever key it has.
 *
 * A ref whose backend has no usable credential is skipped — a fallback that cannot answer is not a
 * fallback, and trying it would only add a failed request to the ledger. Refs are deduplicated, so the
 * same backend is never called twice in one turn.
 */
export function authChain(backends: Backends, store = readAuthStore().store): JevAuth[] {
  const chain: JevAuth[] = [];
  for (const ref of [backends.primary, backends.fallback]) {
    if (!ref) continue;
    const auth = authFor(ref, store);
    if (!auth) continue;
    if (!chain.some((existing) => existing.provider.id === auth.provider.id && existing.model === auth.model)) chain.push(auth);
  }
  const fallbackDefault = resolveJevAuth(store);
  if (fallbackDefault && !chain.some((existing) => existing.provider.id === fallbackDefault.provider.id && existing.model === fallbackDefault.model)) {
    chain.push(fallbackDefault);
  }
  return chain;
}

/** The per-request route: only Cloudflare needs an id that the provider entry cannot carry. */
export const authUrl = (auth: JevAuth): string =>
  auth.provider.id === "cloudflare" ? cfRunUrl(auth.accountId ?? "", auth.model) : auth.provider.url;

export function resolveJevAuth(store = readAuthStore().store): JevAuth | undefined {
  // Environment first: an explicit export (headless run, CI, shared machine) must win over a stored key,
  // the same precedence pi-typesafe uses.
  for (const provider of JEV_PROVIDERS) {
    const auth = credentialsFor(provider.id, store);
    if (auth) return auth;
  }

  // Back-compat: keep working for anyone who already logged in with pi-typesafe installed.
  const legacy = readJsonFile(LEGACY_AUTH_PATH, true);
  const legacyKey = typeof legacy?.apiKey === "string" ? legacy.apiKey.trim() : "";
  if (legacyKey) return { provider: JEV_PROVIDERS[0], key: legacyKey, source: "pi-typesafe login", model: JEV_PROVIDERS[0].model };

  return undefined;
}

/** What `/jev-eye status` has to explain when a Cloudflare credential is incomplete. */
export const envAccountId = (provider: JevProvider): string | undefined =>
  provider.accountEnv ? process.env[provider.accountEnv]?.trim() || undefined : undefined;

export const isPlausibleKey = (key: string): boolean =>
  key.length >= 16 && key.length <= 512 && !/\s/.test(key) && /^[\x21-\x7e]+$/.test(key);

/** Where a key can come from right now, and what to say when a Cloudflare token has no account id. */
export function keySources(): { usable: string[]; cfTokenWithoutAccount: boolean } {
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
