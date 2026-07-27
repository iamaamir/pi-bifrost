#!/usr/bin/env node
// ── Release script ──────────────────────────────────────────
// Usage: node --experimental-strip-types scripts/release.mjs [--patch|--minor|--major] [--publish]
//
// Steps:
//   1. Validate clean working tree
//   2. Run tests + typecheck
//   3. Bump version in package.json (or accept custom --version X.Y.Z)
//   4. Commit version bump + create git tag
//   5. Push branch + tag to origin
//   6. npm publish (if --publish flag, requires confirmation)

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const SCRIPT_DIR = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(SCRIPT_DIR, "..");

function run(cmd, silent = false) {
  try {
    const result = execSync(cmd, { cwd: ROOT, encoding: "utf-8", stdio: silent ? "pipe" : "inherit" });
    return result.trim();
  } catch (err) {
    console.error(`[release] Command failed: ${cmd}`);
    throw err;
  }
}

export function parseVersion(raw) {
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid version "${raw}", expected X.Y.Z`);
  return { major: +match[1], minor: +match[2], patch: +match[3] };
}

export function bumpVersion(current, bumpType) {
  const { major, minor, patch } = parseVersion(current);
  switch (bumpType) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      throw new Error(`Unknown bump type "${bumpType}", use patch | minor | major`);
  }
}

function getLatestTag() {
  try {
    return run(`git tag --sort=-v:refname | head -1`);
  } catch {
    return null;
  }
}

// ── CLI entry point — only runs when invoked directly ─────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[release] Unexpected error: ${err}`);
    process.exit(1);
  });
}

async function main() {
  // ── Parse arguments ────────────────────────────────────────────
  let bumpType = null;
  let customVersion = null;
  let shouldPublish = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--patch" || arg === "--minor" || arg === "--major") {
      bumpType = arg.slice(2);
    } else if (arg === "--version" && args[i + 1]) {
      customVersion = args[++i];
    } else if (arg === "--publish") {
      shouldPublish = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node --experimental-strip-types scripts/release.mjs [--patch|--minor|--major] [--version X.Y.Z] [--publish]`);
      return;
    }
  }

  // ── 0. Verify this is a git repo ────────────────────────────────
  if (!existsSync(join(ROOT, ".git"))) {
    console.error("[release] Not a git repository. Run from the project root.");
    process.exit(1);
  }

  // ── 1. Check clean working tree ──────────────────────────────────
  const status = run("git status --porcelain", true);
  if (status) {
    console.error("[release] Working tree has uncommitted changes. Commit or stash first.");
    console.error(status);
    process.exit(1);
  }

  // ── 2. Run tests + typecheck ─────────────────────────────────────
  console.log("[release] Running tests...");
  run("npm test");
  console.log("[release] Running typecheck...");
  run("npm run typecheck");

  // ── 3. Determine new version ──────────────────────────────────────
  const pkgPath = join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const currentVersion = pkg.version;

  let newVersion;
  if (customVersion) {
    newVersion = customVersion;
  } else if (bumpType) {
    newVersion = bumpVersion(currentVersion, bumpType);
  } else {
    newVersion = bumpVersion(currentVersion, "patch");
  }

  if (newVersion === currentVersion) {
    console.error(`[release] Version ${currentVersion} is already the same as new version. Nothing to release.`);
    process.exit(1);
  }

  console.log(`[release] ${currentVersion} → ${newVersion}`);

  // ── 4. Update package.json version ───────────────────────────────
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  // ── 5. Commit + tag ──────────────────────────────────────────────
  const tag = `v${newVersion}`;
  run(`git add package.json`);
  run(`git commit -m "chore: release v${newVersion}"`);
  run(`git tag -a ${tag} -m "Release v${newVersion}"`);

  // ── 6. Push branch + tag ─────────────────────────────────────────
  console.log("[release] Pushing to origin...");
  run(`git push origin HEAD`);
  run(`git push origin ${tag}`);

  // ── 7. npm publish ────────────────────────────────────────────────
  if (shouldPublish) {
    console.log(`[release] Publishing ${tag} to npm...`);
    run(`npm publish`);
    console.log(`[release] ✅ v${newVersion} published to npm.`);
  } else {
    console.log(`[release] ✅ v${newVersion} tagged and pushed.`);
    console.log(`[release]   To publish to npm: node scripts/release.mjs --publish`);
  }
}
