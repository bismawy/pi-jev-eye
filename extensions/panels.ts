// The framed /jev-eye status and usage panels, plus the headless text fallback for each.
// Data comes from the ledger and the gate; nothing here estimates a number it cannot source.

import { Key } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { consentAllows, nextConsent, readConsent, writeConsent } from "./consent.ts";
import { OWN_USAGE_PATH, currentCatalog, readBackends, readAuthStore, readJsonFile, resolveJevAuth, storedCredential } from "./core.ts";
import type { JevAuth } from "./core.ts";
import { JEV_BLOCK_THRESHOLD, JEV_MAX_REQUESTS, JEV_MIN_DIFF_LINES } from "./gate.ts";
import { backendTotals, clefBudget, clefUsdPerMTok, neuronsSpentOn, statusRow } from "./layer1.ts";
import type { ProviderTotals } from "./layer1.ts";
import { fetchBalanceText, readUsage, today } from "./ledger.ts";
import { state } from "./pmr.ts";
import { JEV_MAX_ROUTING_CALLS, readRouting } from "./routing.ts";
import { STATUS_DESC, STATUS_TITLE, cycleEyeState, panelKeys } from "./supervisor.ts";
import { BACK, StatusPanel, borderPainterFor, modelLabelFor } from "./ui.ts";

/** A stored Cloudflare key without an account id is invisible everywhere else: say why, in status. */
/**
 * The one credential state the status rows cannot show: a Cloudflare token stored without an account id
 * is ignored everywhere else, so the panel says why. Read from the v2 store — a v1 file is migrated on
 * first read, and looking at the old shape meant this row never appeared.
 */
const cloudflareHint = (paint: (color: string, text: string) => string): string[] => {
  const { store } = readAuthStore();
  const clef = storedCredential(store, "cloudflare");
  if (!clef || typeof clef.accountId === "string") return [];
  return [
    `${paint("warning", "Clef hint: ")}a Cloudflare key is stored without an account id, so it is ignored. Run \`/jev-eye accounts\` again, or export $CLOUDFLARE_ACCOUNT_ID.`,
  ];
};

// `/jev-eye usage` panel chrome.
const USAGE_TITLE = "Jev Eye · Usage";
const USAGE_DESC = "Jev and Clef spend, tokens and the free-neuron budget.";

/** The provider balance line for the panel. Only OpenRouter exposes a real one; the Clef block above
 *  already reports its own neuron budget, and TypeSafe has no balance route at all. */
const usageBalance = async (auth: JevAuth | undefined): Promise<string | undefined> => {
  if (auth?.provider.id !== "openrouter") return undefined;
  try {
    return await fetchBalanceText(auth);
  } catch {
    return "unavailable";
  }
};

/**
 * Usage body: one compact table holding Jev (TypeSafe/OpenRouter) and Clef side by side, so both
 * backends are read at a glance. Data is the same ledger `/jev-eye status` uses; nothing is estimated
 * except the dollar figure for a provider that does not report its own cost.
 */
