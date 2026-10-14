// Arnative rounded-box chrome: the frame maths, the boxed dialogs and the pickers.
// Every screen in pi-jev-eye is drawn from here, so a new screen cannot invent its own frame.

import { CURSOR_MARKER, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { JEV_PROVIDERS, storedCredential } from "./core.ts";
import type { BackendModel, JevProvider } from "./core.ts";
import { assignBackend, borderPainter, boxFrame, chosenRowPainter, packPairs, wrapWords } from "./layer1.ts";
import type { AuthStore, Backends } from "./layer1.ts";
import { HEAVY_THINKING_LEVELS, LIGHT_THINKING_LEVELS, SLOT_DEFAULT_THINKING } from "./pmr.ts";
import type { ThinkingLevel } from "./pmr.ts";
import type { Routing } from "./routing.ts";
import { GATE_KEY, KEY_SETS, STATUS_DESC, STATUS_TITLE, TOGGLE_KEY, keybind, keycap, panelKeys } from "./supervisor.ts";

/**
 * Border painter for a screen: the session's thinking level colours the box, as in `/arnative`.
 * The probe order lives in `borderPainter` (layer1, covered by `npm test`), which prefers the
 * arnative soft token before falling back to the thinking slot every theme defines. */
export const borderPainterFor = (theme: any, ctx?: any) => borderPainter(theme, ctx?.thinkingLevel);

/**
 * The credential screen: every backend, its stored state, and the one place a key is added or removed.
 *
 * `select` renders one fixed string per row, so it can show state but cannot react to the highlighted
 * row — the key-source tip was stuck as static filler. This picker re-renders on every move and shows the
 * tip for whatever is under the cursor, which is the whole point of the tip.
 *
 * Two ways out, deliberately different: `[Enter]` picks the backend to store a key for, and
 * `[Ctrl+d]` removes the highlighted one. Removal asks twice — the row switches to a warning, and only a
 * second press deletes — because a key cannot be recovered from this screen. The write itself stays with
 * the caller (`onRemove`), so the filesystem rule for an emptied store lives in one place.
 */
export class AccountsPicker {
  private readonly options: { label: string; status: "stored" | "unset"; provider: JevProvider }[];
  private readonly theme: any;
  private readonly done: (value: JevProvider | null) => void;
  private readonly onRemove: (provider: JevProvider) => Promise<void>;
  private readonly soft: (text: string) => string;
  /** Whose removal awaits its second `[Ctrl+d]`; cleared by any move or by a completed removal. */
  private pendingRemove: string | null = null;
  /** True while `onRemove` runs, so a key repeat cannot start a second deletion. */
  private busy = false;
  private index = 0;

  constructor(
    theme: any,
    store: AuthStore,
    done: (value: JevProvider | null) => void,
    onRemove: (provider: JevProvider) => Promise<void>,
  ) {
    this.theme = theme;
    this.done = done;
    this.onRemove = onRemove;
    this.soft = chosenRowPainter(theme);
    this.options = JEV_PROVIDERS.map((provider) => ({
      label: provider.label,
      status: storedCredential(store, provider.id) ? "stored" : "unset",
      provider,
    }));
  }

  /** Set when the operator pressed [←]; the caller then reopens the menu instead of leaving.
   *  Kept as a plain field: `ctx.ui.custom` resolves one value, and `null` already means "cancelled". */
  wentBack = false;

  private move(delta: number): void {
    this.index = (this.index + delta + this.options.length) % this.options.length;
    this.pendingRemove = null; // moving away cancels a half-confirmed removal
  }

  /** Two presses of the same key, because a stored key is not recoverable from here. */
  private async requestRemove(): Promise<void> {
    const option = this.options[this.index];
    if (this.busy || !option || option.status !== "stored") return;
    if (this.pendingRemove !== option.provider.id) {
      this.pendingRemove = option.provider.id;
      return;
    }
    this.busy = true;
    try {
      await this.onRemove(option.provider);
      this.options[this.index] = { ...option, status: "unset" };
      this.pendingRemove = null;
    } finally {
      this.busy = false;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.home)) {
      this.index = 0;
      this.pendingRemove = null;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.index = this.options.length - 1;
      this.pendingRemove = null;
      return;
    }
    if (matchesKey(data, KEY_SETS.accountsRemove)) {
      void this.requestRemove();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.options[this.index]?.provider ?? null);
      return;
    }
    if (matchesKey(data, Key.escape)) this.done(null);
    if (matchesKey(data, Key.left)) {
      this.wentBack = true;
      this.done(null);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = borderPainterFor(t);
    const inner = width - 4; // two walls, two spaces
    const removeKey = keycap(KEY_SETS.accountsRemove);
    const stored = this.options.some((option) => option.status === "stored");
    const lines = [
      t.fg("accent", t.bold("Jev Eye · Accounts")),
      t.fg("muted", `Pick a backend to store its key${stored ? `, or press [${removeKey}] on a stored one to remove it` : ""}.`),
      "",
    ];
    // Same column rule as every other list: the label is padded to the widest one, so both the state
    // markers and the reading order stay in one column instead of drifting with the label length.
    const column = Math.max(...this.options.map((option) => visibleWidth(option.label)));
    for (const [i, option] of this.options.entries()) {
      const cursor = i === this.index;
      const confirming = cursor && this.pendingRemove === option.provider.id;
      const mark = confirming
        ? t.fg("warning", `press [${removeKey}] again to remove`)
        : option.status === "stored"
          ? t.fg("success", "✓ stored")
          : t.fg("dim", "• not configured");
      const label = cursor ? this.soft(option.label) : t.fg("text", option.label);
      const pad = " ".repeat(Math.max(0, column - visibleWidth(option.label)));
      // `Label  ·  state`, the same divider rule as every list menu, so the state column lines up.
      lines.push(`${cursor ? t.fg("accent", "→ ") : "  "}${label}${pad}  ${t.fg("dim", "·")}  ${mark}`);
    }
    // The live tip: whatever is highlighted, not a static caption.
    const current = this.options[this.index];
    lines.push("");
    if (current) {
      lines.push(t.fg("dim", `Tips: key from ${current.provider.keyHint}`));
      const hint = current.provider.accountEnv ?? `$${current.provider.keyEnv}`;
      lines.push(t.fg("dim", `Or export ${hint}${current.provider.accountEnv ? ` + $${current.provider.keyEnv}` : ""}`));
    }
    lines.push("");
    // Wrapped, never truncated: every advertised key stays visible on a narrow screen. A key is only
    // advertised when some row can act on it — `[Ctrl+d]` does nothing with nothing stored.
    const legend = ["[↑↓] Move", "[Enter] Choose", ...(stored ? [`[${removeKey}] Remove`] : []), "[←] Back", "[Esc] Cancel"];
    for (const pair of packPairs(legend, inner)) lines.push(t.fg("dim", pair));
    // Arnative frame: round corners, one content row per line, so a short terminal clips cleanly.
    return framedRows(lines, width, paint);
  }

  invalidate(): void {}
}

