// Per-turn model routing: classify the prompt, then move the session to the matching slot.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EYE_DIR, JEV_TIMEOUT_MS, authUrl, envBudget, providerIdOf, readJsonFile } from "./core.ts";
import type { JevAuth } from "./core.ts";
import { recordCall, recordOwnUsage } from "./ledger.ts";

import { THINKING_LEVELS, SLOT_DEFAULT_THINKING, state } from "./pmr.ts";
import type { ThinkingLevel } from "./pmr.ts";
import { withBackends, workersAiBody } from "./providers.ts";

export interface Routing {
  enabled: boolean;
  light: string; // "provider/modelId" as listed by ctx.modelRegistry.getAvailable()
  heavy: string;
  lightThinking?: ThinkingLevel;
  heavyThinking?: ThinkingLevel;
}

const ROUTING_PATH = join(EYE_DIR, "routing.json");
export const JEV_MAX_ROUTING_CALLS = envBudget("PI_JEV_EYE_MAX_ROUTING_CALLS", 20); // own session budget, so routing cannot eat the write gate's quota

export function readRouting(): Routing {
  const raw = readJsonFile(ROUTING_PATH);
  return {
    enabled: raw?.enabled === true,
    light: typeof raw?.light === "string" ? raw.light : "",
    heavy: typeof raw?.heavy === "string" ? raw.heavy : "",
    // THINKING_LEVELS validates the file (a hand-edited level outside the union is ignored); the
    // starting value comes from SLOT_DEFAULT_THINKING so the picker and the store cannot disagree.
    lightThinking: THINKING_LEVELS.includes(raw?.lightThinking) ? raw.lightThinking : SLOT_DEFAULT_THINKING.light,
    heavyThinking: THINKING_LEVELS.includes(raw?.heavyThinking) ? raw.heavyThinking : SLOT_DEFAULT_THINKING.heavy,
  };
}

export function writeRouting(routing: Routing): void {
  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(ROUTING_PATH, `${JSON.stringify({ version: 1, ...routing }, null, 2)}\n`, { mode: 0o600 });
}

// Zero-request shortcut: chores need no judgment at all.
const LIGHT_TASK_PATTERNS = [
  /^\s*\/?(commit|push|pull|fetch|status|log|diff|show|branch|checkout|switch|stash|tag|remote|merge|rebase|add)\b/i,
  /\b(git\s+(commit|push|pull|fetch|status|log|diff|stash|branch|tag|remote))\b/i,
  /^\s*(tolong\s+)?(commit|push|pull|sinkron|unggah)\b/i,
];

export const isLightByPattern = (prompt: string): boolean => LIGHT_TASK_PATTERNS.some((p) => p.test(prompt));

/** One judgment against one backend: `null` means this backend could not answer.
 *  Exported so the failover path can be driven directly by `npm test`, without a network or a session. */
export async function attemptWeight(prompt: string, auth: JevAuth): Promise<"light" | "heavy" | "unclear" | null> {
  try {
    // The cap holds per attempt, not per chain: a failover at the last slot would otherwise overshoot it
    // and skip the one-time warning, which fires only when the counter equals the cap.
    if (state.stats.jevRoutingCalls >= JEV_MAX_ROUTING_CALLS) return null;
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
    if (!res.ok) {
      recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
      return null;
    }
    const body = workersAiBody(await res.json());
    if (!body) {
      recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
      return null;
    }
    const choice = body.answers?.weight?.choice;
    const answered = choice === "light" || choice === "heavy" || choice === "unclear";
    // Routing spends the same quota as the gate, so it books the same ledger row.
    recordCall(auth, body, answered);
    return answered ? choice : null;
  } catch {
    recordOwnUsage({ requests: 1, failed: 1 }, providerIdOf(auth));
    return null;
  }
}

/**
 * One judgment: is this turn a heavy review or a light chore? Unclear keeps the current model.
 *
 * The chain is the active backend then its fallback, so a stalled backend costs one timeout and the
 * classification still lands. `null` means no backend answered — the caller keeps the current model.
 */
export async function classifyWeight(prompt: string, chain: JevAuth[]): Promise<"light" | "heavy" | "unclear" | null> {
  const outcome = await withBackends(chain, (auth) => attemptWeight(prompt, auth));
  return outcome?.result ?? null;
}
