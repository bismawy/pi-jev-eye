// The framed /jev-eye status and usage panels, plus the headless text fallback for each.
// Data comes from the ledger and the gate; nothing here estimates a number it cannot source.

import { consentAllows, nextConsent, readConsent, writeConsent } from "./consent.ts";
import { OWN_USAGE_PATH, currentCatalog, readBackends, readAuthStore, readJsonFile, resolveJevAuth, storedCredential } from "./core.ts";
import type { JevAuth } from "./core.ts";
import { JEV_MAX_REQUESTS } from "./gate.ts";
import { backendTotals, chosenRowPainter, clefBudget, clefUsdPerMTok, neuronsSpentOn } from "./layer1.ts";
import type { ProviderTotals } from "./layer1.ts";
import { fetchBalanceText, readUsage, today } from "./ledger.ts";
import { state } from "./pmr.ts";
import { JEV_MAX_ROUTING_CALLS, readRouting } from "./routing.ts";
import { STATUS_DESC, STATUS_TITLE, cycleEyeState } from "./supervisor.ts";
import { BACK, StatusPanel, borderPainterFor, customScreen, modelLabelFor } from "./ui.ts";

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
  // Four decimals across the whole column keep decimal points aligned between Backends and Totals;
  // zero renders as `-` so unused rows carry no `$0.000000` noise.
  const usd = (value: number): string => {
    if (value <= 0) return "-";
    if (value < 0.0001) return "<$0.0001";
    return `$${value.toFixed(4)}`;
  };
  const auth = resolveJevAuth();
  const days = readJsonFile(OWN_USAGE_PATH)?.days;

  // Column widths are fixed so the header and both tables (`Backends` and `Totals`) share one grid.
  // `label: 10` leaves at least two spaces after `"All time"` before `"no requests"`.
  const W = { label: 10, req: 5, tok: 10, cost: 9 };
  const cell = (text: string, width: number, alignRight = true) => {
    const s = text.length > width ? `${text.slice(0, width - 1)}…` : text;
    return alignRight ? s.padStart(width) : s.padEnd(width);
  };
  const header = (label: string) =>
    paint("dim", cell(label, W.label, false) + cell("req", W.req) + cell("in tok", W.tok) + cell("cost", W.cost));
  const row = (label: string, t: Pick<ProviderTotals, "requests" | "inputTokens" | "cost">, extra = "") => {
    const active = t.requests > 0;
    return (
      paint(active ? "text" : "muted", cell(label, W.label, false)) +
      paint(active ? "text" : "dim", cell(String(t.requests), W.req) + cell(n(t.inputTokens), W.tok) + cell(usd(t.cost), W.cost)) +
      extra
    );
  };

  const lines: string[] = [];

  // 1. The two backends, side by side. This is the answer to "how much Jev vs Clef?" in two rows.
  lines.push(paint("accent", "Backends · this month"));
  const monthTotals = readUsage(today().slice(0, 7));
  const { clef, jev } = backendTotals(monthTotals?.providers);
  lines.push(header(""));
  lines.push(row("Jev", jev, `  ${paint("muted", auth && auth.provider.id !== "cloudflare" ? auth.provider.label : "TypeSafe / OpenRouter")}`));
  lines.push(
    row(
      "Clef",
      clef,
      `  ${paint("muted", auth?.provider.id === "cloudflare" ? auth.model : "Cloudflare")} ${paint("dim", "·")} ${paint("muted", clef.neurons >= 1 ? `${n(Math.round(clef.neurons))} neurons` : "no neurons")}`
    )
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
          inputTokens: share(monthTotals!.inputTokens, clef.inputTokens + jev.inputTokens),
          cost: share(monthTotals!.cost, clef.cost + jev.cost),
        },
        `  ${paint("muted", `before the split · no provider data (${Math.round((unattributed / monthTotals!.requests) * 100)}%)`)}`
      )
    );
  }
  if (unattributed > 0 && attributed === 0) {
    lines.push(paint("muted", "the split is recorded from the next request on; the totals below are exact"));
  }
  lines.push("");

  // 2. One-line totals on the same column grid, so the panel still answers when the split is empty.
  lines.push(paint("accent", "Totals · both ledgers"));
  for (const [label, period] of [["Today", today()], ["Month", today().slice(0, 7)], ["All time", ""]] as const) {
    const t = readUsage(period);
    lines.push(
      t
        ? row(label, t, `  ${paint("muted", `${t.ok} ok / ${t.failed} fail`)} ${paint("dim", "·")} ${paint("muted", `out ${n(t.outputTokens)}`)}`)
        : paint("muted", cell(label, W.label, false)) + paint("dim", "no requests")
    );
  }
  lines.push("");

  // 3. The Clef free budget sits under its own heading, flush-left like the rest of the screen so the
  //    bar + count never clips at 68–75 columns and the detail row carries no misleading cursor indent.
  lines.push(paint("accent", "Clef free tier · today"));
  const budget = clefBudget(neuronsSpentOn(days, today()));
  const barWidth = 20;
  const filled = Math.min(barWidth, Math.round((budget.used / budget.free) * barWidth));
  const exhausted = budget.used >= budget.free;
  const tierStatus = budget.overageUsd > 0 ? paint("warning", `over ${usd(budget.overageUsd)}`) : paint("success", "free");
  lines.push(
    `${paint(exhausted ? "warning" : "success", "█".repeat(filled))}${paint("dim", "░".repeat(barWidth - filled))}  ${paint("text", `${n(Math.round(budget.used))}/${n(budget.free)}`)} ${paint("muted", "neurons")} ${paint("dim", "·")} ${tierStatus}`
  );
  lines.push(
    paint("dim", `resets 00:00 UTC · ${n(Math.round(budget.remaining))} left · `) +
      paint("muted", auth?.provider.id === "cloudflare" ? `${auth.model} · $${clefUsdPerMTok(auth.model).toFixed(3)}/M in` : "Clef not the active gate key")
  );
  lines.push("");

  // 4. Session counters: same flush-left `label · value` overview pattern as `/jev-eye status`.
  const s = state.stats;
  const totalBlocked = s.destructiveBlocked + s.secretsBlocked + s.slopBlocked;
  const contextTokens = ctx?.getContextUsage?.()?.tokens;
  const kvRows: [string, string][] = [
    [
      "Session",
      paint(
        "text",
        `gate ${Math.min(s.jevRequests, JEV_MAX_REQUESTS)}/${JEV_MAX_REQUESTS} · routing ${Math.min(s.jevRoutingCalls, JEV_MAX_ROUTING_CALLS)}/${JEV_MAX_ROUTING_CALLS} · reviewed ${s.reviewTurns}`
      ),
    ],
    [
      "Blocked",
      `${paint(totalBlocked > 0 ? "warning" : "text", `${s.destructiveBlocked} dangerous · ${s.secretsBlocked} secret · ${s.slopBlocked} slop`)}${
        typeof contextTokens === "number" ? paint("dim", ` · context ${n(contextTokens)} tok`) : ""
      }`,
    ],
    ...(balance ? [["Balance", paint("text", balance)] as [string, string]] : []),
  ];
  const kvColumn = Math.max(...kvRows.map(([label]) => label.length));
  for (const [label, value] of kvRows) {
    lines.push(`${paint("dim", label.padEnd(kvColumn))} ${paint("dim", "·")} ${value}`);
  }
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
  const outcome = await customScreen<number | null>(ctx, (theme, done) =>
    new StatusPanel(
      theme,
      buildUsage(ctx, theme, balance),
      { rebuild: () => buildUsage(ctx, theme, balance), cycleMode: () => cycleEyeState(ctx), cycleGate: () => writeConsent(nextConsent(readConsent(), ctx.cwd)) },
      done,
      USAGE_TITLE,
      USAGE_DESC,
      false, // read-only: no Mode / Grant-folder toggles on the usage screen
      borderPainterFor(theme, ctx),
      back
    )
  );
  return outcome === BACK ? "back" : undefined;
};

