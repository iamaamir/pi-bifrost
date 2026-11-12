#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHistory, renderTrend } from "./crap-report.mjs";

const REPORT_SCHEMA_VERSION = 1;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_REPORT_BYTES = 512 * 1024;
export const MAX_CASES = 500;
const MAX_CAUSE_DEPTH = 2;
const STATUSES = new Set(["passed", "failed", "blocked", "missing", "deferred"]);
const REQUIRED_GATES = [
  "preflight",
  "unit",
  "typecheck",
  "router-build",
  "pinned-pi-integration",
  "pinned-pi-ui",
  "pinned-pi-reliability-ui",
];

function redact(value) {
  return value
    .replace(/((?:proxy-)?authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n]+/gim, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
}

function boundedText(value, limit = 1_000) {
  return typeof value === "string" ? redact(value).slice(0, limit) : "";
}

function normalizeFailure(error, depth = 0) {
  if (depth > MAX_CAUSE_DEPTH || !error || typeof error !== "object") return undefined;
  const safe = {};
  for (const key of ["code", "failureType"]) {
    if (typeof error[key] === "string") safe[key] = boundedText(error[key], 128);
  }
  if (typeof error.message === "string") safe.message = boundedText(error.message, 2_048);
  if (typeof error.stack === "string") safe.stack = boundedText(error.stack, 6_144);
  if (depth < MAX_CAUSE_DEPTH && error.cause && typeof error.cause === "object") {
    const cause = normalizeFailure(error.cause, depth + 1);
    if (cause) safe.cause = cause;
  }
  return Object.keys(safe).length ? safe : undefined;
}

function normalizeAttempt(attempt) {
  if (typeof attempt === "number" && Number.isFinite(attempt)) return attempt;
  if (typeof attempt === "string") return boundedText(attempt, 500);
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return null;
  const safe = {};
  if (Number.isFinite(attempt.durationMs)) safe.durationMs = attempt.durationMs;
  if (typeof attempt.result === "string") safe.result = boundedText(attempt.result, 100);
  if (typeof attempt.testFile === "string") safe.testFile = boundedText(attempt.testFile, 500);
  if (typeof attempt.testName === "string") safe.testName = boundedText(attempt.testName, 500);
  const failure = normalizeFailure(attempt.failure);
  if (failure) safe.failure = failure;
  return safe;
}

function normalizeSource(source = {}) {
  if (!source || typeof source !== "object" || Array.isArray(source)) source = {};
  const result = {};
  for (const key of ["revisionAtStart", "revisionAtEnd", "fingerprintAtStart", "fingerprintAtEnd"]) {
    if (typeof source[key] === "string") result[key] = boundedText(source[key], 256);
  }
  if (typeof source.changedDuringRun === "boolean") result.changedDuringRun = source.changedDuringRun;
  for (const key of ["dirtyPathsAtStart", "dirtyPathsAtEnd"]) {
    if (!Array.isArray(source[key])) continue;
    result[key] = source[key].slice(0, 2_000).map((entry) => ({
      index: boundedText(entry?.index, 8),
      path: boundedText(entry?.path, 1_000),
    }));
  }
  return result;
}

export function makeReportData(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Evidence must be a JSON object");
  if (evidence.schemaVersion !== 1) throw new Error("Unsupported acceptance evidence schema version");
  if (!Array.isArray(evidence.cases)) throw new Error("Evidence cases must be a bounded array");
  const cases = evidence.cases.slice(0, MAX_CASES);
  const truncatedCases = evidence.cases.length - cases.length;
  const safeEvidence = {
    schemaVersion: 1,
    profile: boundedText(evidence.profile, 40),
    startedAt: boundedText(evidence.startedAt, 80),
    endedAt: boundedText(evidence.endedAt, 80),
    exitCode: Number.isInteger(evidence.exitCode) ? evidence.exitCode : null,
    source: normalizeSource(evidence.source),
    toolVersions: Object.fromEntries(Object.entries(evidence.toolVersions ?? {}).slice(0, 40).map(([key, value]) => [boundedText(key, 100), boundedText(value, 200)])),
    cases: cases.map((item, index) => ({
      order: Number.isInteger(item?.order) ? item.order : index + 1,
      id: boundedText(item?.id ?? `case-${index + 1}`, 200),
      requirements: Array.isArray(item?.requirements) ? item.requirements.slice(0, 20).map((value) => boundedText(value, 80)) : [],
      boundary: boundedText(item?.boundary, 300),
      status: STATUSES.has(item?.status) ? item.status : "missing",
      required: item?.required !== false,
      startedAt: boundedText(item?.startedAt, 80) || null,
      endedAt: boundedText(item?.endedAt, 80) || null,
      durationMs: Number.isFinite(item?.durationMs) ? item.durationMs : null,
      attempts: Array.isArray(item?.attempts) ? item.attempts.slice(0, 20).map(normalizeAttempt) : Number.isFinite(item?.attempts) ? item.attempts : [],
      exclusions: Array.isArray(item?.exclusions) ? item.exclusions.slice(0, 20).map((value) => boundedText(value, 300)) : [],
      artifacts: Array.isArray(item?.artifacts) ? item.artifacts.slice(0, 30).map((value) => boundedText(value, 1_000)) : [],
      ...(item?.detail ? { detail: boundedText(String(item.detail), 2_000) } : {}),
    })),
    ...(truncatedCases > 0 ? { truncatedCases } : {}),
  };
  const output = { schemaVersion: REPORT_SCHEMA_VERSION, evidence: safeEvidence };
  if (Buffer.byteLength(JSON.stringify(output)) > MAX_REPORT_BYTES) throw new Error("Normalized report data exceeds the size limit");
  return output;
}

export function validateReportData(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Evidence must be a JSON object");
  if (evidence.schemaVersion !== 1) throw new Error("Unsupported acceptance evidence schema version");
  if (!Array.isArray(evidence.cases) || evidence.cases.length > MAX_CASES) throw new Error("Evidence cases must be a bounded array");
  return makeReportData(evidence);
}

function escapeCell(value) {
  return boundedText(String(value ?? "—"), 1_200)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/@/g, "&#64;");
}

