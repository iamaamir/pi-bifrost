import type { ClassifierBackend } from "../classifier-backends.ts";
import type { ClassifierEnablement, ClassifierReadiness } from "../runtime-state.ts";
import type { SummaryBlock, SummaryPanelContent } from "./summary-panel.ts";

/** Effective direct-classifier transport, already resolved by the handler. */
export interface ClassifierBackendFacts {
  readonly name: ClassifierBackend;
  readonly auto: boolean;
  /** Detection reason, or "explicit config"; only shown when `auto`. */
  readonly reason: string;
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
  /** Passed through from the runtime rather than copied field by field. */
  readonly enablement: ClassifierEnablement;
  /** Why configured state takes precedence; present with a legacy conflict. */
  readonly conflictNote?: string;
  readonly configured: boolean;
  readonly readiness: ClassifierReadiness;
  readonly backend: ClassifierBackendFacts;
  readonly errors?: readonly string[];
  readonly activity?: ClassifierActivityFacts;
}

function onOff(value: boolean): string {
  return value ? "On" : "Off";
}

/** A row appears only when its value exists, so callers list settings declaratively. */
function row(label: string, value: string | undefined): SummaryBlock[] {
  return value ? [{ kind: "row", label, value }] : [];
}

function statusValue(facts: ClassifierStatusFacts): string {
  return `${onOff(facts.enablement.enabled)} · ${facts.readiness} (${facts.enablement.source})`;
}

function backendLabel(backend: ClassifierBackendFacts): string {
  return backend.auto ? `auto: ${backend.name} (${backend.reason})` : backend.name;
}

function outcomeSummary(outcomes: Readonly<Record<string, number>>): string {
  const entries = Object.entries(outcomes).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([outcome, count]) => `${outcome} ${count}`).join(" · ") : "none recorded";
}

function activityBlocks(activity: ClassifierActivityFacts | undefined): SummaryBlock[] {
  if (!activity) return [];
  return [
    ...row("Activity", `${activity.observations} observations (persisted aggregate)`),
    ...row("Outcomes", outcomeSummary(activity.outcomes)),
    ...row(
      "Average latency",
      activity.averageLatencyMs === undefined ? undefined : `${activity.averageLatencyMs} ms`,
    ),
  ];
}

function diagnosticBlocks(facts: ClassifierStatusFacts): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  const conflict = facts.enablement.legacyConflict;
  if (conflict) {
    blocks.push({
      kind: "message",
      tone: "warning",
      text: `Legacy saved classifierEnabled=${conflict.saved} conflicts with configured=${conflict.configured}${facts.conflictNote ? `; ${facts.conflictNote}` : ""}`,
    });
  }
  if (facts.enablement.runtimeStateIssue) {
    blocks.push({
      kind: "message",
      tone: "error",
      text: `Classification is paused because .pi/bifrost-state.json is unreadable or invalid (${facts.enablement.runtimeStateIssue}). Repair it as a JSON object with boolean enabled and classifierEnabled fields if present, then run /bifrost reload.`,
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
    { kind: "row", label: "Configured", value: onOff(facts.configured) },
    { kind: "row", label: "Backend", value: backendLabel(backend) },
    ...row("Model", backend.model),
    ...row("Endpoint", backend.endpoint),
    ...row("Method", backend.method),
    ...row("Minimum confidence", backend.minConfidence === undefined ? undefined : String(backend.minConfidence)),
    ...row("Credential", backend.credential),
    ...row("Fallback", backend.fallback),
    ...row("Fallback model", backend.fallbackModel),
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
