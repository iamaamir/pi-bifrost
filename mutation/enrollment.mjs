// Capability-owned mutation enrollment.
//
// A capability may own the mutation records for its own source files in a
// data-only `modules/<capability>/mutation.json`. This module is the single
// discovery and normalization boundary: config, the runner, the planner and the
// reporter all consume the inventory composed from here, so a descriptor cannot
// disagree with the target set.
//
// The descriptor is deliberately not executable. Shared policy (runner choice,
// Stryker options, sharding, thresholds, report policy) stays in
// ./config.mjs; a capability only declares which of its files are measured and
// the measured facts about that file.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The only filename a capability may use to enroll mutation targets. */
export const CAPABILITY_DESCRIPTOR = "mutation.json";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MODULES = "modules";
const SUPPORTED_RUNNERS = new Set(["bun", "tap"]);
const TOP_LEVEL_FIELDS = new Set(["targets"]);
const RECORD_FIELDS = new Set([
  "file",
  "mutants",
  "secondsPerMutant",
  "timeoutFactor",
  "timeoutMS",
  "runner",
  "reason",
]);

let defaultDiscovery = null;

/**
 * Flat on-disk stem for one target's reports.
 *
 * A target can sit in a subdirectory (`scripts/toolbox.mjs`). Naming the report
 * after the target path puts it in a nested directory, which the workflow's
 * collection glob and the artifact upload both read as a top-level file, so the
 * run published no report and failed its own completeness gate. One flat stem
 * keeps every report beside the others. Path naming is part of enrollment, so
 * the same rule validates a descriptor and names its report.
 */
export function reportStem(target) {
  return target.replaceAll("/", "__");
}

/** Refuse two targets whose flat report names would collide. */
export function assertUniqueReportStems(targets) {
  const stems = new Map();
  for (const target of targets) {
    const stem = reportStem(target);
    if (stems.has(stem)) {
      throw new Error(
        `mutation targets ${stems.get(stem)} and ${target} share report stem ${stem}; their reports would collide`,
      );
    }
    stems.set(stem, target);
  }
}

