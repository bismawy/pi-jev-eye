// The framed /jev-eye status and usage panels, plus the headless text fallback for each.
// Data comes from the ledger and the gate; nothing here estimates a number it cannot source.

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { consentAllows, nextConsent, readConsent, writeConsent } from "./consent.ts";
import { JEV_PROVIDERS, OWN_USAGE_PATH, currentCatalog, readBackends, readAuthStore, readJsonFile, resolveJevAuth, storedCredential } from "./core.ts";
import type { JevAuth } from "./core.ts";
import { JEV_MAX_REQUESTS } from "./gate.ts";
import { chosenRowPainter, clefBudget, clefRowLabel, clefUsdPerMTok, neuronsSpentOn, packPairs } from "./layer1.ts";
import type { ModelTotals, ProviderTotals } from "./layer1.ts";
import { fetchBalanceText, readUsagePeriod, today } from "./ledger.ts";
import type { UsagePeriod } from "./ledger.ts";
import { state } from "./pmr.ts";
import { JEV_MAX_ROUTING_CALLS, readRouting } from "./routing.ts";
import { STATUS_DESC, STATUS_TITLE, cycleEyeState, usageKeys } from "./supervisor.ts";
import { BACK, StatusPanel, borderPainterFor, customScreen, framedRows, modelLabelFor } from "./ui.ts";

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

const USAGE_PERIODS: { id: UsagePeriod; label: string }[] = [
  { id: "all", label: "All" },
  { id: "today", label: "Today" },
  { id: "7d", label: "7 day" },
  { id: "30d", label: "30 day" },
  { id: "3m", label: "3 month" },
];

interface UsageRenderOptions {
  periodIndex?: number;
  cursor?: number;
  expanded?: Set<string>;
  innerWidth?: number;
}

/**
 * Usage body: Session/Blocked/Clef summary, period filter bar, collapsible Provider/Model table,
 * and Total row. Data comes from the UTC ledger; nothing is estimated except providers that do not
 * report their own cost.
 */
