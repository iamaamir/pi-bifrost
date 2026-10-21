import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { git, matchNamedTestEvent, normalizedTestPath } from "./core.mjs";

const MANIFEST = "change-evidence.json";
const SHA = /^[a-f0-9]{40}$/;
const ZERO_SHA = "0".repeat(40);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Change evidence: ${message}`);
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safePath(value) {
  return text(value) && !isAbsolute(value) && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

export function validateChangeEvidence({ manifest, base, changedFiles, testEvents, root }) {
  requireValue(SHA.test(base), "a full base commit is required");
  requireValue(manifest?.schemaVersion === 1 && manifest.base === base, "missing, unsupported or stale declaration");
  requireValue(Array.isArray(manifest.contracts) && manifest.contracts.length > 0, "contracts must not be empty");
  const changed = new Set(changedFiles.filter((file) => file !== MANIFEST));
  const covered = new Map();
  const ids = new Set();
  for (const contract of manifest.contracts) {
    requireValue(text(contract?.id) && !ids.has(contract.id), "contract IDs must be unique and nonempty");
    ids.add(contract.id);
    requireValue(/^R(?:0[1-9]|1[0-7])$/.test(contract.requirement), "unknown requirement");
    requireValue(text(contract.boundary) && text(contract.assertions), "boundary and observable assertions are required");
    requireValue(Array.isArray(contract.files) && contract.files.length > 0, "changed files are required");
    for (const file of contract.files) {
      requireValue(safePath(file) && changed.has(file), `file is not in the candidate diff: ${file}`);
      requireValue(!covered.has(file), `duplicate file coverage: ${file} declared by ${covered.get(file)} and ${contract.id}`);
      covered.set(file, contract.id);
    }
    for (const dimension of ["boundaryTest", "invariant", "fault"]) {
      const evidence = contract[dimension];
      requireValue(evidence && typeof evidence === "object" && !Array.isArray(evidence), `${contract.id}: missing ${dimension}`);
      if (Object.hasOwn(evidence, "exception")) {
        requireValue(Object.keys(evidence).length === 1 && text(evidence.exception), `${contract.id}: exception requires a rationale and cannot also declare a test`);
        continue;
      }
      requireValue(safePath(evidence.file) && evidence.file.startsWith("tests/") && text(evidence.name), `${contract.id}: invalid ${dimension} test reference`);
      // Normalize exact paths before using the shared matcher; suffix aliases are not evidence.
      const events = testEvents.filter((event) => typeof event.file === "string"
        && normalizedTestPath(root, event.file) === normalizedTestPath(root, evidence.file));
      const result = matchNamedTestEvent(events, evidence, root);
      requireValue(result?.type === "test:complete" && result.passed === true && !result.skipped && !result.todo,
        `${contract.id}: ${dimension} did not complete uniquely and successfully: ${evidence.file} — ${evidence.name}`);
    }
  }
  requireValue([...changed].every((file) => covered.has(file)), `unmapped changed files: ${[...changed].filter((file) => !covered.has(file)).join(", ")}`);
  return manifest;
}

export function changeEvidenceCase({ root, testEvents, env = process.env }) {
  const isPullRequest = env.GITHUB_EVENT_NAME === "pull_request";
  const isPush = env.GITHUB_EVENT_NAME === "push";
  const required = isPullRequest || isPush || Object.hasOwn(env, "BIFROST_EVIDENCE_BASE");
  if (!required) return null;
  const result = { id: "change-evidence", requirements: ["R16"], boundary: "per-change executed evidence declarations", required: true, attempts: 1, artifacts: [MANIFEST], exclusions: [] };
  try {
    const eventPath = env.GITHUB_EVENT_PATH;
    const event = (isPullRequest || isPush) && typeof eventPath === "string"
      ? JSON.parse(readFileSync(eventPath, "utf8"))
      : null;
    const eventBase = isPullRequest
      ? event?.pull_request?.base?.sha
      : isPush
        ? event?.before
        : undefined;
    // Event-driven checks are fail-closed: a missing or null event base cannot be
    // rescued by a competing local BIFROST_EVIDENCE_BASE. Non-event runs use it.
    const base = (isPullRequest || isPush)
      ? eventBase
      : env.BIFROST_EVIDENCE_BASE;
    requireValue(typeof base === "string" && SHA.test(base) && base !== ZERO_SHA, "a full base commit is required");
    git(root, ["merge-base", "--is-ancestor", base, "HEAD"]);
    const changedFiles = git(root, ["diff", "--name-only", "--no-renames", "-z", base, "HEAD"]).split("\0").filter(Boolean);
    const manifestPath = join(root, MANIFEST);
    const stat = lstatSync(manifestPath);
    requireValue(stat.isFile() && stat.size <= 256 * 1024, "declaration must be a regular file no larger than 256 KiB");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    validateChangeEvidence({ manifest, base, changedFiles, testEvents, root });
    return { ...result, status: "passed", detail: JSON.stringify(manifest) };
  } catch (error) {
    return { ...result, status: "failed", detail: String(error.message) };
  }
}
