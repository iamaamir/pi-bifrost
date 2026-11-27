import { safeInteractiveDiagnosticPath } from "../diagnostics.ts";
import type {
  InspectDiagnosticsReport,
  AffinityInspectEvidence,
  EconomicInspectEvidence,
  ReliabilityV2InspectEvidence,
} from "../diagnostics.ts";
import type { ExpandableRow } from "./expandable-rows.ts";
import { jsonTreeRow } from "./json-tree.ts";

export type InspectReport = InspectDiagnosticsReport & {
  economics?: EconomicInspectEvidence;
  reliabilityV2?: ReliabilityV2InspectEvidence;
  affinity?: AffinityInspectEvidence;
  modelPoolSource?: "configured" | "session_catalog_in_memory";
};

export function warningRows(report: InspectDiagnosticsReport): ExpandableRow[] {
  const warnings: ExpandableRow[] = report.diagnostics
    .filter((d) => d.severity !== "info")
    .map((d, i) => ({
      id: `warning-${i}`,
      warning: true,
      label: `${d.severity === "error" ? "Error" : "Warning"}${d.tier ? ` · ${d.tier}` : ""}: ${d.repair}`,
      children: [
        jsonTreeRow(
          "Diagnostic details",
          {
            code: d.code,
            ...(safeInteractiveDiagnosticPath(d.path) ? { path: d.path } : {}),
            entryIndex: d.entryIndex,
            ruleIndex: d.ruleIndex,
            model: d.model,
          },
          `warning-details-${i}`,
        ),
      ],
    }));
  if (report.registry.forceRegistryRefresh)
    warnings.push({
      id: "refresh",
      warning: true,
      label: "Warning: Model catalog refresh needed.",
    });
  const classifier = report.classifier;
  if (classifier.runtimeStateIssue)
    warnings.push({
      id: "classifier-state-warning",
      warning: true,
      label: `Warning: Classifier state invalid (${classifier.runtimeStateIssue}); classification paused. Check .pi/bifrost-state.json: it must be a JSON object with boolean enabled and classifierEnabled fields if present. Then run /bifrost reload.`,
    });
  if (classifier.legacyConflict)
    warnings.push({
      id: "classifier-conflict-warning",
      warning: true,
      label: `Warning: Saved classifier setting conflicts with configuration (saved: ${classifier.legacyConflict.saved}, config: ${classifier.legacyConflict.configured}).`,
      children: [
        {
          id: "classifier-conflict-detail",
          label:
            classifier.source === "session"
              ? "Explicit session-only override is active."
              : !classifier.legacyConflict.configured && classifier.legacyConflict.saved
                ? "Configured off takes precedence; /bifrost classifier on overrides only this session."
                : "Classification paused. /bifrost classifier on or off affects only this session. To resume configured behavior after restart, back up .pi/bifrost-state.json, remove only classifierEnabled, then run /bifrost reload.",
        },
      ],
    });
  for (const [i, error] of classifier.errors.entries())
    warnings.push({ id: `classifier-error-${i}`, warning: true, label: `Error: ${error}` });
  return warnings;
}

export function classifierRow(report: InspectDiagnosticsReport): ExpandableRow {
  const classifier = report.classifier;
  return {
    id: "classifier",
    label: `Classification · ${classifier.readiness === "blocked" ? "paused" : classifier.enabled ? "on" : "off"}`,
    children: [
      { id: "classifier-enabled", label: `Runtime setting: ${classifier.enabled ? "on" : "off"}` },
      { id: "classifier-source", label: `Setting source: ${classifier.source}` },
      {
        id: "classifier-config",
        label: `Config setting: ${classifier.configuredEnabled ? "on" : "off"}`,
      },
      { id: "classifier-readiness", label: `Readiness: ${classifier.readiness}` },
      ...(classifier.backend
        ? [{ id: "classifier-backend", label: `Backend: ${classifier.backend}` }]
        : []),
    ],
  };
}

function diagnosticTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
}

function catalogRow(report: InspectReport): ExpandableRow {
  return {
    id: "catalog",
    label: `Model catalog · ${report.registry.knownModelCount} known · ${report.registry.availableModelCount} available`,
    children: [
      { id: "observed", label: `Observed: ${diagnosticTimestamp(report.observedAt)}` },
      {
        id: "refresh-age",
        label: `Last Bifrost refresh age: ${report.registry.bifrostLastRefreshAgeMs === undefined ? "unknown" : `${report.registry.bifrostLastRefreshAgeMs} ms`}`,
      },
      {
        id: "refresh-interval",
        label: `Refresh interval: ${report.registry.bifrostRegistryRefreshTtlMs} ms`,
      },
      {
        id: "refresh-pending",
        label: `Refresh needed: ${report.registry.forceRegistryRefresh ? "yes" : "no"}`,
      },
      ...(report.modelPoolSource
        ? [
            {
              id: "pool-source",
              label:
                report.modelPoolSource === "configured"
                  ? "Model pool source: configuration"
                  : "Model pool source: Pi catalog in memory · run /bifrost init to refresh and save",
            },
          ]
        : []),
      {
        id: "catalog-note",
        label: "Availability is Pi's local snapshot, not a provider health or credential check.",
      },
    ],
  };
}

