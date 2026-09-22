import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

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
    jevRequests: number;
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
    jevRequests: 0,
  },
};

// --- Layer 1: Local Regex Patterns (0 ms, 0 Token) ---
// A wipe is judged per path argument, not by "the command mentions / somewhere": the old all-absolute-paths rule
// blocked `rm -rf /tmp/scratch` while a regex quirk made it block `git push --force origin feature/x` too.
// Catastrophic = root, a whole top-level dir (/usr, /tmp, /home), a system dir near the top (/var/log),
// home in any form (~, ~/x, $HOME/x), a parent hop, or a top-level glob (/home/*). Everything deeper is scoped.
const SYSTEM_ROOT_DIRS = new Set(["etc", "usr", "var", "boot", "bin", "sbin", "lib", "lib64", "opt", "srv", "root", "sys", "proc", "dev"]);

/** Returns the offending path argument when the command is a filesystem wipe, otherwise null. */
function wipeTarget(command: string): string | null {
  const match = /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+|--recursive\s+--force\s+)+([^;&|]*)/.exec(command);
  if (!match) return null;

  for (const raw of match[1].trim().split(/\s+/)) {
    const target = raw.replace(/^["']|["']$/g, "");
    if (!target) continue;

    if (/^(?:~|\$\{?HOME\}?)(?:\/|$)/.test(target)) return target;
    if (/^\.\.(?:\/\.\.)*\/?$/.test(target)) return target;
    if (!target.startsWith("/")) continue;

    const segments = target.split("/").filter(Boolean);
    if (segments.length <= 1) return target; // / , /* , /usr , /tmp , /home
    if (segments.length === 2 && (SYSTEM_ROOT_DIRS.has(segments[0]) || segments[1].includes("*"))) return target; // /var/log , /home/*
  }

  return null;
}

const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+.*--no-preserve-root\b/i,
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

// --- TypeSafe consent store: Enable all / Enable per folder / Disable ---
type ConsentMode = "all" | "folders" | "off";
interface Consent {
  mode: ConsentMode;
  folders: string[];
}

const CONSENT_DIR = join(homedir(), ".pi", "agent", "pi-jev-eye");
const CONSENT_PATH = join(CONSENT_DIR, "consent.json");
const TYPESAFE_USAGE_PATH = join(homedir(), ".pi", "agent", "pi-typesafe", "usage.json");
const USD_PER_MTOK = 0.042; // mirrors pi-typesafe's default input-token rate

// Default keeps the previous behaviour (gate on wherever a key exists) until the operator chooses otherwise.
function readConsent(): Consent {
  try {
    const parsed = JSON.parse(readFileSync(CONSENT_PATH, "utf8"));
    const mode: ConsentMode = parsed?.mode === "off" || parsed?.mode === "folders" ? parsed.mode : "all";
    const folders = Array.isArray(parsed?.folders) ? parsed.folders.filter((f: unknown) => typeof f === "string") : [];
    return { mode, folders };
  } catch {
    return { mode: "all", folders: [] };
  }
}

function writeConsent(consent: Consent): void {
  mkdirSync(CONSENT_DIR, { recursive: true });
  writeFileSync(CONSENT_PATH, `${JSON.stringify({ version: 1, ...consent }, null, 2)}\n`, { mode: 0o600 });
}

function consentAllows(cwd: string, consent: Consent): boolean {
  if (consent.mode === "all") return true;
  if (consent.mode === "off") return false;
  return consent.folders.some((f) => cwd === f || cwd.startsWith(f.endsWith(sep) ? f : f + sep));
}

function consentLabel(consent: Consent): string {
  if (consent.mode === "all") return "all folders";
  if (consent.mode === "off") return "disabled";
  return `${consent.folders.length} folder(s)`;
}

// Today's totals written by pi-typesafe itself; read-only, never rewritten by us.
function readTypeSafeUsage(): { requests: number; ok: number; failed: number; inputTokens: number; outputTokens: number } | null {
  try {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const totals = JSON.parse(readFileSync(TYPESAFE_USAGE_PATH, "utf8"))?.days?.[day];
    if (!totals) return null;
    return {
      requests: Number(totals.requestsStarted) || 0,
      ok: Number(totals.requestsSucceeded) || 0,
      failed: Number(totals.requestsFailed) || 0,
      inputTokens: Number(totals.inputTokens) || 0,
      outputTokens: Number(totals.outputTokens) || 0,
    };
  } catch {
    return null;
  }
}

// --- Layer 3 budget & thresholds (Jev usage discipline) ---
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
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
}

