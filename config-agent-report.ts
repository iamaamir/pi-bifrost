/**
 * Model-facing text rendering for the Bifrost configuration tool.
 *
 * Pure functions over the tool's result types: no IO, validation, routing, or
 * writes live here, and the dependency runs one way. This module imports the
 * result types (and the shared `shortDigest`) from `config-agent.ts`; the host
 * entry passes `reportText` back into the tool as its renderer, so
 * `config-agent.ts` never imports this module.
 */
import {
  shortDigest,
  type ConfigAgentApplyResult,
  type ConfigAgentChange,
  type ConfigAgentCheckResult,
  type ConfigAgentGuards,
  type ConfigAgentInspectResult,
  type ConfigAgentModel,
  type ConfigAgentPreviewResult,
  type ConfigAgentProbeResult,
  type ConfigAgentToolResult,
} from "./config-agent.ts";

import { PROBE_RESOURCE_DISCLOSURE } from "./probe-workload.ts";

const MAX_REPORT_LINES = 120;
/** Changes get their own budget: a long proposal must not push warnings, probe
 * scope, write eligibility, or the apply digests out of the report. */
const MAX_CHANGE_LINES = 40;
/** The protected tail still needs budgets of its own, or a candidate that warns
 * on every model would grow the report without limit. Omitted entries keep a
 * count so the truncation is visible rather than silent. */
const MAX_WARNING_LINES = 12;
const MAX_PROBE_FAILURE_LINES = 8;

// ── Rendering ──────────────────────────────────────────────────

function modelLine(model: ConfigAgentModel): string {
  return `${model.key} ($${model.inputCost.toFixed(2)} in + $${model.outputCost.toFixed(2)} out per 1M, ctx ${model.contextWindow}${model.reasoning ? ", reasoning" : ""})`;
}

function bounded(lines: readonly string[]): string[] {
  if (lines.length <= MAX_REPORT_LINES) return [...lines];
  // The marker is one of the MAX_REPORT_LINES, not an extra line above it.
  const room = MAX_REPORT_LINES - 1;
  return [...lines.slice(0, room), `... ${lines.length - room} more line(s)`];
}

/**
 * Bound the report body but never drop `tail`. The agent copies the tail
 * (the apply digests) off this report, so truncation may only shorten the
 * optional detail above it. The truncation marker is charged to the same
 * budget, and the tail's own detail lines are capped by their builders, so
 * the result never exceeds MAX_REPORT_LINES.
 */
function boundedWithTail(lines: readonly string[], tail: readonly string[]): string[] {
  const available = MAX_REPORT_LINES - tail.length;
  if (lines.length <= available) return [...lines, ...tail];
  const room = Math.max(available - 1, 0);
  return [...lines.slice(0, room), `... ${lines.length - room} more line(s)`, ...tail];
}

