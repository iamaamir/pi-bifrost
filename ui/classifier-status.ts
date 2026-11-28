import type { SummaryBlock, SummaryPanelContent } from "./summary-panel.ts";

/** Enablement source resolved by runtime-state.ts. */
export type ClassifierStatusSource =
  | "configuration"
  | "session"
  | "legacy-conflict"
  | "runtime-state-invalid";

export type ClassifierReadiness = "ready" | "inactive" | "blocked";

/** Effective direct-classifier transport, already resolved by the handler. */
export interface ClassifierBackendFacts {
  readonly name: string;
  readonly auto: boolean;
  readonly reason?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly method?: string;
  readonly minConfidence?: number;
  readonly credential?: string;
  readonly fallback?: string;
  readonly fallbackModel?: string;
}

/** Persisted aggregates; absent for backends that keep no metrics. */
export interface ClassifierActivityFacts {
  readonly observations: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly averageLatencyMs?: number;
}

/** Everything the status command knows before presentation decides layout. */
export interface ClassifierStatusFacts {
  readonly enabled: boolean;
  readonly source: ClassifierStatusSource;
  readonly configured: boolean;
  readonly readiness: ClassifierReadiness;
  readonly backend: ClassifierBackendFacts;
  readonly legacyConflict?: { readonly saved: boolean; readonly configured: boolean; readonly note: string };
  readonly runtimeStateIssue?: string;
  readonly errors?: readonly string[];
  readonly activity?: ClassifierActivityFacts;
}

function statusValue(facts: ClassifierStatusFacts): string {
  return `${facts.enabled ? "On" : "Off"} · ${facts.readiness} (${facts.source})`;
}

function backendLabel(backend: ClassifierBackendFacts): string {
  if (!backend.auto) return backend.name;
  return backend.reason ? `auto: ${backend.name} (${backend.reason})` : `auto: ${backend.name}`;
}

function outcomeSummary(outcomes: Readonly<Record<string, number>>): string {
  const entries = Object.entries(outcomes).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([outcome, count]) => `${outcome} ${count}`).join(" · ") : "none recorded";
}

function activityBlocks(activity: ClassifierActivityFacts | undefined): SummaryBlock[] {
  if (!activity) return [];
  return [
    {
      kind: "row",
      label: "Activity",
      value: `${activity.observations} observations (persisted aggregate)`,
    },
    { kind: "row", label: "Outcomes", value: outcomeSummary(activity.outcomes) },
    ...(activity.averageLatencyMs === undefined
      ? []
      : [{ kind: "row", label: "Average latency", value: `${activity.averageLatencyMs} ms` } as const]),
  ];
}

function diagnosticBlocks(facts: ClassifierStatusFacts): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  if (facts.legacyConflict) {
    blocks.push({
      kind: "message",
      tone: "warning",
      text: `Legacy saved classifierEnabled=${facts.legacyConflict.saved} conflicts with configured=${facts.legacyConflict.configured}; ${facts.legacyConflict.note}`,
    });
  }
  if (facts.runtimeStateIssue) {
    blocks.push({
      kind: "message",
      tone: "error",
      text: `Classification is paused because .pi/bifrost-state.json is unreadable or invalid (${facts.runtimeStateIssue}). Repair it as a JSON object with boolean enabled and classifierEnabled fields if present, then run /bifrost reload.`,
    });
  }
  for (const error of facts.errors ?? []) blocks.push({ kind: "message", tone: "error", text: error });
  return blocks;
}

/**
 * Build the classifier status panel. Rows are declarative: a new classifier
 * setting becomes one `kind: "row"` entry, and absent fields simply omit their
 * row, so the panel and headless text never drift apart.
 */
export function classifierStatusPanel(facts: ClassifierStatusFacts): SummaryPanelContent {
  const { backend } = facts;
  const settings: SummaryBlock[] = [
    { kind: "row", label: "Configured", value: facts.configured ? "On" : "Off" },
    { kind: "row", label: "Backend", value: backendLabel(backend) },
    ...(backend.model ? [{ kind: "row", label: "Model", value: backend.model } as const] : []),
    ...(backend.endpoint ? [{ kind: "row", label: "Endpoint", value: backend.endpoint } as const] : []),
    ...(backend.method ? [{ kind: "row", label: "Method", value: backend.method } as const] : []),
    ...(backend.minConfidence === undefined
      ? []
      : [{ kind: "row", label: "Minimum confidence", value: String(backend.minConfidence) } as const]),
    ...(backend.credential ? [{ kind: "row", label: "Credential", value: backend.credential } as const] : []),
    ...(backend.fallback ? [{ kind: "row", label: "Fallback", value: backend.fallback } as const] : []),
    ...(backend.fallbackModel
      ? [{ kind: "row", label: "Fallback model", value: backend.fallbackModel } as const]
      : []),
  ];
  const activity = activityBlocks(facts.activity);
  return {
    title: "Bifrost · classifier status",
    blocks: [
      { kind: "row", label: "Status", value: statusValue(facts) },
      ...diagnosticBlocks(facts),
      { kind: "spacing" },
      ...settings,
      ...(activity.length ? [{ kind: "spacing" } as const, ...activity] : []),
    ],
  };
}
