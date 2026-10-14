// Live session state, the keybinding table, and the status-bar indicator.
// One declaration per key: the footer, the shortcuts and the notifications all read KEY_SETS.

import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { authChain, readBackends } from "./core.ts";
import { backendFooterName } from "./layer1.ts";
import { state } from "./pmr.ts";

export const KEY_SETS = {
  /** Cycle ON → REVIEW → OFF.
   *
   *  `ctrl+alt+<letter>` is the portable shape: legacy terminals send it as an ESC-prefixed ctrl code
   *  (`\x1b\x05`) and the kitty protocol as a CSI-u sequence (`\x1b[101;7u`), and `matchesKey` accepts
   *  both — verified, not assumed. Ghostty binds no `ctrl+alt+<letter>` (only `ctrl+alt+<arrow>` and
   *  `ctrl+alt+shift+j`), foot binds none at all, and pi binds only `ctrl+alt+]`.
   *
   *  `ctrl+shift+<letter>` is the shape to avoid: Ghostty owns `ctrl+shift+e` (`new_split:down`) and
   *  `ctrl+shift+t` (`new_tab`), macOS maps Cmd+Shift+letter to `super+shift`, and a terminal without
   *  the kitty protocol reports the shifted chord as the plain ctrl code — `matchesKey("\x14",
   *  "ctrl+shift+t")` is `false`, so the key silently never fires. */
  toggle: "ctrl+alt+e",
  /** Cycle the Jev gate value: all folders / this folder / disabled. Same portable shape as `toggle`;
   *  `ctrl+shift+g` was pi's own `tui.altScreen.searchPrevious`. */
  gate: "ctrl+alt+u",
  /** Cycle the model router on/off inside the routing screen. */
  routingToggle: "ctrl+r",
  /** Remove the highlighted credential on the Accounts screen. `ctrl+d` is pi's `app.session.delete`, but
   *  a custom component owns focus while it is open, so the key never reaches that action. */
  accountsRemove: "ctrl+d",
  /** Assign the highlighted model to the light slot; pressing it again walks that slot's thinking level.
   *  One key for both steps keeps the screen free of a second chord — `ctrl+t` / `ctrl+shift+t` were
   *  exactly the unportable pair the two separate keys needed. */
  routeLight: "space",
  /** Assign the highlighted model to the heavy slot; pressing it again walks its thinking level. */
  routeHeavy: "ctrl+h",
  /** Alias for `ctrl+h`: some terminals report ctrl+h as backspace (`\x08` satisfies both keys), so a
   *  handler that matches the two in order never loses the assignment. */
  routeHeavyAlias: "ctrl+q",
  /** Models screen: make the highlighted backend the active one. `space` is the same
   *  "assign the highlighted row" gesture the routing screen uses; `[[` and `]]` on screen say which slot. */
  modelsPrimary: "space",
  /** Models screen: make the highlighted backend the fallback, tried when the active one cannot answer. */
  modelsFallback: "ctrl+f",
} as const;

export const TOGGLE_KEY = KEY_SETS.toggle;
// Gate scope cycle, announced in the same footer.
export const GATE_KEY = KEY_SETS.gate;

// `/jev-eye status` panel chrome: title, one-line description, footer.
export const STATUS_TITLE = "Jev Eye · Status";
export const STATUS_DESC = "Supervisor, gate, routing and interception for this Pi session.";
// Keycap hint only: `ctrl+alt+e` -> `Ctrl+Alt+e`.
export const keycap = (key: string) =>
  key
    .split("+")
    .map((part) => (part.length > 1 ? part[0].toUpperCase() + part.slice(1) : part))
    .join("+");

const eyeMode = (enabled: boolean, reviewMode: boolean): "ON" | "REVIEW" | "OFF" =>
  !enabled ? "OFF" : reviewMode ? "REVIEW" : "ON";

/**
 * The framed screens' keybind legend, in one place so a new screen cannot invent its own wording or
 * advertise a key it does not act on. `back` is per-screen: only a screen an extension opened itself
 * has somewhere to return to, so `[←] Back` is advertised exactly when `[←]` is handled. A read-only
 * screen (usage) carries no toggles. The footer wraps inside the frame, so no key is dropped.
 */
