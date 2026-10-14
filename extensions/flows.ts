// Interactive login and logout: choose a backend, prove the key, store one credential per provider.

import { unlinkSync } from "node:fs";
import { AUTH_BACKUP_PATH, AUTH_PATH, JEV_PROVIDERS, envAccountId, isPlausibleKey, keySources, providerLabelOf, readAuthStore, writeAuthStore } from "./core.ts";
import type { JevProvider } from "./core.ts";
import { cfRunUrl, isCloudflareAccountId, putCredential, removeCredentials, storedProviderIds } from "./layer1.ts";
import { probeJev } from "./providers.ts";
import { AccountsPicker, accountRowLabels, promptForConfirm, promptForText, providerTip } from "./ui.ts";
import { syncEyeStatus } from "./supervisor.ts";

export const loginFlow = async (ctx: any): Promise<void | "back"> => {
  // A key already exported in the environment is described, never overwritten by a stored one.
  const sources = keySources();
  if (sources.usable.length > 0 || sources.cfTokenWithoutAccount) {
    const parts = [`Keys already active from the environment: ${sources.usable.join(", ") || "none"}.`];
    if (sources.cfTokenWithoutAccount) {
      parts.push(`$CLOUDFLARE_API_TOKEN is set but $CLOUDFLARE_ACCOUNT_ID is not, so Clef stays unavailable.`);
    }
    parts.push("An exported key always takes precedence over the one stored here. Continue anyway?");
    const proceed = await promptForConfirm(ctx, "pi-jev-eye · keys already in the environment", parts.join(" "));
    if (!proceed) return;
  }

  // Pi's selector renders one fixed string per row, so it cannot show a tip that follows the cursor.
  // The custom picker can; RPC and headless sessions keep the same choices as plain rows, because
  // `ctx.ui.custom` is a documented no-op there (rpc-extension-ui.md).
  const { store } = readAuthStore();
  let provider: JevProvider | null;
  let back = false;
  if (ctx.mode === "tui") {
    let picker: AccountsPicker | undefined;
    provider = await ctx.ui.custom<JevProvider | null>((tui: any, theme: any, _kb: any, done: (value: JevProvider | null) => void) => {
      picker = new AccountsPicker(theme, store, done, async (provider) => {
        // The delete happens inside the picker, so its row updates without a reopen. Writes stay here:
        // the rule for an emptied store (delete the file) lives in one place, `removeStoredCredentials`.
        await removeStoredCredentials(ctx, [provider.id], envNote());
      });
      return {
        render: (width: number) => picker!.render(width),
        invalidate: () => picker!.invalidate(),
        handleInput: (data: string) => {
          picker!.handleInput(data);
          tui.requestRender();
        },
      };
    });
    // `custom` resolves one value, so the Back flag is read from the component instance afterwards.
    back = picker?.wentBack === true;
  } else {
    const labels = accountRowLabels(store);
    const choice = await ctx.ui.select("pi-jev-eye · where is your Jev key from?", labels);
    provider = choice ? JEV_PROVIDERS[labels.indexOf(choice)] ?? null : null;
  }
  if (!provider) return back ? "back" : undefined;
  ctx.ui.notify(`[pi-jev-eye] ${providerTip(provider)}`, "info");

  // Clef cannot be reached without an account id, so collect it before the secret. An account id is
  // not a secret: it is shown while typing, while the key stays bulleted.
  let accountId: string | undefined;
  if (provider.accountEnv) {
    accountId = envAccountId(provider);
    if (!accountId) {
      const hint = provider.accountEnv
        ? `${provider.accountEnv} is not set. Paste the 32-char account id from dash.cloudflare.com (Workers AI > Use REST API). Enter confirms, Esc cancels.`
        : "Paste the account id. Enter confirms, Esc cancels.";
      const enteredId = await promptForText(ctx, "Cloudflare account ID", hint, true);
      if (enteredId === undefined) return;
      accountId = String(enteredId).trim();
      if (!isCloudflareAccountId(accountId)) {
        ctx.ui.notify("[pi-jev-eye] A Cloudflare account id is 32 hexadecimal characters. Nothing was saved.", "error");
        return;
      }
    }
  }

  const entered = await promptForText(ctx, `${provider.label} API key`, `Paste the key from ${provider.keyHint}.`);
  if (entered === undefined) return;

  const key = entered.trim();
  if (!isPlausibleKey(key)) {
    ctx.ui.notify("[pi-jev-eye] That does not look like an API key (16-512 chars, no spaces). Nothing was saved.", "error");
    return;
  }

  // The model is chosen in `/jev-eye models` (one answer for the whole session), so login stores the
  // default and probes that. Asking again here gave the same question two homes, and the stored `model`
  // was a third place the gate had to reconcile with the active backend.
  const model = provider.model;

  // Final check on the exact route the gate will use, not on a generic credential probe.
  const url = provider.accountEnv ? cfRunUrl(accountId ?? "", model) : provider.url;
  ctx.ui.notify(`[pi-jev-eye] Checking the key against ${provider.label}…`, "info");
  const probe = await probeJev(provider, key, url, model);
  if (!probe.ok) {
    ctx.ui.notify(`[pi-jev-eye] Login failed: ${probe.detail}. Nothing was saved.`, "error");
    return;
  }

  // Additive: another backend's stored key stays usable. The probe above must pass before this line.
  // Re-read the store here: the picker above may have run a while ago, and it never writes.
  const { store: current, migrated } = readAuthStore();
  const others = storedProviderIds(current).filter((id) => id !== provider.id);
  writeAuthStore(putCredential(current, provider.id, { apiKey: key, model, ...(accountId ? { accountId } : {}) }));
  const shadows = process.env[provider.keyEnv]?.trim() ? ` Note: $${provider.keyEnv} is set and takes precedence over this stored key.` : "";
  const keptNote = others.length > 0 ? ` ${others.map(providerLabelOf).join(", ")} stayed logged in.` : "";
  const migrationNote = migrated ? ` Migrated the old single-key store (backup: ${AUTH_BACKUP_PATH}).` : "";
  ctx.ui.notify(
    `[pi-jev-eye] Logged in via ${provider.label} (${model}): ${probe.detail}. Stored in ${AUTH_PATH} (0600).${keptNote}${shadows}${migrationNote}`,
    "info"
  );
  // A new credential can become the one that answers (an unpicked session falls back to the credential
  // precedence), so the footer cell is republished instead of waiting for a `/reload`.
  syncEyeStatus(ctx);
};

