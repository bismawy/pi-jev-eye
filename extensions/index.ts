import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

// --- Layer 3: Helper TypeSafe Jev ---
function getTypeSafeApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }

  const authPath = join(homedir(), ".pi", "agent", "pi-typesafe", "auth.json");
  try {
    if (process.platform !== "win32") {
      const mode = statSync(authPath).mode;
      if ((mode & 0o077) !== 0) return undefined; // Keamanan permission
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
        code: codeSnippet.slice(0, 4000), // Pangkas state (Signal-over-noise)
      },
      questions: {
        has_slop: {
          type: "noul",
          instructions:
            "Apakah kode ini berisi stub pemalas, implementasi kosong, atau komentar TODO yang belum diselesaikan?",
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
    return null; // Fail-open jika Jev timeout / offline
  }
}

export default function (pi: ExtensionAPI) {
  // Reset turn tracking
  pi.on("turn_start", () => {
    state.modifiedFilesThisTurn = false;
    state.verifiedThisTurn = false;
  });

  // --- Layer 1 & 3: Intersepsi tool_call ---
  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled) return;

    // 1. Cek Bash
    if (event.toolName === "bash") {
      const cmd = typeof event.input?.command === "string" ? event.input.command : "";

      // Track apakah perintah verifikasi dijalankan
      if (VERIFICATION_COMMAND_PATTERNS.some((p) => p.test(cmd))) {
        state.verifiedThisTurn = true;
      }

      // Deteksi aksi destruktif
      for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
        if (pattern.test(cmd)) {
          state.stats.destructiveBlocked++;
          ctx.ui.notify(`[pi-jev-eye] DIBLOKIR: Perintah berbahaya terdeteksi (${pattern})`, "error");
          return {
            block: true,
            reason: `[pi-jev-eye] Perintah diblokir demi keselamatan: "${cmd}". Dilarang menjalankan aksi destruktif tanpa konfirmasi eksplisit.`,
            terminate: true,
          };
        }
      }

      // Deteksi kebocoran secret di argumen command
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(cmd)) {
          state.stats.secretsBlocked++;
          ctx.ui.notify("[pi-jev-eye] DIBLOKIR: Kebocoran API key/secret di perintah bash!", "error");
          return {
            block: true,
            reason: "[pi-jev-eye] Perintah diblokir: Terdeteksi API key/kredensial privat pada baris perintah.",
            terminate: true,
          };
        }
      }
    }

    // 2. Cek Write & Edit
    if (event.toolName === "write" || event.toolName === "edit") {
      state.modifiedFilesThisTurn = true;

      const contentToCheck =
        event.toolName === "write"
          ? String(event.input?.content || "")
          : Array.isArray(event.input?.edits)
          ? event.input.edits.map((e: any) => e.newText || "").join("\n")
          : "";

      // Deteksi kebocoran secret dalam kode yang akan disimpan
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(contentToCheck)) {
          state.stats.secretsBlocked++;
          ctx.ui.notify("[pi-jev-eye] DIBLOKIR: Terdeteksi hardcoded secret dalam file!", "error");
          return {
            block: true,
            reason: "[pi-jev-eye] Penulisan file diblokir: Jangan menulis API key atau kredensial langsung ke dalam kode. Gunakan environment variable.",
          };
        }
      }

      // Layer 3: Cek Slop Jev jika kode baru > 10 baris
      if (state.semanticGate && contentToCheck.split("\n").length >= 10) {
        const apiKey = getTypeSafeApiKey();
        if (apiKey) {
          const slopProb = await checkSlopWithJev(contentToCheck, apiKey);
          if (slopProb !== null && slopProb >= 0.85) {
            state.stats.slopBlocked++;
            ctx.ui.notify(`[pi-jev-eye] DIBLOKIR JEV: Terdeteksi kode slop/stub (p=${slopProb.toFixed(2)})`, "warning");
            return {
              block: true,
              reason: `[pi-jev-eye] Penulisan diblokir oleh Jev (p=${slopProb.toFixed(2)}): Terdeteksi kode slop/stub/TODO yang belum selesai diimplementasikan. Harap lengkapi kode nyata sebelum menyimpan.`,
            };
          }
        }
      }
    }
  });

  // --- Layer 2: State Tracker "Done-Check" pada Akhir Turn ---
  pi.on("message_end", async (event, ctx) => {
    if (!state.enabled) return;
    if (event.message.role !== "assistant") return;

    // Periksa apakah agent menyatakan selesai tapi belum verifikasi
    if (state.modifiedFilesThisTurn && !state.verifiedThisTurn) {
      const text = Array.isArray(event.message.content)
        ? event.message.content.map((c: any) => c.text || "").join(" ")
        : "";

      const claimsDone = /\b(selesai|sudah selesai|done|berhasil diperbaiki|berhasil dibuat|terapkan)\b/i.test(text);

      if (claimsDone) {
        state.stats.verificationReminders++;
        ctx.ui.notify(
          "[pi-jev-eye] Peringatan: File telah dimodifikasi tetapi belum ada verifikasi (test/lint/build)!",
          "warning"
        );
      }
    }
  });

  // --- Perintah CLI `/eye` ---
  pi.registerCommand("eye", {
    description: "Pengawas pi-jev-eye: status, toggle, dan statistik",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();

      if (sub === "on") {
        state.enabled = true;
        ctx.ui.notify("[pi-jev-eye] Supervisor diaktifkan.", "info");
        return;
      }

      if (sub === "off") {
        state.enabled = false;
        ctx.ui.notify("[pi-jev-eye] Supervisor dinonaktifkan.", "warning");
        return;
      }

      const apiKey = getTypeSafeApiKey();
      const statusText = [
        "=== Status pi-jev-eye ===",
        `Status: ${state.enabled ? "AKTIF" : "NONAKTIF"}`,
        `Layer 1 (Regex Filter): AKTIF`,
        `Layer 2 (Done-Check Tracker): AKTIF`,
        `Layer 3 (Jev Semantic Gate): ${apiKey ? "SIAP (Key tervalidasi)" : "OFFLINE (Kunci TypeSafe tidak ditemukan)"}`,
        "",
        "--- Statistik Intersepsi ---",
        `Perintah Berbahaya Dicegat: ${state.stats.destructiveBlocked}`,
        `Kebocoran Secret Dicegat:   ${state.stats.secretsBlocked}`,
        `Kode Slop Dicegat (Jev):    ${state.stats.slopBlocked}`,
        `Peringatan Tanpa Verifikasi: ${state.stats.verificationReminders}`,
        "",
        "Gunakan: `/eye on` atau `/eye off` untuk mengontrol.",
      ].join("\n");

      ctx.ui.notify(statusText, "info");
    },
  });
}
