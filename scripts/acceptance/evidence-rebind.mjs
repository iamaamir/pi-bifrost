import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./core.mjs";

const MANIFEST = "change-evidence.json";
const SHA = /^[a-f0-9]{40}$/;
const REGEX_REQUIREMENT = /^R(?:0[1-9]|1[0-7])$/;
const CAP_BYTES = 256 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Evidence rebind: ${message}`);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadEvidenceManifest(root) {
  const path = join(root, MANIFEST);
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`Evidence rebind: cannot read the declaration at ${path}: ${String(error.message).split("\n")[0]}`);
  }
  requireValue(stat.isFile() && stat.size <= CAP_BYTES, "declaration must be a regular file no larger than 256 KiB");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Evidence rebind: the declaration at ${path} is not valid JSON: ${String(error.message).split("\n")[0]}`);
  }
  requireValue(manifest.schemaVersion === 1, "declaration must use schemaVersion 1");
  requireValue(Array.isArray(manifest.contracts) && manifest.contracts.length > 0, "contracts must not be empty");
  return manifest;
}

/** Resolve a ref to a commit the object database actually contains. */
export function resolveBaseRef(root, ref) {
  let sha;
  try {
    sha = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split("\n")[0];
    throw new Error(`Evidence rebind: the base ref ${ref} does not resolve to a commit: ${detail}`);
  }
  requireValue(SHA.test(sha), "the rebind base must resolve to a full commit sha");
  return sha;
}

export function assertBaseAncestor(root, base) {
  requireValue(SHA.test(base), "a full base commit sha is required");
  try {
    git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
  } catch (error) {
    // merge-base --is-ancestor exits 1 exactly when the relation does not
    // hold; any other failure is a git-level problem and must keep its cause.
    if (error?.status === 1) {
      throw new Error(`Evidence rebind: the base ${base} is not an ancestor of HEAD`);
    }
    throw error;
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
  const path = join(root, MANIFEST);
  requireValue(lstatSync(path).isFile(), "declaration must exist as a regular file before rebinding");
  const contents = `${JSON.stringify(manifest, null, 2)}\n`;
  // Reformatting can grow the file: refuse a rewrite that would break the
  // size cap the acceptance validator enforces, before touching the disk.
  requireValue(Buffer.byteLength(contents) <= CAP_BYTES,
    `the rewritten declaration would be ${Buffer.byteLength(contents)} bytes; the cap is ${CAP_BYTES}`);
  try {
    if (readFileSync(path, "utf8") === contents) return false;
  } catch {}
  // Land the rewrite through a same-directory temp file so a crash mid-write
  // cannot leave the tracked declaration truncated.
  const tempPath = `${path}.rebind-${process.pid}.tmp`;
  writeFileSync(tempPath, contents);
  try {
    renameSync(tempPath, path);
  } catch (error) {
    unlinkSync(tempPath);
    throw error;
  }
  return true;
}

/**
 * Rebind the per-change declaration to a base and validate the shape the
 * acceptance run will enforce: the base resolves and is an ancestor of HEAD,
 * the declaration names that base, and declared files exactly cover
 * diff(base, HEAD). With --apply, the rebinding manifest is validated in
 * memory before anything is written, so a structurally invalid declaration
 * never reaches disk.
 */
export function evaluateEvidenceRebind({ root, baseRef, apply = false }) {
  const base = resolveBaseRef(root, baseRef);
  assertBaseAncestor(root, base);
  const previous = loadEvidenceManifest(root);
  const manifest = apply ? rebindedManifest(previous, base) : previous;
  const problems = evidenceCoverageProblems(manifest, changedFilesForBase(root, base));
  let wrote = false;
  if (apply) {
    wrote = writeEvidenceManifest(root, manifest);
  }
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
  const args = process.argv.slice(2);
  const applyFlags = args.filter((arg) => arg === "--apply");
  const operands = args.filter((arg) => arg !== "--apply");
  const malformed = operands.length > 1 || applyFlags.length > 1 || operands.some((arg) => arg.startsWith("--"));
  if (malformed) {
    console.error(usage());
    process.exitCode = 1;
  } else {
    try {
      const result = evaluateEvidenceRebind({ root: process.cwd(), baseRef: operands[0] ?? "origin/v2", apply: applyFlags.length === 1 });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === "passed" ? 0 : 1;
    } catch (error) {
      console.error(String(error.message));
      process.exitCode = 1;
    }
  }
}
