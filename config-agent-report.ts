/**
 * Model-facing text rendering for the Bifrost configuration tool.
 *
 * Pure functions over the tool's result types: no IO, validation, routing, or
 * writes live here. `config-agent.ts` owns policy and IO and imports
 * `reportText` (and `shortDigest`) from this module; the import from
 * `config-agent.ts` below is type-only, so the runtime dependency stays
 * one-directional.
 */
import type {
  ConfigAgentApplyResult,
  ConfigAgentChange,
  ConfigAgentCheckResult,
  ConfigAgentGuards,
  ConfigAgentInspectResult,
  ConfigAgentModel,
  ConfigAgentPreviewResult,
  ConfigAgentToolResult,
} from "./config-agent.ts";

const MAX_REPORT_LINES = 120;

export function shortDigest(digest: string | null): string {
  return digest === null ? "absent" : digest.slice(0, 12);
}

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
    `classifier: ${result.routing.classifier.enabled ? `enabled (${result.routing.classifier.backend ?? "auto backend"})` : "disabled"}`,
    `affinity: ${result.routing.affinity.mode}`,
    `reliability: v${result.routing.reliability.stateVersion}${result.routing.reliability.enabled ? "" : " (disabled)"}`,
    `available models: ${result.inventory.length}${result.inventoryProvider ? ` of ${result.availableModelCount} (provider "${result.inventoryProvider}")` : ""}`,
    `known but unavailable models: ${result.knownUnavailableCount}`,
  ];
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
  ];
}

function renderCheck(result: ConfigAgentCheckResult): string {
  const lines = [
    "--- bifrost candidate check ---",
    `status: ${result.status}`,
    `source: ${result.source} (${result.sourcePath})`,
    `proposal: ${shortDigest(result.proposalDigest)}`,
  ];
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
  if (result.status !== "ok") {
    for (const note of result.notes) lines.push(`  ${note}`);
    lines.push("-------------------------------------------");
    return bounded(lines).join("\n");
  }
  lines.push("tier assignments (forced tier resolution, deterministic):");
  for (const tier of result.tiers) {
    lines.push(`  ${tier.tier} (${tier.strategy}) -> ${tier.selected ?? "nothing resolved"}`);
    for (const excluded of tier.excluded) lines.push(`    excluded: ${excluded.model} (${excluded.exclusion})`);
    if (tier.unknownUnavailable.length > 0) lines.push(`    known but unavailable: ${tier.unknownUnavailable.join(", ")}`);
  }
  if (result.cases.length > 0) {
    lines.push("representative prompts:");
    for (const entry of result.cases) {
      lines.push(`  "${entry.prompt.slice(0, 80)}" -> ${entry.decidedBy} / ${entry.confidence}: ${entry.selected ? `${entry.selectedTier} => ${entry.selected}` : "no selection"}`);
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
    `source: ${result.source} (${result.sourcePath})`,
    `applied: ${result.applied}; reloaded: ${result.reloaded}; verified: ${result.verified}`,
  ];
  if (result.reason) lines.push(`reason: ${result.reason}`);
  for (const change of result.changes) lines.push(`  ${changeLine(change)}`);
  if (result.routing) lines.push(`active default tier: ${result.routing.defaultTier ?? "none"}; tiers: ${result.routing.tiers.map((tier) => tier.tier).join(", ") || "none"}`);
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
