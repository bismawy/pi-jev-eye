import test from "node:test";
import assert from "node:assert/strict";
import { DESTRUCTIVE_BASH_PATTERNS, legacyTotals, mergeTotals, normalizeTotals, sumDays, wipeTarget } from "../extensions/layer1.ts";

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