function code(value) {
  const text = boundedText(String(value ?? "—"), 1_000).replace(/\]\(/g, "] (").replace(/@/g, "&#64;").replace(/[\r\n\t]+/g, " ");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(longest + 1);
  const needsPadding = /^[ `]|[ `]$/u.test(text);
  return `${fence}${needsPadding ? ` ${text} ` : text}${fence}`;
}

function trustedRunUrl(context) {
  if (context.trusted !== true) return undefined;
  if (!/^\d{1,30}$/.test(String(context.runId ?? ""))) return undefined;
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(String(context.repository ?? ""))) return undefined;
  if (String(context.repository).split("/").some((part) => part === "." || part === "..")) return undefined;
  try {
    const base = new URL(context.serverUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return undefined;
    const rootPath = base.pathname.replace(/\/$/u, "");
    base.pathname = `${rootPath}/${context.repository}/actions/runs/${context.runId}`;
    return base.toString();
  } catch {
    return undefined;
  }
}

function statusEmoji(status) {
  return ({ passed: "🟩 PASS", failed: "🟥 FAIL", blocked: "🟨 BLOCKED", missing: "⬜ MISSING", deferred: "⏳ DEFERRED" })[status] ?? "⬜ MISSING";
}

function confidenceVisual(state) {
  return ({ "VERIFIED CHECKS": "🟢 VERIFIED CHECKS", BLOCKED: "🔴 BLOCKED", INCOMPLETE: "🟠 INCOMPLETE", LIMITED: "🟡 LIMITED" })[state] ?? "🟠 INCOMPLETE";
}

function countStatuses(cases) {
  const counts = { passed: 0, failed: 0, blocked: 0, missing: 0, deferred: 0 };
  for (const item of cases) counts[item.status]++;
  return counts;
}

