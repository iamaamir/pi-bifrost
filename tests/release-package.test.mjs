import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));

test("npm release contains runtime files but no local state or checkout files", () => {
  const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  }))[0];
  const paths = pack.files.map((file) => file.path);
  const rootSources = readdirSync(root).filter((path) => path.endsWith(".ts"));
  for (const required of [...rootSources, "bifrost.json", "schema.json", "package.json"]) {
    assert.ok(paths.includes(required), `release missing ${required}`);
  }
  assert.ok(paths.every((path) => path.endsWith(".ts") && !path.includes("/")
    || ["bifrost.json", "schema.json", "README.md", "CHANGELOG.md", "package.json"].includes(path)
    || path.startsWith("examples/")), "release contains files outside source and examples allowlist");
});
