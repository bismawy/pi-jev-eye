// The failover path, driven against a stubbed `fetch`: the active backend answers, and only a call that
// cannot be used moves to the fallback. `npm test` only covered pure folds before this file; the claim
// "a stalled provider costs one timeout instead of losing the judgment" is a behaviour, so it is proved
// as one — no real network, but the real functions and the real chain.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: core.ts derives its state paths from HOME at import time, and `askJev` writes the ledger.
process.env.HOME = mkdtempSync(join(tmpdir(), "jev-providers-test-"));
process.env.USERPROFILE = process.env.HOME;
for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
  delete process.env[name];
}

const here = (file) => new URL(`../extensions/${file}`, import.meta.url).href;
const { withBackends } = await import(here("providers.ts"));
const { askJev, attemptJev } = await import(here("gate.ts"));
const { attemptWeight, classifyWeight } = await import(here("routing.ts"));
const { state } = await import(here("pmr.ts"));

const PROVIDER = (id) => ({
  typesafe: { id: "typesafe", short: "TypeSafe", url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", keyEnv: "TYPESAFE_API_KEY", keyHint: "x" },
  cloudflare: { id: "cloudflare", short: "Clef", url: "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash", model: "clef-flash", keyEnv: "CLOUDFLARE_API_TOKEN", keyHint: "x", accountEnv: "CLOUDFLARE_ACCOUNT_ID" },
}[id]);

/** `provider/model` in the same shape `authChain` produces, without touching disk or the environment. */
const auth = (id, model) => ({ provider: PROVIDER(id), key: "k".repeat(40), source: "$TEST_KEY", model, ...(id === "cloudflare" ? { accountId: "a".repeat(32) } : {}) });

/** The Cloudflare route wraps its answer; TypeSafe answers flat. One stub serves both. */
const clefEnvelope = (answers) => ({ success: true, result: { model: "clef-flash", answers, usage: { input_tokens: 100, output_tokens: 0 } } });

/** Install a fetch stub for one test and always put the original back. */
async function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return handler(String(url), init, calls.length);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const notOk = (status = 503) => new Response("upstream down", { status });

test("authChain puts the active backend first, the fallback second, and skips what has no credential", async () => {
  const { writeBackends } = await import(here("core.ts"));
  // `core.ts` reads the store and the environment at call time, so this drives the real resolution:
  // the exported key makes TypeSafe usable, the stored store makes Clef usable, and nothing is mocked.
  process.env.TYPESAFE_API_KEY = "t".repeat(40);
  writeBackends({ primary: "cloudflare:clef-flash", fallback: "typesafe:jev-latest" });
  const { authChain, readBackends, writeAuthStore } = await import(here("core.ts"));
  const { putCredential } = await import(here("layer1.ts"));

  // The store is written directly because this test owns no TUI: Clef needs an account id plus a token.
  writeAuthStore(putCredential({ version: 2, providers: {} }, "cloudflare", { apiKey: "c".repeat(40), accountId: "a".repeat(32) }));
  assert.deepEqual(readBackends(), { primary: "cloudflare:clef-flash", fallback: "typesafe:jev-latest" }, "the file is read back as written");

  const chain = authChain(readBackends());
  assert.deepEqual(
    chain.map((entry) => `${entry.provider.id}:${entry.model}`),
    ["cloudflare:clef-flash", "typesafe:jev-latest"],
    "active first, fallback second"
  );
  assert.equal(chain[0].accountId, "a".repeat(32), "a Clef entry carries its account id, so the route can be built");
  assert.equal(chain[1].key, "t".repeat(40), "and the TypeSafe entry takes the exported key");
  assert.equal(chain[1].source, "$TYPESAFE_API_KEY", "with the source recorded as the environment, not the store");

  // A fallback that cannot answer is not a fallback: with no Clef credential stored it is skipped, and the
  // credential precedence supplies whatever else is usable rather than an empty chain.
  writeAuthStore({ version: 2, providers: {} });
  writeBackends({ primary: "cloudflare:clef-flash", fallback: "typesafe:jev-latest" });
  const skipped = authChain(readBackends());
  assert.deepEqual(skipped.map((entry) => `${entry.provider.id}:${entry.model}`), ["typesafe:jev-latest"], "an unusable active backend is skipped, never entered twice");

  // And nothing at all is an empty chain, which callers read as "no judgment available".
  delete process.env.TYPESAFE_API_KEY;
  writeBackends({ primary: "", fallback: "" });
  assert.deepEqual(authChain(readBackends()), [], "no ref and no credential is an empty chain, not a crash");

  writeBackends({ primary: "", fallback: "" });
});

test("withBackends returns the first backend that answers and leaves the failover counter alone", async () => {
  state.stats.fallbacks = 0;
  const chain = [auth("typesafe", "jev-latest"), auth("cloudflare", "clef-flash")];
  const seen = [];
  const outcome = await withBackends(chain, async (entry) => {
    seen.push(entry.model);
    return entry.model === "jev-latest" ? "from-typesafe" : "from-clef";
  });
  assert.equal(outcome.result, "from-typesafe", "the active backend's result is the one returned");
  assert.equal(outcome.auth.model, "jev-latest", "and its credential is reported alongside it");
  assert.deepEqual(seen, ["jev-latest"], "the fallback is never called when the active backend answers");
  assert.equal(state.stats.fallbacks, 0, "no failover means no counter");
});

test("withBackends only moves on when a backend cannot answer", async () => {
  state.stats.fallbacks = 0;
  const chain = [auth("typesafe", "jev-latest"), auth("cloudflare", "clef-flash")];
  const seen = [];
  const outcome = await withBackends(chain, async (entry) => {
    seen.push(entry.model);
    return entry.model === "jev-latest" ? null : "from-clef";
  });
  assert.equal(outcome.result, "from-clef", "the fallback's result is returned instead");
  assert.equal(outcome.auth.model, "clef-flash");
  assert.deepEqual(seen, ["jev-latest", "clef-flash"], "the failed attempt is tried before the next one");
  assert.equal(state.stats.fallbacks, 1, "and the failover is counted for the status row");
});

test("withBackends reports failure when no backend can answer", async () => {
  state.stats.fallbacks = 0;
  const outcome = await withBackends([auth("typesafe", "jev-latest"), auth("cloudflare", "clef-flash")], async () => null);
  assert.equal(outcome, null, "no answer at all is null, which callers read as fail-open");
  assert.equal(state.stats.fallbacks, 0, "an all-failed chain is not a failover");
});

test("askJev falls over to the second backend and records both attempts", async () => {
  state.stats.fallbacks = 0;
  state.stats.jevRequests = 0;
  const chain = [auth("typesafe", "jev-latest"), auth("cloudflare", "clef-flash")];

  await withFetch(
    (url) => (url.includes("typesafe.ai") ? notOk(503) : Response.json(clefEnvelope({ has_slop: { noul: 0.1 }, has_unfinished_todo: { noul: 0.2 } }))),
    async (calls) => {
      const verdict = await askJev("const x = 1;\n".repeat(12), chain);
      assert.equal(calls.length, 2, "the primary is tried, then the fallback");
      assert.equal(calls[0].url.includes("typesafe.ai"), true, "the active backend goes first");
      assert.equal(calls[1].url.includes("cloudflare"), true, "the fallback is the Cloudflare route");
      assert.equal(calls[1].body.model, "clef-flash", "and it carries the fallback's own model, not the active one's");
      assert.equal(verdict.has_slop, 0.1, "the verdict comes from the backend that answered");
      assert.equal(verdict.has_unfinished_todo, 0.2);
      assert.equal(verdict.answers_request, null, "a dimension this turn did not ask for stays null, not zero");
      assert.equal(state.stats.fallbacks, 1, "the failover is visible in the status row");
    }
  );
});

test("askJev never reads a failed call as a clean verdict", async () => {
  state.stats.fallbacks = 0;
  const code = "const x = 1;\n".repeat(12);
  // A 200 with a missing answer is a failure of that backend: the dimension comes back null, which the
  // gate reads as "no block signal", never as "clean".
  await withFetch(
    () => Response.json(clefEnvelope({})),
    async () => {
      // The whole chain failed, so `askJev` returns null — which the gate reads as fail-open, never as
      // "no slop". A dimension of null is a fail-open too, but an answerless 200 must not look like one.
      assert.equal(await askJev(code, [auth("typesafe", "jev-latest")]), null, "an answerless 200 is a failed attempt, not a clean verdict");
      assert.equal(state.stats.fallbacks, 0, "a single-backend chain has no failover to count");
    }
  );

  // A thrown network error is the same branch, not an exception the caller has to catch.
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    assert.equal(await askJev(code, [auth("typesafe", "jev-latest")]), null, "and then the whole chain is null");
  } finally {
    globalThis.fetch = original;
  }
});