const buildUsage = (ctx: any, theme?: any, balance?: string): string[] => {
  const paint = (color: string, value: string) => (theme ? theme.fg(color, value) : value);
  const n = (value: number) => value.toLocaleString("en-US");
  const usd = (value: number) => (value >= 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(6)}`);
  const auth = resolveJevAuth();
  const days = readJsonFile(OWN_USAGE_PATH)?.days;

  // Column widths are fixed so the header and every row line up byte-for-byte.
  const W = { label: 9, req: 6, tok: 11, cost: 10 };
  const cell = (text: string, width: number, alignRight = true) => {
    const s = text.length > width ? `${text.slice(0, width - 1)}…` : text;
    return alignRight ? s.padStart(width) : s.padEnd(width);
  };
  const header = (label: string) =>
    paint("dim", cell(label, W.label, false) + cell("req", W.req) + cell("in tok", W.tok) + cell("cost", W.cost));
  const row = (label: string, t: ProviderTotals, extra = "", color = "text") =>
    paint(color, cell(label, W.label, false)) +
    paint("dim", cell(String(t.requests), W.req) + cell(n(t.inputTokens), W.tok) + cell(usd(t.cost), W.cost)) +
    extra;

  const lines: string[] = [];

  // 1. The two backends, side by side. This is the answer to "how much Jev vs Clef?" in two rows.
  lines.push(paint("accent", "Backends · this month"));
  const monthTotals = readUsage(today().slice(0, 7));
  const { clef, jev } = backendTotals(monthTotals?.providers);
  lines.push(header(""));
  lines.push(row("Jev", jev, `  ${paint("muted", auth && auth.provider.id !== "cloudflare" ? auth.provider.label : "TypeSafe / OpenRouter")}`));
  lines.push(
    row("Clef", clef, `  ${paint("muted", auth?.provider.id === "cloudflare" ? auth.model : "Cloudflare")} · ${clef.neurons >= 1 ? `${n(Math.round(clef.neurons))} neurons` : "no neurons"}`)
  );
  // Entries written before provider attribution existed cannot be split. Showing only the attributed
  // rows would make the table look complete while it covered a fraction of the period.
  const attributed = clef.requests + jev.requests;
  const unattributed = Math.max(0, (monthTotals?.requests ?? 0) - attributed);
  if (unattributed > 0) {
    const share = (total: number, known: number) => Math.max(0, total - known);
    lines.push(
      row(
        "Earlier",
        {
          requests: unattributed,
          ok: 0,
          failed: 0,
          inputTokens: share(monthTotals!.inputTokens, clef.inputTokens + jev.inputTokens),
          outputTokens: 0,
          cost: share(monthTotals!.cost, clef.cost + jev.cost),
          neurons: share(monthTotals!.neurons ?? 0, clef.neurons + jev.neurons),
        },
        `  ${paint("muted", `before the split · no provider data (${Math.round((unattributed / monthTotals!.requests) * 100)}%)`)}`
      )
    );
  }
  if (unattributed > 0 && attributed === 0) {
    lines.push(paint("muted", "the split is recorded from the next request on; the totals below are exact"));
  }
  lines.push("");

  // 2. One-line totals, so the panel still answers when the split is empty.
  lines.push(paint("accent", "Totals · both ledgers"));
  for (const [label, period] of [["Today", today()], ["Month", today().slice(0, 7)], ["All time", ""]] as const) {
    const t = readUsage(period);
    lines.push(
      t
        ? paint("dim", cell(label, W.label, false)) +
            paint("dim", cell(`${t.requests}`, W.req) + cell(n(t.inputTokens), W.tok) + cell(usd(t.cost), W.cost)) +
            paint("muted", `  ${t.ok} ok / ${t.failed} fail · out ${n(t.outputTokens)}`)
        : paint("dim", cell(label, W.label, false)) + paint("muted", "no requests")
    );
  }
  lines.push("");

  // 3. The Clef free budget is the one number that changes behaviour (the gate stops working if it is exhausted).
  const budget = clefBudget(neuronsSpentOn(days, today()));
  const barWidth = 20;
  const filled = Math.min(barWidth, Math.round((budget.used / budget.free) * barWidth));
  const exhausted = budget.used >= budget.free;
  lines.push(
    `${paint("accent", "Clef free tier")} ${paint(exhausted ? "warning" : "success", "█".repeat(filled))}${paint("dim", "░".repeat(barWidth - filled))} ${n(Math.round(budget.used))}/${n(budget.free)} neurons today${budget.overageUsd > 0 ? paint("warning", ` · over ${usd(budget.overageUsd)}`) : " · free"}`
  );
  lines.push(
    paint("dim", `  resets 00:00 UTC · ${n(Math.round(budget.remaining))} left · `) +
      paint("muted", auth?.provider.id === "cloudflare" ? `${auth.model} · $${clefUsdPerMTok(auth.model).toFixed(3)}/M in` : "Clef not the active gate key")
  );
  lines.push("");

  // 4. Session counters, one line each, no prose.
  const s = state.stats;
  lines.push(
    paint("accent", "Session ") +
      paint("dim", `gate ${Math.min(s.jevRequests, JEV_MAX_REQUESTS)}/${JEV_MAX_REQUESTS} · routing ${Math.min(s.jevRoutingCalls, JEV_MAX_ROUTING_CALLS)}/${JEV_MAX_ROUTING_CALLS} · reviewed ${s.reviewTurns}`)
  );
  lines.push(
    paint("accent", "Blocked ") +
      paint("dim", `${s.destructiveBlocked} dangerous · ${s.secretsBlocked} secret · ${s.slopBlocked} slop`) +
      (typeof ctx?.getContextUsage?.()?.tokens === "number" ? paint("dim", ` · context ${n(ctx.getContextUsage().tokens)} tok`) : "")
  );
  if (balance) lines.push(paint("accent", "Balance ") + paint("dim", balance));
  return lines;
};

/** `/jev-eye usage`: the same framed panel as status, with the spend breakdown. */
export const showUsage = async (ctx: any, back = true): Promise<void | "back"> => {
  const balance = await usageBalance(resolveJevAuth());
  // `custom` is a no-op in RPC (rpc-extension-ui.md): it resolves undefined without drawing anything,
  // so the text fallback must be chosen by mode, not by the method existing.
  if (ctx.mode !== "tui") {
    ctx.ui.notify([USAGE_TITLE, USAGE_DESC, "", ...buildUsage(ctx, undefined, balance)].join("\n"), "info");
    return;
  }
  const outcome = await ctx.ui.custom<number | null>((tui: any, theme: any, _kb: any, done: (value: number | null) => void) => {
    const panel = new StatusPanel(
      theme,
      buildUsage(ctx, theme, balance),
      { rebuild: () => buildUsage(ctx, theme, balance), cycleMode: () => cycleEyeState(ctx), cycleGate: () => writeConsent(nextConsent(readConsent(), ctx.cwd)) },
      done,
      USAGE_TITLE,
      USAGE_DESC,
      false, // read-only: no Mode / Grant-folder toggles on the usage screen
      borderPainterFor(theme, ctx),
      back
    );
    return {
      render: (width: number) => panel.render(width),
      invalidate: () => panel.invalidate(),
      handleInput: (data: string) => {
        panel.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return outcome === BACK ? "back" : undefined;
};

/** Status body only: plain text in headless mode, colourised when the panel hands over a theme.
 *  Spend lives in `/jev-eye usage`; this screen answers "what is active right now" in five lines. */
const buildStatus = (ctx: any, theme?: any): string[] => {
  const auth = resolveJevAuth();
  const consent = readConsent();
  const paint = (color: string, value: string) => (theme ? theme.fg(color, value) : value);

  // A zero count is the healthy value, so only a non-zero one draws the eye.
  const count = (value: number) => paint(value > 0 ? "warning" : "text", String(value));

  const routing = readRouting();
  const models: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
  const backends = readBackends();
  const catalog = currentCatalog();
  const backendLabel = (ref: string) => {
    const row = catalog.find((m) => m.ref === ref);
    return row ? `${row.label} · ${row.providerShort}` : ref;
  };
  const thisFolderOn = consentAllows(ctx.cwd, consent);
  const scope = consent.mode === "folder" ? `This folder (${thisFolderOn ? "ON" : "off"})` : consent.mode === "all" ? "All folders" : "Disabled";
  const s = state.stats;
  const gate = Math.min(s.jevRequests, JEV_MAX_REQUESTS);
  const classified = Math.min(s.jevRoutingCalls, JEV_MAX_ROUTING_CALLS);

  // One row = `Label · STATUS | detail`: the left column is scannable, the right column is the
  // evidence. `statusRow` pads the label so every `·` lands in one column, like the list menus.
  const row = (name: string, status: string, details: (string | false | undefined)[], accent: string) =>
    statusRow(name, status, details, (token, text) => paint(token, text), accent);

  const lines = [
    row("Supervisor", state.enabled ? "ENABLED" : "DISABLED", [state.reviewMode ? "Review all turns" : "Review prompt trigger"], state.enabled ? "success" : "warning"),
    row("Scope folders", consent.mode === "disabled" ? "OFF" : "ON", [scope], consent.mode === "disabled" ? "warning" : "success"),
    auth
      ? row("Gate", "READY", [backends.primary ? backendLabel(backends.primary) : `${auth.provider.short} · ${auth.model}`, backends.fallback ? `fallback ${backendLabel(backends.fallback)}` : `auto: ${auth.provider.short}`, `Key from ${auth.source}`], "success")
      : row("Gate", "OFFLINE", ["no key, run `/jev-eye accounts`"], "warning"),
    row("Rules", "ACTIVE", [`Block at p≥${JEV_BLOCK_THRESHOLD} on diffs ≥${JEV_MIN_DIFF_LINES} lines`, `gate ${gate}/${JEV_MAX_REQUESTS}`, `routing ${classified}/${JEV_MAX_ROUTING_CALLS}${s.fallbacks > 0 ? ` · ${s.fallbacks} fallback` : ""}`], "success"),
    row(
      "Routing",
      routing.enabled ? "ON" : "OFF",
      [
        `light ${modelLabelFor(models, routing.light) || "unset"}`,
        `heavy ${modelLabelFor(models, routing.heavy) || "unset"}`,
        `${s.lightTurns} light / ${s.heavyTurns} heavy turns`,
      ],
      routing.enabled ? "success" : "muted",
    ),
    row("Blocked", "STATS", [
      `${count(s.destructiveBlocked)} dangerous`,
      `${count(s.secretsBlocked)} secrets`,
      `${count(s.slopBlocked)} slop`,
      `${count(s.verificationReminders)} unverified`,
      `${s.reviewTurns} reviewed turns`,
    ], "muted"),
    ...cloudflareHint(paint),
  ];

  const contextTokens = ctx?.getContextUsage?.()?.tokens;
  if (typeof contextTokens === "number") lines.push(row("Context", "USED", [`${contextTokens.toLocaleString("en-US")} tokens`], "muted"));
  return lines;
};

/** `/jev-eye status`: the framed panel, falling back to the same body as plain text without a TUI. */
export const showStatus = async (ctx: any, back = true): Promise<void | "back"> => {
  if (ctx.mode !== "tui") {
    ctx.ui.notify([STATUS_TITLE, STATUS_DESC, "", ...buildStatus(ctx), "", panelKeys(true, back).join("  ")].join("\n"), "info");
    return;
  }

  const outcome = await ctx.ui.custom<number | null>((tui: any, theme: any, _kb: any, done: (value: number | null) => void) => {
    const panel = new StatusPanel(
      theme,
      buildStatus(ctx, theme),
      {
        rebuild: () => buildStatus(ctx, theme),
        cycleMode: () => {
          cycleEyeState(ctx);
        },
        cycleGate: () => writeConsent(nextConsent(readConsent(), ctx.cwd)),
      },
      done,
      STATUS_TITLE,
      STATUS_DESC,
      true,
      borderPainterFor(theme, ctx),
      back
    );
    return {
      render: (width: number) => panel.render(width),
      invalidate: () => panel.invalidate(),
      handleInput: (data: string) => {
        panel.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return outcome === BACK ? "back" : undefined;
};