function caseStatusMap(cases) {
  return new Map(cases.map((item) => [item.id, item]));
}

function fingerprintRelation(source) {
  if (!source?.fingerprintAtStart || !source?.fingerprintAtEnd) return "unknown";
  return source.fingerprintAtStart === source.fingerprintAtEnd ? "match" : "differ";
}

function elapsedMs(evidence) {
  const start = Date.parse(evidence.startedAt);
  const end = Date.parse(evidence.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function determineConfidence(data, context, counts) {
  const evidence = data.evidence;
  if (context.conclusion === "in_progress") return { state: "INCOMPLETE", reasons: ["Workflow is still in progress; final acceptance evidence is pending."] };
  if (context.conclusion && context.conclusion !== "success") return { state: "BLOCKED", reasons: [`The workflow concluded ${boundedText(context.conclusion, 80)}.`] };
  if (!evidence || evidence.schemaVersion !== 1 || !evidence.cases?.length) return { state: "INCOMPLETE", reasons: ["Acceptance evidence is missing or malformed."] };
  if (!evidence.profile || !Number.isInteger(evidence.exitCode) || !evidence.source?.revisionAtStart || !evidence.source?.revisionAtEnd || !evidence.source?.fingerprintAtStart || !evidence.source?.fingerprintAtEnd) {
    return { state: "INCOMPLETE", reasons: ["Evidence is missing a profile, process result, or source identity field."] };
  }
  if (!/^[a-f\d]{7,64}$/i.test(String(context.sha ?? ""))) return { state: "INCOMPLETE", reasons: ["The report has no valid trusted commit identity."] };
  if (evidence.exitCode !== 0) return { state: "BLOCKED", reasons: ["The acceptance command returned a nonzero exit code."] };
  if (evidence.source?.changedDuringRun || evidence.source?.revisionAtStart !== evidence.source?.revisionAtEnd || evidence.source?.fingerprintAtStart !== evidence.source?.fingerprintAtEnd) {
    return { state: "BLOCKED", reasons: ["Source revision or fingerprint changed during the run; this evidence is stale."] };
  }
  if (!Array.isArray(evidence.source?.dirtyPathsAtStart) || !Array.isArray(evidence.source?.dirtyPathsAtEnd)) {
    return { state: "INCOMPLETE", reasons: ["Evidence does not state whether the tested working tree was clean."] };
  }
  if (evidence.source.dirtyPathsAtStart.length || evidence.source.dirtyPathsAtEnd.length) {
    return { state: "BLOCKED", reasons: ["The tested working tree was dirty; the result cannot be tied to the commit."] };
  }
  if (context.sha.toLowerCase() !== evidence.source.revisionAtStart.toLowerCase()) {
    return { state: "BLOCKED", reasons: ["Evidence revision does not match the requested commit; this report is stale."] };
  }
  const byId = caseStatusMap(evidence.cases);
  if (byId.size !== evidence.cases.length) return { state: "BLOCKED", reasons: ["Duplicate case identifiers make this evidence ambiguous."] };
  const missingGates = REQUIRED_GATES.filter((id) => !byId.has(`gate:${id}`));
  const badGates = REQUIRED_GATES.filter((id) => {
    const item = byId.get(`gate:${id}`);
    return item && item.status !== "passed";
  });
  if (missingGates.length || badGates.length) {
    const reasons = [];
    if (missingGates.length) reasons.push(`Required gates are missing: ${missingGates.join(", ")}.`);
    if (badGates.length) reasons.push(`Required gates did not pass: ${badGates.join(", ")}.`);
    return { state: "BLOCKED", reasons };
  }
  const requiredIssues = evidence.cases.filter((item) => item.required && ["failed", "blocked", "missing", "deferred"].includes(item.status));
  if (requiredIssues.length) return { state: "BLOCKED", reasons: [`${requiredIssues.length} required acceptance case(s) failed, blocked, missing, or deferred.`] };
  if (counts.failed > 0) return { state: "BLOCKED", reasons: [`${counts.failed} failed acceptance case(s) need review.`] };
  if (context.conclusion !== "success") return { state: "INCOMPLETE", reasons: ["The final workflow conclusion has not been supplied."] };
  if (evidence.profile !== "deterministic") return { state: "LIMITED", reasons: [`The ${boundedText(evidence.profile, 40) || "unknown"} profile does not establish the deterministic acceptance boundary.`] };
  return { state: "VERIFIED CHECKS", reasons: [] };
}

function issueRows(cases) {
  return cases.filter((item) => item.status === "failed" || (item.required && ["blocked", "missing", "deferred"].includes(item.status)))
    .sort((a, b) => a.order - b.order)
    .slice(0, 8);
}

function conciseIssue(item) {
  return boundedText(item.detail || item.boundary || "Review this required case.", 200);
}

function fullIssue(item) {
  const detail = boundedText(item.detail || item.boundary || "Review this case.", 300);
  const paths = item.artifacts.length ? `\n\nArtifacts: ${item.artifacts.slice(0, 3).map((path) => code(boundedText(path, 200))).join(", ")}${item.artifacts.length > 3 ? `, and ${item.artifacts.length - 3} more in the workflow artifact` : ""}` : "";
  return `- **${statusEmoji(item.status)} ${escapeCell(item.id)}** — ${escapeCell(detail)}${paths}`;
}

function resolveCrapHistory(context) {
  if (Array.isArray(context?.crapHistory)) return context.crapHistory;
  if (typeof context?.crapHistory === "string") {
    return context.crapHistory.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  }
  if (typeof context?.crapHistoryPath === "string") {
    try {
      return readHistory(context.crapHistoryPath);
    } catch {
      return [];
    }
  }
  return [];
}

export function renderCiReport(inputData, context = {}) {
  context ??= {};
  let data;
  try {
    data = inputData?.schemaVersion === REPORT_SCHEMA_VERSION && Array.isArray(inputData.evidence?.cases)
      ? makeReportData(inputData.evidence)
      : makeReportData(inputData);
  } catch {
    data = makeReportData({ schemaVersion: 1, cases: [] });
  }
  const evidence = data.evidence;
  const counts = countStatuses(evidence.cases);
  const confidence = determineConfidence(data, context, counts);
  const runUrl = trustedRunUrl(context);
  const sha = /^[a-f\d]{7,64}$/i.test(String(context.sha ?? "")) ? context.sha : "unknown";
  const run = /^\d{1,30}$/.test(String(context.runId ?? "")) ? String(context.runId) : "unknown";
  const attempt = /^\d{1,10}$/.test(String(context.attempt ?? "")) ? String(context.attempt) : "unknown";
  const duration = elapsedMs(evidence);
  const durationText = duration === null ? "unknown" : `${(duration / 1000).toFixed(1)} s`;
  const gates = REQUIRED_GATES.map((id) => caseStatusMap(evidence.cases).get(`gate:${id}`));
  const issues = issueRows(evidence.cases);
  const deferred = evidence.cases.filter((item) => item.status === "deferred");

  const crapRecords = resolveCrapHistory(context);
  let crapSection;
  if (crapRecords.length > 0) {
    const latest = crapRecords[crapRecords.length - 1];
    crapSection = [];
    crapSection.push("### CRAP analysis");
    crapSection.push("");
    crapSection.push(
      `- Current (rev ${code(latest.revision ?? "unknown")}${latest.dirty ? "*" : ""}, ${latest.at ? String(latest.at).slice(0, 10) : "unknown"}): ${latest.flagged ?? "?"}/${latest.functions ?? "?"} flagged at or above ${latest.threshold ?? "?"} (${latest.percentFlagged ?? "?"}%); max ${latest.max ?? "?"}`,
    );
    if (crapRecords.length > 1) {
      const first = crapRecords[0];
      const delta = (latest.flagged ?? 0) - (first.flagged ?? 0);
      const direction = delta === 0 ? "unchanged" : delta > 0 ? "drifting up" : "improving";
      crapSection.push(
        `- Trend: ${crapRecords.length} snapshots ${String(first.at ?? "?").slice(0, 10)} → ${String(latest.at ?? "?").slice(0, 10)}: flagged ${first.flagged} → ${latest.flagged} (${delta >= 0 ? "+" : ""}${delta}), ${direction}.`,
      );
    }
    crapSection.push("");
    const trend = renderTrend(crapRecords, latest.threshold ?? 30);
    crapSection.push("```text");
    crapSection.push(...trend.split("\n"));
    crapSection.push("```");
    crapSection.push("");
  } else {
    crapSection = [
      "### CRAP analysis",
      "",
      "Not included in this run. Supply CRAP history via CI artifacts or run `npm run crap` locally.",
      "",
    ];
  }

  const scope = evidence.profile === "live"
    ? "Scope: Live profile; one approved model allowlisted; provider requests may be blocked; PRD coverage partial."
    : "Scope: Pi + fake providers; live providers not tested; PRD coverage partial.";
  const workflowLinks = runUrl ? `[Workflow run](${runUrl}) · [Artifacts](${runUrl}#artifacts)` : "Workflow and artifact links are available when published by CI.";
  const resultLine = context.conclusion === "in_progress" ? "Result: ⏳ PENDING · Waiting for final acceptance evidence." : undefined;
  const report = [
    "## Pi-Bifrost CI",
    "",
    `> **PR confidence: ${confidenceVisual(confidence.state)} (required checks only)** · 🟩 ${counts.passed} passed · 🟥 ${counts.failed} failed · 🟨 ${counts.blocked} blocked · ⬜ ${counts.missing} missing · ⏳ ${counts.deferred} deferred`,
    `> **${scope}**`,
    `> **Workflow result: ${{ success: "🟢 PASS", failure: "🔴 FAIL", cancelled: "🔴 CANCELLED", in_progress: "⏳ PENDING" }[context.conclusion] ?? "⬜ UNKNOWN"}** · Passing checks alone do not clear required acceptance cases.`,
    "",
    `SHA ${code(sha.slice(0, 7))} · Run ${code(run)} · Attempt ${code(attempt)} · ${durationText} · Profile: ${code(evidence.profile || "unknown")} · ${workflowLinks}`,
    ...(resultLine ? [resultLine] : []),
    "",
    "### Individual release checks",
    "",
    "| Required gate | Status |",
    "| --- | --- |",
    ...REQUIRED_GATES.map((id, index) => {
      const gate = gates[index];
      return `| ${escapeCell(gate?.boundary === "installed-tool-preflight" ? "Preflight" : ({ unit: "Unit tests", typecheck: "Typecheck", "router-build": "Router build", "pinned-pi-integration": "Pi integration", "pinned-pi-ui": "Pi UI", "pinned-pi-reliability-ui": "Reliability UI" }[id] ?? id))} | ${gate ? statusEmoji(gate.status) : statusEmoji("missing")} |`;
    }),
    "",
    ...crapSection,
    "### Action needed",
    "",
    ...(issues.length ? issues.slice(0, 2).map((item) => `- **${statusEmoji(item.status)} ${escapeCell(item.id)}** — ${escapeCell(conciseIssue(item))}`) : confidence.reasons.length ? confidence.reasons.slice(0, 2).map((reason) => `- ${escapeCell(reason)}`) : ["- No failed, blocked, or missing required cases were recorded." ]),
    "",
    "<details>",
    "<summary>Full issues, provenance, deferred work, and evidence paths</summary>",
    "",
    "### Full issue details",
    "",
    ...(issues.length ? issues.map(fullIssue) : ["No failed, blocked, or missing required cases were recorded."]),
    "",
    "### Provenance and limits",
    "",
    `- Commit: ${code(sha)} · Run: ${code(run)} · Attempt: ${code(attempt)} · Workflow duration: ${durationText}`,
    `- Source revision: start ${code(evidence.source?.revisionAtStart || "unknown")}; end ${code(evidence.source?.revisionAtEnd || "unknown")}. Fingerprints: ${fingerprintRelation(evidence.source)}; changedDuringRun: ${evidence.source?.changedDuringRun ?? "unknown"}.`,
    `- ${evidence.profile === "live" ? "The opt-in live profile covers only its approved model and run; it does not establish support for every provider or a flake-free rate." : "Live providers were not run by deterministic CI. Fake-provider results cover only their named cases; they do not establish support for every provider or a flake-free rate."}`,
    `- Deferred cases: ${deferred.length ? deferred.slice(0, 5).map((item) => `${code(item.id)} (${escapeCell(item.boundary || "scope deferred")})`).join(", ") + (deferred.length > 5 ? `, and ${deferred.length - 5} more in the evidence` : "") : "none recorded"}.`,
    "- This report describes recorded checks for one commit. The PR controls the workflow producer and test code, so review those changes before relying on the result. It is not a probability of correctness or a claim that all product requirements are covered.",
    "",
    "</details>",
  ].join("\n");
  return { markdown: report + "\n", confidence, counts };
}

export function writeCiReport({ evidence, outputDir, context = {} }) {
  const data = makeReportData(evidence);
  mkdirSync(outputDir, { recursive: true });
  const dataPath = join(outputDir, "report-data.json");
  const markdownPath = join(outputDir, "ci-report.md");
  writeFileSync(dataPath, JSON.stringify(data), { mode: 0o600 });
  writeFileSync(markdownPath, renderCiReport(data, context).markdown, { mode: 0o600 });
  return { dataPath, markdownPath };
}

export function exportCiReportIfConfigured({ isMain, profile, evidence, artifactDir, env = process.env }) {
  if (!isMain || profile !== "deterministic" || env.GITHUB_ACTIONS !== "true" || env.BIFROST_CI_REPORT !== "1") return undefined;
  const outputs = writeCiReport({
    evidence,
    outputDir: artifactDir,
    context: {
      trusted: true,
      sha: env.BIFROST_CI_REPORT_SHA,
      runId: env.BIFROST_CI_REPORT_RUN_ID,
      attempt: env.BIFROST_CI_REPORT_RUN_ATTEMPT,
      repository: env.BIFROST_CI_REPORT_REPOSITORY,
      serverUrl: env.BIFROST_CI_REPORT_SERVER_URL,
    },
  });
  const reportPath = outputs.markdownPath;
  const dataPath = outputs.dataPath;
  if ([reportPath, dataPath].some((value) => /[\r\n]/u.test(value))) throw new Error("CI report export paths cannot contain newlines");
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `report-markdown=${reportPath}\nreport-data=${dataPath}\n`, { mode: 0o600 });
  }
  return outputs;
}

