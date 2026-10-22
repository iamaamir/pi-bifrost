#!/usr/bin/env node
// Check that repository paths cited in issue bodies are readable by someone who
// only sees the remote. Each cited path must exist in the working tree and on
// the default branch.
//
// Usage:
//   node scripts/check-issue-refs.mjs <issue-number> [more...]
//   node scripts/check-issue-refs.mjs --ref v2 <issue-number> [more...]
//   node scripts/check-issue-refs.mjs --offline <issue-number> [more...]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "iamaamir/pi-bifrost";
const CITED_PATH = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:md|mjs|cjs|js|ts|json))(?![\w/-])/g;

/**
 * Extract deduplicated repository paths cited in an issue body.
 * Bare extensions, provider/model identifiers and prose are not paths.
 */
export function extractCitedPaths(body) {
  const paths = new Set();
  for (const match of String(body).matchAll(CITED_PATH)) {
    // A sentence-ending period is punctuation, not part of the path.
    paths.add(match[1].replace(/^\.\//, "").replace(/\.+$/, ""));
  }
  return [...paths].sort();
}

/**
 * Resolve each cited path against the working tree and an optional remote probe.
 * `remote` stays null when no probe is supplied, so an offline run cannot claim
 * a path is missing from the remote.
 */
export function checkReferences(paths, { root = REPO_ROOT, remoteExists = null } = {}) {
  return paths.map((path) => ({
    path,
    local: existsSync(join(root, path)),
    remote: remoteExists ? Boolean(remoteExists(path)) : null,
  }));
}

/** Print the result table and return the references that are not readable. */
export function report(results, stream = process.stdout) {
  const width = Math.max(4, ...results.map((result) => result.path.length));
  stream.write(`${"path".padEnd(width)}  local  remote\n`);
  for (const result of results) {
    const local = result.local ? "yes" : "NO";
    const remote = result.remote === null ? "-" : result.remote ? "yes" : "NO";
    stream.write(`${result.path.padEnd(width)}  ${local.padEnd(5)}  ${remote}\n`);
  }
  return results.filter((result) => !result.local || result.remote === false);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function remoteProbe(repo, ref) {
  return (path) => {
    try {
      execFileSync("gh", ["api", `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`], {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };
}

export function parseArgs(argv) {
  const issues = [];
  let offline = false;
  let ref = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--offline") offline = true;
    else if (argument === "--ref") {
      ref = argv[index + 1] ?? "";
      index += 1;
    } else if (argument.startsWith("--")) return { error: `unknown option: ${argument}` };
    else issues.push(argument);
  }
  if (issues.length === 0) return { error: "no issue numbers supplied" };
  if (issues.some((issue) => !/^\d+$/.test(issue))) return { error: "issue numbers must be numeric" };
  if (ref !== null && ref.trim() === "") return { error: "--ref needs a branch name" };
  return { issues, offline, ref };
}

function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`usage: node scripts/check-issue-refs.mjs [--ref <branch>] [--offline] <issue-number> [...]\n${parsed.error}\n`);
    return 2;
  }
  const { issues, offline } = parsed;

  const repo = process.env.BIFROST_TRACKER_REPO ?? gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  const ref = offline
    ? ""
    : parsed.ref ?? gh(["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]);
  if (!offline && !ref) {
    process.stderr.write("the default branch could not be resolved; rerun with --offline to check the working tree only\n");
    return 2;
  }

  const cited = new Set();
  for (const issue of issues) {
    const body = gh(["issue", "view", issue, "-R", repo, "--json", "body", "-q", ".body"]);
    for (const path of extractCitedPaths(body)) cited.add(path);
  }

  const results = checkReferences([...cited].sort(), {
    remoteExists: offline ? null : remoteProbe(repo, ref),
  });
  const missing = report(results);

  if (missing.length === 0) return 0;
  const paths = missing.map((result) => result.path).join(", ");
  process.stderr.write(
    `\n${missing.length} cited path(s) are not readable from ${repo}@${ref}: ${paths}\n` +
      "An agent without this working copy cannot follow them.\n",
  );
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