test("attemptJev treats every unusable response as a failure of that backend", async () => {
  const code = "const x = 1;\n".repeat(12);
  const one = [auth("typesafe", "jev-latest")];
  // Each case is a real failure mode the chain must fail over on, and one that must NOT be one.
  const cases = [
    ["a non-OK status", () => notOk(503), null],
    ["a Cloudflare envelope reporting failure", () => Response.json({ success: false, errors: [{ message: "boom" }] }), null],
    ["an envelope with no answers at all", () => Response.json(clefEnvelope({})), null],
    ["a 200 whose body is not JSON", () => new Response("<html>gateway</html>"), null],
  ];
  for (const [label, handler, expected] of cases) {
    const result = await withFetch(handler, () => attemptJev(code, auth("typesafe", "jev-latest")).catch(() => null));
    if (expected === null) assert.equal(result, null, `${label} is a failure, not a verdict`);
  }
  // And the one that must not be a failure: a real answer with a low score is still an answer, and a
  // partial answer (one dimension of several) is an answer too — the other dimensions stay null.
  const answered = await withFetch(
    () => Response.json({ model: "jev-latest", answers: { has_slop: { noul: 0.02 } } }),
    () => attemptJev(code, auth("typesafe", "jev-latest"))
  );
  assert.equal(answered.has_slop, 0.02, "a clean verdict is returned as-is; a low score is not a failure");
  assert.equal(answered.has_unfinished_todo, null, "a dimension this answer did not cover stays null");
  assert.equal(state.stats.fallbacks, 0, "an answered call is never a failover");
});

