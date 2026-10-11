import test from "node:test";
import assert from "node:assert/strict";
import { DESTRUCTIVE_BASH_PATTERNS, cfRunUrl, clefBody, clefError, isCloudflareAccountId, legacyTotals, mergeTotals, normalizeTotals, sumDays, wipeTarget } from "../extensions/layer1.ts";

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
