import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  };
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
  },
};

// --- Layer 1: Local Regex Patterns (0 ms, 0 Token) ---
const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+-[rfRF]{1,4}\s+([/~]|\$HOME|\.\.)/i,
  /\brm\s+--recursive\s+--force\s+([/~]|\$HOME|\.\.)/i,
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

// --- Layer 3: TypeSafe Jev helper ---
function getTypeSafeApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }

  const authPath = join(homedir(), ".pi", "agent", "pi-typesafe", "auth.json");
  try {
    if (process.platform !== "win32") {
      const mode = statSync(authPath).mode;
      if ((mode & 0o077) !== 0) return undefined; // Permission safety check
    }
    const data = JSON.parse(readFileSync(authPath, "utf8"));
    return typeof data.apiKey === "string" && data.apiKey.trim() ? data.apiKey.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function checkSlopWithJev(codeSnippet: string, apiKey: string): Promise<number | null> {
  try {
    const payload = {
      model: "jev-latest",
      state: {
        code: codeSnippet.slice(0, 4000), // Trim state (signal over noise)
      },
      questions: {
        has_slop: {
          type: "noul",
          instructions:
            "Does this code contain lazy stubs, empty implementations, or unresolved TODO comments?",
        },
      },
    };

    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return null;
    const json: any = await res.json();
    return json?.answers?.has_slop?.noul ?? null;
  } catch {
    return null; // Fail-open when Jev times out or is offline
  }
}

const EYE_SUBCOMMANDS = [
  { value: "status", label: "status", description: "Show supervisor status, layers, and interception stats" },
  { value: "on", label: "on", description: "Enable the supervisor" },
  { value: "off", label: "off", description: "Disable the supervisor" },
];

export default function (pi: ExtensionAPI) {
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

      // Detect destructive actions
      for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
        if (pattern.test(cmd)) {
          state.stats.destructiveBlocked++;
          ctx.ui.notify(`[pi-jev-eye] BLOCKED: dangerous command detected (${pattern})`, "error");
          return {
            block: true,
            reason: `[pi-jev-eye] Command blocked for safety: "${cmd}". Destructive actions require explicit user confirmation.`,
            terminate: true,
          };
        }
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

      // Layer 3: check Jev slop when the new code exceeds 10 lines
      if (state.semanticGate && contentToCheck.split("\n").length >= 10) {
        const apiKey = getTypeSafeApiKey();
        if (apiKey) {
          const slopProb = await checkSlopWithJev(contentToCheck, apiKey);
          if (slopProb !== null && slopProb >= 0.85) {
            state.stats.slopBlocked++;
            ctx.ui.notify(`[pi-jev-eye] JEV BLOCK: slop/stub code detected (p=${slopProb.toFixed(2)})`, "warning");
            return {
              block: true,
              reason: `[pi-jev-eye] Write blocked by Jev (p=${slopProb.toFixed(2)}): slop/stub/unfinished TODO code detected. Implement the real thing before saving.`,
            };
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

  // --- `/eye` CLI command ---
  pi.registerCommand("eye", {
    description: "pi-jev-eye supervisor: status, toggle, and stats",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items: AutocompleteItem[] = EYE_SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.toLowerCase()));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "on") {
        state.enabled = true;
        ctx.ui.notify("[pi-jev-eye] Supervisor enabled.", "info");
        return;
      }

      if (sub === "off") {
        state.enabled = false;
        ctx.ui.notify("[pi-jev-eye] Supervisor disabled.", "warning");
        return;
      }

      const apiKey = getTypeSafeApiKey();
      const statusText = [
        "=== pi-jev-eye status ===",
        `Status: ${state.enabled ? "ENABLED" : "DISABLED"}`,
        `Layer 1 (Regex filter): ENABLED`,
        `Layer 2 (Done-check tracker): ENABLED`,
        `Layer 3 (Jev semantic gate): ${apiKey ? "READY (key validated)" : "OFFLINE (no TypeSafe key found)"}`,
        "",
        "--- Interception stats ---",
        `Dangerous commands blocked:`.padEnd(31) + state.stats.destructiveBlocked,
        `Secret leaks blocked:`.padEnd(31) + state.stats.secretsBlocked,
        `Slop writes blocked (Jev):`.padEnd(31) + state.stats.slopBlocked,
        `Warnings without verification:`.padEnd(31) + state.stats.verificationReminders,
        "",
        "Use: `/eye on` or `/eye off` to control.",
      ].join("\n");

      ctx.ui.notify(statusText, "info");
    },
  });
}
