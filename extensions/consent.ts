// Gate consent: which folders the Jev write gate is allowed to judge.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { EYE_DIR } from "./core.ts";

type ConsentMode = "all" | "folder" | "disabled";
interface Consent {
  mode: ConsentMode;
  folders: string[];
}

const CONSENT_PATH = join(EYE_DIR, "consent.json");

// Legacy values ("folders"/"off") migrate on read; anything unknown falls back to "all",
// which is also what PI_TYPESAFE_ENABLED=1 means for the built-in tool.
export function readConsent(): Consent {
  try {
    const parsed = JSON.parse(readFileSync(CONSENT_PATH, "utf8"));
    const raw = String(parsed?.mode ?? "all");
    const mode: ConsentMode = raw === "disabled" || raw === "off" ? "disabled" : raw === "folder" || raw === "folders" ? "folder" : "all";
    const folders = Array.isArray(parsed?.folders) ? parsed.folders.filter((f: unknown) => typeof f === "string") : [];
    // "this folder" with no folder left reads as Disabled, not as a puzzling empty list.
    return { mode: mode === "folder" && folders.length === 0 ? "disabled" : mode, folders };
  } catch {
    return { mode: "all", folders: [] };
  }
}

export function writeConsent(consent: Consent): void {
  mkdirSync(EYE_DIR, { recursive: true });
  writeFileSync(CONSENT_PATH, `${JSON.stringify({ version: 1, ...consent }, null, 2)}\n`, { mode: 0o600 });
}

export function consentAllows(cwd: string, consent: Consent): boolean {
  if (consent.mode === "all") return true;
  if (consent.mode === "disabled") return false;
  return consent.folders.some((f) => cwd === f || cwd.startsWith(f.endsWith(sep) ? f : f + sep));
}

export function consentLabel(consent: Consent): string {
  if (consent.mode === "all") return "Enable all folder";
  if (consent.mode === "disabled") return "Disabled";
  return `Enable this folder (${consent.folders.length})`;
}

/** all folders → this folder (cwd added) → disabled → all folders. */
export function nextConsent(consent: Consent, cwd: string): Consent {
  if (consent.mode === "all") return { mode: "folder", folders: [...new Set([...consent.folders, cwd])] };
  if (consent.mode === "folder") return { mode: "disabled", folders: consent.folders };
  return { mode: "all", folders: consent.folders };
}