/**
 * Rounded-box list picker: same frame as `@bismawy/pi-arnative`'s ListPicker and the screens beside it.
 * `ctx.ui.select` renders itself with two full-width rules, so a menu that must be rounded has to own its
 * component. `rows` are pre-styled one-liners; the arrow is the only thing this class adds.
 */
/** `done()` value meaning the user pressed [←] Back rather than choosing or cancelling. */
export const BACK = -2;

class ListPicker {
  private readonly rows: { label: string; note: string }[];
  private readonly title: string;
  private readonly subtitle: string;
  private readonly footer: string[];
  private readonly theme: any;
  private readonly paint: (text: string) => string;
  private readonly done: (value: number | null) => void;
  private readonly soft: (text: string) => string;
  private index: number;

  constructor(
    theme: any,
    title: string,
    rows: { label: string; note: string }[],
    subtitle: string,
    done: (value: number | null) => void,
    paint: (text: string) => string,
    initialIndex = 0,
  ) {
    this.theme = theme;
    this.title = title;
    this.rows = rows;
    this.subtitle = subtitle;
    this.done = done;
    this.paint = paint;
    this.soft = chosenRowPainter(theme);
    // Reopening a menu after [←] must land on the row the operator left from, not on the first one.
    this.index = Math.min(Math.max(initialIndex, 0), Math.max(0, rows.length - 1));
    this.footer = ["[↑↓] Move", "[Enter] Choose", "[Esc] Cancel"];
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.index = (this.index - 1 + this.rows.length) % this.rows.length;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = (this.index + 1) % this.rows.length;
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.index = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.index = this.rows.length - 1;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.index);
      return;
    }
    if (matchesKey(data, Key.escape)) this.done(null);
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = this.paint;
    const inner = width - 4; // two walls, two spaces
    const lines = [t.fg("accent", t.bold(this.title)), t.fg("muted", this.subtitle), ""];
    // Every label is padded to the widest one, so all `·` dividers land in one column (as in `menuLabels`).
    const column = Math.max(...this.rows.map((item) => visibleWidth(item.label)));
    for (const [i, item] of this.rows.entries()) {
      const chosen = i === this.index;
      const label = chosen ? this.soft(item.label) : t.fg(item.note ? "text" : "muted", item.label);
      const pad = " ".repeat(Math.max(0, column - visibleWidth(item.label)));
      const note = item.note ? `${t.fg("dim", "  ·  ")}${t.fg("dim", item.note)}` : "";
      lines.push(`${chosen ? t.fg("accent", "→ ") : "  "}${label}${pad}${note}`);
    }
    lines.push("");
    for (const pair of packPairs(this.footer, inner)) lines.push(t.fg("dim", pair));
    return framedRows(lines, width, paint);
  }

  invalidate(): void {}
}

/** Content column of a framed row: the frame owns the two walls, so the content gets the rest. */
const boxInner = (width: number): number => Math.max(0, width - 4);

