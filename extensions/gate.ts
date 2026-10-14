// Layer 3: the semantic write gate. One batched question per diff, hard per-session budget.

import { JEV_TIMEOUT_MS, authUrl, providerIdOf } from "./core.ts";
import type { JevAuth } from "./core.ts";
import { USD_PER_MTOK, clefNeuronsFor, clefUsdPerMTok } from "./layer1.ts";
import { recordOwnUsage } from "./ledger.ts";
import { state } from "./pmr.ts";
import { withBackends, workersAiBody } from "./providers.ts";

export const JEV_MIN_DIFF_LINES = 10; // Skip tiny diffs: the same question repeated per write is what burns the quota
export const JEV_BLOCK_THRESHOLD = 0.85; // P(yes) needed to block a write
export const JEV_MAX_REQUESTS = 20; // Hard per-session cap: one request = all dimensions, never one per question
const JEV_MAX_STATE_CHARS = 4000; // Pruned state (signal over noise), far below the 64 KiB limit

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

// Two independent dimensions, batched into ONE request. One attempt against one backend, for the chain in
// `askJev` below: `null` is the one value that means "this backend could not answer", which is exactly what
// the failover needs to tell apart from a judgment that came back clean.
async function attemptJev(codeSnippet: string, auth: JevAuth): Promise<JevVerdict | null> {
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
    const answers = body.answers;
    // A 200 that carries no answer for this request is a failure of this backend, not a clean verdict:
    // the three dimensions below would all read `null`, the gate would find no block signal, and the
    // failover would never run because the attempt looked successful. At least one dimension must be a
    // number before the attempt counts as an answer.
    if (!answers || typeof answers !== "object" || Object.values(answers).every((value: any) => typeof value?.noul !== "number")) {
      recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
      return null;
    }
    return {
      has_slop: answers.has_slop?.noul ?? null,
      has_unfinished_todo: answers.has_unfinished_todo?.noul ?? null,
      answers_request: answers.answers_request?.noul ?? null,
    };
  } catch {
    recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
    return null; // Fail-open when Jev times out or is offline
  }
}

/** One attempt against one backend: `null` means this backend could not answer.
 *  Exported so the failover path can be driven directly by `npm test`, without a network or a session. */
export { attemptJev };

/**
 * The semantic verdict, down the configured chain: the active backend, then the fallback.
 *
 * One failed call is one ledger row and owes nothing to the caller — the gate fails open either way —
 * but a second backend that answers turns a failed write check back into a real gate. The verdict
 * itself is the same shape whichever backend produced it, which is what lets the chain stay silent
 * here and visible in `/jev-eye status` (`fallbacks`).
 */
export async function askJev(codeSnippet: string, chain: JevAuth[]): Promise<JevVerdict | null> {
  const outcome = await withBackends(chain, (auth) => attemptJev(codeSnippet, auth));
  return outcome?.result ?? null;
}
