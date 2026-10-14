// Renders the real /jev-eye screens headlessly and asserts what a screenshot would show:
// every line lands exactly on the terminal width, the frame is coloured, and no advertised key is lost.
//
// `npm test` covers the pure frame maths in extensions/layer1.ts; this covers the components in
// extensions/index.ts, which cannot be imported without `@earendil-works/pi-tui`. Run it from a
// checkout where the peer dependencies resolve (pi itself provides them when the extension loads):
//
//   npm run render-check
//
// It needs a temporary node_modules symlink when the repo has none, e.g.
//   ln -s ../pi-arnative/node_modules node_modules
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: the extension derives its state paths from HOME at import time, so an empty home keeps the
// check off the machine's real `auth.json` (a stored key would change which prompts open).
process.env.HOME = mkdtempSync(join(tmpdir(), "jev-render-check-"));
process.env.USERPROFILE = process.env.HOME;
for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  delete process.env[name];
}

const entry = new URL("../extensions/index.ts", import.meta.url).href;
const { default: install } = await import(entry);
const { KEY_SETS } = await import(new URL("../extensions/supervisor.ts", import.meta.url).href);
const { EYE_SUBCOMMANDS } = await import(new URL("../extensions/supervisor.ts", import.meta.url).href);
const { keybind } = await import(new URL("../extensions/supervisor.ts", import.meta.url).href);

/**
 * A frame may only draw key names that survive a narrow, legacy terminal. Ligatures and modifier
 * symbols are not portable: a key the terminal cannot draw is advertised as a control it is not, and
 * one the operator cannot read is worse than no legend. `Ctrl+Shift+T` is the pair this replaces.
 */
const showsKey = (text) => /^\[[^\]]*[A-Za-z][^\]]*\]$/.test(text) && /\bshift\b/i.test(text) === false;

const commands = {};
const sent = [];
install({
  on() {},
  registerShortcut() {},
  registerCommand: (name, definition) => { commands[name] = definition; },
  sendUserMessage: (text) => sent.push(text),
  setModel: async () => true,
  getThinkingLevel: () => "low",
  setThinkingLevel() {},
});