function tiersRow(report: InspectReport): ExpandableRow {
  return {
    id: "tiers",
    label: `Models by tier · ${report.tiers.length} ${report.tiers.length === 1 ? "tier" : "tiers"}`,
    children: report.tiers.map((tier, i) => ({
      id: `tier-${i}`,
      label: `${tier.tier} · ${tier.configuredEntryCount} ${tier.configuredEntryCount === 1 ? "entry" : "entries"} · ${tier.candidates.length} ${tier.candidates.length === 1 ? "match" : "matches"}`,
      children: tier.candidates.map((candidate, j) => ({
        id: `candidate-${i}-${j}`,
        label: candidate.model,
        children: [
          { id: `available-${i}-${j}`, label: `Available in Pi: ${candidate.available}` },
          {
            id: `auth-${i}-${j}`,
            label: `Credential setting: ${candidate.auth} (not verified)`,
          },
          { id: `circuit-${i}-${j}`, label: `Circuit: ${candidate.circuit}` },
          ...(candidate.openUntil === undefined
            ? []
            : [{ id: `until-${i}-${j}`, label: `Open until: ${diagnosticTimestamp(candidate.openUntil)}` }]),
          ...(candidate.failureEvidence
            ? [jsonTreeRow("Failure evidence", candidate.failureEvidence, `evidence-${i}-${j}`)]
            : []),
        ],
      })),
    })),
  };
}

function reliabilityRow(report: InspectReport): ExpandableRow {
  return {
    id: "reliability",
    label: `Reliability · ${report.reliabilityPolicy.enabled ? "on" : "off"}`,
    children: [
      {
        id: "allowance-cooldown",
        label: `Allowance cooldown: ${report.reliabilityPolicy.cooldownOnAllowanceExhausted ? "on" : "off"}`,
      },
      {
        id: "cooldown-scope",
        label: `Cooldown scope: ${report.reliabilityPolicy.allowanceCooldownScope}`,
      },
      { id: "rate-limits", label: "Provider rate-limit throttles: on" },
    ],
  };
}

export function diagnosticsRow(report: InspectReport): ExpandableRow {
  return {
    id: "diagnostics",
    label: "Diagnostics · local snapshot",
    children: [
      catalogRow(report),
      tiersRow(report),
      reliabilityRow(report),
      ...(report.economics
        ? [
            {
              id: "reserve",
              label: `Reserve policy · ${report.economics.mode}`,
              children: [
                ...report.economics.sources.map((source, i) => ({
                  id: `reserve-source-${i}`,
                  label: `Source: ${source.source} · scope: ${source.scope} · authority: ${source.authority}`,
                  children: [
                    jsonTreeRow(
                      "Evidence",
                      {
                        freshness: source.freshness,
                        observedAgeMs: source.observedAgeMs,
                        periods: source.periods,
                      },
                      `reserve-evidence-${i}`,
                    ),
                  ],
                })),
                ...report.economics.diagnostics.map((diagnostic, i) =>
                  jsonTreeRow("Reserve diagnostic", diagnostic, `reserve-diagnostic-${i}`),
                ),
              ],
            },
          ]
        : []),
      ...(report.reliabilityV2
        ? [jsonTreeRow("Reliability state", report.reliabilityV2, "reliability-v2")]
        : []),
      ...(report.affinity ? [jsonTreeRow("Model affinity", report.affinity, "affinity")] : []),
      ...(report.diagnostics.length === 0
        ? [{ id: "no-diagnostics", label: "Diagnostics: none" }]
        : []),
      ...report.diagnostics
        .filter((d) => d.severity === "info")
        .map((d, i) => ({
          id: `info-${i}`,
          label: `Info: ${d.repair}`,
          children: [
            jsonTreeRow(
              "Diagnostic details",
              {
                code: d.code,
                ...(safeInteractiveDiagnosticPath(d.path) ? { path: d.path } : {}),
                tier: d.tier,
                entryIndex: d.entryIndex,
                ruleIndex: d.ruleIndex,
                model: d.model,
              },
              `info-details-${i}`,
            ),
          ],
        })),
    ],
  };
}
