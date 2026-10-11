import test from "node:test";
import assert from "node:assert/strict";
import { DESTRUCTIVE_BASH_PATTERNS, backendTotals, cfRunUrl, clefBody, clefBudget, clefError, clefNeuronsFor, clefNeuronsPerMTok, clefUsdPerMTok, isCloudflareAccountId, legacyTotals, mergeTotals, neuronsSpentOn, normalizeTotals, sumDays, wipeTarget } from "../extensions/layer1.ts";

// The literal is assembled so this file cannot trip the extension's own bash gate while it is being written.
const rm = "r" + "m";

// Every path that must be judged catastrophic, whatever the flag spelling or position in the line.
const wipes = [
  `${rm} -rf /`,
  `${rm} -rf /var/log`,
  `${rm} -rf ~/Documents`,
  `${rm} -rf '/home/*'`,
  `${rm} -R /usr`,
  `${rm} --force --recursive /usr`,
  `${rm} -rf ./build && ${rm} -rf /`,
  `echo x | ${rm} -rf /`,
];

for (const command of wipes) {
  test(`wipe detected: ${command}`, () => assert.ok(wipeTarget(command), "expected a wipe target"));
}

// Scoped deletes stay allowed — the gate must not cry wolf on ordinary work.
const scoped = [
  `${rm} -rf ./build`,
  `${rm} -rf /tmp/scratch`,
  `${rm} -rf /home/bisma/scratch`,
  `${rm} --force --recursive ./node_modules`,
  `${rm} /tmp/jev-req*.mjs`,
];

for (const command of scoped) {
  test(`scoped delete allowed: ${command}`, () => assert.equal(wipeTarget(command), null));
}

// The glob rule exists for bare "wipe this whole dir" globs; a named prefix glob is a scoped delete.
test(`bare glob still blocked: ${rm} -rf /tmp/*`, () => assert.ok(wipeTarget(`${rm} -rf /tmp/*`)));

const blocked = (command) => DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command));

test("force push to main is blocked", () => assert.ok(blocked("git push --force origin main")));
test("force push to a feature branch is allowed", () => assert.equal(blocked("git push --force origin feature/x"), false));
test("force-with-lease is not a destructive force push", () => assert.equal(blocked("git push --force-with-lease origin main"), false));
test("short -f push to master is blocked", () => assert.ok(blocked("git push -f origin master")));
test("reset --hard is blocked", () => assert.ok(blocked("git reset --hard HEAD~3")));

// --- Usage ledger: the older pi-typesafe days must still show up, not vanish behind an empty own ledger. ---
test("a pi-typesafe day maps onto our counters", () => {
  const day = legacyTotals({ requestsStarted: 12, requestsSucceeded: 11, requestsFailed: 1, inputTokens: 28996, outputTokens: 3829 });
  assert.equal(day.requests, 12);
  assert.equal(day.ok, 11);
  assert.equal(day.failed, 1);
  assert.equal(day.inputTokens, 28996);
  assert.ok(Math.abs(day.cost - (28996 * 0.042) / 1e6) < 1e-12, "cost is estimated when the ledger has none");
});

test("own and legacy days add up instead of one replacing the other", () => {
  const own = normalizeTotals({ requests: 2, ok: 2, inputTokens: 100, outputTokens: 10, cost: 0.1 });
  const legacy = legacyTotals({ requestsStarted: 3, requestsSucceeded: 3, inputTokens: 200, outputTokens: 20 });
  const merged = mergeTotals(own, legacy);
  assert.equal(merged.requests, 5);
  assert.equal(merged.inputTokens, 300);
  assert.equal(merged.outputTokens, 30);
});

test("a ledger missing on one side is not a zero contribution", () => {
  const own = normalizeTotals({ requests: 1 });
  assert.deepEqual(mergeTotals(own, undefined), own);
  assert.deepEqual(mergeTotals(undefined, own), own);
  assert.equal(mergeTotals(undefined, undefined), undefined);
});

test("sumDays counts only the requested day or month", () => {
  const days = { "2026-09-20": { requests: 12 }, "2026-09-21": { requests: 5 }, "2026-08-31": { requests: 99 } };
  assert.equal(sumDays(days, "2026-09", normalizeTotals).requests, 17);
  assert.equal(sumDays(days, "2026-09-20", normalizeTotals).requests, 12);
  assert.equal(sumDays(days, "2026-07", normalizeTotals), undefined);
  assert.equal(sumDays(undefined, "2026-09", normalizeTotals), undefined);
});

// --- Cloudflare Workers AI route (Clef): the account id is a credential-adjacent value, the base is not. ---
const accountId = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("only a 32-char hex string is accepted as an account id", () => {
  assert.ok(isCloudflareAccountId(accountId));
  assert.ok(isCloudflareAccountId(accountId.toUpperCase()));
  assert.equal(isCloudflareAccountId("a1b2c3"), false);
  assert.equal(isCloudflareAccountId("a1b2c3d4e5f60718293a4b5c6d7e8f9g"), false);
  assert.equal(isCloudflareAccountId(""), false);
});

test("the Clef route carries the account id and the chosen model", () => {
  assert.equal(cfRunUrl(accountId, "clef-flash"), `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`);
  assert.ok(cfRunUrl(accountId, "clef").endsWith("/@cf/cloudflare/clef"));
});

// The REST route wraps the System One answer in { result, success, errors }; missing that wrapper reads
// as "the model answered nothing" and silently fails the write gate open.
test("a Workers AI envelope unwraps to its result", () => {
  const body = { model: "clef", answers: { has_slop: { type: "noul", noul: 0.91 } }, usage: { input_tokens: 1200 } };
  assert.deepEqual(clefBody({ result: body, success: true, errors: [] }), body);
});