// A real ANSI theme. A tag-based fake would break the width maths: `visibleWidth` measures ANSI
// correctly and would count the tags as columns.
const TOKEN_CODE = {
  accent: 1, accentSoft: 2, tint: 3, text: 4, muted: 5, dim: 6, success: 7, warning: 8, error: 9,
  thinkingOff: 10, thinkingLow: 11, thinkingHigh: 12, thinkingText: 13,
};
const ansiTheme = {
  fg: (color, text) => {
    if (!(color in TOKEN_CODE)) throw new Error(`Unknown theme color: ${color}`);
    return `\x1b[38;5;${TOKEN_CODE[color]}m${text}\x1b[39m`;
  },
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

/** Drives one command and captures each custom screen so it can be rendered and answered by hand. */
function harness(theme = ansiTheme) {
  const screens = [];
  const ctx = {
    mode: "tui",
    cwd: "/tmp/jev-render-check",
    thinkingLevel: "low",
    ui: {
      theme,
      notify() {},
      setStatus() {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      custom: (factory) => new Promise((resolve) => {
        screens.push({ wrapper: factory({ requestRender() {} }, theme, {}, resolve), resolve });
      }),
    },
    modelRegistry: {
      getAvailable: () => [{ provider: "fireworks", id: "deepseek-v4p1-flash", name: "Flash", contextWindow: 128000 }],
    },
    getContextUsage: () => ({ tokens: 1234 }),
  };
  return { ctx, screens };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * An RPC/headless context, where `ctx.ui.custom` exists but is a documented no-op: it resolves
 * `undefined` without drawing. The extension must branch on `ctx.mode` and never reach for it — gating on
 * `typeof custom === "function"` passes in RPC and then silently loses the screen, which is the bug this
 * harness makes impossible to reintroduce: calling `custom` here is a failure, not a drawn screen.
 */
function rpcHarness() {
  const notices = [];
  let customCalls = 0;
  const ctx = {
    mode: "rpc",
    cwd: "/tmp/jev-render-check",
    thinkingLevel: "low",
    ui: {
      theme: ansiTheme,
      notify: (message) => notices.push(String(message)),
      setStatus() {},
      select: async () => undefined,
      input: async () => undefined,
      confirm: async () => false,
      custom: async () => {
        customCalls++;
        return undefined;
      },
    },
    modelRegistry: { getAvailable: () => [] },
    getContextUsage: () => ({ tokens: 1234 }),
  };
  return { ctx, notices, customCalls: () => customCalls };
}

/**
 * Every `·` in a list of `Label … · … note` rows must sit in the same column. A row whose label was not
 * padded puts its divider somewhere else, which is exactly what the arnative list template forbids.
 * Returns the divider columns, so a caller can assert they are all equal.
 */
function dividerColumns(text, rows) {
  return rows.map((needle) => {
    const line = text.split("\n").find((l) => l.includes(needle));
    assert.equal(!!line, true, `no row rendered for ${needle}`);
    return line.indexOf("·");
  });
}
const strip = (line) => line.replace(/\x1b\[[0-9;:?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b_pi:c\x07/g, "");

/** Every line of a framed screen must be exactly `width` columns, walls included. */
function frameCheck(label, lines, width) {
  assert.equal(strip(lines[0]).startsWith("╭"), true, `${label}: the screen opens with a top edge`);
  assert.equal(strip(lines.at(-1)).startsWith("╰"), true, `${label}: and closes with a bottom edge`);
  for (const line of lines) {
    const columns = strip(line).length;
    assert.equal(columns, width, `${label}: a line is ${columns} columns, expected ${width} :: ${strip(line)}`);
  }
  return strip(lines.join("\n"));
}

/** Open the command, walk `picks` through the screens it raises, and return the screen after them. */
async function open(label, argument, picks, width) {
  const { ctx, screens } = harness();
  const run = commands["jev-eye"].handler(argument, ctx);
  await tick();
  for (const [i, value] of picks.entries()) {
    assert.equal(!!screens[i], true, `${label}: screen ${i} never opened`);
    screens[i].resolve(value);
    await tick();
  }
  const last = screens[picks.length];
  assert.equal(!!last, true, `${label}: no screen to render`);
  const text = frameCheck(`${label}@${width}`, last.wrapper.render(width), width);
  last.resolve(picks.length === 0 ? null : undefined);
  await run;
  return text;
}

// The root menu at the widths an operator actually has: the legend must not fall off either one.
for (const width of [40, 80, 120]) {
  const text = await open(`menu@${width}`, "", [], width);
  assert.equal(text.includes("Jev Eye · Menu"), true, "the root menu names itself");
  assert.equal(text.includes("[Enter] Choose"), true, "and advertises how to pick");
  assert.equal(text.includes("[←] Back"), false, "the root has nothing behind it, so it promises no back key");
}

// Every advertised subcommand must be reachable, and nothing may be advertised that the menu does not
// own. `login`/`logout` and `on`/`review`/`off`/`toggle` lived here with no row behind them: the
// autocomplete promised four names for the Accounts screen and four more for a keybinding.
{
  const values = EYE_SUBCOMMANDS.map((s) => s.value);
  const menuRows = ["accounts", "models", "status", "usage", "routing"];
  for (const row of menuRows) {
    assert.equal(values.includes(row), true, `the menu row ${row} has a matching subcommand`);
  }
  for (const gone of ["login", "logout", "on", "review", "off", "toggle"]) {
    assert.equal(values.includes(gone), false, `${gone} is not advertised: it had no menu row`);
  }
  // The menu rows are the first four entries, so the list reads in the same order as the menu.
  assert.deepEqual(values.slice(0, 5), menuRows, `subcommands open in the menu\'s order, got ${values.slice(0, 5).join(",")}`);

  // Every key the two global shortcuts announce must survive a narrow, legacy terminal: the frame is
  // drawn with plain ASCII letters, never a ligature or a modifier symbol.
  for (const key of ["toggle", "gate", "routingToggle", "accountsRemove", "routeLight", "routeHeavy"]) {
    assert.equal(showsKey(keybind(KEY_SETS[key])), true, `${KEY_SETS[key]} is a portable keycap: ${keybind(KEY_SETS[key])}`);
  }
  // A shifted chord is not portable: Ghostty owns ctrl+shift+e/new_split and ctrl+shift+t/new_tab, and
  // `matchesKey("\x14", "ctrl+shift+t")` is false, so the key would never fire on a legacy terminal.
  for (const [name, chord] of Object.entries(KEY_SETS)) {
    assert.equal(/shift/.test(chord), false, `${name} (${chord}) must not be a shifted chord`);
  }

  // Behavioural proof, not just the list: every advertised value must dispatch to a real handler.
  for (const value of values) {
    const { ctx, notices, customCalls } = rpcHarness();
    await commands["jev-eye"].handler(value, ctx).catch(() => {});
    const unknown = notices.find((n) => n.includes("Unknown argument"));
    assert.equal(unknown, undefined, `${value} dispatches instead of falling through: ${unknown}`);
    assert.equal(customCalls(), 0, `${value} keeps to ctx.mode and never reaches ctx.ui.custom in RPC`);
  }

  // The renamed paths still land somewhere useful, but say so instead of pretending they never existed.
  for (const renamed of ["login", "logout"]) {
    const { ctx, notices } = rpcHarness();
    await commands["jev-eye"].handler(renamed, ctx).catch(() => {});
    assert.equal(notices.some((n) => n.includes("/jev-eye accounts")), true, `${renamed} points at the Accounts screen`);
    assert.equal(notices.some((n) => n.includes("Unknown argument")), false, `${renamed} is not reported as unknown`);
  }
  for (const mode of ["on", "review", "off", "toggle"]) {
    const { ctx, notices } = rpcHarness();
    await commands["jev-eye"].handler(mode, ctx).catch(() => {});
    assert.equal(notices.some((n) => n.includes(KEY_SETS.toggle)), true, `${mode} names the keybinding that owns the mode`);
    assert.equal(notices.some((n) => n.includes("Unknown argument")), false, `${mode} is not reported as unknown`);
  }
}

// `[←] Back` is per-screen: the menu path has a previous menu, the direct subcommand does not.
// Both branches are exercised, because advertising a key that does nothing was the original bug.
assert.equal((await open("status from menu", "", [2], 80)).includes("[←] Back"), true, "status opened from the menu can go back");
assert.equal((await open("status direct", "status", [], 80)).includes("[←] Back"), false, "status opened by subcommand cannot, and must not pretend to");
assert.equal((await open("usage direct", "usage", [], 80)).includes("[←] Back"), false, "usage opened by subcommand advertises no back key");
assert.equal((await open("routing direct", "routing", [], 80)).includes("[←] Back"), false, "routing opened by subcommand advertises no back key");

// Every sub-screen opens inside the frame, and the read-only one advertises no toggle it ignores.
const status = await open("status", "", [2], 80);
assert.equal(status.includes("Grant folder"), true, "status keeps its last footer key at 80 columns");
// One legend order on every framed screen: nav/confirm, the screen's keys, then the exits (Back before
// Esc, because Back stays inside the extension and Esc leaves it).
{
  const at = (token) => status.indexOf(token);
  const order = ["[Enter] Done", "[Ctrl+Alt+e] Supervisor", "[Ctrl+Alt+u] Grant folder", "[←] Back", "[Esc] Cancel"].map(at);
  assert.equal(order.every((i) => i >= 0), true, `every status footer key is present, got ${order.join(",")}`);
  assert.deepEqual([...order].sort((x, y) => x - y), order, `the status footer runs confirm → keys → exits, got ${order.join(",")}`);
}
const usage = await open("usage", "", [3], 80);
assert.equal(usage.includes("[Enter] Done"), true, "usage advertises its real exits");
assert.equal(usage.includes("Supervisor"), false, "usage must not advertise a toggle it ignores");
{
  const usageOrder = ["[Enter] Done", "[Esc] Cancel"].map((token) => usage.indexOf(token));
  assert.deepEqual([...usageOrder].sort((x, y) => x - y), usageOrder, "the read-only footer keeps confirm before the exit");
}
await open("routing", "", [4], 80);

// The Models screen: one list of every backend, two slot keys, and the tier in parentheses so the footer
// can dim exactly the modifier. The rows must read `label  · ✓ active · [provider]`, with the label
// padded to the widest one — the two Clef models differ only by the tier, so the dividers are the only
// thing that can drift when a longer `clef-flash` row appears.
{
  const models = await open("models", "models", [], 100);
  assert.equal(models.includes("[Space] Active"), true, "the active key is advertised from KEY_SETS");
  assert.equal(models.includes("[Ctrl+f] Fallback"), true, "the fallback key is advertised from KEY_SETS");
  assert.equal(models.includes("[←] Back"), false, "a subcommand screen has no menu behind it, so it promises no back key");
  for (const label of ["jev-latest", "typesafe/jev-1.13", "clef", "clef (flash)"]) {
    assert.equal(models.includes(label), true, `the catalog lists ${label}`);
  }
  // The parenthesised tier is what the footer dims, so it must be on the row verbatim.
  assert.equal(/clef \(flash\)/.test(models), true, "the Clef flash model carries its tier in parentheses");
  const dividerAt = (needle) => {
    const line = models.split("\n").find((l) => l.includes(needle) && l.includes("·"));
    return line.indexOf("·");
  };
  // `typesafe/jev-1.13` is the widest label, so every divider sits in its column.
  assert.equal(new Set(["jev-latest", "typesafe/jev-1.13", "clef (flash)"].map(dividerAt)).size, 1, "model rows put their divider in one column");
}

// The Models description must fit its own frame. It names the two slot keys, so a clipped one is a
// screen whose footer promises a key the description never explained — the bug the routing header had.
for (const width of [40, 80, 120]) {
  const screen = await open(`models header@${width}`, "models", [], width);
  assert.equal(screen.includes("…"), false, `the Models description is not clipped at ${width} columns`);
  assert.equal(screen.includes("sets fallback."), true, `the Models description reaches its period at ${width} columns`);
  assert.equal(screen.includes("[Ctrl+f] sets fallback."), true, `the fallback key stays bracketed at ${width} columns`);
}

// The slot keys, driven on the real component: `[Space]` assigns active, `[Ctrl+f]` the fallback, a
// second press clears, and the same ref can never occupy both slots. Then `[Enter]` persists and the
// store is read back, so the file the gate reads is the one the screen wrote.
{
  const { ctx, screens } = harness();
  const run = commands["jev-eye"].handler("models", ctx);
  await tick();
  const picker = screens[0].wrapper;
  const rowOf = (needle) => strip(picker.render(100).join("\n")).split("\n").find((l) => l.includes(needle));
  const notice = () => {
    const rows = strip(picker.render(100).join("\n")).split("\n").map((l) => l.replace(/^│|│\s*$/g, "").trim());
    const at = rows.findIndex((l) => /^\(\d+\/\d+\)$/.test(l));
    return at >= 0 ? rows[at + 1] : "<no counter row>";
  };
  assert.equal(notice(), "", "before any key the notice row stays empty");

  picker.handleInput(" ");
  assert.equal(rowOf("jev-latest").includes("✓ active"), true, "space makes the highlighted row active");
  assert.equal(notice().includes("Active → "), true, `the notice names what the key did: ${notice()}`);
  picker.handleInput(" ");
  assert.equal(rowOf("jev-latest").includes("✓ active"), false, "a second press clears the slot, so the key is a toggle");
  assert.equal(notice(), "Active cleared");

  picker.handleInput(" ");
  picker.handleInput("\x1b[B"); // down to OpenRouter
  picker.handleInput("\x06"); // ctrl+f: fallback
  assert.equal(rowOf("typesafe/jev-1.13").includes("✓ fallback"), true, "ctrl+f assigns the fallback");
  assert.equal(rowOf("jev-latest").includes("✓ active"), true, "and leaves the active slot alone");
  picker.handleInput("\x1b[A"); // back up to TypeSafe
  picker.handleInput("\x06"); // ctrl+f on the active row: the ref moves, it cannot occupy both
  assert.equal(rowOf("jev-latest").includes("✓ fallback"), true, "the fallback can be moved onto the other slot");
  assert.equal(rowOf("jev-latest").includes("✓ active"), false, "and the old slot is emptied, not duplicated");
  assert.equal(notice().includes("active cleared"), true, `the notice explains the move: ${notice()}`);

  screens[0].resolve(null);
  await run;
}

// The Models screen persists what it showed: `[Enter]` writes `backends.json`, and the gate reads that
// file through `readBackends`. Proved here by writing a real selection and reading it back, so a screen
// that forgot to save cannot pass on the render alone.
{
  const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { readBackends, currentCatalog } = await import(new URL("../extensions/core.ts", import.meta.url).href);
  const eyeDir = join(process.env.HOME, ".pi", "agent", "pi-jev-eye");
  mkdirSync(eyeDir, { recursive: true });
  const valid = currentCatalog()[0].ref;

  // A ref the catalog does not list reads as unset, so a hand-edited file cannot aim the gate at a route
  // that does not exist.
  writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: "typesafe:jev-removed", fallback: valid }), { mode: 0o600 });
  assert.deepEqual(readBackends(), { primary: "", fallback: valid }, "a stale ref is dropped, the valid one survives");

  const { ctx, screens } = harness();
  const run = commands["jev-eye"].handler("models", ctx);
  await tick();
  screens[0].wrapper.handleInput(" "); // active on the first catalog row
  screens[0].resolve({ primary: valid, fallback: "" });
  await run;

  assert.deepEqual(readBackends(), { primary: valid, fallback: "" }, "the screen's saved selection is what the gate reads");

  // The root menu row answers "which backend is judging my writes?" before the screen is opened, so the
  // menu is rendered against the file the screen just wrote.
  const menuWithPick = await open("menu with a picked backend", "", [], 100);
  assert.equal(
    /Models\s+\u00b7\s+active: /.test(menuWithPick),
    true,
    `the Models row names the active backend: ${menuWithPick.split("\n").find((l) => l.includes("Models"))}`
  );
  rmSync(join(eyeDir, "backends.json"), { force: true });
  assert.deepEqual(readBackends(), { primary: "", fallback: "" }, "no file means both slots are auto");
}

// The arnative list rule: the label is padded to the widest one, so every `·` divider lines up.
{
  const menu = await open("divider column", "", [], 100);
  assert.equal(menu.includes("Logout"), false, "the root menu has no separate Logout row: Accounts owns add and remove");
  const columns = dividerColumns(menu, ["Accounts", "Models", "Status", "Usage", "Routing"]);
  assert.equal(new Set(columns).size, 1, `menu dividers sit in one column, got ${columns.join(",")}`);

  const { ctx, screens } = harness();
  const run = commands["jev-eye"].handler("", ctx);
  await tick();
  screens[0].resolve(0); // Login: the provider picker, whose labels differ in length
  await tick();
  const login = strip(screens[1].wrapper.render(100).join("\n"));
  const loginColumns = dividerColumns(login, ["TypeSafe account", "OpenRouter account", "Cloudflare Workers AI"]);
  assert.equal(new Set(loginColumns).size, 1, `login rows put their divider in one column, got ${loginColumns.join(",")}`);
  screens[1].resolve(null);
  await run;

  // Negative proof: the check must fail on an unpadded row, or it would pass on the bug it guards.
  const unpadded = "A  ·  one\nLonger  ·  two";
  assert.notEqual(new Set(dividerColumns(unpadded, ["A ", "Longer"])).size, 1, "an unpadded row set does not produce one column, so the check has teeth");
}

// Every glyph a screen draws must be covered by a plain monospace font, not just the one on this
// machine. `×2` was added here and removed for the same reason: the note it carried belongs in the
// description, and a special character buys nothing a word cannot. Listicles and box-drawing are the
// intended set; anything decorative is not.
{
  const { KEY_SETS: keys } = await import(new URL("../extensions/supervisor.ts", import.meta.url).href);
  // `showsKey` already asserts the keycap side (ASCII letters only). This covers the rest of the chrome.
  const PORTABLE = new Set([
    "\u00b7", // ·  MIDDLE DOT — the one list divider, present in every monospace font checked
    "\u2014", // —  em dash
    "\u2013", // –  en dash
    "\u2022", // •  bullet
    "\u2026", // …  ellipsis, drawn only by the frame when content is cut
    "\u2190", "\u2191", "\u2192", "\u2193", // ← ↑ → ↓
    "\u2265", // ≥
    "\u25cb", "\u25cf", "\u2713", // ○ ● ✓ (status marker, stored marker)
    "\u2588", "\u2591", // █ ░ (usage bar)
  ]);
  const rpc = rpcHarness();
  for (const [label, arg] of [["status", "status"], ["usage", "usage"], ["accounts", "accounts"], ["menu", ""]]) {
    await commands["jev-eye"].handler(arg, rpc.ctx).catch(() => {});
    for (const notice of rpc.notices) {
      for (const ch of strip(notice)) {
        if (ch.charCodeAt(0) <= 0x7e || /[\u2500-\u257f]/.test(ch)) continue; // ASCII and the frame's box-drawing
        assert.equal(PORTABLE.has(ch), true, `${label} draws U+${ch.charCodeAt(0).toString(16).toUpperCase()} ${JSON.stringify(ch)}, which is not in the portable set`);
      }
    }
    rpc.notices.length = 0;
  }
}

// The routing header must fit the frame it lives in. The old sentence ("Route light chores … ${keycap}
// turns routing on/off.") was clipped to "turns routin…" at 80 columns, so the screen opened by cutting
// its own explanation in half. Asserted at the widths an operator uses, not just the wide one.
for (const width of [80, 120]) {
  const header = await open(`routing header@${width}`, "routing", [], width);
  // It wraps onto more than one row now, so the description is read as the block above the query line.
  const rows = header.split("\n");
  const at = rows.findIndex((l) => l.includes("> type to filter"));
  const block = rows
    .slice(1, at)
    .map((l) => l.replace(/^│|│\s*$/g, "").trim())
    .filter(Boolean)
    .join(" ");
  assert.equal(block.includes("Chores to the"), true, `the routing screen explains itself at ${width} columns: ${block}`);
  assert.equal(block.includes("…"), false, `the description is not clipped at ${width} columns: ${block}`);
  assert.equal(block.includes("press again to cycle its thinking"), true, `the description carries the folded thinking step: ${block}`);
  assert.equal(block.split(/\s+/).length <= 30, true, `the description stays two rows at 80 columns, not a paragraph: ${block}`);
  // Every keycap in the description is bracketed (skill: brackets around every key), including the two
  // slot keys, and the trailing period proves the sentence reached its end instead of being cut.
  for (const key of ["[Space]", "[Ctrl+h]", "[Ctrl+r]"]) {
    assert.equal(block.includes(key), true, `the description names ${key} in brackets: ${block}`);
  }
  assert.equal(block.trimEnd().endsWith("toggles routing."), true, `the description ends with its period, not a cut: ${block}`);
}

// The routing legend must be built from KEY_SETS, not from literals written beside the handler:
// a key spelled in two places drifts in one of them, and the footer then lies about what works.
{
  const routing = await open("routing legend", "routing", [], 120);
  for (const key of ["routingToggle", "routeLight", "routeHeavy"]) {
    assert.equal(routing.includes(keybind(KEY_SETS[key])), true, `the routing footer advertises ${keybind(KEY_SETS[key])} from KEY_SETS`);
    assert.equal(showsKey(keybind(KEY_SETS[key])), true, `${KEY_SETS[key]} has a key name a frame can draw in every terminal`);
  }
  // The folded thinking step has no key of its own — it is the second press of Light/Heavy. The legend
  // must not advertise a chord for it, because `ctrl+t`/`ctrl+shift+t` were exactly the unportable pair
  // (Ghostty's `new_tab`, and no event at all without the kitty protocol).
  for (const gone of ["lightThinking", "heavyThinking"]) {
    assert.equal(gone in KEY_SETS, false, `${gone} is gone: thinking cycles from the slot key`);
  }
  assert.equal(/(Light Think|Heavy Think)/.test(routing), false, "no legend row advertises a separate thinking chord");
  assert.equal(routing.includes("[Space] Light"), true, "the light key is advertised from KEY_SETS");
  assert.equal(routing.includes("[Ctrl+h] Heavy"), true, "the heavy key is advertised from KEY_SETS");
  // The legend stays a plain key list: the note about the folded thinking step lives in the description,
  // so a marker like `(×2 thinking)` on two labels (or a pair of thinking chords) must not come back.
  assert.equal(/×2|Light Think|Heavy Think|\(×/.test(routing), false, "the legend carries no duplicate note about the second press");
  // The ordering rule: navigation, then confirmation, then the screen's own keys, then Back, then Cancel.
  const order = ["[↑↓] Move", "[Enter] Done", "[Space] Light", "[Ctrl+h] Heavy", "[Ctrl+r] Routing", "[Esc] Cancel"]
    .map((token) => routing.indexOf(token));
  assert.equal(order.every((at) => at >= 0), true, `every legend token is present, got ${order.join(",")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `the legend runs nav → confirm → keys → exits, got ${order.join(",")}`);
}

// The thinking step folds into the slot key: pressing the same key twice walks the level, a different
// row resets it to that slot's own default, and the level is visible in the cell. Without this the
// second press would look like a no-op, which is what the removed `[Ctrl+t]`/`[Ctrl+Shift+t]` pair hid.
{
  const { LIGHT_THINKING_LEVELS, HEAVY_THINKING_LEVELS, SLOT_DEFAULT_THINKING } = await import(new URL("../extensions/pmr.ts", import.meta.url).href);
  const { ctx, screens } = harness();
  ctx.modelRegistry.getAvailable = () => [
    { provider: "fireworks", id: "deepseek-v4p1-flash" },
    { provider: "fireworks", id: "solo-model" },
  ];
  const run = commands["jev-eye"].handler("routing", ctx).catch(() => {});
  await tick();
  // The needle must not be a substring of the first id, or `find` returns that row instead.
  const row = (needle) => strip(screens[0].wrapper.render(120).join("\n")).split("\n").find((l) => l.includes(needle));
  const press = (data) => screens[0].wrapper.handleInput(data);

  // The notice row sits directly under the `(n/m)` counter, so it is read by position, not by keyword —
  // a keyword match also catches the `Light model: … [thinking: …]` summary further down.
  const notice = () => {
    const rows = strip(screens[0].wrapper.render(120).join("\n")).split("\n").map((l) => l.replace(/^│|│\s*$/g, "").trim());
    const at = rows.findIndex((l) => /^\(\d+\/\d+\)$/.test(l));
    return at >= 0 ? rows[at + 1] : "<no counter row>";
  };
  assert.equal(notice(), "", "before any key the notice row stays empty; the legend already names the fold");

  press(" "); // light on the highlighted row
  assert.equal(row("deepseek-v4p1-flash").includes(`✓ light (${SLOT_DEFAULT_THINKING.light})`), true, "the light slot starts at the shared default");
  assert.equal(notice().includes("press again to cycle"), true, `assigning says what a second press does: ${notice()}`);
  press(" ");
  const afterDefault = LIGHT_THINKING_LEVELS[(LIGHT_THINKING_LEVELS.indexOf(SLOT_DEFAULT_THINKING.light) + 1) % LIGHT_THINKING_LEVELS.length];
  assert.equal(row("deepseek-v4p1-flash").includes(`✓ light (${afterDefault})`), true, "a second press cycles the level after the default, it does not clear the slot");
  assert.equal(/Light thinking → \w+/.test(notice()), true, `the notice reports the level the key just set: ${notice()}`);
  const lightCycles = [];
  for (let i = 0; i < LIGHT_THINKING_LEVELS.length; i++) {
    lightCycles.push(LIGHT_THINKING_LEVELS.find((level) => row("deepseek-v4p1-flash").includes(`✓ light (${level})`)));
    press(" ");
  }
  assert.equal(lightCycles.includes(undefined), false, "every light level is reachable from the same key");
  assert.equal(lightCycles[0] === lightCycles[lightCycles.length - 1], false, "the light list wraps without repeating its start early");

  // A different row resets the level to the slot's default instead of carrying the previous choice.
  press("\x1b[B");
  press(" ");
  assert.equal(row("solo-model").includes(`✓ light (${SLOT_DEFAULT_THINKING.light})`), true, "moving to another row resets the level to the shared default");

  // Heavy is its own list: it cannot be dropped to `off`, which is the light slot's job.
  press("\x08");
  assert.equal(row("solo-model").includes(`✓ heavy (${SLOT_DEFAULT_THINKING.heavy})`), true, "the heavy slot starts at `high`, never `off`");
  assert.equal(HEAVY_THINKING_LEVELS.includes("off"), false, "the heavy list cannot reach `off`");
  assert.equal(LIGHT_THINKING_LEVELS.includes("max"), false, "the light list cannot reach `max`");
  const heavyCycles = [];
  for (let i = 0; i < HEAVY_THINKING_LEVELS.length; i++) {
    heavyCycles.push(HEAVY_THINKING_LEVELS.find((level) => row("solo-model").includes(`✓ heavy (${level})`)));
    press("\x08");
  }
  assert.equal(heavyCycles.includes(undefined), false, "every heavy level is reachable from the same key");

  // `ctrl+h` arrives as `\x08`, which is also backspace: the heavy match must win, or the assignment
  // would be eaten by the filter prompt in every terminal that reports them the same way.
  assert.equal(screens[0].wrapper.render(120).join("\n").includes("✓ heavy"), true, "ctrl+h/backspace never loses the heavy assignment");
  screens[0].resolve(null);
  await run;
}

// A routing row reads `model  · ✓ light · [provider]`: the slot column is tight (one space, not two, or
// `✓ light` floats away from its divider) and the two slots differ in colour, so the assigned slot is
// readable at a glance. Both are asserted on the real render, colours included.
{
  const { SLOT_TOKEN } = await import(new URL("../extensions/ui.ts", import.meta.url).href);
  assert.notEqual(SLOT_TOKEN.light, SLOT_TOKEN.heavy, "the two routing slots never share a colour token");
  for (const token of [SLOT_TOKEN.light, SLOT_TOKEN.heavy]) {
    // The ansi harness throws on an unknown token, so this also proves the theme defines both.
    assert.equal(!!ansiTheme.fg(token, "x"), true, `${token} resolves on a real theme`);
  }

  const { ctx, screens } = harness();
  // Same width as a `gemini-3.5-flash-lite` id, so the longest row is the one under test. Set before the
  // screen opens: the picker captures the list it was built with.
  ctx.modelRegistry.getAvailable = () => [
    { provider: "antigravity", id: "gemini-3.5-flash-lite" },
    { provider: "antigravity", id: "gemini-3.8-flash" },
  ];
  const run = commands["jev-eye"].handler("routing", ctx).catch(() => {});
  await tick();
  screens[0].wrapper.handleInput(" "); // light on the highlighted row
  screens[0].wrapper.handleInput("\x1b[B");
  screens[0].wrapper.handleInput("\x08"); // ctrl+h: heavy on the second row
  const raw = screens[0].wrapper.render(120).join("\n");
  const lightOnly = raw.split("\n").find((l) => l.includes("gemini-3.5-flash-lite"));
  const heavyOnly = raw.split("\n").find((l) => l.includes("gemini-3.8-flash"));
  const paint = (token, text) => `\x1b[38;5;${TOKEN_CODE[token]}m${text}\x1b[39m`;
  assert.equal(lightOnly.includes(paint(SLOT_TOKEN.light, "✓ light")), true, "the light slot takes SLOT_TOKEN.light");
  assert.equal(lightOnly.includes(paint(SLOT_TOKEN.heavy, "✓ light")), false, "light is never painted as heavy");
  assert.equal(heavyOnly.includes(paint(SLOT_TOKEN.heavy, "✓ heavy")), true, "the heavy slot takes SLOT_TOKEN.heavy (amber)");
  assert.equal(heavyOnly.includes(paint(SLOT_TOKEN.light, "✓ heavy")), false, "heavy is never painted as light");

  // Padding proof: the slot cell keeps exactly one space to each divider, so the column does not drift
  // when a row gains an assignment. The thinking level rides inside the cell (`✓ heavy (high)`).
  const stripped = strip(raw).split("\n").find((l) => l.includes("✓ heavy"));
  assert.equal(/ · ✓ heavy \(\w+\) · \[antigravity\]/.test(stripped), true, `the slot cell is tight against both dividers: ${stripped}`);
  screens[0].resolve(null);
  await run;
}

// The key prompt masks a secret; the Cloudflare account id is not a secret, so it is shown.
{
  const { ctx, screens } = harness();
  const run = commands["jev-eye"].handler("login", ctx);
  await tick();
  screens[0].wrapper.handleInput("\r"); // the first provider, TypeSafe: a plain secret
  await tick();
  const prompt = screens[1];
  assert.equal(!!prompt, true, "choosing a provider asks for its key");
  for (const width of [40, 72]) frameCheck(`key@${width}`, prompt.wrapper.render(width), width);
  prompt.wrapper.handleInput("s".repeat(64));
  const masked = strip(prompt.wrapper.render(72).join("\n"));
  assert.equal(masked.includes("••"), true, "a key is masked while it is typed");
  assert.equal(masked.includes("s".repeat(8)), false, "and never echoed");
  prompt.resolve(undefined);
  await run;
}

// An account id is not a secret, so the same dialog reveals it instead of masking it.
{
  const { ctx, screens } = harness();
  const run = commands["jev-eye"].handler("login", ctx);
  await tick();
  screens[0].wrapper.handleInput("\x1b[B");
  screens[0].wrapper.handleInput("\x1b[B");
  screens[0].wrapper.handleInput("\r"); // Cloudflare: needs an account id before the token
  await tick();
  const prompt = screens[1];
  assert.equal(strip(prompt.wrapper.render(72).join("\n")).includes("Cloudflare account ID"), true, "Cloudflare asks for the account id first");
  prompt.wrapper.handleInput("a1b2c3d4");
  const revealed = strip(prompt.wrapper.render(72).join("\n"));
  assert.equal(revealed.includes("a1b2c3d4"), true, "the account id is shown as typed");
  assert.equal(revealed.includes("••"), false, "and is not masked");
  prompt.resolve(undefined);
  await run;
}

// The frame colour follows the theme: the arnative soft token, else the session's thinking slot.
{
  const { ctx, screens } = harness({ ...ansiTheme, fg: (color, text) => `<${color}>${text}</${color}>` });
  const run = commands["jev-eye"].handler("", ctx);
  await tick();
  assert.equal(screens[0].wrapper.render(80)[0].includes("<accentSoft>╭"), true, "an arnative theme gets the soft border");
  screens[0].resolve(null);
  await run;

  const builtin = harness({ ...ansiTheme, fg: (color, text) => {
    if (color === "accentSoft") throw new Error("Unknown theme color: accentSoft");
    return `<${color}>${text}</${color}>`;
  } });
  const runBuiltin = commands["jev-eye"].handler("", builtin.ctx);
  await tick();
  assert.equal(builtin.screens[0].wrapper.render(80)[0].includes("<thinkingLow>╭"), true, "a built-in theme follows the thinking level, not an uncoloured frame");
  builtin.screens[0].resolve(null);
  await runBuiltin;
}


// The flat trigger: `/eye <task>` re-sends the operator text so the one detection point in
// `before_agent_start` sees the marker. Asserted on the real handler, not on the regex alone, because
// the command and the inline form must agree — a handler that stripped the marker would leave every
// `/eye` turn unreviewed while the regex test stayed green.
{
  assert.equal(typeof commands["eye"], "object", "/eye is registered next to /jev-eye");

  const eyeHarness = () => {
    const notices = [];
    return {
      notices,
      ctx: {
        mode: "rpc",
        cwd: "/tmp/jev-render-check",
        ui: { theme: ansiTheme, notify: (message) => notices.push(String(message)), setStatus() {} },
      },
    };
  };

  sent.length = 0;
  const task = "perbaiki parser di src/eye.ts";
  const ok = eyeHarness();
  await commands["eye"].handler(task, ok.ctx);
  assert.equal(sent.length, 1, "a task is re-sent exactly once");
  assert.equal(sent[0], `/eye ${task}`, "the marker is kept, so the one detection point still fires");
  assert.equal(ok.notices.some((n) => n.includes("Reviewed turn")), true, "the operator is told the turn is reviewed");

  // No task: the command must ask for one instead of sending an empty turn.
  sent.length = 0;
  const empty = eyeHarness();
  await commands["eye"].handler("", empty.ctx);
  assert.equal(sent.length, 0, "an empty /eye sends no turn");
  assert.equal(empty.notices.some((n) => n.includes("needs a task")), true, "and says how to fix it");

  sent.length = 0;
  await commands["eye"].handler("   ", eyeHarness().ctx);
  assert.equal(sent.length, 0, "whitespace counts as no task");
}

console.log("render checks OK");

// RPC and headless sessions must print text and never touch `custom`: in RPC it exists and resolves
// `undefined` without drawing, so reaching it loses the screen silently instead of failing.
{
  for (const argument of ["status", "usage"]) {
    const { ctx, notices, customCalls } = rpcHarness();
    await commands["jev-eye"].handler(argument, ctx);
    assert.equal(customCalls(), 0, `${argument} never calls ctx.ui.custom over RPC`);
    assert.equal(notices.length, 1, `${argument} reports itself in one notice over RPC`);
    assert.equal(notices[0].includes("╭"), false, `${argument} stays unboxed over RPC`);
    assert.equal(notices[0].includes("Jev Eye ·"), true, `${argument} still names itself over RPC`);
  }
}

// A Cloudflare token stored without an account id is unusable, and the status row that says so reads the
// v2 store (`{ version, providers }`). It once read the v1 shape and the row was dead code — a green
// render check on the empty case would never have showed it, so the credential is written here for real.
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const authPath = join(process.env.HOME, ".pi", "agent", "pi-jev-eye");
  mkdirSync(authPath, { recursive: true });
  writeFileSync(
    join(authPath, "auth.json"),
    JSON.stringify({ version: 2, providers: { cloudflare: { apiKey: "x".repeat(40), model: "clef-flash" } } }),
    { mode: 0o600 }
  );
  const { ctx, screens } = harness();
  const run = commands["jev-eye"].handler("status", ctx);
  await tick();
  const text = strip(screens[0].wrapper.render(120).join("\n"));
  assert.equal(text.includes("without an account id"), true, "status warns about a Clef token that has no account id");
  screens[0].resolve(undefined);
  await run;

  // And the warning stays away once the credential is complete, so the row is not unconditional noise.
  writeFileSync(
    join(authPath, "auth.json"),
    JSON.stringify({ version: 2, providers: { cloudflare: { apiKey: "x".repeat(40), model: "clef-flash", accountId: "a".repeat(32) } } }),
    { mode: 0o600 }
  );
  const ok = harness();
  const runOk = commands["jev-eye"].handler("status", ok.ctx);
  await tick();
  const okText = strip(ok.screens[0].wrapper.render(120).join("\n"));
  assert.equal(okText.includes("without an account id"), false, "a complete Clef credential raises no warning");
  ok.screens[0].resolve(undefined);
  await runOk;
}

// The status cell this extension publishes to the status bar is `Eye: ● ON (Backend)` — the format the
// operator asked for — and the backend is the ACTIVE one, read from `backends.json`, never a literal
// `TypeSafe`. Both shapes are driven here: the value `syncEyeStatus` writes, and the pi-arnative footer's
// parse of it (the suffix must be the only dim run, or `Eye: ● ON` would be buried).
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { syncEyeStatus } = await import(new URL("../extensions/supervisor.ts", import.meta.url).href);
  const eyeDir = join(process.env.HOME, ".pi", "agent", "pi-jev-eye");
  mkdirSync(eyeDir, { recursive: true });
  // Both credentials are stored: the point is that the cell follows the PICK, not that one key exists.
  writeFileSync(
    join(eyeDir, "auth.json"),
    JSON.stringify({
      version: 2,
      providers: {
        cloudflare: { apiKey: "x".repeat(40), model: "clef-flash", accountId: "a".repeat(32) },
        typesafe: { apiKey: "t".repeat(40) },
        openrouter: { apiKey: "o".repeat(40) },
      },
    }),
    { mode: 0o600 }
  );

  // Act on a Clef selection... the value names Clef Flash, not the provider that happens to be first.
  writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: "cloudflare:clef-flash", fallback: "" }), { mode: 0o600 });
  const published = [];
  syncEyeStatus({ ui: { setStatus: (key, value) => published.push({ key, value }) } });
  assert.equal(published[0].key, "pi-jev-eye", "the status is published under the pi-jev-eye key");
  assert.equal(published[0].value, "Eye: ● ON (Clef Flash)", `the Clef value is the requested format, got ${JSON.stringify(published[0].value)}`);

  // ...and on a Jev selection, which is the same word whether the key is TypeSafe or OpenRouter.
  for (const ref of ["typesafe:jev-latest", "openrouter:typesafe/jev-1.13"]) {
    writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: ref, fallback: "" }), { mode: 0o600 });
    const seen = [];
    syncEyeStatus({ ui: { setStatus: (_key, value) => seen.push(value) } });
    assert.equal(seen[0], "Eye: ● ON (Jev)", `${ref} reads as (Jev), got ${JSON.stringify(seen[0])}`);
  }

  // With nothing picked, the credential precedence decides and the cell still carries a backend.
  writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: "", fallback: "" }), { mode: 0o600 });
  const auto = [];
  syncEyeStatus({ ui: { setStatus: (_key, value) => auto.push(value) } });
  assert.equal(auto[0], "Eye: ● ON (Jev)", `an unpicked session falls back to the credential precedence, got ${JSON.stringify(auto[0])}`);

  // An active pick whose key is missing is skipped, so the cell names what actually answers — the pick
  // that cannot be called must not be the name on the line.
  writeFileSync(join(eyeDir, "auth.json"), JSON.stringify({ version: 2, providers: { typesafe: { apiKey: "t".repeat(40) } } }), { mode: 0o600 });
  writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: "cloudflare:clef-flash", fallback: "typesafe:jev-latest" }), { mode: 0o600 });
  const skipped = [];
  syncEyeStatus({ ui: { setStatus: (_key, value) => skipped.push(value) } });
  assert.equal(skipped[0], "Eye: ● ON (Jev)", `a keyless Clef pick is skipped for the fallback, got ${JSON.stringify(skipped[0])}`);

  // The footer's parse: `(Backend)` is the suffix and the only dim run, so `Eye: ● ON` stays readable.
  const { jevEyeStatusLine } = await import("/run/media/bisma/DATA/Pi/pi-arnative/extensions/footer.ts");
  const dim = (text) => `\x1b[2m${text}\x1b[22m`;
  const line = jevEyeStatusLine("Eye: ● ON (Clef Flash)", (t) => t, dim, (t) => t, undefined);
  // The glyph is U+F21B (`fa-user_secret`): pinned by codepoint, because a swapped-in Nerd glyph that
  // renders blank on another platform is exactly the bug the ponytail cell had (`\\uf51` -> `\\uef04`).
  assert.equal(strip(line).codePointAt(0), 0xf21b, `the cell leads with U+F21B, got U+${strip(line).codePointAt(0).toString(16).toUpperCase()}`);
  // One space between the glyph and the label: the two spaces the wider previous glyph needed read as a
  // gap once `\uf21b` took its place. Asserted on the exact string, so a stray pad fails here.
  assert.equal(strip(line), "\uf21b" + " Eye: ● ON (Clef Flash)", "the footer keeps the value verbatim once painted");
  assert.equal(strip(line).includes("\uf21b" + "  "), false, "the icon is followed by one space, not two");
  assert.deepEqual([...line.matchAll(/\x1b\[2m(.*?)\x1b\[22m/g)].map((m) => m[1]), ["(Clef Flash)"], "only the backend suffix is dim");
  assert.equal(jevEyeStatusLine("Eye: ● ON", (t) => t, dim, (t) => t, undefined).includes("("), false, "a value with no backend gains no guessed parenthesis");

  writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: "", fallback: "" }), { mode: 0o600 });

  // The router rule: the footer recognises the cell by the LABEL its value carries, because the value
  // contains no `jev-eye` anywhere. `value.includes("jev-eye")` was the old test and it went false — the
  // cell fell through to the generic path and lost its icon and its dim suffix.
  const { isJevEyeStatus } = await import("/run/media/bisma/DATA/Pi/pi-arnative/extensions/footer.ts");
  assert.equal(isJevEyeStatus("Eye: ● ON (Clef Flash)"), true, "the published value is recognised as its own cell");
  assert.equal(isJevEyeStatus("Eye: ○ OFF (Jev)"), true, "every mode's value is, REVIEW included");
  assert.equal(isJevEyeStatus("Jev: ● ON"), false, "the previous format is not claimed as this cell");
  assert.equal(isJevEyeStatus("MCP: 2 servers enabled"), false, "and neither is another extension's status");
  assert.equal("Eye: ● ON (Clef Flash)".includes("jev-eye"), false, "the value carries no internal key name, which is what broke the old matcher");
}

// Saving in `/jev-eye models` must republish the footer cell, not only write the file. The operator saw
// the old backend until a `/reload`, because `writeBackends` alone changes nothing on screen: pi's
// `setStatus` is what triggers the render, so the save path has to call it.
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const eyeDir = join(process.env.HOME, ".pi", "agent", "pi-jev-eye");
  mkdirSync(eyeDir, { recursive: true });
  writeFileSync(join(eyeDir, "auth.json"), JSON.stringify({ version: 2, providers: { typesafe: { apiKey: "t".repeat(40) } } }), { mode: 0o600 });
  writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: "typesafe:jev-latest", fallback: "" }), { mode: 0o600 });

  // A TUI context whose `setStatus` records the publish, which is exactly what the footer reads.
  const { ctx, screens } = harness();
  const published = [];
  ctx.ui.setStatus = (key, value) => published.push({ key, value });
  const run = commands["jev-eye"].handler("models", ctx);
  await tick();
  assert.equal(published.length, 0, "opening the screen publishes nothing: the picks have not been saved yet");
  screens[0].resolve({ primary: "typesafe:jev-latest", fallback: "" });
  await run;
  assert.equal(published.length > 0, true, "saving republishes the cell instead of waiting for a /reload");
  assert.equal(published.at(-1).value, "Eye: ● ON (Jev)", `and the published value names the saved backend, got ${JSON.stringify(published.at(-1).value)}`);

  // The same path with a Clef pick: the value must follow the file, not the previous value.
  writeFileSync(join(eyeDir, "auth.json"), JSON.stringify({ version: 2, providers: { cloudflare: { apiKey: "x".repeat(40), model: "clef-flash", accountId: "a".repeat(32) } } }), { mode: 0o600 });
  const clef = harness();
  const clefPublished = [];
  clef.ctx.ui.setStatus = (key, value) => clefPublished.push(value);
  const runClef = commands["jev-eye"].handler("models", clef.ctx);
  await tick();
  clef.screens[0].resolve({ primary: "cloudflare:clef-flash", fallback: "" });
  await runClef;
  assert.equal(clefPublished.at(-1), "Eye: ● ON (Clef Flash)", `a Clef save publishes the Clef cell, got ${JSON.stringify(clefPublished.at(-1))}`);

  // And a failed publish must never break the save: `syncEyeStatus` swallows a disposed ui by design.
  const headless = rpcHarness();
  await commands["jev-eye"].handler("models", headless.ctx).catch(() => {});
  const { readBackends: read } = await import(new URL("../extensions/core.ts", import.meta.url).href);
  assert.equal(typeof read().primary, "string", "the headless path still reaches a real state read");

  writeFileSync(join(eyeDir, "backends.json"), JSON.stringify({ version: 1, primary: "", fallback: "" }), { mode: 0o600 });
}

// The confirm dialog is a vertical list, like every other list here and like pi's own `ctx.ui.confirm`
// (a Yes/No select list). It advertised `[←→] Switch`, which was both the wrong axis and a collision:
// `[←]` already means Back inside this extension's menus, so the footer read as "leave the dialog".
{
  const UP = "\x1b[A";
  const DOWN = "\x1b[B";

  /** Open login with a dirty environment, so the first screen is the confirm dialog. */
  const openConfirm = async () => {
    process.env.TYPESAFE_API_KEY = "x".repeat(40);
    const h = harness();
    const run = commands["jev-eye"].handler("login", h.ctx).catch(() => {});
    await tick();
    return { ...h, run };
  };

  const first = await openConfirm();
  assert.equal(first.screens.length >= 1, true, "login asks for confirmation when a key is already exported");
  const text = strip(first.screens[0].wrapper.render(90).join("\n"));
  assert.equal(text.includes("[↑↓]"), true, "the confirm dialog advertises vertical movement");
  assert.equal(text.includes("[←→]"), false, "and never the horizontal legend that read as Back");
  assert.equal(text.includes("[←]"), false, "nor a bare [←], which means Back in every other screen");
  first.screens[0].resolve(false);
  await first.run;

  // `[↑↓]` must really move the answer: Enter after a move picks the other row. The chosen row is the
  // one the arrow points at, and that is what the wrapper reports back.
  for (const [key, expectedRow] of [[null, "Confirm"], [DOWN, "Cancel"], [UP, "Confirm"]]) {
    const h = await openConfirm();
    const confirm = h.screens[0];
    if (key) confirm.wrapper.handleInput(key);
    const shown = strip(confirm.wrapper.render(90).join("\n"));
    const arrow = shown.split("\n").find((l) => l.includes("→"));
    assert.equal(arrow.includes(expectedRow), true, `${key ?? "no key"} puts the arrow on ${expectedRow}, got ${arrow.trim()}`);
    confirm.resolve(false);
    await h.run;
  }
  delete process.env.TYPESAFE_API_KEY;
}

// The Accounts screen owns add and remove. A stored key is not recoverable from the screen, so removal
// takes two presses of `[Ctrl+d]`, and the second press must be the only thing that writes.
{
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const authDir = join(process.env.HOME, ".pi", "agent", "pi-jev-eye");
  mkdirSync(authDir, { recursive: true });
  const authPath = join(authDir, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({ version: 2, providers: { typesafe: { apiKey: "x".repeat(40), model: "jev-latest" }, cloudflare: { apiKey: "y".repeat(40), model: "clef-flash", accountId: "a".repeat(32) } } }),
    { mode: 0o600 }
  );
  const read = () => (JSON.parse(readFileSync(authPath, "utf8")).providers ?? {});
  const REMOVE = "\x04"; // ctrl+d

  const openAccounts = async () => {
    const h = harness();
    const run = commands["jev-eye"].handler("accounts", h.ctx).catch(() => {});
    await tick();
    assert.equal(h.screens.length >= 1, true, "accounts opens the Accounts screen");
    return { ...h, run };
  };

  const first = await openAccounts();
  const row = () => strip(first.screens[0].wrapper.render(90).join("\n")).split("\n").find((l) => l.includes("TypeSafe account"));
  assert.equal(row().includes("✓ stored"), true, "a stored credential reports its state");
  const legend = () => strip(first.screens[0].wrapper.render(90).join("\n"));
  assert.equal(legend().includes("[Ctrl+d] Remove"), true, "the remove key is advertised while something is stored");

  first.screens[0].wrapper.handleInput(REMOVE);
  assert.equal(row().includes("again to remove"), true, "the first press asks for confirmation instead of deleting");
  assert.equal(!!read().typesafe, true, "and nothing is written on that first press");

  first.screens[0].wrapper.handleInput(REMOVE);
  await tick();
  assert.equal(!!read().typesafe, false, "the second press removes exactly the highlighted credential");
  assert.equal(!!read().cloudflare, true, "and leaves the other backend alone");
  assert.equal(row().includes("not configured"), true, "the row reflects the removal without reopening the screen");
  first.screens[0].resolve(null);
  await first.run;

  // Moving away must cancel a half-confirmed removal, or a stray move plus a later press would delete.
  writeFileSync(
    authPath,
    JSON.stringify({ version: 2, providers: { typesafe: { apiKey: "x".repeat(40), model: "jev-latest" } } }),
    { mode: 0o600 }
  );
  const move = await openAccounts();
  move.screens[0].wrapper.handleInput(REMOVE);
  move.screens[0].wrapper.handleInput("\x1b[B"); // down
  move.screens[0].wrapper.handleInput(REMOVE);
  await tick();
  assert.equal(!!read().typesafe, true, "moving between rows cancels the pending removal");
  move.screens[0].resolve(null);
  await move.run;

  // Nothing stored means no remove key advertised: a screen must not promise a key it ignores.
  writeFileSync(authPath, JSON.stringify({ version: 2, providers: {} }), { mode: 0o600 });
  const { ctx, screens } = harness();
  const runEmpty = commands["jev-eye"].handler("accounts", ctx).catch(() => {});
  await tick();
  const empty = strip(screens[0].wrapper.render(90).join("\n"));
  assert.equal(empty.includes("[Ctrl+d]"), false, "an empty store advertises no remove key");
  screens[0].resolve(null);
  await runEmpty;
}