/** Drive the same picker everywhere: TUI gets the rounded box, RPC and headless keep `ctx.ui.select`.
 *  `initialIndex` keeps the cursor where the operator left it when a sub-screen returns with [←]. */
export async function pickRow(
  ctx: any,
  title: string,
  rows: { label: string; note: string }[],
  subtitle: string,
  initialIndex = 0,
): Promise<number | null> {
  if (ctx.mode !== "tui") {
    const labels = rows.map((row) => (row.note ? `${row.label} · ${row.note}` : row.label));
    const choice = await ctx.ui.select(title, labels);
    return choice ? labels.indexOf(choice) : null;
  }
  const picked = await ctx.ui.custom<number | null>((tui: any, theme: any, _kb: any, done: (value: number | null) => void) => {
    const picker = new ListPicker(theme, title, rows, subtitle, done, borderPainterFor(theme, ctx), initialIndex);
    return {
      render: (width: number) => picker.render(width),
      invalidate: () => picker.invalidate(),
      handleInput: (data: string) => {
        picker.handleInput(data);
        tui.requestRender();
      },
    };
  });
  return picked;
}

/**
 * The Accounts rows as plain strings, for the headless path where `custom` UI does not exist.
 * The same state markers the picker draws, minus the cursor and the live tip.
 */
export const accountRowLabels = (store: AuthStore): string[] =>
  JEV_PROVIDERS.map((provider) => `${provider.label} ${storedCredential(store, provider.id) ? "✓ stored" : "• not configured"}`);

/** One line naming where a provider's key comes from, used wherever that cannot be rendered in place. */
export const providerTip = (provider: JevProvider): string => `Tips: key from ${provider.keyHint}`;

/**
 * Frame whole rows into the arnative box: split on newlines first, clip each row to the inner width,
 * then let `boxFrame` add the walls (it boxes every row itself — boxing here too would double them).
 * A newline left inside a row would open a hole in the frame, and a value from the network or a pasted
 * query must not be trusted. Every framed screen in this file renders through here. The clip keeps an
 * ellipsis: a model ref cut to `deepseek-v` must not read as a whole model name.
 */
const framedRows = (rows: string[], width: number, paint: (text: string) => string): string[] =>
  boxFrame(
    rows.flatMap((content) => String(content).split("\n")).map((content) => truncateToWidth(content, boxInner(width))),
    width,
    paint,
  );

/** Single-line input that renders bullets instead of the typed key. */
class SecretInput extends Input {
  render(width: number): string[] {
    const length = [...this.getValue()].length;
    // One column is held back for the caret: the marker is zero-width, and if it were the last thing
    // over the limit `truncateToWidth` would drop it — which puts an IME candidate window in the wrong
    // column while a long key is being pasted.
    const bullets = "•".repeat(Math.min(length, Math.max(0, width - 1)));
    const cursor = this.focused ? `${CURSOR_MARKER}\x1b[7m \x1b[27m` : "";
    return [truncateToWidth(bullets + cursor, width, "")];
  }
}

/**
 * One screen for the routing targets, keybind-driven: type to filter, `space` assigns the
 * highlighted model as the light target, `ctrl+h` as the heavy target, `enter` saves,
 * `esc` discards. Rows carry `✓ (light)` / `✓ (heavy)` so both slots stay visible at once.
 */
const modelRef = (model: any): string => `${model.provider}/${model.id}`;

/** Human label shared by the routing screen and the status block: model name plus the capitalized
 *  provider, without repeating a vendor the display name already carries. */
function modelLabel(model: any): string {
  const name = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : model.id;
  const providerRaw = String(model.provider ?? "").trim();
  const provider = providerRaw ? providerRaw[0].toUpperCase() + providerRaw.slice(1) : "unknown";

  // Model display names often already carry the vendor/provider in parentheses or suffix
  // e.g. "Claude Sonnet 4.6 (Antigravity)" -> avoid "Claude Sonnet 4.6 (Antigravity) (Antigravity)"
  if (name.toLowerCase().includes(provider.toLowerCase())) {
    return name;
  }
  return `${name} (${provider})`;
}

/** Raw `provider/modelId` ref → human label; the ref itself when the registry does not list it. */
export const modelLabelFor = (models: any[], ref: string): string => {
  const model = models.find((m) => modelRef(m) === ref);
  return model ? modelLabel(model) : ref;
};

/**
 * Theme token per routing slot, so the two assignments never look alike. `light` keeps the house accent;
 * `heavy` takes amber — the one warm token every theme defines, which reads as "expensive" without the
 * red of `error`. Both are probed by the render check, so a token the theme drops cannot silently paint
 * both slots the same colour.
 */
export const SLOT_TOKEN = { light: "accent", heavy: "warning" } as const;

