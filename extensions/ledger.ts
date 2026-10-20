// Usage ledger: per-day counters, the per-provider split and the provider balance line.

import { mkdirSync, writeFileSync } from "node:fs";
import { EYE_DIR, LEGACY_USAGE_PATH, OWN_USAGE_PATH, providerIdOf, readJsonFile } from "./core.ts";
import type { JevAuth } from "./core.ts";
import { EMPTY_TOTALS, USD_PER_MTOK, addProviderTotals, clefNeuronsFor, clefUsdPerMTok, legacyTotals, mergeTotals, normalizeTotals, sumDays } from "./layer1.ts";
import type { DayTotals, ProviderTotals } from "./layer1.ts";

// Cloudflare resets the free neuron allowance at 00:00 UTC, so a ledger day is a UTC day: a local
// day would split one Clef allowance across two rows (7 hours off in WIB).
export const today = (): string => new Date().toISOString().slice(0, 10);

/** One period across both ledgers: today, or the current calendar month. */
export function readUsage(period: string): DayTotals | undefined {
  return mergeTotals(
    sumDays(readJsonFile(OWN_USAGE_PATH)?.days, period, normalizeTotals),
    sumDays(readJsonFile(LEGACY_USAGE_PATH)?.days, period, legacyTotals)
  );
}

export function recordOwnUsage(patch: Partial<DayTotals>, providerId?: string): void {
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

/** One HTTP call that came back 200: its tokens, cost and neurons are billed whether or not the body was usable,
 *  so the gate and the router both book it here as exactly one row, ok or failed. */
export function recordCall(auth: JevAuth, body: any, answered: boolean): void {
  const inputTokens = Number(body?.usage?.input_tokens) || 0;
  // Cloudflare reports a model-specific price and meters neurons; the others fall back to the flat rate.
  const isClef = auth.provider.id === "cloudflare";
  const reportedCost = Number(body?.usage?.cost) || (isClef ? (inputTokens * clefUsdPerMTok(auth.model)) / 1e6 : NaN);
  recordOwnUsage(
    {
      requests: 1,
      ...(answered ? { ok: 1 } : { failed: 1 }),
      inputTokens,
      outputTokens: Number(body?.usage?.output_tokens) || 0,
      cost: Number.isFinite(reportedCost) ? reportedCost : (inputTokens * USD_PER_MTOK) / 1e6,
      // Only Cloudflare bills in neurons; storing 0 for the rest keeps the panel math uniform.
      neurons: isClef ? clefNeuronsFor(auth.model, inputTokens) : 0,
    },
    providerIdOf(auth)
  );
}

// Account balance: OpenRouter exposes one directly, Cloudflare has no remaining-neuron route, TypeSafe has none at all.
// Only `/jev-eye usage` reads it; `/jev-eye status` stays offline and instant.
export async function fetchBalanceText(auth: JevAuth): Promise<string> {
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