test("classifyWeight falls over too, and returns null when nothing answers", async () => {
  state.stats.fallbacks = 0;
  const chain = [auth("typesafe", "jev-latest"), auth("cloudflare", "clef-flash")];
  // The route is the active backend's; the model in the body is the attempt's own, so a failover cannot
  // send the fallback's model to the active backend's URL.
  await withFetch(
    (url) => (url.includes("typesafe.ai") ? notOk() : Response.json(clefEnvelope({ weight: { choice: "light" } }))),
    async (calls) => {
      assert.equal(await classifyWeight("tolong commit ya", chain), "light", "the fallback's classification is returned");
      assert.equal(calls.length, 2, "and only because the primary could not answer");
      assert.equal(calls[1].body.state.request.text, "tolong commit ya", "the fallback sees the same request text");
      assert.equal(state.stats.fallbacks, 1, "the routing failover is counted like the gate's");
    }
  );

  const outcome = await withFetch(() => notOk(), async () => classifyWeight("apa saja", chain));
  assert.equal(outcome, null, "every backend down is null, so the turn keeps its model");

  // A failed classification attempt is one null per backend, which is what the chain walks past.
  const attempt = await withFetch(() => notOk(), async (calls) => {
    const result = await attemptWeight("apa saja", auth("typesafe", "jev-latest"));
    assert.equal(calls[0].body.model, "jev-latest", "the attempt names its own model");
    return result;
  });
  assert.equal(attempt, null, "attemptWeight returns null for a backend that could not answer");
});

