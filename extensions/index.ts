// pi-jev-eye entry point: wire the layers and own the Pi event subscriptions.
//
// Layer order, leaf-first — a file imports only the ones above it:
//   layer1.ts     pure maths (box chrome, regex, ledger folds); no pi import, covered by `npm test`
//   pmr.ts        session state (leaf: every layer touches it)
//   core.ts       providers, on-disk paths, credential store
//   providers.ts  live credential probe
//   ui.ts         Arnative rounded-box chrome and every screen component
//   supervisor.ts keybinding table and status-bar indicator
//   gate.ts       Layer 3 semantic write gate
//   panels.ts     /jev-eye status and usage panels
//   commands.ts   /jev-eye menus and subcommands
//   this file     event wiring only: routing, consent, Layers 1-2, shortcuts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DESTRUCTIVE_BASH_PATTERNS, SECRET_PATTERNS, VERIFICATION_COMMAND_PATTERNS, wipeTarget } from "./layer1.ts";
import { authChain, readBackends, resolveJevAuth, setClefModels } from "./core.ts";
import { JEV_BLOCK_THRESHOLD, JEV_MAX_REQUESTS, JEV_MIN_DIFF_LINES, askJev } from "./gate.ts";
import { consentAllows, consentLabel, nextConsent, readConsent, writeConsent } from "./consent.ts";
import { installCommands } from "./commands.ts";
import { REVIEW_CONTRACT, REVIEW_TRIGGER } from "./review.ts";
import { state } from "./pmr.ts";
import { GATE_KEY, TOGGLE_KEY, cycleEyeState, syncEyeStatus } from "./supervisor.ts";
import { JEV_MAX_ROUTING_CALLS, classifyWeight, isLightByPattern, readRouting } from "./routing.ts";

/**
 * Ask Cloudflare for the Clef models this account can reach, once per session.
 *
 * The list is the provider's, not this package's: a new `clef-*` model must appear in `/jev-eye models`
 * without a release. Only the Cloudflare models route is read, and only when a credential exists; a failed
 * or absent request leaves the shipped list in place, so an offline session still offers the known models.
 */
async function refreshClefModels(): Promise<void> {
  const auth = resolveJevAuth();
  if (auth?.provider.id !== "cloudflare") return;
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/ai/models/search?search=clef`, {
      headers: { Authorization: `Bearer ${auth.key}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;
    const body: any = await res.json();
    const ids = (body?.result ?? [])
      .map((entry: any) => String(entry?.name ?? ""))
      .filter((name: string) => name.startsWith("@cf/cloudflare/clef"))
      .map((name: string) => name.slice(name.lastIndexOf("/") + 1));
    setClefModels(ids);
  } catch {
    // Offline or a revoked token: the shipped list answers, and `/jev-eye accounts` reports the key.
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

    let target: "light" | "heavy" | "unclear" | null = null;
    // Built before any branch that can return early: a reviewed turn keeps its contract on the routing-off
    // path, the exhausted-budget path, and the no-credential path, instead of losing it to an early return.
    const contract = reviewed ? { message: { customType: "pi-jev-eye-review", content: REVIEW_CONTRACT, display: true } } : undefined;

    const routing = readRouting();
    if (!routing.enabled || !routing.light || !routing.heavy) {
      return contract;
    }
    target = isLightByPattern(prompt) ? "light" : null;

    if (!target) {
      if (state.stats.jevRoutingCalls >= JEV_MAX_ROUTING_CALLS) {
        if (state.stats.jevRoutingCalls === JEV_MAX_ROUTING_CALLS) {
          state.stats.jevRoutingCalls++;
          ctx.ui.notify(
            `[pi-jev-eye] Routing budget used up (${JEV_MAX_ROUTING_CALLS} classifications); keeping the current model.`,
            "warning"
          );
        }
        return contract;
      }
      const auth = authChain(readBackends());
      if (auth.length === 0) return contract;
      target = await classifyWeight(prompt, auth);
    }

    if (target !== "light" && target !== "heavy") return contract;

    const ref = target === "light" ? routing.light : routing.heavy;
    const available: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
    const model = available.find((m) => `${m.provider}/${m.id}` === ref);

    if (!model) {
      ctx.ui.notify(`[pi-jev-eye] Routing target ${ref} is not an available model; keeping the current one.`, "warning");
      return contract;
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
    await refreshClefModels();
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

      const edits = (event.input as { edits?: unknown })?.edits;
      const contentToCheck =
        event.toolName === "write"
          ? String(event.input?.content || "")
          : Array.isArray(edits)
          ? edits.map((e: any) => e.newText || "").join("\n")
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
        const auth = authChain(readBackends());
        if (auth.length > 0) {
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

  installCommands(pi);
}
