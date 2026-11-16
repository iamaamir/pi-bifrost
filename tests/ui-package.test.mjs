import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("ships the UI components and preserves their original package paths", () => {
  const cache = mkdtempSync(join(tmpdir(), "bifrost-ui-pack-"));
  let packed;
  try {
    [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } }));
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  const paths = new Set(packed.files.map(({ path }) => path));
  for (const name of ["cost-view", "expandable-rows", "result-viewer", "config-approval", "ux-status"]) {
    assert(paths.has(`ui/${name}.ts`), `package is missing ui/${name}.ts`);
    assert(import.meta.resolve(`pi-bifrost/${name}.ts`).endsWith(`/ui/${name}.ts`));
  }
  assert(paths.has("ui/panel.ts"), "package is missing the overlay panel");
});
