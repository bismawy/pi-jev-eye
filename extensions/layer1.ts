// --- Layer 1: Local Regex Patterns (0 ms, 0 Token) ---
// Pure rules, kept out of index.ts so they can be checked with `npm test` (node --test test/).
// A wipe is judged per path argument, not by "the command mentions / somewhere": the old all-absolute-paths rule
// blocked `rm -rf /tmp/scratch` while a regex quirk made it block `git push --force origin feature/x` too.
// Catastrophic = root, a whole top-level dir (/usr, /tmp, /home), a system dir near the top (/var/log),
// home in any form (~, ~/x, $HOME/x), a parent hop, or a top-level glob (/home/*). Everything deeper is scoped.
const SYSTEM_ROOT_DIRS = new Set(["etc", "usr", "var", "boot", "bin", "sbin", "lib", "lib64", "opt", "srv", "root", "sys", "proc", "dev"]);

// Every rm in the command, so a scoped `rm` early in the line cannot hide a catastrophic one later.
const WIPE_INVOCATION = /\brm\s+([^;&|]*)/g;

/** Any recursive or forced flag, whatever the case or order: -rf, -R, -f -r, --recursive, --force. */
const DESTRUCTIVE_FLAG = /^(?:-[a-zA-Z]*[rf][a-zA-Z]*|--(?:recursive|force))$/i;

/** Returns the offending path argument when the command is a filesystem wipe, otherwise null. */
export function wipeTarget(command: string): string | null {
  for (const match of command.matchAll(WIPE_INVOCATION)) {
    const args = match[1].trim().split(/\s+/).filter(Boolean);
    if (!args.some((arg) => DESTRUCTIVE_FLAG.test(arg))) continue;

    for (const raw of args) {
      if (raw.startsWith("-")) continue; // a flag, or the `--` separator
      const target = raw.replace(/^["']|["']$/g, "");
      if (!target) continue;

      if (/^(?:~|\$\{?HOME\}?)(?:\/|$)/.test(target)) return target;
      if (/^\.\.(?:\/\.\.)*\/?$/.test(target)) return target;
      if (!target.startsWith("/")) continue;

      const segments = target.split("/").filter(Boolean);
      if (segments.length <= 1) return target; // / , /* , /usr , /tmp , /home
      if (SYSTEM_ROOT_DIRS.has(segments[0])) return target; // /var/log , /usr/lib/x — nothing inside a system dir is a scoped delete
      if (segments.length === 2 && segments[1].includes("*")) return target; // /home/* , /tmp/*
    }
  }

  return null;
}

export const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+.*--no-preserve-root\b/i,
  /\bgit\s+push\s+.*--force(?!-with-lease).*(main|master)\b/i,
  /\bgit\s+push\s+-f\s+.*(main|master)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(DATABASE|TABLE)\b/i,
  /\bmkfs(\.[a-z0-9]+)?\b/i,
  />\s*\/dev\/sd[a-z]/i,
];

export const SECRET_PATTERNS = [
  /\bsk-[a-zA-Z0-9]{20,}\b/,
  /\bghp_[a-zA-Z0-9]{20,}\b/,
  /\bgho_[a-zA-Z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z-_]{35}\b/,
  /-----BEGIN\s+(RSA|OPENSSH|EC|DSA)?\s*PRIVATE\s+KEY-----/,
];

export const VERIFICATION_COMMAND_PATTERNS = [
  /\b(npm|pnpm|bun|yarn)\s+(test|run\s+(test|typecheck|lint|build|check))\b/i,
  /\b(cargo\s+(test|check))\b/i,
  /\b(pytest|mypy|ruff\s+check)\b/i,
  /\b(go\s+(test|vet))\b/i,
  /\bvitest\b/i,
];
