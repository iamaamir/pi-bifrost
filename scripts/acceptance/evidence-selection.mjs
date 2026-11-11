import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EVIDENCE_MANIFESTS = ["change-evidence.json", "release-evidence.json"];
const SHA = /^[a-f0-9]{40}$/;
const ZERO_SHA = "0".repeat(40);
const CAP_BYTES = 256 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Evidence selection: ${message}`);
}

export function eventEvidenceBase(env = process.env) {
  const isPullRequest = env.GITHUB_EVENT_NAME === "pull_request";
  const isPush = env.GITHUB_EVENT_NAME === "push";
  if (!isPullRequest && !isPush) return Object.hasOwn(env, "BIFROST_EVIDENCE_BASE") ? env.BIFROST_EVIDENCE_BASE : undefined;
  requireValue(typeof env.GITHUB_EVENT_PATH === "string", "event payload path is unavailable");
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  return isPullRequest ? event?.pull_request?.base?.sha : event?.before;
}

/** Select exactly one fixed-path declaration bound to the trusted event base. */
export function selectEvidenceManifest({ root, base }) {
  requireValue(typeof base === "string" && SHA.test(base) && base !== ZERO_SHA, "a full nonzero base commit is required");
  const present = [];
  for (const file of EVIDENCE_MANIFESTS) {
    const path = join(root, file);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    requireValue(stat.isFile() && stat.size <= CAP_BYTES, `${file} must be a regular file no larger than 256 KiB`);
    let manifest;
    try { manifest = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { throw new Error(`Evidence selection: ${file} is not valid JSON: ${String(error.message).split("\n")[0]}`); }
    present.push({ file, path, manifest });
  }
  const matching = present.filter((item) => item.manifest?.base === base);
  requireValue(matching.length === 1, matching.length === 0
    ? "missing, unsupported or stale declaration: no declaration is bound to the trusted event base"
    : "multiple declarations are bound to the trusted event base");
  const selected = matching[0];
  requireValue(selected.manifest?.schemaVersion === 1, `${selected.file} must use schemaVersion 1`);
  requireValue(Array.isArray(selected.manifest?.contracts) && selected.manifest.contracts.length > 0,
    `${selected.file} must contain at least one contract`);
  return { ...selected, base };
}
