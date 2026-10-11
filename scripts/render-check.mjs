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

const commands = {};
install({
  on() {},
  registerShortcut() {},
  registerCommand: (name, definition) => { commands[name] = definition; },
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

// Every sub-screen opens inside the frame, and the read-only one advertises no toggle it ignores.
assert.equal((await open("status", "", [2], 80)).includes("Grant folder"), true, "status keeps its last footer key at 80 columns");
const usage = await open("usage", "", [3], 80);
assert.equal(usage.includes("[Enter] Done"), true, "usage advertises its real exits");
assert.equal(usage.includes("Supervisor"), false, "usage must not advertise a toggle it ignores");
await open("routing", "", [4], 80);

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

console.log("render checks OK");
