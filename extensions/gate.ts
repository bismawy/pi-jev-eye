// Layer 3: the semantic write gate. One batched question per diff, hard per-session budget.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JEV_TIMEOUT_MS, authUrl, envBudget, providerIdOf } from "./core.ts";
import type { JevAuth } from "./core.ts";
import { recordCall, recordOwnUsage } from "./ledger.ts";
import { state } from "./pmr.ts";
import { withBackends, workersAiBody } from "./providers.ts";

export const JEV_MIN_DIFF_LINES = 10; // Skip tiny diffs: the same question repeated per write is what burns the quota
// P(yes) needed to block a write. PI_JEV_EYE_BLOCK_THRESHOLD overrides it per session; a value outside (0.5, 1]
// falls back to 0.85, because a threshold at or below a coin flip would block most legitimate writes.
export const JEV_BLOCK_THRESHOLD = blockThreshold(process.env.PI_JEV_EYE_BLOCK_THRESHOLD);

export function blockThreshold(raw: string | undefined): number {
  const value = Number(raw);
  return value > 0.5 && value <= 1 ? value : 0.85;
}
export const JEV_MAX_REQUESTS = envBudget("PI_JEV_EYE_MAX_REQUESTS", 20); // Hard per-session cap: one request = all dimensions, never one per question
const JEV_MAX_STATE_CHARS = 4000; // Pruned state (signal over noise), far below the 64 KiB limit

// The gate asks about stubs and placeholders in logic; prose, config and data files have none, so judging
// a README, a CHANGELOG or a JSON file only produces false blocks and spends the session budget.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp|sh|ps1|lua|dart|scala|vue|svelte|astro)$/i;

export function isCodePath(path: unknown): boolean {
  return typeof path === "string" && CODE_FILE.test(path);
}

// Facts are sent to the judge as evidence, so a count that includes legal code biases it toward "slop":
// {} as an object literal, a default value, an arrow no-op or a deliberate catch {} is not a stub,
// and a TODO inside a string is data, not unfinished work. Only an empty body right after a parameter
// list (with an optional return type) counts.
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\\n]){0,}\1/g;
const EMPTY_CATCH = /\bcatch\s{0,}(?:\([^)]{0,}\))?\s{0,}\{\s*\}/g;
const EMPTY_CALLABLE_BODY = /\)\s*(?::\s*[^{};=]+?)?\s*\{\s*\}/g;

// Machine-checkable facts first: Jev judges, it does not verify.
export function codeFacts(code: string) {
  const bare = code.replace(STRING_LITERAL, '""').replace(EMPTY_CATCH, "");
  return {
    lines: code.split("\n").length,
    placeholder_markers: (bare.match(/\b(?:TODO|FIXME|XXX|not implemented|NotImplementedError)\b/gi) ?? []).length,
    empty_bodies: (bare.match(EMPTY_CALLABLE_BODY) ?? []).length,
    ellipsis_only_lines: (code.match(/^\s*\.\.\.\s*$/gm) ?? []).length,
  };
}

// The file before the edit, so the judge sees the change in place. null when it cannot be read (a new path,
// a typo), which leaves editContext with the bare fragments; the edit tool itself reports the bad path.
export function readSource(cwd: string, path: unknown): string | null {
  if (typeof path !== "string" || !path) return null;
  try {
    return readFileSync(resolve(cwd, path.replace(/^@/, "")), "utf8");
  } catch {
    return null;
  }
}

const EDIT_CONTEXT_LINES = 20;

// An edit judged alone is a fragment: a newText that closes a function body reads like a stub.
// Judge each replacement inside the lines around it, in the file as it will be after the edit.
// Without the file (new path, unreadable, oldText not found) the bare fragments are all there is.
export function editContext(original: string | null, edits: { oldText?: string; newText?: string }[]): string {
  const fragments = edits.map((e) => e.newText ?? "");
  if (original === null) return fragments.join("\n");
  let after = original;
  for (const e of edits) {
    if (!e.oldText || !after.includes(e.oldText)) return fragments.join("\n");
    after = after.replace(e.oldText, () => e.newText ?? "");
  }
  const lines = after.split("\n");
  const windows = fragments.map((text) => {
    const at = text ? after.indexOf(text) : -1;
    if (at < 0) return text;
    const first = after.slice(0, at).split("\n").length - 1;
    const last = first + text.split("\n").length - 1;
    return lines.slice(Math.max(0, first - EDIT_CONTEXT_LINES), last + EDIT_CONTEXT_LINES + 1).join("\n");
  });
  return windows.join("\n\n");
}

// A block reason without its evidence makes the agent rewrite blind and burn the request budget; name the counts to fix.
export function blockHint(f: ReturnType<typeof codeFacts>): string {
  return "Facts: " + f.empty_bodies + " empty bodies, " + f.placeholder_markers + " placeholder markers, " + f.ellipsis_only_lines + " ellipsis-only lines. Replace each with real logic, or split the write so every part is complete on its own.";
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
        // Counted on the same slice the judge reads, so a marker past the cut is never evidence it cannot see.
        facts: codeFacts(codeSnippet.slice(0, JEV_MAX_STATE_CHARS)),
        ...(request ? { request: { text: request } } : {}),
      },
      questions,
    };

    // The cap holds per attempt, not per chain: a failover at the last slot would otherwise overshoot it
    // and skip the one-time warning, which fires only when the counter equals the cap.
    if (state.stats.jevRequests >= JEV_MAX_REQUESTS) return null;
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
    const answers = body.answers;
    // A 200 that carries no answer for this request is a failure of this backend, not a clean verdict:
    // the three dimensions below would all read `null`, the gate would find no block signal, and the
    // failover would never run because the attempt looked successful. At least one dimension must be a
    // number before the attempt counts as an answer.
    const answered =
      !!answers && typeof answers === "object" && Object.values(answers).some((value: any) => typeof value?.noul === "number");
    // One HTTP call is one ledger row: the tokens were spent either way, only the outcome differs.
    recordCall(auth, body, answered);
    if (!answered) return null;
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
