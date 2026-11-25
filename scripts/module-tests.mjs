// Issue #351: path-based discovery for the one reserved module test location.
// Pure and root-relative so gate entrypoints can share it and tests can exercise
// isolated trees. No registry, no recursion, no runtime asset discovery.
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const EXECUTABLE_TEST = /\.test\.(?:ts|mjs)$/u;
const ROOT_TEST = /^tests\/[^/]+\.test\.(?:ts|mjs)$/u;
const INTEGRATION_TEST = /^tests\/integration\/[^/]+\.test\.mjs$/u;
// The gate globs skip dot-prefixed path segments, so a hidden capability or a
// dot-prefixed test file never runs. Classifying one as executable would let
// the repository inventory accept a test that silently stays unexecuted.
const MODULE_TEST = /^modules\/(?!\.)[^/]+\/tests\/(?!\.)[^/]+\.test\.(?:ts|mjs)$/u;

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
      if (entry.isFile() && !entry.name.startsWith(".") && EXECUTABLE_TEST.test(entry.name)) {
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

/**
 * Copy nested capability runtime into an isolated staging root that mirrors the
 * shipped layout. Root sources import capabilities by relative path, so a flat
 * copy of the root cannot resolve them.
 */
export function copyModuleSources(root, destination) {
  for (const file of moduleSourceFiles(root)) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, file), target);
  }
}

/** Whether a path is an executable unit test in one of the three reserved locations. */
export function isExecutableTest(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  return ROOT_TEST.test(normalized) || INTEGRATION_TEST.test(normalized) || MODULE_TEST.test(normalized);
}

/**
 * Executable-looking test files that sit outside every reserved location. The
 * gates select by glob, so such a file would never run while still looking
 * like a test; the repository inventory test rejects it instead.
 */
export function misplacedTestFiles(relativePaths) {
  return relativePaths.filter((path) => EXECUTABLE_TEST.test(path) && !isExecutableTest(path));
}
