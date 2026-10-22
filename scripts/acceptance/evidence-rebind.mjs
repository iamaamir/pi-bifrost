import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./core.mjs";

const MANIFEST = "change-evidence.json";
const SHA = /^[a-f0-9]{40}$/;
const REGEX_REQUIREMENT = /^R(?:0[1-9]|1[0-7])$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Evidence rebind: ${message}`);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadEvidenceManifest(root) {
  const path = join(root, MANIFEST);
  const stat = lstatSync(path);
  requireValue(stat.isFile() && stat.size <= 256 * 1024, "declaration must be a regular file no larger than 256 KiB");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  requireValue(manifest.schemaVersion === 1, "declaration must use schemaVersion 1");
  requireValue(Array.isArray(manifest.contracts) && manifest.contracts.length > 0, "contracts must not be empty");
  return manifest;
}

/** Resolve a ref to a commit the object database actually contains. */
export function resolveBaseRef(root, ref) {
  const sha = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  requireValue(SHA.test(sha), "the rebind base must resolve to a full commit sha");
  return sha;
}

export function assertBaseAncestor(root, base) {
  requireValue(SHA.test(base), "a full base commit sha is required");
  try {
    git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
  } catch {
    throw new Error(`Evidence rebind: the base ${base} is not an ancestor of HEAD`);
  }
}

/** Changed files between base and HEAD, excluding the declaration itself, like the validator. */
export function changedFilesForBase(root, base) {
  return git(root, ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"])
    .split("\0").filter(Boolean).filter((file) => file !== MANIFEST);
}

function safePath(value) {
  return text(value) && !isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

/**
 * Structural file-coverage mirror of validateChangeEvidence(): every declared
 * file must be inside the candidate diff, each file declared by exactly one
 * contract, and every changed file must be declared. Named test refs and
 * witness execution stay with the full acceptance run, which checks them
 * against real test events.
 */
export function evidenceCoverageProblems(manifest, changedFiles) {
  requireValue(text(manifest.base) && SHA.test(manifest.base), "the declaration must carry a full base commit sha");
  const changedSet = new Set([...new Set(changedFiles)]);
  const covered = new Map();
  const ids = new Set();
  const notInDiff = new Set();
  for (const contract of manifest.contracts) {
    requireValue(text(contract?.id) && !ids.has(contract.id), "contract IDs must be unique and nonempty");
    ids.add(contract.id);
    requireValue(REGEX_REQUIREMENT.test(contract.requirement), `${contract.id}: unknown requirement`);
    requireValue(text(contract.boundary) && text(contract.assertions), `${contract.id}: boundary and observable assertions are required`);
    requireValue(Array.isArray(contract.files) && contract.files.length > 0, `${contract.id}: changed files are required`);
    for (const file of contract.files) {
      requireValue(safePath(file), `${contract.id}: declared path is unsafe: ${file}`);
      if (!changedSet.has(file)) notInDiff.add(file);
      if (covered.has(file)) throw new Error(`Evidence rebind: duplicate file coverage: ${file} declared by ${covered.get(file)} and ${contract.id}`);
      covered.set(file, contract.id);
    }
  }
  const declaredCount = covered.size;
  const changedCount = changedSet.size;
  const changedNotDeclared = [...changedSet].filter((file) => !covered.has(file));
  return { notInDiff: [...notInDiff], changedNotDeclared, declaredCount, changedCount };
}

/** Replace the declaration base commit while preserving key order. */
export function rebindedManifest(manifest, base) {
  requireValue(SHA.test(base), "a full base commit sha is required");
  return { ...manifest, base };
}

export function writeEvidenceManifest(root, manifest) {
  requireValue(lstatSync(join(root, MANIFEST)).isFile(), "declaration must exist as a regular file before rebinding");
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  const path = join(root, MANIFEST);
  try {
    if (readFileSync(path, "utf8") === contents) return false;
  } catch {}
  writeFileSync(path, contents);
  return true;
}

/**
 * Rebind the per-change declaration to a base and validate the shape the
 * acceptance run will enforce: the base resolves and is an ancestor of HEAD,
 * and declared files exactly cover diff(base, HEAD).
 */
/**
 * Rebind the per-change declaration to a base and validate the shape the
 * acceptance run will enforce: the base resolves and is an ancestor of HEAD,
 * the declaration names that base, and declared files exactly cover
 * diff(base, HEAD).
 */
export function evaluateEvidenceRebind({ root, baseRef, apply = false }) {
  const base = resolveBaseRef(root, baseRef);
  assertBaseAncestor(root, base);
  let wrote = false;
  if (apply) {
    const previous = loadEvidenceManifest(root);
    wrote = writeEvidenceManifest(root, rebindedManifest(previous, base));
  }
  const manifest = loadEvidenceManifest(root);
  const problems = evidenceCoverageProblems(manifest, changedFilesForBase(root, base));
  const declarationMatches = manifest.base === base;
  const status = declarationMatches && problems.notInDiff.length === 0 && problems.changedNotDeclared.length === 0
    ? "passed"
    : "failed";
  return { status, base, wrote, declarationMatches, ...problems, detail: JSON.stringify(problems) };
}

export function usage() {
  return `usage: node scripts/acceptance/evidence-rebind.mjs <base-ref> [--apply]\n`
    + `  resolves <base-ref> (default origin/v2) and validates that ${MANIFEST}\n`
    + `  declares an ancestor base and a file list exactly covering diff(base, HEAD);\n`
    + `  --apply rewrites the declaration base commit to <base-ref> first.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  const operands = process.argv.slice(2).filter((arg) => arg !== "--apply");
  if (operands.length > 1) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    try {
      const result = evaluateEvidenceRebind({ root: process.cwd(), baseRef: operands[0] ?? "origin/v2", apply });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "passed" ? 0 : 1;
    } catch (error) {
      console.error(String(error.message));
      process.exitCode = 1;
    }
  }
}