export const panelKeys = (controls: boolean, back = true): string[] =>
  [
    "[Enter] Done",
    ...(controls ? [`[${keycap(TOGGLE_KEY)}] Supervisor`, `[${keycap(GATE_KEY)}] Grant folder`] : []),
    ...(back ? ["[←] Back"] : []),
    // The exits last, in the order they act: Back stays inside the extension, Esc leaves it. Same order
    // as the routing picker's legend, so one reading works on every framed screen.
    "[Esc] Cancel",
  ];

/** Paint a keybinding for a legend, from the same table the handler matches against. */
export const keybind = (key: string): string => `[${keycap(key)}]`;

/** Autocomplete rows for a prefix, matched on the whole value so `routing ` reaches the arguments. */
export const eyeCompletions = (prefix: string): AutocompleteItem[] | null => {
  const items: AutocompleteItem[] = EYE_SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.toLowerCase()));
  return items.length > 0 ? items : null;
};

export function cycleEyeState(ctx?: any): "ON" | "REVIEW" | "OFF" {
  if (!state.enabled) {
    state.enabled = true;
    state.reviewMode = false;
  } else if (!state.reviewMode) {
    state.enabled = true;
    state.reviewMode = true;
  } else {
    state.enabled = false;
    state.reviewMode = false;
  }
  if (ctx) syncEyeStatus(ctx);
  return eyeMode(state.enabled, state.reviewMode);
}

// Live state + keybindings render in the panel footer, not in Pi's status bar.
//
// One entry per thing the operator can actually reach: the first four mirror the root menu's rows,
// and the rest are the routing arguments the handler matches. A name that is not a row and not an
// argument does not belong here — that is how `login`/`logout` and `on`/`review`/`off`/`toggle` used
// to sit in the list with no counterpart anywhere visible. Supervisor mode has one path, the
// `ctrl+alt+e` keybinding, and it is named by that keybinding rather than by a subcommand.
export const EYE_SUBCOMMANDS = [
  { value: "accounts", label: "accounts", description: "Accounts screen [menu row]: store a key for TypeSafe, OpenRouter, or Cloudflare Workers AI (Clef), and remove one with [Ctrl+d]" },
  { value: "models", label: "models", description: "Models screen [menu row]: choose the active Jev/Clef backend and the fallback it fails over to" },
  { value: "status", label: "status", description: "Show supervisor, gate scope, routing and interception stats [menu row]" },
  { value: "usage", label: "usage", description: "Show Jev/Clef spend: per-provider totals and the Cloudflare free-neuron budget [menu row]" },
  { value: "routing", label: "routing", description: "Model routing screen: pick the light and heavy targets [menu row]" },
  { value: "routing light", label: "routing light", description: "Open the routing screen focused on the light slot" },
  { value: "routing heavy", label: "routing heavy", description: "Open the routing screen focused on the heavy slot" },
  { value: "routing on", label: "routing on", description: "Turn per-turn routing on (needs both targets set)" },
  { value: "routing off", label: "routing off", description: "Turn per-turn routing off; turns keep the current model" },
];

// Live supervisor state for Pi's status bar (read by the pi-arnative footer):
// key "pi-jev-eye" present = extension active; ● ON / ○ OFF = supervisor state.
//
// The value is `Eye: ● MODE (Backend)` in plain text — the format the operator asked for:
//   Eye: ● ON (Clef Flash)   when the active backend is a Clef model
//   Eye: ● ON (Jev)          when it is TypeSafe or OpenRouter (the same decision backend, one name)
//   Eye: ● ON (Jev)          when nothing is picked and the credential precedence answers
// The name is the ACTIVE backend read from `backends.json`, never a hardcoded provider, so switching in
// `/jev-eye models` changes this line without a reload. The footer owns the painting of the `(...)` suffix
// (it dims it), because a status value is a fact, not a layout.
export function syncEyeStatus(ctx: any): void {
  try {
    const ui = ctx?.ui;
    if (typeof ui?.setStatus !== "function") return;
    const dot = !state.enabled ? "○" : "●";
    const label = !state.enabled ? "OFF" : state.reviewMode ? "REVIEW" : "ON";
    ui.setStatus("pi-jev-eye", `Eye: ${dot} ${label} (${backendStatusName()})`);
  } catch {
    // ui may already be disposed at session close: ignore
  }
}

/** Name inside the status cell's parentheses: the active backend's suffix, or `Jev` when nothing is picked. */
function backendStatusName(): string {
  const active = authChain(readBackends())[0];
  return active ? backendFooterName(active.provider.id, active.model) : "Jev";
}