// Two independent dimensions, batched into ONE request.
async function askJev(codeSnippet: string, apiKey: string): Promise<JevVerdict | null> {
  try {
    const payload = {
      model: "jev-latest",
      state: {
        code: codeSnippet.slice(0, JEV_MAX_STATE_CHARS),
        facts: codeFacts(codeSnippet),
      },
      questions: {
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
      },
    };

    state.stats.jevRequests++;
    const res = await fetch(JEV_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });

    if (!res.ok) return null;
    const json: any = await res.json();
    return {
      has_slop: json?.answers?.has_slop?.noul ?? null,
      has_unfinished_todo: json?.answers?.has_unfinished_todo?.noul ?? null,
    };
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
          reason: `[pi-jev-eye] Command blocked for safety: "${cmd}". Destructive actions require explicit user confirmation.`,
          terminate: true,
        };
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

      // Layer 3: Jev semantic gate, only for diffs above the line threshold
      const consent = readConsent();
      if (state.semanticGate && consentAllows(ctx.cwd, consent) && contentToCheck.split("\n").length >= JEV_MIN_DIFF_LINES) {
        const apiKey = getTypeSafeApiKey();
        if (apiKey) {
          if (state.stats.jevRequests >= JEV_MAX_REQUESTS) {
            if (state.stats.jevRequests === JEV_MAX_REQUESTS) {
              state.stats.jevRequests++; // notify once, then stay silent
              ctx.ui.notify(
                `[pi-jev-eye] Jev request budget for this session is used up (${JEV_MAX_REQUESTS}); semantic gate now fails open.`,
                "warning"
              );
            }
          } else {
            const verdict = await askJev(contentToCheck, apiKey);
            const hits = verdict
              ? ([
                  ["has_slop", verdict.has_slop],
                  ["has_unfinished_todo", verdict.has_unfinished_todo],
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

  // --- `/jev-eye` command (alias: `/eye`) ---
  const buildStatus = (ctx: any): string => {
    const apiKey = getTypeSafeApiKey();
    const consent = readConsent();
    const usage = readTypeSafeUsage();
    const contextTokens = ctx?.getContextUsage?.()?.tokens;
    const pad = (label: string) => label.padEnd(31);

    const lines = [
      "=== pi-jev-eye status ===",
      `Supervisor: ${state.enabled ? "ENABLED" : "DISABLED"}  (layers 1-2 are local: 0 token, 0 request)`,
      `Layer 3 (Jev semantic gate): ${apiKey ? "READY (key validated)" : "OFFLINE (no TypeSafe key found)"}`,
      `  threshold p≥${JEV_BLOCK_THRESHOLD}, min ${JEV_MIN_DIFF_LINES} lines`,
      `  consent: ${consentLabel(consent)}`,
      `  this folder: ${consentAllows(ctx.cwd, consent) ? "ALLOWED" : "not allowed"}  (${ctx.cwd})`,
      `  session budget: ${Math.min(state.stats.jevRequests, JEV_MAX_REQUESTS)}/${JEV_MAX_REQUESTS} Jev requests used`,
      `  built-in tool gate: PI_TYPESAFE_ENABLED=${process.env.PI_TYPESAFE_ENABLED ?? "unset"} (pi-typesafe reads it at session start)`,
      "",
      "--- TypeSafe usage today (ledger read-only: ~/.pi/agent/pi-typesafe/usage.json) ---",
      usage
        ? `Requests: ${usage.requests} started (${usage.ok} ok, ${usage.failed} failed)`
        : "Requests: no ledger entry for today",
    ];

    if (usage) {
      const usd = (usage.inputTokens * USD_PER_MTOK) / 1e6;
      lines.push(`Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out  (~$${usd.toFixed(6)} input-only rate)`);
    }
    if (typeof contextTokens === "number") {
      lines.push(`Model context now: ${contextTokens} tokens`);
    }

    lines.push(
      "",
      "--- Interception stats (this session) ---",
      pad("Dangerous commands blocked:") + state.stats.destructiveBlocked,
      pad("Secret leaks blocked:") + state.stats.secretsBlocked,
      pad("Slop writes blocked (Jev):") + state.stats.slopBlocked,
      pad("Warnings without verification:") + state.stats.verificationReminders,
      "",
      "Menu: `/jev-eye` with no arguments. Direct: `/jev-eye status|on|off`."
    );

    return lines.join("\n");
  };

  // Interactive menu: Enable all / Enable per folder / Disable / Status
  const openMenu = async (ctx: any): Promise<void> => {
    const consent = readConsent();
    const thisFolderOn = consentAllows(ctx.cwd, consent);
    const folderOption =
      consent.mode === "all"
        ? `Scope to this folder only ·  ${ctx.cwd}`
        : thisFolderOn
        ? `Remove this folder    ·  ${ctx.cwd}`
        : `Add this folder       ·  ${ctx.cwd}`;
    const options = [
      `Enable all folders    ·  gate on in every folder`,
      folderOption,
      `Disable TypeSafe gate ·  layers 1-2 stay on`,
      `Show status`,
    ];

    const choice = await ctx.ui.select("pi-jev-eye · TypeSafe gate", options);
    if (!choice) return;

    if (choice === options[0]) {
      writeConsent({ mode: "all", folders: consent.folders });
      ctx.ui.notify("[pi-jev-eye] TypeSafe gate: ENABLED for all folders.", "info");
      return;
    }

    if (choice === options[1]) {
      let next: Consent;
      let verb: string;

      if (consent.mode === "all") {
        next = { mode: "folders", folders: [ctx.cwd] };
        verb = "SCOPED to";
      } else if (thisFolderOn) {
        const folders = consent.folders.filter((f) => f !== ctx.cwd);
        // Removing the last folder while in per-folder mode leaves the gate off everywhere.
        next = { mode: folders.length > 0 ? "folders" : "off", folders };
        verb = "REMOVED";
      } else {
        const folders = [...new Set([...consent.folders, ctx.cwd])];
        next = { mode: "folders", folders };
        verb = "ADDED";
      }

      writeConsent(next);
      ctx.ui.notify(
        `[pi-jev-eye] TypeSafe gate: ${verb} ${ctx.cwd} — now ${consentLabel(next)}.`,
        verb === "ADDED" ? "info" : "warning"
      );
      return;
    }

    if (choice === options[2]) {
      writeConsent({ mode: "off", folders: consent.folders });
      ctx.ui.notify(
        "[pi-jev-eye] TypeSafe gate: DISABLED (layers 1-2 still on). The built-in typesafe_evaluate tool owns its own gate — stop it with `/typesafe disable`.",
        "warning"
      );
      return;
    }

    ctx.ui.notify(buildStatus(ctx), "info");
  };

  const eyeHandler = async (args: string, ctx: any) => {
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

    if (sub === "") {
      await openMenu(ctx);
      return;
    }

    if (sub !== "status") {
      ctx.ui.notify(`[pi-jev-eye] Unknown argument "${sub}". Use: status | on | off, or no argument for the menu.`, "warning");
      return;
    }

    ctx.ui.notify(buildStatus(ctx), "info");
  };

  const completions = (prefix: string): AutocompleteItem[] | null => {
    const items: AutocompleteItem[] = EYE_SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.toLowerCase()));
    return items.length > 0 ? items : null;
  };

  pi.registerCommand("jev-eye", {
    description: "pi-jev-eye supervisor: menu (Enable all / per folder / Disable), status, usage stats",
    getArgumentCompletions: completions,
    handler: eyeHandler,
  });
  pi.registerCommand("eye", {
    description: "pi-jev-eye supervisor (alias of /jev-eye)",
    getArgumentCompletions: completions,
    handler: eyeHandler,
  });
}