function renderInspect(result: ConfigAgentInspectResult): string {
  const lines = [
    "--- bifrost configuration ---",
    `enabled: ${result.routing.enabled}`,
    `schemaVersion: ${result.routing.schemaVersion}`,
    `default tier: ${result.routing.defaultTier ?? "none"}`,
    `global strategy: ${result.routing.strategy ?? "first"}`,
    "layers (lowest to highest precedence):",
    ...result.layers.map((layer) => `  ${layer.layer}${layer.editable ? "" : " (read-only)"}: ${layer.path}${layer.exists ? ` [${layer.bytes} bytes, ${layer.fields.length} field(s)]` : " [absent]"}${layer.readError ? ` -- ${layer.readError}` : ""}`),
    "tiers:",
    ...result.routing.tiers.map((tier) => `  ${tier.tier} (${tier.strategy})${tier.fallbackTiers ? ` fallback: [${tier.fallbackTiers.join(", ")}]` : ""}: ${tier.pool.join(", ") || "empty"}`),
    `classifier runtime (loaded${result.routing.classifier.configGeneration === undefined ? "" : ` generation ${result.routing.classifier.configGeneration}`}): ${result.routing.classifier.enabled ? "enabled" : "disabled"} (${result.routing.classifier.source}); configured=${result.routing.classifier.configuredEnabled ? "on" : "off"}; backend=${result.routing.classifier.backend ?? "auto backend"}${result.routing.classifier.legacyConflict ? `; legacy saved=${result.routing.classifier.legacyConflict.saved} conflicts with configured=${result.routing.classifier.legacyConflict.configured}` : ""}`,
    ...(result.routing.classifier.projected ? [`classifier policy in disk layers: runtime would be ${result.routing.classifier.projected.enabled ? "enabled" : "disabled"} (${result.routing.classifier.projected.source}); configured=${result.routing.classifier.projected.configuredEnabled ? "on" : "off"}; backend=${result.routing.classifier.projected.backend ?? "auto backend"}`] : []),
    ...(result.routing.classifier.loadedConfigMatches === false ? ["loaded config differs from effective disk layers; run /bifrost reload to activate disk changes"] : []),
    ...(result.routing.classifier.runtimeStateIssue ? [`classifier runtime state invalid (${result.routing.classifier.runtimeStateIssue}); repair .pi/bifrost-state.json as a JSON object with boolean enabled and classifierEnabled fields if present, then run /bifrost reload`] : []),
    `affinity: ${result.routing.affinity.mode}`,
    `reliability: v${result.routing.reliability.stateVersion}${result.routing.reliability.enabled ? "" : " (disabled)"}`,
    `available models: ${result.inventory.length}${result.inventoryProvider ? ` of ${result.availableModelCount} (provider "${result.inventoryProvider}")` : ""}`,
    `known but unavailable models: ${result.knownUnavailableCount}`,
  ];
  const authProblems = result.providerAuth.filter((auth) => auth.state === "invalid" || auth.state === "not_configured");
  if (authProblems.length > 0) {
    lines.push("provider sign-in:");
    for (const auth of authProblems) {
      lines.push(auth.state === "invalid"
        ? `  ${auth.provider}: invalid -- ${auth.reason ?? "sign-in could not be resolved"} (its models fail when selected until it is signed in again)`
        : `  ${auth.provider}: not configured -- its models cannot route`);
    }
  }
  lines.push("available model inventory:");
  for (const model of result.inventory.slice(0, 40)) lines.push(`  ${modelLine(model)}`);
  if (result.inventory.length > 40) {
    const nextOffset = (result.inventoryOffset ?? 0) + 40;
    lines.push(`  ... ${result.inventory.length - 40} more; repeat inspect with${result.inventoryProvider ? ` "provider": "${result.inventoryProvider}" and` : ""} "offset": ${nextOffset} to list the rest`);
  }
  if (result.issues.length > 0) {
    lines.push("issues:");
    for (const issue of result.issues) lines.push(`  ${issue.severity}: ${issue.message}`);
  }
  lines.push("restrictions:");
  for (const restriction of result.restrictions) lines.push(`  ${restriction}`);
  lines.push("-----------------------------");
  return bounded(lines).join("\n");
}

/**
 * Render a pointer on one line without merging distinct keys: backslashes
 * double, so a key with a literal "\\u000a" reads differently from one with a
 * real newline. The stored path stays unescaped, which keeps it unique.
 */