const buildUsage = (
  ctx: any,
  theme?: any,
  balance?: string,
  opts: UsageRenderOptions = {}
): { lines: string[]; providerIds: string[] } => {
  const paint = (color: string, value: string) => (theme ? theme.fg(color, value) : value);
  const soft = theme ? chosenRowPainter(theme) : (text: string) => text;
  const n = (value: number) => value.toLocaleString("en-US");
  // Four decimals across the whole column keep decimal points aligned across provider rows and Total;
  // zero renders as `-` so unused rows carry no `$0.0000` noise.
  const usd = (value: number): string => {
    if (value <= 0) return "-";
    if (value < 0.0001) return "<$0.0001";
    return `$${value.toFixed(4)}`;
  };

  const periodIndex = opts.periodIndex ?? 0;
  const period = USAGE_PERIODS[periodIndex] ?? USAGE_PERIODS[0];
  const expanded = opts.expanded ?? new Set<string>();
  const interactive = typeof opts.cursor === "number" && opts.cursor >= 0;
  const innerWidth = opts.innerWidth ?? 72;

  const auth = resolveJevAuth();
  const days = readJsonFile(OWN_USAGE_PATH)?.days;
  const catalog = currentCatalog();
  const totals = readUsagePeriod(period.id);

  const lines: string[] = [];

  // 1. Top KV summary: Session, Blocked, Clef (today), and optional OpenRouter Balance.
  const s = state.stats;
  const totalBlocked = s.destructiveBlocked + s.secretsBlocked + s.slopBlocked;
  const contextTokens = ctx?.getContextUsage?.()?.tokens;
  const budget = clefBudget(neuronsSpentOn(days, today()));
  const barWidth = innerWidth < 68 ? 18 : 20;
  const filled = Math.min(barWidth, Math.round((budget.used / budget.free) * barWidth));
  const exhausted = budget.used >= budget.free;
  const tierStatus = budget.overageUsd > 0 ? paint("warning", `over ${usd(budget.overageUsd)}`) : paint("success", "free");
  const clefBarLine = `${paint(exhausted ? "warning" : "success", "█".repeat(filled))}${paint("dim", "░".repeat(barWidth - filled))}  ${paint("text", `${n(Math.round(budget.used))}/${n(budget.free)}`)} ${paint("muted", "neurons")} ${paint("dim", "·")} ${tierStatus}`;
  const freeTierTag = innerWidth >= 72 ? " (free-tier)" : "";
  const clefActiveText =
    auth?.provider.id === "cloudflare"
      ? paint(
          "muted",
          innerWidth >= 76 ? `${auth.model} ($${clefUsdPerMTok(auth.model).toFixed(3)}/M in)` : auth.model
        )
      : paint("dim", "inactive");
  const clefDetailLine = `${paint("dim", `resets 00:00 UTC · ${n(Math.round(budget.remaining))} left${freeTierTag} · `)}${clefActiveText}`;

  const kvRows: [string, string][] = [
    [
      "Session",
      `${paint(
        "text",
        `gate ${Math.min(s.jevRequests, JEV_MAX_REQUESTS)}/${JEV_MAX_REQUESTS} · routing ${Math.min(s.jevRoutingCalls, JEV_MAX_ROUTING_CALLS)}/${JEV_MAX_ROUTING_CALLS} · reviewed ${s.reviewTurns}`
      )}${typeof contextTokens === "number" ? paint("dim", ` · ctx ${n(contextTokens)}`) : ""}`,
    ],
    [
      "Blocked",
      paint(totalBlocked > 0 ? "warning" : "muted", `${s.destructiveBlocked} dangerous · ${s.secretsBlocked} secret · ${s.slopBlocked} slop`),
    ],
    ["Clef (today)", clefBarLine],
    ...(balance ? [["Balance", paint("text", balance)] as [string, string]] : []),
  ];

  // 2. Period filter bar between horizontal rules.
  const rule = paint("dim", "─".repeat(Math.max(20, innerWidth)));
  lines.push(rule);
  lines.push(
    USAGE_PERIODS.map((p, idx) =>
      idx === periodIndex
        ? theme
          ? paint("accent", theme.bold(p.label))
          : `[${p.label}]`
        : paint("dim", p.label)
    ).join(paint("dim", " · "))
  );
  lines.push(rule);

  // 3. Provider / Model table.
  const W = { label: 19, req: 8, tok: 11, cost: 10 };
  const gridWidth = W.label + W.req + W.tok + W.cost;
  const cell = (text: string, width: number, alignRight = true) => {
    const s = text.length > width ? `${text.slice(0, width - 1)}…` : text;
    return alignRight ? s.padStart(width) : s.padEnd(width);
  };
  const outcomeSuffix = (t: Pick<ModelTotals, "requests" | "ok" | "failed" | "outputTokens">): string => {
    if (t.requests <= 0) return "";
    const failPart = t.failed > 0 ? ` · ${n(t.failed)} fail` : "";
    const full = ` (${n(t.ok)} ok${failPart} · out ${n(t.outputTokens)})`;
    if (gridWidth + full.length <= innerWidth) {
      return (
        paint("dim", " (") +
        paint("muted", `${n(t.ok)} ok`) +
        (t.failed > 0 ? `${paint("dim", " · ")}${paint("warning", `${n(t.failed)} fail`)}` : "") +
        paint("dim", " · ") +
        paint("muted", `out ${n(t.outputTokens)}`) +
        paint("dim", ")")
      );
    }
    const compact = ` (${n(t.ok)} ok)`;
    if (gridWidth + compact.length <= innerWidth) {
      return `${paint("dim", " (")}${paint("muted", `${n(t.ok)} ok`)}${paint("dim", ")")}`;
    }
    return "";
  };
  const renderRow = (
    label: string,
    t: Pick<ModelTotals, "requests" | "ok" | "failed" | "inputTokens" | "outputTokens" | "cost">,
    labelColor: "text" | "muted" | "dim" | "soft" = t.requests > 0 ? "text" : "muted",
    withOutcome = true
  ) => {
    const active = t.requests > 0;
    const styledLabel =
      labelColor === "soft" ? soft(cell(label, W.label, false)) : paint(labelColor, cell(label, W.label, false));
    const numbers = paint(
      active ? "text" : "dim",
      cell(n(t.requests), W.req) + cell(n(t.inputTokens), W.tok) + cell(usd(t.cost), W.cost)
    );
    return `${styledLabel}${numbers}${withOutcome ? outcomeSuffix(t) : ""}`;
  };

  lines.push(paint("dim", cell("Provider / Model", W.label, false) + cell("Request", W.req) + cell("In-tok", W.tok) + cell("Cost", W.cost)));

  const EMPTY_BUCKET: ProviderTotals = { requests: 0, ok: 0, failed: 0, inputTokens: 0, outputTokens: 0, cost: 0, neurons: 0 };
  const providersMap = totals?.providers ?? {};
  const visibleProviders = JEV_PROVIDERS.filter((provider) => {
    const hasUsage = (providersMap[provider.id]?.requests ?? 0) > 0;
    const isConfigured = catalog.some((entry) => entry.providerId === provider.id && entry.configured);
    return hasUsage || isConfigured || provider.id === "typesafe" || provider.id === "cloudflare";
  });

  const providerIds = visibleProviders.map((p) => p.id);
  let attributedRequests = 0;
  let attributedIn = 0;
  let attributedCost = 0;
  let attributedOk = 0;
  let attributedFailed = 0;
  let attributedOut = 0;

  for (const [idx, provider] of visibleProviders.entries()) {
    const pTotals = providersMap[provider.id] ?? EMPTY_BUCKET;
    attributedRequests += pTotals.requests;
    attributedIn += pTotals.inputTokens;
    attributedCost += pTotals.cost;
    attributedOk += pTotals.ok;
    attributedFailed += pTotals.failed;
    attributedOut += pTotals.outputTokens;

    const isExpanded = expanded.has(provider.id);
    const isCursor = interactive && opts.cursor === idx;
    const marker = isExpanded ? "▾" : "▸";
    lines.push(
      renderRow(
        `${marker} ${provider.short}`,
        pTotals,
        isCursor ? "soft" : pTotals.requests > 0 ? "text" : "muted",
        true
      )
    );

    if (isExpanded) {
      const catalogModels = catalog.filter((entry) => entry.providerId === provider.id).map((entry) => entry.model);
      const recordedModels = Object.keys(pTotals.models ?? {});
      const modelIds = [...new Set([...catalogModels, ...recordedModels])];
      const recordedSum = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.requests, 0);
      const unsplitReq = Math.max(0, pTotals.requests - recordedSum);

      for (const modelId of modelIds) {
        let mTotals: ModelTotals = pTotals.models?.[modelId] ?? EMPTY_BUCKET;
        // Single-model providers have no ambiguity for pre-split ledger rows: attribute directly.
        if (modelIds.length === 1 && unsplitReq > 0) {
          const sumIn = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.inputTokens, 0);
          const sumOut = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.outputTokens, 0);
          const sumOk = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.ok, 0);
          const sumFail = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.failed, 0);
          const sumCost = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.cost, 0);
          mTotals = {
            requests: mTotals.requests + unsplitReq,
            ok: mTotals.ok + Math.max(0, pTotals.ok - sumOk),
            failed: mTotals.failed + Math.max(0, pTotals.failed - sumFail),
            inputTokens: mTotals.inputTokens + Math.max(0, pTotals.inputTokens - sumIn),
            outputTokens: mTotals.outputTokens + Math.max(0, pTotals.outputTokens - sumOut),
            cost: mTotals.cost + Math.max(0, pTotals.cost - sumCost),
            neurons: pTotals.neurons,
          };
        }
        const displayModel = provider.id === "cloudflare" ? clefRowLabel(modelId) : modelId;
        lines.push(renderRow(`   ${displayModel}`, mTotals, mTotals.requests > 0 ? "muted" : "dim", false));
      }

      if (modelIds.length > 1 && unsplitReq > 0) {
        const sumIn = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.inputTokens, 0);
        const sumOut = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.outputTokens, 0);
        const sumOk = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.ok, 0);
        const sumFail = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.failed, 0);
        const sumCost = Object.values(pTotals.models ?? {}).reduce((acc, m) => acc + m.cost, 0);
        lines.push(
          renderRow(
            "   earlier",
            {
              requests: unsplitReq,
              ok: Math.max(0, pTotals.ok - sumOk),
              failed: Math.max(0, pTotals.failed - sumFail),
              inputTokens: Math.max(0, pTotals.inputTokens - sumIn),
              outputTokens: Math.max(0, pTotals.outputTokens - sumOut),
              cost: Math.max(0, pTotals.cost - sumCost),
            },
            "dim",
            false
          )
        );
      }
    }
  }

  const unattributed = Math.max(0, (totals?.requests ?? 0) - attributedRequests);
  if (unattributed > 0 && totals) {
    lines.push(
      renderRow(
        "  Earlier",
        {
          requests: unattributed,
          ok: Math.max(0, totals.ok - attributedOk),
          failed: Math.max(0, totals.failed - attributedFailed),
          inputTokens: Math.max(0, totals.inputTokens - attributedIn),
          outputTokens: Math.max(0, totals.outputTokens - attributedOut),
          cost: Math.max(0, totals.cost - attributedCost),
        },
        "muted",
        false
      )
    );
  }

  lines.push(rule);
  lines.push(renderRow("Total", totals ?? EMPTY_BUCKET, totals && totals.requests > 0 ? "text" : "muted", true));
  lines.push("");
  const kvColumn = Math.max(...kvRows.map(([label]) => label.length));
  const detailIndent = " ".repeat(kvColumn + 3);
  for (const [label, value] of kvRows) {
    lines.push(`${paint("dim", label.padEnd(kvColumn))} ${paint("dim", "·")} ${value}`);
    if (label === "Clef (today)") lines.push(`${detailIndent}${clefDetailLine}`);
  }

  return { lines, providerIds };
};

