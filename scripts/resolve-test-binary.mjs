#!/usr/bin/env node
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

function isExecutable(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function trimEnvValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function resolveTestBinary({
  envVar,
  name,
  root = process.cwd(),
  env = process.env,
}) {
  const explicit = trimEnvValue(env[envVar]);
  if (explicit) {
    if (!isExecutable(explicit)) {
      throw new Error(
        `${envVar}="${explicit}" is set but is not an executable file.`,
      );
    }
    return {
      path: explicit,
      source: `env:${envVar}`,
      searched: [explicit],
    };
  }

  const candidateDirs = unique([
    join(root, "node_modules", ".bin"),
    join(root, ".pi", "npm", "node_modules", ".bin"),
  ]);

  const candidates = candidateDirs.map((candidateDir) =>
    join(candidateDir, name),
  );

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return {
        path: candidate,
        source: `repo:${name}`,
        searched: candidates,
      };
    }
  }

  const pathDirs = unique((env.PATH ?? "").split(delimiter).map((entry) => entry.trim()));
  const pathCandidates = pathDirs.map((dir) => join(dir, name));

  for (const candidate of pathCandidates) {
    if (isExecutable(candidate)) {
      return {
        path: candidate,
        source: `PATH:${name}`,
        searched: [...candidates, ...pathCandidates],
      };
    }
  }

  throw new Error(
    [
      `Could not resolve ${name}.`,
      `Set ${envVar}=<path> or make ${name} available on PATH.`,
      `Checked: ${[...candidates, ...pathCandidates].join(", ") || "(none)"}.`,
    ].join(" "),
  );
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] === scriptPath) {
  const [, , envVar, name, rootArg] = process.argv;
  if (!envVar || !name) {
    console.error("Usage: node scripts/resolve-test-binary.mjs <ENV_VAR> <binary-name> [root]");
    process.exit(1);
  }

  try {
    const resolved = resolveTestBinary({
      envVar,
      name,
      root: rootArg ? resolvePath(rootArg) : resolvePath(dirname(scriptPath), ".."),
    });
    process.stdout.write(`${resolved.path}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
