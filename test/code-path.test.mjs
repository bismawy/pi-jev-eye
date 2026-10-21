import test from "node:test";
import assert from "node:assert/strict";
import { isCodePath } from "../extensions/gate.ts";

// Layer 3 asks about stubs in logic, so only source files are judged; prose, config and data never are.
for (const path of ["src/a.ts", "b.mjs", "c.py", "ui/d.tsx", "e.go", "@extensions/gate.ts"]) {
  test("judged: " + path, () => assert.equal(isCodePath(path), true));
}

for (const path of ["README.md", "package.json", "CHANGELOG.md", "config.yaml", ".env.example", "", undefined]) {
  test("not judged: " + String(path), () => assert.equal(isCodePath(path), false));
}