function displayPath(field: string): string {
  return field
    .replace(/\\/g, "\\\\")
    .replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function changeLine(change: ConfigAgentChange): string {
  const base = `${change.kind} ${displayPath(change.field)}`;
  if (change.kind === "add") return `${base}: ${compactValue(change.after)}`;
  if (change.kind === "remove") return `${base} (was ${compactValue(change.before)})`;
  return `${base}: ${compactValue(change.before)} -> ${compactValue(change.after)}`;
}

/** Change list on its own budget, with a count so an omitted tail is never
 * mistaken for the whole proposal. */
function changeLines(changes: readonly ConfigAgentChange[]): string[] {
  if (changes.length === 0) return [];
  const shown = changes.slice(0, MAX_CHANGE_LINES);
  const lines = ["changes:", ...shown.map((change) => `  ${changeLine(change)}`)];
  const omitted = changes.length - shown.length;
  if (omitted > 0) lines.push(`  ... ${omitted} more change(s) omitted`);
  return lines;
}

function warningLines(result: ConfigAgentCheckResult): string[] {
  const warnings = result.issues.filter((issue) => issue.severity === "warning");
  if (warnings.length === 0) return [];
  const shown = warnings.slice(0, MAX_WARNING_LINES);
  const lines = ["warnings:", ...shown.map((warning) => `  ${warning.message}`)];
  const omitted = warnings.length - shown.length;
  if (omitted > 0) {
    lines.push(`  ... ${omitted} more warning(s) omitted; the tool result's issues list carries every message`);
  }
  return lines;
}

/** Probe scope and outcome. The denominator is what was requested, not what came
 * back: a transport that returned fewer outcomes must not read as a full pass. */
function probeLines(result: ConfigAgentCheckResult): string[] {
  const lines: string[] = [];
  if (result.probePlan && result.probePlan.length > 0) {
    const planned = result.liveProbe ? "live probe targets" : "live probe not run";
    lines.push(`${planned}: ${result.probePlan.length} model(s), one primary probe each, no session fallback -- ${result.probePlan.join(", ")}`);
    lines.push(`  ${PROBE_RESOURCE_DISCLOSURE}`);
    // The consent dialog cannot afford this sentence: it renders above the model
    // list, where every extra line pushes real content off a small terminal. The
    // report has its own bounded budget, so the guarantee lives here.
    lines.push("  a pass describes this provider now; it is not a promise for later");
    if (!result.liveProbe) lines.push("  run it only with probe: true after the user agrees; a plain check sends nothing");
  }
  // A skipped model was never asked, so it is neither a pass nor a failure.
  if (result.probeSkipped && result.probeSkipped.length > 0) {
    lines.push(`live probe skipped: ${result.probeSkipped.length} model(s) whose provider's sign-in does not resolve for this session -- ${result.probeSkipped.map((entry) => entry.model).join(", ")}`);
    lines.push("  skipped is not a probe failure; these models were not asked");
  }
  // Failures only, plus a count. A succeeded probe carries no decision, and one
  // line per model would crowd out the change list above it.
  if (result.liveProbe) {
    const answered = result.liveProbe.filter((entry) => entry.status === "ok");
    const skipped = result.liveProbe.filter((entry) => entry.status === "skipped");
    const failed = result.liveProbe.filter((entry) => entry.status === "error" || entry.status === "timeout");
    const requested = result.probePlan?.length ?? result.liveProbe.length;
    lines.push(`live probe (one primary probe per model): ${answered.length}/${requested} answered${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}${result.liveProbe.length < requested ? `, ${requested - result.liveProbe.length} without a reported outcome` : ""}`);
    if (skipped.length > 0) lines.push(`  ${skipped.length} model${skipped.length === 1 ? "" : "s"} skipped: the check was cancelled, or the model was not asked; a cancelled request may already have been sent and charged`);
    if (result.liveProbe.length < requested) lines.push(`  ${requested - result.liveProbe.length} model${requested - result.liveProbe.length === 1 ? "" : "s"} were requested but produced no outcome; treat them as unverified, not as passing`);
    lines.push(...failedProbeLines(failed));
  }
  return lines;
}

/** Failed probes only; their count is capped so the protected tail cannot grow
 * past the report budget, and the omission stays visible. */
function failedProbeLines(failed: readonly ConfigAgentProbeResult[]): string[] {
  const lines = failed.slice(0, MAX_PROBE_FAILURE_LINES).map((entry) => `  ${entry.model}: ${entry.status}${entry.reason ? ` -- ${entry.reason}` : ""}`);
  const omitted = failed.length - MAX_PROBE_FAILURE_LINES;
  if (omitted > 0) lines.push(`  ... ${omitted} more failed probe(s) omitted; the tool result's liveProbe list carries every outcome`);
  return lines;
}

const MAX_VALUE_CHARS = 100;

function compactValue(value: unknown): string {
  if (value === undefined) return "";
  const text = JSON.stringify(value) ?? "";
  return text.length <= MAX_VALUE_CHARS ? text : `${text.slice(0, MAX_VALUE_CHARS - 3)}...`;
}

/**
 * The agent has to pass these digests back to apply, so the model-facing report
 * carries them in full even though the summary lines stay abbreviated.
 */
function digestLines(proposalDigest: string | null, guards: ConfigAgentGuards | null): string[] {
  if (!proposalDigest || !guards) return [];
  return [
    "apply digests (pass these back unchanged):",
    `  proposalDigest: ${proposalDigest}`,
    `  sourceDigest: ${guards.sourceDigest ?? "absent"}`,
    `  effectiveDigest: ${guards.effectiveDigest}`,
    `  catalogDigest: ${guards.catalogDigest}`,
    ...(guards.classifierRuntimeDigest ? [`  classifierRuntimeDigest: ${guards.classifierRuntimeDigest}`] : []),
  ];
}

function renderCheck(result: ConfigAgentCheckResult): string {
  const lines = [
    "--- bifrost candidate check ---",
    `status: ${result.status}`,
    `source: ${result.source} (${result.sourcePath})`,
    `proposal: ${shortDigest(result.proposalDigest)}`,
  ];
  if (result.routingBefore?.classifier || result.routingAfter?.classifier) {
    const before = result.routingBefore?.classifier;
    const after = result.routingAfter?.classifier;
    const projected = after?.projected;
    lines.push(`classifier runtime now: ${before?.enabled ? "enabled" : "disabled"} (${before?.source ?? "unknown"}); configured=${before?.configuredEnabled ? "on" : "off"}; backend=${before?.backend ?? "auto"}; loaded generation=${before?.configGeneration ?? "unknown"}`);
    if (projected) lines.push(`classifier runtime projection after candidate: ${projected.enabled ? "enabled" : "disabled"} (${projected.source}); configured=${projected.configuredEnabled ? "on" : "off"}; backend=${projected.backend ?? "auto"}`);
    if (before?.loadedConfigMatches === false) lines.push("current loaded config differs from effective disk layers; reload required to activate disk changes");
    if (before?.runtimeStateIssue) lines.push(`runtime state invalid (${before.runtimeStateIssue}); classification stays paused despite session overrides until repair and reload`);
  }
  if (result.status === "usage" || result.status === "rejected") {
    lines.push("nothing was written");
    for (const issue of result.issues.filter((issue) => issue.severity === "error")) lines.push(`  error: ${issue.message}`);
    for (const note of result.notes) lines.push(`  ${note}`);
    return boundedWithTail(lines, [...warningLines(result), "------------------------------"]).join("\n");
  }
  // A deep-merged patch changes nested fields, so report those paths. The plan
  // computes this list from the same source pair as `changes`, so the two are
  // non-empty together.
  lines.push(...(result.nestedChanges.length === 0 ? ["changes: none"] : changeLines(result.nestedChanges)));
  lines.push("tiers after the change:");
  for (const tier of result.routingAfter?.tiers ?? []) {
    lines.push(`  ${tier.tier} (${tier.strategy})${tier.fallbackTiers ? ` fallback: [${tier.fallbackTiers.join(", ")}]` : ""}: ${tier.pool.join(", ") || "empty"}`);
  }
  if (result.references.length > 0) {
    lines.push("pool entries that cannot route:");
    for (const reference of result.references) lines.push(`  ${reference.tier}: ${reference.entry} (${reference.status})`);
  }
  if (result.newlyEligibleModels.length > 0) lines.push(`newly referenced models that are available: ${result.newlyEligibleModels.join(", ")}`);
  if (result.removedModels.length > 0) lines.push(`models no longer referenced by any tier: ${result.removedModels.join(", ")}`);
  for (const note of result.notes) lines.push(`note: ${note}`);
  // Safety data is never truncated: a long change or tier list may not push the
  // warnings, probe scope, write eligibility, or apply digests out of the report.
  const tail = [
    ...warningLines(result),
    ...probeLines(result),
    `write eligible: ${result.writeEligible}`,
    ...(result.writeEligible ? digestLines(result.proposalDigest, result.guards) : []),
    "------------------------------",
  ];
  return boundedWithTail(lines, tail).join("\n");
}

function renderPreview(result: ConfigAgentPreviewResult): string {
  const lines = [
    "--- bifrost candidate preview (offline) ---",
    `status: ${result.status}`,
    `source: ${result.source} (${result.sourcePath})`,
    `proposal: ${shortDigest(result.proposalDigest)}`,
    `network: ${result.network}; prompt execution: ${result.promptExecution}`,
  ];
  for (const issue of result.issues) lines.push(`  ${issue.severity}: ${issue.message}`);
  if (result.status !== "ok") {
    for (const note of result.notes) lines.push(`  ${note}`);
    lines.push("-------------------------------------------");
    return bounded(lines).join("\n");
  }
  if (result.routing) {
    const classifier = result.routing.classifier;
    lines.push(`classifier runtime (loaded${classifier.configGeneration === undefined ? "" : ` generation ${classifier.configGeneration}`}): ${classifier.enabled ? "enabled" : "disabled"} (${classifier.source}); configured=${classifier.configuredEnabled ? "on" : "off"}; backend=${classifier.backend ?? "auto"}`);
    if (classifier.projected) lines.push(`classifier policy projection: runtime would be ${classifier.projected.enabled ? "enabled" : "disabled"} (${classifier.projected.source}); configured=${classifier.projected.configuredEnabled ? "on" : "off"}; backend=${classifier.projected.backend ?? "auto"}`);
    if (classifier.runtimeStateIssue) lines.push(`runtime state invalid (${classifier.runtimeStateIssue}); classification stays paused despite session overrides until repair and reload`);
  }
  lines.push("tier assignments (forced tier resolution, deterministic):");
  for (const tier of result.tiers) {
    lines.push(`  requested ${tier.requestedTier ?? tier.tier} (${tier.strategy}) -> ${tier.selectedTier ?? tier.tier}: ${tier.selected ?? "nothing resolved"}`);
    if (tier.fallbackReason) lines.push(`    fallback: ${tier.fallbackReason}`);
    for (const excluded of tier.excluded) lines.push(`    excluded: ${excluded.model} (${excluded.exclusion})`);
    if (tier.unknownUnavailable.length > 0) lines.push(`    known but unavailable: ${tier.unknownUnavailable.join(", ")}`);
  }
  if (result.cases.length > 0) {
    lines.push("representative prompts:");
    for (const entry of result.cases) {
      lines.push(`  "${entry.prompt.slice(0, 80)}" -> ${entry.decidedBy} / ${entry.confidence}: requested=${entry.tier ?? "none"}; selected=${entry.selected ? `${entry.selectedTier ?? "unknown"} => ${entry.selected}` : "none"}`);
      if (entry.fallbackReason) lines.push(`    fallback: ${entry.fallbackReason}`);
      for (const excluded of entry.excluded) lines.push(`    excluded: ${excluded.model} (${excluded.exclusion})`);
      if (entry.unavailable.length > 0) lines.push(`    known but unavailable: ${entry.unavailable.join(", ")}`);
    }
  }
  const noteLines = result.notes.map((note) => `note: ${note.replace(/\r\n|\r|\n/g, "\\n")}`);
  const tail = [...noteLines, ...digestLines(result.proposalDigest, result.guards), "-------------------------------------------"];
  return boundedWithTail(lines, tail).join("\n");
}

function renderApply(result: ConfigAgentApplyResult): string {
  const lines = [
    "--- bifrost configuration apply ---",
    `status: ${result.status}`,
    ...(result.sourcePath ? [`source: ${result.source} (${result.sourcePath})`] : []),
    `applied: ${result.applied}; reloaded: ${result.reloaded}; verified: ${result.verified}`,
  ];
  if (result.reason) lines.push(`reason: ${result.reason}`);
  lines.push(...changeLines(result.nestedChanges));
  if (result.routing) {
    const classifier = result.routing.classifier;
    lines.push(`active default tier: ${result.routing.defaultTier ?? "none"}; tiers: ${result.routing.tiers.map((tier) => tier.tier).join(", ") || "none"}`);
    lines.push(`classifier runtime (loaded${classifier.configGeneration === undefined ? "" : ` generation ${classifier.configGeneration}`}): ${classifier.enabled ? "enabled" : "disabled"} (${classifier.source}); configured=${classifier.configuredEnabled ? "on" : "off"}; backend=${classifier.backend ?? "auto"}`);
    if (classifier.projected) lines.push(`classifier policy projection: runtime would be ${classifier.projected.enabled ? "enabled" : "disabled"} (${classifier.projected.source}); configured=${classifier.projected.configuredEnabled ? "on" : "off"}; backend=${classifier.projected.backend ?? "auto"}`);
    if (classifier.loadedConfigMatches === false) lines.push("loaded config differs from effective disk layers; the running extension did not activate them");
    if (classifier.runtimeStateIssue) lines.push(`runtime state invalid (${classifier.runtimeStateIssue}); classification stays paused despite session overrides until repair and reload`);
  }
  for (const note of result.notes) lines.push(`note: ${note}`);
  lines.push("----------------------------------");
  return bounded(lines).join("\n");
}

export function reportText(result: ConfigAgentToolResult): string {
  switch (result.operation) {
    case "inspect": return renderInspect(result);
    case "check": return renderCheck(result);
    case "preview": return renderPreview(result);
    case "apply": return renderApply(result);
  }
}
