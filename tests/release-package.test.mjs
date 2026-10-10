import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("package manifest preserves the Pi extension and opts into a narrow router subpath", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./index.ts"]);
  assert.deepEqual(pkg.exports["./router"], {
    types: "./dist/router/router.d.ts",
    import: "./dist/router/router.js",
  });
  assert.deepEqual(pkg.exports["./*"], "./*", "legacy package subpaths stay mapped");
  for (const included of ["*.ts", "dist/router/", "bifrost.json", "schema.json", "examples/", "docs/router-api.md"]) {
    assert.ok(pkg.files.includes(included), `package files must include ${included}`);
  }
  assert.equal(pkg.files.includes("scripts/"), false);
  assert.equal(pkg.files.includes("tests/"), false);
});