/** Status body only: plain text in headless mode (`cursorIndex = -1`), interactive in TUI.
 *  Detailed spend, per-provider totals, and block breakdowns live in `/jev-eye usage`. */
const buildStatus = (ctx: any, theme?: any, cursorIndex = -1): string[] => {
  const auth = resolveJevAuth();
  const consent = readConsent();
  const paint = (color: string, value: string) => (theme ? theme.fg(color, value) : value);
  const soft = theme ? chosenRowPainter(theme) : (text: string) => text;
  const routing = readRouting();
  const models: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
  const backends = readBackends();
  const catalog = currentCatalog();
  const thisFolderOn = consentAllows(ctx.cwd, consent);
  const s = state.stats;
  const totalBlocked = s.destructiveBlocked + s.secretsBlocked + s.slopBlocked;

  // Overview rows sit above the controls (same pattern as ModelsPicker): flush-left dim labels
  // padded to the widest overview label (`7`), visually separate from the `→` selectable controls
  // below (padded to `"Folder gate"` = 11) so read-only rows are never mistaken for selectable items.
  const overviewColumn = Math.max("Backend".length, "Routing".length, "Session".length);
  const controlColumn = Math.max("Supervisor".length, "Folder gate".length);
  const overview = (label: string, value: string): string =>
    `${paint("dim", label.padEnd(overviewColumn))} ${paint("dim", "·")} ${value}`;
  const control = (label: string, value: string, cursor = false): string => {
    const marker = cursorIndex >= 0 ? (cursor ? paint("accent", "→ ") : "  ") : "";
    const styled = cursor ? soft(label.padEnd(controlColumn)) : paint("text", label.padEnd(controlColumn));
    return `${marker}${styled} ${paint("dim", "·")} ${value}`;
  };

  const supervisorValue = !state.enabled
    ? paint("warning", "DISABLED")
    : state.reviewMode
      ? `${paint("success", "REVIEW")} ${paint("muted", "(all turns)")}`
      : `${paint("success", "ENABLED")} ${paint("muted", "(prompt trigger)")}`;

  const scopeValue =
    consent.mode === "all"
      ? paint("success", "ALL FOLDERS")
      : consent.mode === "folder"
        ? `${paint(thisFolderOn ? "success" : "warning", "THIS FOLDER")} ${paint("muted", `(${thisFolderOn ? "ON" : "off"})`)}`
        : paint("warning", "DISABLED");

  const primaryRow = backends.primary ? catalog.find((m) => m.ref === backends.primary) : undefined;
  const fallbackRow = backends.fallback ? catalog.find((m) => m.ref === backends.fallback) : undefined;
  const activeText = primaryRow
    ? `${primaryRow.label} (${primaryRow.providerShort})`
    : auth
      ? `${auth.model} (${auth.provider.short})`
      : "";
  const backendValue = !auth
    ? `${paint("warning", "OFFLINE")} ${paint("muted", "· no key")}`
    : `${paint("text", activeText)}${fallbackRow ? paint("muted", ` → ${fallbackRow.label}`) : ""}`;

  const routingValue = routing.enabled
    ? `${paint("success", "ON")} ${paint("muted", `· ${modelLabelFor(models, routing.light) || "unset"} → ${modelLabelFor(models, routing.heavy) || "unset"}`)}`
    : paint("muted", "OFF");

  const sessionValue = `${paint(totalBlocked > 0 ? "warning" : "muted", `${totalBlocked} blocked`)}${paint(
    "dim",
    ` · ${s.reviewTurns} reviewed${s.fallbacks > 0 ? ` · ${s.fallbacks} fallback` : ""}`
  )}`;

  return [
    overview("Backend", backendValue),
    overview("Routing", routingValue),
    overview("Session", sessionValue),
    "",
    control("Supervisor", supervisorValue, cursorIndex === 0),
    control("Folder gate", scopeValue, cursorIndex === 1),
    ...cloudflareHint(paint),
  ];
};

/** `/jev-eye status`: the framed panel, falling back to the same body as plain text without a TUI. */
export const showStatus = async (ctx: any, back = true): Promise<void | "back"> => {
  if (ctx.mode !== "tui") {
    ctx.ui.notify([STATUS_TITLE, STATUS_DESC, "", ...buildStatus(ctx)].join("\n"), "info");
    return;
  }

  const outcome = await customScreen<number | null>(ctx, (theme, done) =>
    new StatusPanel(
      theme,
      buildStatus(ctx, theme, 0),
      {
        rebuild: (cursor = 0) => buildStatus(ctx, theme, cursor),
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
    )
  );
  return outcome === BACK ? "back" : undefined;
};