function fail(descriptor, message) {
  throw new Error(`mutation enrollment ${descriptor}: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unknownFields(value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

/**
 * Walk every component of `relativePath` below `root`, refusing a symlink in any
 * of them. Returns false when the path does not exist, so an absent optional
 * descriptor can be told apart from a broken one.
 */
function assertNoSymlink(root, relativePath, descriptor) {
  const segments = relativePath.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      fail(descriptor, `cannot inspect ${segments.slice(0, index + 1).join("/")}: ${error.message}`);
    }
    if (stat.isSymbolicLink()) {
      fail(
        descriptor,
        `${segments.slice(0, index + 1).join("/")} is a symlink; enrollment paths must be real directories and files`,
      );
    }
  }
  return true;
}

function validateFile(file, descriptor) {
  if (typeof file !== "string" || file === "" || file !== file.trim()) {
    fail(descriptor, "each target needs a non-empty capability-relative file");
  }
  if (file.includes("\0")) fail(descriptor, `file "${file}" must not contain NUL`);
  if (file.includes("\\")) fail(descriptor, `file "${file}" must use forward slashes (noncanonical path)`);
  if (file.startsWith("/") || /^[A-Za-z]:/u.test(file)) {
    fail(descriptor, `file "${file}" must be capability-relative, not absolute`);
  }
  if (/[*?[\]{}!]/u.test(file)) fail(descriptor, `file "${file}" must not contain glob characters`);
  // The workflow passes plan-cli's target list through a comma-separated string;
  // a comma or line break in a path would split it into unknown module names.
  if (/[,\r\n]/u.test(file)) {
    fail(descriptor, `file "${file}" must not contain a comma or line break; the workflow serializes targets as a comma-separated list`);
  }
  if (file.includes(":")) fail(descriptor, `file "${file}" must not contain a drive or stream separator`);
  const segments = file.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(descriptor, `file "${file}" must be a canonical capability-relative path with no empty, dot or traversal segments`);
  }
  if (segments.includes("node_modules")) {
    fail(descriptor, `file "${file}" must be a runtime source, not under node_modules`);
  }
  if (segments.some((segment) => ["tests", "test", "__tests__"].includes(segment))) {
    fail(descriptor, `file "${file}" must be a runtime source, not a test file`);
  }
  if (!/\.(?:ts|mjs)$/u.test(file)) {
    fail(descriptor, `file "${file}" must be a runtime .ts or .mjs source`);
  }
  if (file.endsWith(".d.ts") || /\.(?:test|spec)\.(?:ts|mjs)$/u.test(file)) {
    fail(descriptor, `file "${file}" must be a runtime source, not a declaration or test file`);
  }
}

function validateRecord(value, index, descriptor) {
  const label = `target ${index + 1}`;
  if (!isObject(value)) fail(descriptor, `${label} must be an object`);
  const unknown = unknownFields(value, RECORD_FIELDS);
  if (unknown.length > 0) fail(descriptor, `${label} has unknown field(s): ${unknown.join(", ")}`);
  for (const field of ["file", "mutants", "secondsPerMutant", "timeoutFactor", "timeoutMS"]) {
    if (!(field in value)) fail(descriptor, `${label} is missing ${field}`);
  }
  validateFile(value.file, descriptor);
  if (!Number.isInteger(value.mutants) || value.mutants <= 0) {
    fail(descriptor, `${label} mutants must be a positive integer`);
  }
  if (!Number.isFinite(value.secondsPerMutant) || value.secondsPerMutant <= 0) {
    fail(descriptor, `${label} secondsPerMutant must be a finite positive number`);
  }
  if (!Number.isFinite(value.timeoutFactor) || value.timeoutFactor <= 0) {
    fail(descriptor, `${label} timeoutFactor must be a finite positive number`);
  }
  if (!Number.isInteger(value.timeoutMS) || value.timeoutMS <= 0) {
    fail(descriptor, `${label} timeoutMS must be a positive integer`);
  }
  if ("runner" in value) {
    if (!SUPPORTED_RUNNERS.has(value.runner)) {
      fail(descriptor, `${label} has unsupported runner "${value.runner}"; expected bun or tap`);
    }
    if (typeof value.reason !== "string" || value.reason.trim() === "") {
      fail(descriptor, `${label} runner "${value.runner}" needs a non-empty reason`);
    }
  } else if ("reason" in value) {
    fail(descriptor, `${label} has a reason without a runner; a reason only explains an override`);
  }
  return value;
}

function parseDescriptor(capability, descriptorRelative, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(descriptorRelative, `malformed JSON: ${error.message}`);
  }
  if (!isObject(parsed)) fail(descriptorRelative, "must contain a JSON object");
  const unknown = unknownFields(parsed, TOP_LEVEL_FIELDS);
  if (unknown.length > 0) fail(descriptorRelative, `has unknown field(s): ${unknown.join(", ")}`);
  if (!Array.isArray(parsed.targets)) fail(descriptorRelative, 'must contain a "targets" array');
  if (parsed.targets.length === 0) {
    fail(descriptorRelative, "is empty; remove the descriptor instead of enrolling nothing");
  }
  // The bytes that produced this snapshot. A later recheck compares it with the
  // descriptor on disk, so a mid-run edit cannot stamp a report whose identity
  // claims metadata the run never used.
  const descriptorDigest = createHash("sha256").update(raw).digest("hex");
  return parsed.targets.map((value, index) => {
    const record = validateRecord(value, index, descriptorRelative);
    return {
      capability,
      descriptor: descriptorRelative,
      descriptorDigest,
      file: record.file,
      target: `${MODULES}/${capability}/${record.file}`,
      mutants: record.mutants,
      secondsPerMutant: record.secondsPerMutant,
      timeoutFactor: record.timeoutFactor,
      timeoutMS: record.timeoutMS,
      ...(record.runner === undefined ? {} : { runner: record.runner, reason: record.reason }),
    };
  });
}

function discover(root) {
  const result = { names: [], records: [], targets: {}, estimates: {}, overrides: {}, descriptors: {} };
  const modulesRelative = MODULES;
  if (!assertNoSymlink(root, modulesRelative, modulesRelative)) return result;
  const modulesPath = join(root, modulesRelative);
  const modulesStat = lstatSync(modulesPath);
  if (!modulesStat.isDirectory()) fail(modulesRelative, "must be a directory");

  const capabilities = readdirSync(modulesPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const records = [];
  for (const entry of capabilities) {
    if (entry.isSymbolicLink()) fail(`${modulesRelative}/${entry.name}`, "capability directory is a symlink");
    if (!entry.isDirectory()) continue;
    const capability = entry.name;
    const descriptorRelative = `${modulesRelative}/${capability}/${CAPABILITY_DESCRIPTOR}`;
    // A capability without a descriptor is not enrolled. This is the opt-out
    // path, so it is deliberately silent; whole-descriptor deletion is reviewed
    // against the base inventory rather than guessed here.
    if (!assertNoSymlink(root, descriptorRelative, descriptorRelative)) continue;
    const descriptorPath = join(root, descriptorRelative);
    const descriptorStat = lstatSync(descriptorPath);
    if (!descriptorStat.isFile()) {
      fail(descriptorRelative, "must be a regular file, not a directory or special file");
    }
    let raw;
    try {
      raw = readFileSync(descriptorPath, "utf8");
    } catch (error) {
      fail(descriptorRelative, `is unreadable: ${error.message}`);
    }
    for (const record of parseDescriptor(capability, descriptorRelative, raw)) {
      const sourceRelative = record.target;
      if (!assertNoSymlink(root, sourceRelative, descriptorRelative)) {
        fail(descriptorRelative, `missing source file ${sourceRelative}`);
      }
      const sourceStat = lstatSync(join(root, sourceRelative));
      if (!sourceStat.isFile()) {
        fail(descriptorRelative, `source ${sourceRelative} must be a regular file`);
      }
      records.push(record);
    }
  }

  // Deterministic order: a stable code-unit comparison of the normalized target
  // path. Directory read order is irrelevant, and the old incidental order is
  // not recreated with ordinals or a hidden path list.
  records.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));

  const seen = new Set();
  for (const record of records) {
    if (seen.has(record.target)) {
      fail(record.descriptor, `duplicate normalized target ${record.target}`);
    }
    seen.add(record.target);
    result.names.push(record.target);
    result.records.push(record);
    result.targets[record.target] = {
      timeoutFactor: record.timeoutFactor,
      timeoutMS: record.timeoutMS,
      secondsPerMutant: record.secondsPerMutant,
    };
    result.estimates[record.target] = record.mutants;
    if (record.runner !== undefined) {
      result.overrides[record.target] = { runner: record.runner, reason: record.reason };
    }
    result.descriptors[record.target] = record.descriptor;
  }
  assertUniqueReportStems(result.names);
  return result;
}

/**
 * Discover and validate the capability descriptors below `root`.
 *
 * The default repository discovery is cached because every consumer runs in one
 * process against one checkout. Identity computation deliberately re-reads the
 * descriptor from disk, so a mid-run edit is still detected.
 */
export function discoverCapabilityTargets({ root = ROOT } = {}) {
  if (root === ROOT && defaultDiscovery) return defaultDiscovery;
  const result = discover(root);
  if (root === ROOT) defaultDiscovery = result;
  return result;
}

/** The descriptor that enrolls `target`, or null for a central target. */
export function capabilityDescriptorFor(target) {
  return discoverCapabilityTargets().descriptors[target] ?? null;
}

/**
 * Re-discover from disk and prove `target` is still enrolled.
 *
 * A measurement must not stamp a target whose descriptor was removed or
 * replaced during the run. Re-reading here makes identity computation fail
 * closed instead of trusting the cached normalized inventory. Central targets
 * return null without a filesystem walk.
 */
export function assertEnrollmentCurrent(target, { root = ROOT, snapshot = null } = {}) {
  if (!target.startsWith(`${MODULES}/`)) return null;
  const record = discover(root).records.find((entry) => entry.target === target);
  if (!record) {
    throw new Error(
      `mutation target ${target} is no longer enrolled by an on-disk capability descriptor; rerun from the current descriptor`,
    );
  }
  const enrolled =
    snapshot ??
    (root === ROOT
      ? discoverCapabilityTargets().records.find((entry) => entry.target === target)
      : null);
  if (enrolled && enrolled.descriptorDigest !== record.descriptorDigest) {
    throw new Error(
      `enrollment descriptor ${record.descriptor} changed during the run; rerun from the current descriptor`,
    );
  }
  return record;
}