/** Keys the process inherited cannot be unset from here, so this sentence is shared by add and remove. */
const envNote = (): string => {
  const fromEnv = JEV_PROVIDERS.filter((p) => process.env[p.keyEnv]?.trim()).map((p) => `$${p.keyEnv}`);
  return fromEnv.length ? ` ${fromEnv.join(", ")} comes from the environment and cannot be removed here.` : "";
};

/** Delete the given providers from the store; an emptied store removes the file so status reads OFFLINE. */
const removeStoredCredentials = async (ctx: any, ids: string[], note: string): Promise<void> => {
  try {
    const { store } = readAuthStore();
    const next = removeCredentials(store, ids);
    const removed = ids.map(providerLabelOf).join(", ");
    if (storedProviderIds(next).length === 0) {
      unlinkSync(AUTH_PATH);
      ctx.ui.notify(`[pi-jev-eye] Logged out of ${removed}; the store is now empty.${note}`, "info");
      // The removed backend may have been the one answering; the cell follows what is left.
      syncEyeStatus(ctx);
      return;
    }
    writeAuthStore(next);
    const left = storedProviderIds(next).map(providerLabelOf).join(", ");
    ctx.ui.notify(`[pi-jev-eye] Logged out of ${removed}. Still logged in: ${left}.${note}`, "info");
    syncEyeStatus(ctx);
  } catch (error) {
    ctx.ui.notify(`[pi-jev-eye] Could not update ${AUTH_PATH}: ${(error as Error).message}`, "error");
  }
};
