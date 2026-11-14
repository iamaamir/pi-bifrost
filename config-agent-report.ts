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
  type ConfigAgentToolResult,
} from "./config-agent.ts";

const MAX_REPORT_LINES = 120;

// ── Rendering ──────────────────────────────────────────────────

function modelLine(model: ConfigAgentModel): string {
  return `${model.key} ($${model.inputCost.toFixed(2)} in + $${model.outputCost.toFixed(2)} out per 1M, ctx ${model.contextWindow}${model.reasoning ? ", reasoning" : ""})`;
}

function bounded(lines: readonly string[]): string[] {
  return lines.length <= MAX_REPORT_LINES ? [...lines] : [...lines.slice(0, MAX_REPORT_LINES), `... ${lines.length - MAX_REPORT_LINES} more line(s)`];
}

/**
 * Bound the report body but never drop `tail`. The agent copies the tail
 * (the apply digests) off this report, so truncation may only shorten the
 * optional detail above it.
 */
function boundedWithTail(lines: readonly string[], tail: readonly string[]): string[] {
  const room = MAX_REPORT_LINES - tail.length;
  if (lines.length <= room) return [...lines, ...tail];
  return [...lines.slice(0, Math.max(room, 0)), `... ${lines.length - Math.max(room, 0)} more line(s)`, ...tail];
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

function changeLine(change: ConfigAgentChange): string {
  const base = `${change.kind} ${change.field}`;
  if (change.kind === "add") return `${base}: ${compactValue(change.after)}`;
  if (change.kind === "remove") return `${base} (was ${compactValue(change.before)})`;
  return `${base}: ${compactValue(change.before)} -> ${compactValue(change.after)}`;
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
    lines.push("------------------------------");
    return bounded(lines).join("\n");
  }
  lines.push(result.changes.length === 0 ? "changes: none" : "changes:");
  for (const change of result.changes) lines.push(`  ${changeLine(change)}`);
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
  const warnings = result.issues.filter((issue) => issue.severity === "warning");
  if (warnings.length > 0) {
    lines.push("warnings:");
    for (const warning of warnings) lines.push(`  ${warning.message}`);
  }
  // Scope and cost are stated whether or not the probe ran, so a caller can ask
  // before spending anything. The denominator is what was requested, not what
  // came back: a transport that returned fewer outcomes must not read as a full
  // pass.
  if (result.probePlan && result.probePlan.length > 0) {
    const planned = result.liveProbe ? "live probe targets" : "live probe not run";
    lines.push(`${planned}: ${result.probePlan.length} model(s), one request each -- ${result.probePlan.join(", ")}`);
    if (!result.liveProbe) lines.push("  run it only with probe: true after the user agrees; a plain check sends nothing");
  }
  // Failures only, plus a count. A succeeded probe carries no decision, and one
  // line per model would push the warnings above it out of the bounded report.
  if (result.liveProbe) {
    const answered = result.liveProbe.filter((entry) => entry.status === "ok");
    const skipped = result.liveProbe.filter((entry) => entry.status === "skipped");
    const failed = result.liveProbe.filter((entry) => entry.status === "error" || entry.status === "timeout");
    const requested = result.probePlan?.length ?? result.liveProbe.length;
    lines.push(`live probe (one tiny prompt per model): ${answered.length}/${requested} answered${skipped.length > 0 ? `, ${skipped.length} skipped` : ""}${result.liveProbe.length < requested ? `, ${requested - result.liveProbe.length} without a reported outcome` : ""}`);
    if (skipped.length > 0) lines.push(`  ${skipped.length} model${skipped.length === 1 ? "" : "s"} not asked (check cancelled before the request completed)`);
    if (result.liveProbe.length < requested) lines.push(`  ${requested - result.liveProbe.length} model${requested - result.liveProbe.length === 1 ? "" : "s"} were requested but produced no outcome; treat them as unverified, not as passing`);
    for (const entry of failed) {
      lines.push(`  ${entry.model}: ${entry.status}${entry.reason ? ` -- ${entry.reason}` : ""}`);
    }
  }
  for (const note of result.notes) lines.push(`note: ${note}`);
  lines.push(`write eligible: ${result.writeEligible}`);
  const tail = [
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
  for (const note of result.notes) lines.push(`note: ${note}`);
  const tail = [...digestLines(result.proposalDigest, result.guards), "-------------------------------------------"];
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
  for (const change of result.changes) lines.push(`  ${changeLine(change)}`);
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
