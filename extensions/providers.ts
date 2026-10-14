// The probe that proves a credential works against a provider's live route before it is stored, and the
// one call path every Jev/Clef request takes: active backend first, fallback behind it.

import type { JevAuth, JevProvider } from "./core.ts";
import { clefBody, clefError } from "./layer1.ts";
import { state } from "./pmr.ts";

type ClefAnswer = { model?: string; answers?: Record<string, any>; usage?: { input_tokens?: number; output_tokens?: number } };

export const workersAiBody = (json: any): ClefAnswer | undefined => clefBody(json) as ClefAnswer | undefined;
const workersAiError = clefError;

/** One tiny request: proves the key AND that the route works, before anything is saved. */
export async function probeJev(provider: JevProvider, key: string, url = provider.url, model = provider.model): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        state: { probe: "connectivity check from pi-jev-eye accounts" },
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

/**
 * One judgment, tried down the chain: the active backend first, then the fallback.
 *
 * A failed call is one that the caller cannot use — a non-OK response, a shape the envelope unwrap
 * rejects, a timeout, a network error. All four mean the same thing to the gate (it fails open) and to
 * the router (the turn keeps its model), so they are one branch here instead of a reason the caller has
 * to classify. Each attempt records its own ledger row, so a failed primary is counted exactly once.
 */
export async function withBackends<T>(chain: JevAuth[], attempt: (auth: JevAuth) => Promise<T | null>): Promise<{ auth: JevAuth; result: T } | null> {
  for (const [index, auth] of chain.entries()) {
    const result = await attempt(auth);
    if (result !== null) {
      // The first entry is the active backend; only a later one is a failover worth counting.
      if (index > 0) state.stats.fallbacks++;
      return { auth, result };
    }
  }
  return null;
}