test("a raw (non-enveloped) answer still reads", () => {
  const body = { model: "jev-1.13.0", answers: { has_slop: { type: "noul", noul: 0.1 } } };
  assert.deepEqual(clefBody(body), body);
});

test("success:false is a failure even when a result is present", () => {
  assert.equal(clefBody({ result: { answers: {} }, success: false, errors: [{ message: "invalid account id" }] }), undefined);
  assert.equal(clefBody(undefined), undefined);
  assert.equal(clefBody("nope"), undefined);
});

test("the Cloudflare error list becomes one readable line", () => {
  assert.equal(clefError({ errors: [{ message: "invalid api token" }, { message: "retry later" }] }), "invalid api token; retry later");
  assert.equal(clefError({ success: false }), "no result");
});

// --- Per-provider rollup: what lets one panel separate Jev from Clef ---
test("an entry written before provider attribution folds without inventing providers", () => {
  const old = normalizeTotals({ requests: 3, inputTokens: 100, cost: 0.0000042 });
  assert.equal(old.providers, undefined);
  assert.equal(old.neurons, undefined);
  assert.equal(old.requests, 3);
});

test("a provider's counters are kept per provider, never summed into one bucket", () => {
  const days = {
    "2026-10-11": {
      requests: 4,
      inputTokens: 900,
      cost: 0.0001,
      neurons: 3.5,
      providers: { cloudflare: { requests: 2, inputTokens: 500, neurons: 1.7 }, typesafe: { requests: 2, inputTokens: 400 } },
    },
  };
  const month = sumDays(days, "2026-10", normalizeTotals);
  assert.equal(month.requests, 4);
  assert.equal(month.providers.cloudflare.requests, 2);
  assert.equal(month.providers.typesafe.requests, 2);
  assert.equal(month.providers.cloudflare.inputTokens, 500);
  assert.equal(month.providers.typesafe.inputTokens, 400);
  assert.equal(month.providers.typesafe.neurons, 0);
});

test("folding two ledgers adds matching providers instead of replacing them", () => {
  const own = sumDays({ "2026-10-11": { requests: 1, providers: { cloudflare: { requests: 1, inputTokens: 10 } } } }, "2026-10", normalizeTotals);
  const legacy = sumDays({ "2026-10-11": { requestsStarted: 1, inputTokens: 5 } }, "2026-10", legacyTotals);
  const merged = mergeTotals(own, legacy);
  assert.equal(merged.providers.cloudflare.requests, 1);
  assert.equal(merged.requests, 2);
});

test("only today's neurons count against the free daily allowance", () => {
  const days = { "2026-10-11": { neurons: 120 }, "2026-10-10": { neurons: 9999 } };
  assert.equal(neuronsSpentOn(days, "2026-10-11"), 120);
  assert.equal(neuronsSpentOn(days, "2026-10-09"), 0);
});

// The panel shows Jev and Clef side by side, so the split must be exact — and a partial entry must
// not poison the sum with NaN.
test("the backend split keeps Clef apart from every other Jev provider", () => {
  const { clef, jev } = backendTotals({
    cloudflare: { requests: 4, inputTokens: 1332, cost: 0.0000506, neurons: 2427 },
    typesafe: { requests: 2, inputTokens: 900, cost: 0.0000378 },
    openrouter: { requests: 1, inputTokens: 10, cost: 0.000001 },
  });
  assert.equal(clef.requests, 4);
  assert.equal(clef.neurons, 2427);
  assert.equal(jev.requests, 3, "TypeSafe and OpenRouter both count as Jev");
  assert.equal(jev.inputTokens, 910);
  assert.equal(jev.neurons, 0, "only Cloudflare is metered in neurons");
});

test("a partial provider entry contributes zeros, never NaN", () => {
  const { clef } = backendTotals({ cloudflare: { requests: 1 } });
  assert.equal(clef.requests, 1);
  assert.equal(clef.inputTokens, 0);
  assert.equal(clef.cost, 0);
  assert.equal(clef.neurons, 0);
});

test("an empty or missing split reads as two zeroed backends", () => {
  for (const input of [undefined, {}]) {
    const { clef, jev } = backendTotals(input);
    assert.equal(clef.requests + jev.requests, 0);
    assert.equal(clef.cost + jev.cost, 0, "no invented spend");
  }
});

// --- Clef pricing: clef-flash bills 6x less than clef, and the free tier is 10,000 neurons/day ---
test("the Clef price and neuron rate follow the chosen model", () => {
  assert.equal(clefUsdPerMTok("clef"), 0.24);
  assert.equal(clefUsdPerMTok("clef-flash"), 0.038);
  assert.equal(clefNeuronsPerMTok("clef"), 21818);
  assert.equal(clefNeuronsPerMTok("clef-flash"), 3455);
  assert.equal(clefUsdPerMTok("a-model-from-the-future"), 0.038, "an unknown model is charged as the cheap one, never as free");
  assert.equal(clefNeuronsFor("clef-flash", 1_000_000), 3455);
  assert.equal(clefNeuronsFor("clef-flash", 0), 0);
});

test("the free-neuron budget reports what is left and what overage would cost", () => {
  const under = clefBudget(2500);
  assert.equal(under.used, 2500);
  assert.equal(under.remaining, 7500);
  assert.equal(under.overageUsd, 0);

  const over = clefBudget(12_000);
  assert.equal(over.remaining, 0);
  assert.equal(over.overageUsd, 0.022, "2000 neurons over at $0.011/1000");

  assert.equal(clefBudget(-5).used, 0, "a negative counter clamps instead of reporting extra budget");
});