test("an answerless 200 is one failed ledger row, not ok plus failed", async () => {
  const { rmSync, readFileSync } = await import("node:fs");
  const { OWN_USAGE_PATH } = await import(here("core.ts"));
  const { today } = await import(here("ledger.ts"));
  rmSync(OWN_USAGE_PATH, { force: true });
  const result = await withFetch(
    () => Response.json(clefEnvelope({})),
    () => attemptJev("const x = 1;\n".repeat(12), auth("typesafe", "jev-latest"))
  );
  assert.equal(result, null, "an answerless 200 is still a failure of that backend");
  const day = JSON.parse(readFileSync(OWN_USAGE_PATH, "utf8")).days[today()];
  assert.equal(day.requests, 1, "one HTTP call is one request in the ledger");
  assert.equal(day.failed, 1, "and it is the failed one");
  assert.equal(day.ok || 0, 0, "an answerless 200 is never also counted as ok");
});

test("the request cap holds per attempt, so a failover at the last slot cannot overshoot it", async () => {
  const chain = [auth("typesafe", "jev-latest"), auth("cloudflare", "clef-flash")];
  const { JEV_MAX_REQUESTS } = await import(here("gate.ts"));
  const { JEV_MAX_ROUTING_CALLS } = await import(here("routing.ts"));
  state.stats.jevRequests = JEV_MAX_REQUESTS - 1;
  state.stats.jevRoutingCalls = JEV_MAX_ROUTING_CALLS - 1;
  await withFetch(
    (url) => (url.includes("typesafe.ai") ? notOk() : Response.json(clefEnvelope({ has_slop: { noul: 0.1 }, weight: { choice: "light" } }))),
    async (calls) => {
      assert.equal(await askJev("const x = 1;\n".repeat(12), chain), null, "the gate fallback is not called past the cap");
      assert.equal(await classifyWeight("apa saja", chain), null, "nor the routing fallback");
      assert.equal(calls.length, 2, "one call each: the primary at the last slot, never the fallback");
    }
  );
  assert.equal(state.stats.jevRequests, JEV_MAX_REQUESTS, "the gate counter stops at the cap, so the one-time warning still fires");
  assert.equal(state.stats.jevRoutingCalls, JEV_MAX_ROUTING_CALLS, "and so does the routing counter");
  state.stats.jevRequests = 0;
  state.stats.jevRoutingCalls = 0;
});

test("routing books its calls in the ledger like the gate does", async () => {
  const { rmSync, readFileSync } = await import("node:fs");
  const { OWN_USAGE_PATH } = await import(here("core.ts"));
  const { today } = await import(here("ledger.ts"));
  rmSync(OWN_USAGE_PATH, { force: true });
  state.stats.jevRoutingCalls = 0;
  const choice = await withFetch(
    () => Response.json(clefEnvelope({ weight: { choice: "light" } })),
    () => attemptWeight("apa saja", auth("cloudflare", "clef-flash"))
  );
  assert.equal(choice, "light", "the answered classification is returned");
  await withFetch(() => notOk(), () => attemptWeight("apa saja", auth("cloudflare", "clef-flash")));
  const day = JSON.parse(readFileSync(OWN_USAGE_PATH, "utf8")).days[today()];
  assert.equal(day.requests, 2, "both routing calls are in the ledger");
  assert.equal(day.ok, 1, "the answered one is ok");
  assert.equal(day.failed, 1, "the 503 is failed");
  assert.equal(day.inputTokens, 100, "and the answered call books its tokens");
  state.stats.jevRoutingCalls = 0;
});

test("the ledger day is the UTC day, matching the Clef 00:00 UTC reset", async () => {
  const { today } = await import(here("ledger.ts"));
  assert.equal(today(), new Date().toISOString().slice(0, 10));
});

test("the session caps read a positive integer from the environment and keep 20 otherwise", async () => {
  const { envBudget } = await import(here("core.ts"));
  const name = "PI_JEV_EYE_TEST_BUDGET";
  delete process.env[name];
  assert.equal(envBudget(name, 20), 20, "unset keeps the default");
  for (const bad of ["", "abc", "0", "-3", "2.5"]) {
    process.env[name] = bad;
    assert.equal(envBudget(name, 20), 20, "value " + JSON.stringify(bad) + " keeps the default");
  }
  process.env[name] = "50";
  assert.equal(envBudget(name, 20), 50, "a positive integer wins");
  delete process.env[name];
});
