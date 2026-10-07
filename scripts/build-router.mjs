import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const output = join(root, "dist", "router");
rmSync(output, { recursive: true, force: true });

let compiler;
try {
  compiler = require.resolve("typescript/bin/tsc", { paths: [root] });
} catch {
  throw new Error("The router build requires the repository's declared TypeScript devDependency; install package devDependencies first.");
}

const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.router-build.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