interface UsagePanelState {
  periodIndex: number;
  cursor: number;
  expanded: Set<string>;
}

/** Interactive `/jev-eye usage` panel: range cycling (`Tab` / `←→`) and collapsible provider tree (`↑↓` + `Space`). */
class UsagePanel {
  private readonly view: UsagePanelState = { periodIndex: 0, cursor: 0, expanded: new Set<string>() };
  private providerIds: string[] = [];
  private readonly theme: any;
  private readonly paint: (text: string) => string;
  private readonly ctx: any;
  private readonly balance: string | undefined;
  private readonly done: (value?: typeof BACK) => void;
  private readonly back: boolean;

  constructor(ctx: any, theme: any, balance: string | undefined, done: (value?: typeof BACK) => void, back = true) {
    this.ctx = ctx;
    this.theme = theme;
    this.paint = borderPainterFor(theme, ctx);
    this.balance = balance;
    this.done = done;
    this.back = back;
    this.providerIds = buildUsage(ctx, theme, balance).providerIds;
  }

  private moveCursor(delta: number): void {
    if (this.providerIds.length === 0) return;
    this.view.cursor = (this.view.cursor + delta + this.providerIds.length) % this.providerIds.length;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done(this.back ? BACK : undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.view.periodIndex = (this.view.periodIndex + 1) % USAGE_PERIODS.length;
      return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, Key.left)) {
      this.view.periodIndex = (this.view.periodIndex - 1 + USAGE_PERIODS.length) % USAGE_PERIODS.length;
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveCursor(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.view.cursor = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      if (this.providerIds.length > 0) this.view.cursor = this.providerIds.length - 1;
      return;
    }
    if (matchesKey(data, Key.space)) {
      const id = this.providerIds[this.view.cursor];
      if (!id) return;
      if (this.view.expanded.has(id)) this.view.expanded.delete(id);
      else this.view.expanded.add(id);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(20, width - 4);
    const { lines, providerIds } = buildUsage(this.ctx, t, this.balance, {
      periodIndex: this.view.periodIndex,
      cursor: this.view.cursor,
      expanded: this.view.expanded,
      innerWidth: inner,
    });
    this.providerIds = providerIds;
    if (providerIds.length > 0 && this.view.cursor >= providerIds.length) {
      this.view.cursor = providerIds.length - 1;
    }
    const header = [
      t.fg("accent", t.bold(USAGE_TITLE)),
      t.fg("muted", USAGE_DESC),
      "",
      ...lines,
      "",
      ...packPairs(usageKeys(this.back), inner).map((pair) => t.fg("dim", pair)),
    ];
    return framedRows(header, width, this.paint);
  }

  invalidate(): void {
    this.providerIds = [];
  }
}

/** `/jev-eye usage`: the same framed panel as status, with the spend breakdown. */
export const showUsage = async (ctx: any, back = true): Promise<void | "back"> => {
  const balance = await usageBalance(resolveJevAuth());
  // `custom` is a no-op in RPC (rpc-extension-ui.md): it resolves undefined without drawing anything,
  // so the text fallback must be chosen by mode, not by the method existing.
  if (ctx.mode !== "tui") {
    ctx.ui.notify([USAGE_TITLE, USAGE_DESC, "", ...buildUsage(ctx, undefined, balance).lines].join("\n"), "info");
    return;
  }
  const outcome = await customScreen<number | null>(ctx, (theme, done) => new UsagePanel(ctx, theme, balance, done, back));
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
