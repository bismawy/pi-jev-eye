// The /jev-eye menus and subcommands: the root loop, the routing flow, and argument dispatch.

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { currentCatalog, readAuthStore, readBackends, resolveJevAuth, writeBackends } from "./core.ts";
import { loginFlow } from "./flows.ts";
import { showStatus, showUsage } from "./panels.ts";
import { EYE_MARKER, EYE_TRIGGER } from "./review.ts";
import { readRouting, writeRouting } from "./routing.ts";
import type { Routing } from "./routing.ts";
import { TOGGLE_KEY, eyeCompletions, syncEyeStatus } from "./supervisor.ts";
import { BACK, ModelsPicker, RoutingPicker, borderPainterFor, pickRow } from "./ui.ts";
import type { Backends } from "./layer1.ts";

const saveRouting = (ctx: any, next: Routing): void => {
  writeRouting(next);
  ctx.ui.notify(
    `[pi-jev-eye] Routing ${next.enabled ? "ON" : "OFF"} · light ${next.light || "(unset)"} · heavy ${next.heavy || "(unset)"}${
      next.enabled ? "" : " — routing stays off until both targets are set"
    }.`,
    next.enabled ? "info" : "warning"
  );
};

/** The whole routing screen: one keybind-driven picker for both targets. */
const openRoutingMenu = async (ctx: any, focus: "light" | "heavy" = "light", back = true): Promise<void | "back"> => {
  const available: any[] = ctx?.modelRegistry?.getAvailable?.() ?? [];
  if (available.length === 0) {
    ctx.ui.notify("[pi-jev-eye] No authenticated models found to route to.", "error");
    return;
  }

  const current = readRouting();

  if (ctx.mode !== "tui") {
    // Headless fallback keeps the same semantics with two plain lists.
    const refs = ["(none)", ...available.map((m: any) => `${m.provider}/${m.id}`)];
    const light = await ctx.ui.select("Light model", refs);
    if (light === undefined) return;
    const heavy = await ctx.ui.select("Heavy model", refs);
    if (heavy === undefined) return;
    const next = { light: light === "(none)" ? "" : light, heavy: heavy === "(none)" ? "" : heavy, enabled: current.enabled };
    saveRouting(ctx, { ...next, enabled: next.enabled && !!next.light && !!next.heavy });
    return;
  }

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value: Routing | null) => void) => {
    const picker = new RoutingPicker(theme, available, current, focus, done, borderPainterFor(theme, ctx), back);
    return {
      render: (width: number) => picker.render(width),
      invalidate: () => picker.invalidate(),
      handleInput: (data: string) => {
        picker.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (result === BACK) return "back";
  if (!result) {
    ctx.ui.notify("[pi-jev-eye] Routing unchanged.", "info");
    return;
  }
  saveRouting(ctx, result);
};

/** The whole Models screen: which backend answers, and which one takes over when it cannot. */
const openModelsMenu = async (ctx: any, back = true): Promise<void | "back"> => {
  const store = readAuthStore().store;
  const models = currentCatalog(store);
  const current = readBackends();

  // Saving is two steps, and the second one is why the footer looked stale: writing the file does not
  // republish the status value, so the cell kept naming the previous backend until a `/reload`. pi's
  // `setStatus` triggers its own render, so republishing here updates the footer live.
  const announce = (next: { primary: string; fallback: string }, picked: boolean) => {
    const label = (ref: string) => models.find((m) => m.ref === ref)?.label ?? "(auto)";
    ctx.ui.notify(
      `[pi-jev-eye] ${picked ? "Models saved" : "Models unchanged"} · active ${next.primary ? label(next.primary) : "(auto)"} · fallback ${next.fallback ? label(next.fallback) : "(auto)"}.`,
      "info"
    );
    syncEyeStatus(ctx);
  };

  if (ctx.mode !== "tui") {
    // Headless keeps the same two slots with two plain lists.
    const refs = ["(auto)", ...models.map((m) => m.ref)];
    const primary = await ctx.ui.select("Active backend", refs);
    if (primary === undefined) return;
    const fallback = await ctx.ui.select("Fallback backend", refs);
    if (fallback === undefined) return;
    const next = { primary: primary === "(auto)" ? "" : primary, fallback: fallback === "(auto)" ? "" : fallback };
    writeBackends(next);
    announce(next, true);
    return;
  }

  const result = await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value: Backends | null) => void) => {
    const picker = new ModelsPicker(theme, models, current, done, back);
    return {
      render: (width: number) => picker.render(width),
      invalidate: () => picker.invalidate(),
      handleInput: (data: string) => {
        picker.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (result === BACK) return "back";
  if (!result) {
    ctx.ui.notify("[pi-jev-eye] Models unchanged.", "info");
    return;
  }
  writeBackends(result);
  announce(result, true);
};

// Interactive menu: accounts, models, status, usage, routing
const openMenu = async (ctx: any): Promise<void> => {
  const auth = resolveJevAuth();
  const routing = readRouting();
  const backends = readBackends();
  const catalog = currentCatalog();
  const backendName = (ref: string) => catalog.find((m) => m.ref === ref)?.label;
  const modelsDesc = backends.primary
    ? `active: ${backendName(backends.primary)}${backends.fallback ? ` · fallback: ${backendName(backends.fallback)}` : " · no fallback"}`
    : "choose the active Jev/Clef backend and its fallback";
  const routingDesc = routing.enabled
    ? `ON · ${routing.light || "unset"} → ${routing.heavy || "unset"}`
    : "off · configure light & heavy targets";

  // One entry for credentials: the Accounts screen adds and removes, so a separate Logout row would be a
  // second path to the same operation and would drift from it. Its subcommand is `/jev-eye accounts`,
  // never `login`/`logout`: those two names promised a screen the row already owns.
  const rows = [
    { label: "Accounts", note: auth ? `keys & stored state (current: ${auth.provider.label})` : "TypeSafe, OpenRouter, or Cloudflare Workers AI (Clef) key" },
    { label: "Models", note: modelsDesc },
    { label: "Status", note: "supervisor, gate scope & metrics" },
    { label: "Usage", note: "Jev/Clef spend, per-provider split & free-neuron budget" },
    { label: "Routing", note: routingDesc },
  ];

  // The root menu has no previous screen, so it carries no [←] Back. Sub-screens that end with
  // [Esc] fall back here too, so the operator never lands in the editor with a half-open menu.
  // Remembering the last row keeps [←] on the screen the operator came from instead of resetting to
  // the first row, which read as "back sent me to Accounts".
  let cursor = 0;
  while (true) {
    const index = await pickRow(ctx, "Jev Eye · Menu", rows, "Supervisor settings and live state for this session.", cursor);
    if (index === null) return;
    cursor = index;
    let outcome: void | "back";
    if (index === 0) {
      outcome = await loginFlow(ctx);
    } else if (index === 1) {
      outcome = await openModelsMenu(ctx, true);
    } else if (index === 2) {
      outcome = await showStatus(ctx, true);
    } else if (index === 3) {
      outcome = await showUsage(ctx, true);
    } else {
      outcome = await openRoutingMenu(ctx, "light", true);
    }
    // Any screen that was left with [←] reopens this menu; anything else ends the command.
    if (outcome !== "back") return;
  }
};

const eyeHandler = async (args: string, ctx: any) => {
  const sub = args.trim().toLowerCase();

  if (sub === "") {
    await openMenu(ctx);
    return;
  }

  if (sub === "routing" || sub.startsWith("routing ")) {
    const value = sub.slice("routing".length).trim();
    if (value === "light" || value === "heavy") {
      await openRoutingMenu(ctx, value, false);
      return;
    }
    if (value === "on" || value === "off") {
      const routing = readRouting();
      writeRouting({ ...routing, enabled: value === "on" });
      const missing = value === "on" && (!routing.light || !routing.heavy);
      ctx.ui.notify(
        value === "on"
          ? `[pi-jev-eye] Routing ON · light ${routing.light || "(unset)"} · heavy ${routing.heavy || "(unset)"}${
              missing ? " — set both targets with `/jev-eye routing`" : ""
            }.`
          : "[pi-jev-eye] Routing OFF; turns keep the current model.",
        missing ? "warning" : value === "on" ? "info" : "warning"
      );
      return;
    }
    await openRoutingMenu(ctx, "light", false);
    return;
  }

  if (sub === "toggle" || sub === "on" || sub === "review" || sub === "off") {
    // The mode has exactly one path, the `ctrl+alt+e` keybinding, which the Status screen's footer
    // also advertises. A second name for it here is how `on`/`review`/`off`/`toggle` ended up as four
    // subcommands with no menu row, no completion anyone wanted, and a mode value that had to be kept
    // in sync with `cycleEyeState` by hand.
    ctx.ui.notify(`[pi-jev-eye] Supervisor mode is the ${TOGGLE_KEY} keybinding (and the Status screen's footer). There is no \`/jev-eye ${sub}\`; run \`/jev-eye status\` to see the current mode.`, "warning");
    return;
  }

  if (sub === "accounts") {
    await loginFlow(ctx);
    return;
  }

  if (sub === "models") {
    await openModelsMenu(ctx, false);
    return;
  }

  // `login` and `logout` were the same screen under two names. Point at the one that exists instead of
  // silently accepting either, so an old habit still reaches Accounts without keeping a duplicate row.
  if (sub === "login" || sub === "logout") {
    ctx.ui.notify(`[pi-jev-eye] \`/jev-eye ${sub}\` was renamed to \`/jev-eye accounts\`: one screen stores a key and removes one with [Ctrl+d]. Opening it now.`, "info");
    await loginFlow(ctx);
    return;
  }

  if (sub === "usage") {
    await showUsage(ctx, false);
    return;
  }

  if (sub !== "status") {
    ctx.ui.notify(
      `[pi-jev-eye] Unknown argument "${sub}". Use: accounts | models | status | usage | routing [light|heavy|on|off], or no argument for the menu (supervisor mode is ${TOGGLE_KEY}).`,
      "warning"
    );
    return;
  }

  await showStatus(ctx, false);
};

/**
 * The flat trigger's command form: `/eye <task>`.
 *
 * A registered command runs before the prompt is built and pi discards the command text once it is
 * handled, so the handler re-sends the operator's own words as a user message and the ordinary prompt
 * path runs. It sends `EYE_MARKER + task` rather than the bare task: detection then stays in ONE place
 * (the `before_agent_start` hook), which is also why this command exists at all — without it, `/eye` at
 * the start of an input is consumed as a command and the marker never reaches the hook.
 *
 * `pi.sendUserMessage` is the sender because `ctx` (an `ExtensionCommandContext`) has no send method.
 * The send is deliberately not awaited: pi holds the editor until the handler settles, so waiting for the
 * turn would freeze input for its whole duration.
 */
const eyeTrigger = (pi: any) => async (args: string, ctx: any) => {
  const task = String(args ?? "").replace(EYE_TRIGGER, " ").replace(/\s{2,}/g, " ").trim();
  if (!task) {
    ctx.ui.notify("[pi-jev-eye] `/eye` needs a task: run `/eye <task>` or write `/eye` inside a prompt.", "warning");
    return;
  }
  ctx.ui.notify("[pi-jev-eye] Reviewed turn via `/eye`; the write gate compares the diff against this task.", "info");
  pi.sendUserMessage(`${EYE_MARKER} ${task}`);
};

/** The one export this file owes the entry point: register `/jev-eye` against the handlers above. */
export function installCommands(pi: any): void {
  pi.registerCommand("jev-eye", {
    description: "pi-jev-eye supervisor: menu (Accounts / Models / Status / Usage / Routing), status, usage stats",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => eyeCompletions(prefix),
    handler: eyeHandler,
  });
  pi.registerCommand("eye", {
    description: "pi-jev-eye reviewed turn: `/eye <task>` opens the calibrated report contract (same as typing `/eye` in a prompt)",
    handler: eyeTrigger(pi),
  });
}