function parseArgs(argv) {
  const values = {};
  const names = new Set(["--evidence", "--output-dir", "--sha", "--run-id", "--attempt", "--repository", "--server-url", "--conclusion"]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!names.has(flag)) throw new Error(`Unknown flag: ${flag}`);
    if (values[flag] !== undefined) throw new Error(`${flag} may only be specified once`);
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values[flag] = value;
  }
  if (!values["--evidence"]) throw new Error("--evidence is required");
  return {
    evidencePath: values["--evidence"],
    outputDir: values["--output-dir"],
    context: {
      sha: values["--sha"],
      runId: values["--run-id"],
      attempt: values["--attempt"],
      repository: values["--repository"],
      serverUrl: values["--server-url"],
      conclusion: values["--conclusion"],
    },
  };
}

export function runReportCli(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const size = statSync(options.evidencePath).size;
    if (size > MAX_INPUT_BYTES) throw new Error("Evidence input exceeds the size limit");
    const evidence = JSON.parse(readFileSync(options.evidencePath, "utf8"));
    const outputDir = options.outputDir ? resolve(options.outputDir) : dirname(resolve(options.evidencePath));
    const outputs = writeCiReport({ evidence, outputDir, context: options.context });
    process.stdout.write(`CI report: ${outputs.markdownPath}\nReport data: ${outputs.dataPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runReportCli();
}