export class RoutingPicker {
  private pending: Routing;
  private query = "";
  private index = 0;
  /** Last thing a key did, shown under the table so the folded thinking step is not invisible. */
  private notice = "";
  private readonly models: any[];
  private readonly theme: any;
  private readonly done: (value: Routing | null) => void;
  private readonly paint: (text: string) => string;
  private readonly soft: (text: string) => string;
  /** False when the screen was opened straight from `/jev-eye routing`, which has no menu behind it. */
  private readonly back: boolean;
  private static readonly WINDOW = 10;

  constructor(
    theme: any,
    models: any[],
    initial: Routing,
    focus: "light" | "heavy",
    done: (value: Routing | null) => void,
    paint: (text: string) => string,
    back = true,
  ) {
    this.theme = theme;
    this.models = models;
    this.pending = { ...initial };
    this.done = done;
    this.paint = paint;
    this.soft = chosenRowPainter(theme);
    this.back = back;
    const preferred = focus === "light" ? initial.light : initial.heavy;
    const at = models.findIndex((m) => modelRef(m) === preferred);
    this.index = at >= 0 ? at : 0;
  }

  private filtered(): any[] {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return this.models;
    return this.models.filter((m) => {
      const haystack = `${m.id} ${m.provider} ${m.name ?? ""}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }

  private move(delta: number): void {
    const rows = this.filtered();
    if (rows.length === 0) return;
    this.index = (this.index + delta + rows.length) % rows.length;
  }

  private assign(slot: "light" | "heavy"): void {
    const row = this.filtered()[this.index];
    if (!row) return;
    const ref = modelRef(row);
    // Already assigned to this row: the key walks that slot's thinking level instead of clearing it.
    // Removing an assignment is `[Ctrl+r] Routing` + `[Enter]` (routing needs both targets), so no key
    // needs to unset a slot — and the pair of thinking chords this replaces cannot come back.
    if (this.pending[slot] === ref) return this.cycleThinking(slot);
    const field = slot === "light" ? "lightThinking" : "heavyThinking";
    this.pending = { ...this.pending, [slot]: ref, [field]: SLOT_DEFAULT_THINKING[slot] };
    // One sentence, once: what the key assigned and what pressing it again will cycle.
    this.notice = `${slot === "light" ? "Light" : "Heavy"} slot → ${ref} · thinking ${this.pending[field as keyof Routing]} · press again to cycle`;
  }

  /** Walks one slot's thinking level through the list its default lives in. */
  private cycleThinking(slot: "light" | "heavy"): void {
    const field = slot === "light" ? "lightThinking" : "heavyThinking";
    const levels = slot === "light" ? LIGHT_THINKING_LEVELS : HEAVY_THINKING_LEVELS;
    const current = (this.pending[field as keyof Routing] as ThinkingLevel | undefined) ?? SLOT_DEFAULT_THINKING[slot];
    const next = levels[(levels.indexOf(current) + 1) % levels.length];
    this.pending = { ...this.pending, [field]: next };
    this.notice = `${slot === "light" ? "Light" : "Heavy"} thinking → ${next}`;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    // `\x08` satisfies BOTH `Key.backspace` and `ctrl+h` in pi's parser, so the heavy chord is matched
    // (with its alias) before backspace: otherwise the filter prompt would eat the heavy assignment in
    // every terminal that reports ctrl+h as backspace. Backspace is the less destructive match here,
    // because the query is recoverable and a slot assignment is what the operator asked for.
    if (matchesKey(data, KEY_SETS.routeHeavy) || matchesKey(data, KEY_SETS.routeHeavyAlias)) return this.assign("heavy");
    if (matchesKey(data, Key.space) || data === " ") return this.assign("light");
    if (matchesKey(data, KEY_SETS.routingToggle)) {
      this.pending = { ...this.pending, enabled: !this.pending.enabled };
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.query = this.query.slice(0, -1);
      this.index = 0;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      // Without both targets there is nothing to route between, so routing does not stay on.
      const both = !!this.pending.light && !!this.pending.heavy;
      return this.done({ ...this.pending, enabled: this.pending.enabled && both });
    }
    if (this.back && matchesKey(data, Key.left)) return this.done(BACK);
    if (matchesKey(data, Key.escape)) return this.done(null);
    if (data.length === 1 && data >= " ") {
      this.query += data;
      this.index = 0;
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = this.paint;
    const inner = width - 4; // two walls, two spaces
    const rows = this.filtered();
    const lines: string[] = [
      t.fg("accent", t.bold("Jev Eye · Routing")),
      // The description carries both facts the screen needs: what routing does, and that the slot key does
      // twice the work. The table and the legend below stay pure (rows, keys, labels) — no `×2` marker
      // duplicating this sentence in the legend.
      ...wrapWords(
        `Chores to the cheap model, real work to the strongest. ${keybind(KEY_SETS.routeLight)} / ${keybind(KEY_SETS.routeHeavy)} assign a slot; press again to cycle its thinking. ${keybind(KEY_SETS.routingToggle)} toggles routing.`,
        inner
      ).map((line) => t.fg("muted", line)),
      "",
      // The query is one line, but a stray paste must never break the frame: spread it first.
      ...`${t.fg("accent", "> ")}${this.query}${this.query ? "" : t.fg("dim", "type to filter")}`.split("\n"),
      "",
    ];

    const start = Math.max(0, Math.min(this.index - Math.floor(RoutingPicker.WINDOW / 2), Math.max(0, rows.length - RoutingPicker.WINDOW)));
    const slice = rows.slice(start, start + RoutingPicker.WINDOW);
    if (slice.length === 0) lines.push(t.fg("warning", "  no model matches this filter"));

    // One model row = `model id  ·  assigned slots  ·  [provider]`: the id is padded to the widest id so
    // every divider lands in one column, exactly as the list menus do. Only the slot column carries its
    // own colours (light accent, heavy amber) and no surrounding padding, so `✓ light` reads as one unit.
    const column = Math.max(...rows.map((m) => visibleWidth(String(m.id))), 0);
    const slotCell = (ref: string) => {
      const slots = [
        this.pending.light === ref ? ["light", SLOT_TOKEN.light, this.pending.lightThinking ?? ""] : null,
        this.pending.heavy === ref ? ["heavy", SLOT_TOKEN.heavy, this.pending.heavyThinking ?? ""] : null,
      ].filter(Boolean) as [string, string, string][];
      if (slots.length === 0) return t.fg("dim", "—");
      // The thinking level rides in the slot cell: it is the one setting a second press of this key
      // changes, so hiding it elsewhere would make that press look like nothing happened.
      return slots
        .map(([label, token, thinking]) => `${t.fg(token, `✓ ${label}`)}${thinking ? t.fg("muted", ` (${thinking})`) : ""}`)
        .join(t.fg("dim", " · "));
    };
    for (const model of slice) {
      const ref = modelRef(model);
      const cursor = rows[this.index] === model;
      const pad = " ".repeat(Math.max(0, column - visibleWidth(String(model.id))));
      // Chosen row: the arrow keeps the accent, the model id takes the soft tint, the provider tag stays muted.
      const prefix = cursor ? t.fg("accent", "→ ") : "  ";
      const name = cursor ? this.soft(model.id) : t.fg("text", model.id);
      const provider = t.fg("muted", `[${model.provider}]`);
      lines.push(`${prefix}${name}${pad}  ${t.fg("dim", "·")} ${slotCell(ref)} ${t.fg("dim", "·")} ${provider}`);
    }

    const position = rows.length === 0 ? 0 : Math.min(this.index + 1, rows.length);
    lines.push(t.fg("muted", `  (${position}/${rows.length})`));
    // After a key, this row reports what just changed; before any key it stays empty, because the
    // description above already names the fold. One line, one job.
    lines.push(this.notice ? t.fg("muted", `  ${this.notice}`) : "");
    lines.push("");
    lines.push(
      `${t.fg("dim", "Routing: ")}${this.pending.enabled ? t.fg("success", "ON") : t.fg("muted", "off")}${
        this.pending.enabled && (!this.pending.light || !this.pending.heavy) ? t.fg("warning", "  (needs both targets)") : ""
      }`
    );
    lines.push(
      `${t.fg("dim", "Light model: ")}${this.pending.light ? t.fg(SLOT_TOKEN.light, modelLabelFor(this.models, this.pending.light)) : t.fg("muted", "(unset)")} ${t.fg("muted", `[thinking: ${this.pending.lightThinking ?? "low"}]`)}`
    );
    lines.push(
      `${t.fg("dim", "Heavy model: ")}${this.pending.heavy ? t.fg(SLOT_TOKEN.heavy, modelLabelFor(this.models, this.pending.heavy)) : t.fg("muted", "(unset)")} ${t.fg("muted", `[thinking: ${this.pending.heavyThinking ?? "high"}]`)}`
    );
    lines.push("");
    const count = `${this.models.length} models`;
    const prefix = `${count} · `;
    // The skill's legend order, nav first and exits last: what the screen always acts on, then the
    // screen's own keys, then `[←] Back` (only when there is a menu behind it), then cancel. Each
    // advertised key is rendered from KEY_SETS, so a legend cannot drift from what handleInput matches.
    // Labels stay bare (`[Space] Light`): the description owns the note about the second press, so the
    // legend remains a plain key list.
    const legend = [
      "[↑↓] Move",
      "[Enter] Done",
      `${keybind(KEY_SETS.routeLight)} Light`,
      `${keybind(KEY_SETS.routeHeavy)} Heavy`,
      `${keybind(KEY_SETS.routingToggle)} Routing`,
      ...(this.back ? ["[←] Back"] : []),
      "[Esc] Cancel",
    ];
    // The count rides the first legend row, so the wrapping budget is what is left after that prefix.
    const legendRows = packPairs(legend, Math.max(1, inner - visibleWidth(prefix)));
    lines.push(`${t.fg("accent", count)}${t.fg("dim", ` · ${legendRows[0] ?? ""}`)}`);
    for (const pair of legendRows.slice(1)) lines.push(t.fg("dim", pair));
    return framedRows(lines, width, paint);
  }

  invalidate(): void {}
}

/**
 * The Models screen: one list of every backend this session can call, and the two slots that pick which
 * model answers. `[Space]` makes the highlighted row the active backend, `[Ctrl+f]` its fallback.
 *
 * One list, not a provider list plus a model sub-list: the two Clef models are two rows of the same table,
 * which is what makes `/jev-eye models clef-flash` and `/jev-eye models clef` (see `matchModelRef`) the
 * same selection the screen shows, with no second screen to keep in step.
 *
 * The list stays complete when a backend has no key — the row says `not configured` instead of vanishing,
 * because this screen is where an operator discovers what exists before storing a key for it.
 */
export class ModelsPicker {
  private pending: Backends;
  private index = 0;
  /** Last thing a key did, under the table; empty before the first key, when the description says it all. */
  private notice = "";
  private readonly models: BackendModel[];
  private readonly theme: any;
  private readonly soft: (text: string) => string;
  private readonly done: (value: Backends | null) => void;
  /** False when the screen was opened straight from `/jev-eye models`, which has no menu behind it. */
  private readonly back: boolean;

  constructor(theme: any, models: BackendModel[], initial: Backends, done: (value: Backends | null) => void, back = true) {
    this.theme = theme;
    this.models = models;
    this.pending = { ...initial };
    this.done = done;
    this.soft = chosenRowPainter(theme);
    this.back = back;
    const at = models.findIndex((m) => m.ref === initial.primary);
    this.index = at >= 0 ? at : 0;
  }

  private move(delta: number): void {
    this.index = (this.index + delta + this.models.length) % this.models.length;
    this.notice = "";
  }

  /** The two slots; nothing else is assignable, so no key can invent a third role. */
  private assign(slot: "primary" | "fallback"): void {
    const row = this.models[this.index];
    if (!row) return;
    const before = this.pending;
    this.pending = assignBackend(before, slot, row.ref);
    const role = slot === "primary" ? "Active" : "Fallback";
    // Three outcomes, three sentences: the key cleared its own slot, the key moved the model off the
    // other slot, or the key just assigned. The middle one is the move `assignBackend` allows so one
    // model can never be both the active backend and its own fallback.
    const otherRole = slot === "primary" ? "fallback" : "active";
    if (before[slot] === row.ref) this.notice = `${role} cleared`;
    else if (before[slot === "primary" ? "fallback" : "primary"] === row.ref) this.notice = `${role} → ${row.label}; ${otherRole} cleared`;
    else this.notice = `${role} → ${row.label}`;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.home)) {
      this.index = 0;
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.index = this.models.length - 1;
      return;
    }
    if (matchesKey(data, KEY_SETS.modelsPrimary)) return this.assign("primary");
    if (matchesKey(data, KEY_SETS.modelsFallback)) return this.assign("fallback");
    if (matchesKey(data, Key.enter)) return this.done({ ...this.pending });
    if (this.back && matchesKey(data, Key.left)) return this.done(BACK);
    if (matchesKey(data, Key.escape)) return this.done(null);
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = borderPainterFor(t);
    const inner = width - 4; // two walls, two spaces
    const lines: string[] = [
      t.fg("accent", t.bold("Jev Eye · Models")),
      ...wrapWords(
        `The active backend answers every Jev/Clef call; the fallback takes over when it cannot. ${keybind(KEY_SETS.modelsPrimary)} sets active, ${keybind(KEY_SETS.modelsFallback)} sets fallback.`,
        inner
      ).map((line) => t.fg("muted", line)),
      "",
    ];

    // Same list template as every other screen: label padded to the widest one, so both `·` dividers and
    // the state column land in one place. The reference is the label — `clef-flash` and `clef` differ
    // only by the tier in parentheses.
    const column = Math.max(...this.models.map((m) => visibleWidth(m.label)), 0);
    for (const [i, model] of this.models.entries()) {
      const cursor = i === this.index;
      const pad = " ".repeat(Math.max(0, column - visibleWidth(model.label)));
      const slot = this.pending.primary === model.ref ? SLOT_TOKEN.light : this.pending.fallback === model.ref ? SLOT_TOKEN.heavy : "";
      const slotLabel = this.pending.primary === model.ref ? "✓ active" : "✓ fallback";
      // Slot first, key state second: a row can be assigned while its key is missing (an export or a
      // credential can appear later), and hiding the assignment behind `no key` would make the screen
      // look like the key did nothing.
      const state = `${slot ? t.fg(slot, slotLabel) : t.fg("dim", "—")}${model.configured ? "" : t.fg("warning", " · no key")}`;
      const label = cursor ? this.soft(model.label) : model.configured ? t.fg("text", model.label) : t.fg("muted", model.label);
      lines.push(
        `${cursor ? t.fg("accent", "→ ") : "  "}${label}${pad}  ${t.fg("dim", "·")} ${state} ${t.fg("dim", "·")} ${t.fg("muted", `[${model.providerShort}]`)}`
      );
    }

    lines.push(t.fg("muted", `  (${this.models.length === 0 ? 0 : this.index + 1}/${this.models.length})`));
    lines.push(this.notice ? t.fg("muted", `  ${this.notice}`) : "");
    lines.push("");
    // One line per slot, so a screen with no assignment still says what it will fall back to (the
    // credential precedence), instead of leaving the operator to guess.
    const slotLine = (name: string, ref: string, token: string) => {
      const row = this.models.find((m) => m.ref === ref);
      return `${t.fg("dim", `${name}: `)}${row ? t.fg(token, row.label) : t.fg("muted", "(auto)")}`;
    };
    lines.push(slotLine("Active", this.pending.primary, SLOT_TOKEN.light));
    lines.push(slotLine("Fallback", this.pending.fallback, SLOT_TOKEN.heavy));
    lines.push("");
    const legend = [
      "[↑↓] Move",
      "[Enter] Done",
      `${keybind(KEY_SETS.modelsPrimary)} Active`,
      `${keybind(KEY_SETS.modelsFallback)} Fallback`,
      ...(this.back ? ["[←] Back"] : []),
      "[Esc] Cancel",
    ];
    for (const pair of packPairs(legend, inner)) lines.push(t.fg("dim", pair));
    return framedRows(lines, width, paint);
  }

  invalidate(): void {}
}

/** `/jev-eye status` panel: the same framing as the routing picker and the vision-watcher screen, with
 *  both advertised keybindings live so the footer never promises a key that does nothing here. */
export class StatusPanel {
  private lines: string[];
  private readonly paint: (text: string) => string;
  private readonly theme: any;
  private readonly actions: {
    rebuild: () => string[];
    cycleMode: () => void;
    cycleGate: () => void;
  };
  private readonly done: (value?: void) => void;
  private readonly title: string;
  private readonly desc: string;
  /** Read-only screens (usage) must not advertise, or act on, the status toggles. */
  private readonly controls: boolean;
  /** Only a screen an extension opened itself can return to a previous menu; a direct subcommand cannot. */
  private readonly back: boolean;

  constructor(
    theme: any,
    lines: string[],
    actions: { rebuild: () => string[]; cycleMode: () => void; cycleGate: () => void },
    done: (value?: void) => void,
    title: string = STATUS_TITLE,
    desc: string = STATUS_DESC,
    controls = true,
    paint: (text: string) => string = borderPainterFor(theme),
    back = true
  ) {
    this.theme = theme;
    this.paint = paint;
    this.lines = lines;
    this.actions = actions;
    this.done = done;
    this.title = title;
    this.desc = desc;
    this.controls = controls;
    this.back = back;
  }

  /** A toggle changes state, so the body is rebuilt in place; the caller re-renders after input. */
  private apply(mutate: () => void): void {
    mutate();
    this.lines = this.actions.rebuild();
  }

  handleInput(data: string): void {
    // [←] is handled only where the footer promises it: a direct subcommand has no previous menu.
    if (this.back && matchesKey(data, Key.left)) {
      this.done(BACK);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    if (matchesKey(data, TOGGLE_KEY)) {
      if (this.controls) this.apply(this.actions.cycleMode);
      return;
    }
    if (matchesKey(data, GATE_KEY)) {
      if (this.controls) this.apply(this.actions.cycleGate);
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const paint = this.paint;
    const inner = width - 4; // two walls, two spaces
    // Same round frame as the routing and login pickers; the controls line stays live.
    const header = [
      // Same nesting Pi's own headers use (fg outside bold) — tmux capture-pane did not show the
      // colour, the raw render bytes do.
      t.fg("accent", t.bold(this.title)),
      t.fg("muted", this.desc),
      "",
      ...this.lines,
      "",
    ];
    // The footer wraps instead of losing its last key: `[Ctrl+Shift+u] Grant folder` fell off an
    // 80-column screen while still being registered and advertised.
    for (const pair of packPairs(panelKeys(this.controls, this.back), inner)) {
      header.push(t.fg("dim", pair));
    }
    return framedRows(header, width, paint);
  }

  invalidate(): void {}
}

class SecretPrompt {
  private readonly theme: any;
  private readonly title: string;
  private readonly hint: string;
  private readonly reveal: boolean;
  private readonly input = new SecretInput();
  isFocused = false;

  constructor(theme: any, title: string, hint: string, done: (value?: string) => void, reveal = false) {
    this.theme = theme;
    this.title = title;
    this.hint = hint;
    this.reveal = reveal;
    this.input.onSubmit = (value) => done(value);
    this.input.onEscape = () => done(undefined);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.input.onEscape?.();
      return;
    }
    this.input.handleInput(data);
  }

  /** The frame owns every row: the title, the wrapped hint, the input line, and the legend. */
  render(width: number): string[] {
    const t = this.theme;
    const inner = width - 4; // two walls, two spaces
    const title = t.fg("accent", t.bold(this.title));
    const hints = wrapWords(this.hint, inner).map((line: string) => t.fg("muted", line));
    // One rendered input line, kept whole so the caret marker stays inside it: clipping the bullet run
    // first is what keeps the marker from falling off the end of a long pasted key.
    // A secret renders bullets; an account id is not a secret, so it is shown as typed.
    const field = this.reveal
      ? `${t.fg("accent", "  ")}${t.fg("text", truncateToWidth(this.input.getValue(), Math.max(0, inner - 2), ""))}`
      : t.fg("accent", "  ") + (this.input.render(inner - 2)[0] ?? "");
    const legend = packPairs(["[Enter] Verify & save", "[Esc] Cancel"], inner).map((pair: string) => t.fg("dim", pair));
    return framedRows([title, ...hints, "", field, "", ...legend], width, borderPainterFor(t));
  }
}

/**
 * BoxedConfirm is the yes/no dialog on the same template, replacing `ctx.ui.confirm`, which Pi draws
 * with its own chrome. Enter answers with the highlighted row and Esc cancels; the default is always
 * the safe answer, because these questions guard a stored key and never confirm work already done.
 */
class BoxedConfirm {
  private readonly theme: any;
  private readonly title: string;
  private readonly message: string;
  private readonly done: (value: boolean) => void;
  /** Confirm first: the safe answer is the default, and these questions guard a stored key. */
  private readonly choices = ["Confirm", "Cancel"];
  private index = 0;

  constructor(theme: any, title: string, message: string, done: (value: boolean) => void) {
    this.theme = theme;
    this.title = title;
    this.message = message;
    this.done = done;
  }

  handleInput(data: string): void {
    // Vertical, like every other list in the package and like pi's own `ctx.ui.confirm` (which is a
    // Yes/No select list). `[←→]` was both the wrong axis and a collision: `[←]` already means Back in
    // this extension's menus, so advertising it here read as "leave the dialog".
    //
    // Direction-aware and clamped, not a blind toggle: `[↑]` used to move the selection *down* onto
    // Cancel, which is the opposite of what the key says. Two rows need no wrap — `[↑]` at the top and
    // `[↓]` at the bottom simply stay put.
    if (matchesKey(data, Key.up)) {
      this.index = Math.max(0, this.index - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = Math.min(this.choices.length - 1, this.index + 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(this.index === 0);
      return;
    }
    if (matchesKey(data, Key.escape)) this.done(false);
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = width - 4; // two walls, two spaces
    const soft = chosenRowPainter(t);
    const title = t.fg("accent", t.bold(this.title));
    const message = wrapWords(this.message, inner).map((line: string) => t.fg("muted", line));
    const choices = this.choices.map((label: string, i: number) => {
      const chosen = i === this.index;
      return `${chosen ? t.fg("accent", "→ ") : "  "}${chosen ? soft(label) : t.fg("text", label)}`;
    });
    const legend = packPairs(["[↑↓] Select", "[Enter] Choose", "[Esc] Cancel"], inner).map((pair: string) => t.fg("dim", pair));
    return framedRows([title, ...message, "", ...choices, "", ...legend], width, borderPainterFor(t));
  }
}

/** The custom dialogs only exist in TUI mode: `custom` is a documented no-op in RPC, not a missing method. */
async function customScreen<T>(ctx: any, build: (tui: any, theme: any, done: (value: T) => void) => any): Promise<T> {
  return await ctx.ui.custom<T>((tui: any, theme: any, _kb: any, done: (value: T) => void) => {
    const component = build(tui, theme, done);
    return {
      render: (width: number) => component.render(width),
      invalidate: () => component.invalidate?.(),
      handleInput: (data: string) => {
        component.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/**
 * One frame for every input dialog: the boxed component in TUI mode, the plain Pi dialog everywhere
 * else. `ctx.mode` decides, not `typeof ctx.ui.custom === "function"` — in RPC mode `custom` exists
 * and resolves undefined without drawing, so a method-exists test silently loses the whole dialog.
 */
export async function promptForText(ctx: any, title: string, hint: string, reveal = false): Promise<string | undefined> {
  if (ctx.mode !== "tui") return await ctx.ui.input(reveal ? title : `${title} (visible while typing)`, hint);
  return await customScreen<string | undefined>(ctx, (tui: any, theme: any, done: (value: string | undefined) => void) =>
    new SecretPrompt(theme, title, hint, done, reveal)
  );
}

/**
 * One frame for every yes/no dialog. `ctx.ui.confirm` is what Pi draws itself, so a boxed confirm has to
 * own its component; headless clients keep the plain dialog.
 */
export async function promptForConfirm(ctx: any, title: string, message: string): Promise<boolean> {
  if (ctx.mode !== "tui") return await ctx.ui.confirm(title, message);
  const answer = await customScreen<boolean>(ctx, (tui: any, theme: any, done: (value: boolean) => void) =>
    new BoxedConfirm(theme, title, message, done)
  );
  return answer === true;
}

/** Resolves `"back"` when the operator pressed [←] on the provider picker, so the menu reopens. */
