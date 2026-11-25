// Issue #351: path-based discovery for the one reserved module test location.
// Pure and root-relative so gate entrypoints can share it and tests can exercise
// isolated trees. No registry, no recursion, no runtime asset discovery.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const EXECUTABLE_TEST = /\.test\.(?:ts|mjs)$/u;
const ROOT_TEST = /^tests\/[^/]+\.test\.(?:ts|mjs)$/u;
const INTEGRATION_TEST = /^tests\/integration\/[^/]+\.test\.mjs$/u;
const MODULE_TEST = /^modules\/[^/]+\/tests\/[^/]+\.test\.(?:ts|mjs)$/u;

/** Repo-relative executable unit tests under `modules/<capability>/tests/`. */
export function moduleTestFiles(root) {
  let capabilities;
  try {
    capabilities = readdirSync(join(root, "modules"), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const capability of capabilities) {
    if (!capability.isDirectory() || capability.name.startsWith(".")) continue;
    const testsDir = join(root, "modules", capability.name, "tests");
    let entries;
    try {
      entries = readdirSync(testsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && EXECUTABLE_TEST.test(entry.name)) {
        files.push(`modules/${capability.name}/tests/${entry.name}`);
      }
    }
  }
  return files.sort();
}

/** Repo-relative nested capability runtime TS, excluding the reserved tests subtree. */
export function moduleSourceFiles(root) {
  const files = [];
  let capabilities;
  try {
    capabilities = readdirSync(join(root, "modules"), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const capability of capabilities) {
    if (!capability.isDirectory() || capability.name.startsWith(".")) continue;
    const walk = (directory, prefix) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name !== "tests") walk(join(directory, entry.name), rel);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
          && !/\.test\.(?:ts|mjs)$/u.test(entry.name)) {
          files.push(rel);
        }
      }
    };
    walk(join(root, "modules", capability.name), `modules/${capability.name}`);
  }
  return files.sort();
}

/** Whether a path is an executable unit test in one of the three reserved locations. */
export function isExecutableTest(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  return ROOT_TEST.test(normalized) || INTEGRATION_TEST.test(normalized) || MODULE_TEST.test(normalized);
}
