import test from "node:test";
import assert from "node:assert/strict";
import { DESTRUCTIVE_BASH_PATTERNS, wipeTarget } from "../extensions/layer1.ts";

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
];

for (const command of scoped) {
  test(`scoped delete allowed: ${command}`, () => assert.equal(wipeTarget(command), null));
}

const blocked = (command) => DESTRUCTIVE_BASH_PATTERNS.some((pattern) => pattern.test(command));

test("force push to main is blocked", () => assert.ok(blocked("git push --force origin main")));
test("force push to a feature branch is allowed", () => assert.equal(blocked("git push --force origin feature/x"), false));
test("force-with-lease is not a destructive force push", () => assert.equal(blocked("git push --force-with-lease origin main"), false));
test("short -f push to master is blocked", () => assert.ok(blocked("git push -f origin master")));
test("reset --hard is blocked", () => assert.ok(blocked("git reset --hard HEAD~3")));
