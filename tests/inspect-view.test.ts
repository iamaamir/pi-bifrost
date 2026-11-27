import { test } from "node:test";
import assert from "node:assert/strict";
import { InspectView, showInspectView } from "../ui/inspect-view.ts";
import type { InspectDiagnosticsReport } from "../diagnostics.ts";

const report = {
  observedAt: 1000, registry: { knownModelCount: 1, availableModelCount: 1, bifrostRegistryRefreshTtlMs: 100, forceRegistryRefresh: true },
  reliabilityPolicy: { enabled: true, cooldownOnAllowanceExhausted: true, allowanceCooldownScope: "model" },
  diagnostics: [{ severity: "warning", tier: "quick", repair: "Check model." }],
  tiers: [{ tier: "quick", configuredEntryCount: 1, candidates: [{ model: "provider/model", available: true, auth: "configured", circuit: "closed" }] }],
  classifier: { enabled: true, configuredEnabled: true, source: "configuration", readiness: "ready", errors: [] },
} as unknown as InspectDiagnosticsReport;
const theme = { fg: (_role: string, text: string) => text };

test("inspect shows warnings and expands diagnostic report", () => {
  const view = new InspectView(report, () => ({ columns: 100, rows: 40 }), theme, () => {}, () => {});
  const render = () => view.render(100).join("\n");
  assert.match(render(), /Warning · quick: Check model/);
  assert.match(render(), /Model catalog refresh needed/);
  assert.doesNotMatch(render(), /Tier: quick/);
  for (let i = 0; i < 4; i++) view.handleInput("j");
  view.handleInput("\r");
  assert.match(render(), /Model catalog · 1 known · 1 available/);
  assert.doesNotMatch(render(), /inspection \(local snapshot\)/);
});

test("inspect keeps navigation hints visible at narrow widths", () => {
  const view = new InspectView(report, () => ({ columns: 24, rows: 40 }), theme, () => {}, () => {});
  const output = view.render(24).join("\n");
  assert.match(output, /Esc close/);
  assert.match(output, /Enter/);
});

test("inspect declines non-TUI contexts", async () => {
  assert.equal(await showInspectView({ hasUI: false, mode: "rpc" } as never, report), false);
});

test("classifier warnings use structured state rather than report lines", () => {
  const classifier = { ...report.classifier, errors: ["Check classifier backend."], legacyConflict: { saved: false, configured: true } };
  const view = new InspectView({ ...report, classifier }, () => ({ columns: 100, rows: 40 }), theme, () => {}, () => {});
  const output = view.render(100).join("\n");
  assert.match(output, /Check classifier backend/);
  assert.match(output, /Saved classifier setting conflicts/);
  assert.doesNotMatch(output, /stale text/);
  assert.doesNotMatch(output, /Models by tier/);
});

test("inspect grows with expanded rows and caps height on resize", () => {
  let height = 40;
  const view = new InspectView(report, () => ({ columns: 100, rows: height }), theme, () => {}, () => {});
  const closed = view.render(100);
  assert.match(closed.join("\n"), /Classification/);
  assert.ok(closed.length < 15);
  view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
  assert.ok(view.render(100).length > closed.length);
  height = 12;
  assert.ok(view.render(100).length <= height);
});

test("inspect reports runtime state issue and actionable constraints", () => {
  const classifier = { ...report.classifier, runtimeStateIssue: "invalid-json" as const };
  const view = new InspectView({ ...report, classifier }, () => ({ columns: 120, rows: 40 }), theme, () => {}, () => {});
  const output = view.render(120).join("\n");
  assert.match(output, /invalid-json/);
  assert.match(output, /JSON object/);
  assert.doesNotMatch(output, /\[object Object\]/);
});

test("inspect shows strategy and hides only top-level schema", () => {
  const config = { $schema: "top-schema", strategy: "cheapest", nested: { $schema: "nested-schema" } };
  const view = new InspectView(report, () => ({ columns: 120, rows: 80 }), theme, () => {}, () => {}, config);
  for (let i = 0; i < 3; i++) view.handleInput("j");
  view.handleInput("\r");
  const output = view.render(120).join("\n");
  assert.match(output, /"strategy": "cheapest"/);
  assert.doesNotMatch(output, /top-schema|\$schema/);
  view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
  assert.match(view.render(120).join("\n"), /nested-schema/);
});

test("inspect renders loaded nested config safely without mutation", () => {
  const config = { $schema: "top-schema", nested: { $schema: "nested-schema", items: ["secret\x1b[31m", { value: "\u009bcontrol" }], empty: [] } };
  const before = structuredClone(config);
  const view = new InspectView(report, () => ({ columns: 120, rows: 80 }), theme, () => {}, () => {}, config);
  const render = () => view.render(120).join("\n");
  for (let i = 0; i < 3; i++) view.handleInput("j");
  assert.match(render(), /Full configuration/);
  view.handleInput("\r"); view.handleInput("j"); view.handleInput("\r");
  assert.match(render(), /nested-schema/);
  assert.doesNotMatch(render(), /top-schema/);
  view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
  assert.match(render(), /secret\\u001b\[31m/);
  view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
  assert.match(render(), /\\u009bcontrol/);
  assert.doesNotMatch(render(), /\x1b/);
  assert.deepEqual(config, before);
});

test("diagnostics show unknown catalog and disabled reliability without stale lines", () => {
  const edge = { ...report, diagnostics: [], tiers: [], registry: { ...report.registry, knownModelCount: "unknown" as const, availableModelCount: "unknown" as const, forceRegistryRefresh: false }, reliabilityPolicy: { ...report.reliabilityPolicy, enabled: false } };
  const view = new InspectView(edge, () => ({ columns: 120, rows: 40 }), theme, () => {}, () => {});
  view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
  let text = view.render(120).join("\n");
  assert.match(text, /unknown known · unknown available/);
  assert.match(text, /Models by tier · 0 tiers/);
  assert.match(text, /Reliability · off/);
  assert.doesNotMatch(text, /stale report|refresh needed/);
  view.handleInput("j"); view.handleInput("\r");
  text = view.render(120).join("\n");
  assert.match(text, /Last Bifrost refresh age: unknown/);
  assert.match(text, /not a provider health or credential check/);
});

test("extended diagnostics expose reserve, unavailable reliability, affinity and pool source", () => {
  const extended = {
    ...report, diagnostics: [], registry: { ...report.registry, forceRegistryRefresh: false },
    economics: { mode: "observe" as const, sources: [{ source: "estimate", scope: "provider", authority: "estimated", freshness: "missing" as const, periods: [] }], diagnostics: [] },
    reliabilityV2: { version: 2 as const, status: "unavailable" as const, observationsEnabled: false, cooldownOnAllowanceExhausted: true, reasonCode: "state_unavailable" },
    affinity: { mode: "observe" as const, source: "config" as const, status: "locality_unknown" as const },
    modelPoolSource: "session_catalog_in_memory" as const,
  };
  const view = new InspectView(extended, () => ({ columns: 150, rows: 80 }), theme, () => {}, () => {});
  const text = () => view.render(150).join("\n");
  view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
  view.handleInput("j"); view.handleInput("\r");
  assert.match(text(), /Pi catalog in memory/);
  view.handleInput("\x1b[D");
  view.handleInput("j"); view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
  assert.match(text(), /Source: estimate · scope: provider · authority: estimated/);
  view.handleInput("\x1b[D"); view.handleInput("j"); view.handleInput("\r");
  assert.match(text(), /"reasonCode": "state_unavailable"/);
  view.handleInput("\x1b[D"); view.handleInput("j"); view.handleInput("\r");
  assert.match(text(), /"status": "locality_unknown"/);
});

test("diagnostic counts use singular and plural labels", () => {
  for (const count of [0, 1, 2]) {
    const tier = report.tiers[0]!;
    const sample = { ...report, diagnostics: [], registry: { ...report.registry, forceRegistryRefresh: false }, tiers: Array.from({ length: count }, () => ({ ...tier, configuredEntryCount: count, candidates: Array.from({ length: count }, () => tier.candidates[0]!) })) };
    const view = new InspectView(sample, () => ({ columns: 120, rows: 40 }), theme, () => {}, () => {});
    view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
    assert.match(view.render(120).join("\n"), new RegExp(`Models by tier · ${count} ${count === 1 ? "tier" : "tiers"}\\b`));
    if (count) {
      view.handleInput("j"); view.handleInput("j"); view.handleInput("\r");
      assert.match(view.render(120).join("\n"), new RegExp(`${count} ${count === 1 ? "entry" : "entries"} · ${count} ${count === 1 ? "match" : "matches"}\\b`));
    }
  }
});

test("classifier row distinguishes enabled runtime from blocked readiness", async () => {
  const { classifierRow } = await import("../ui/inspect-diagnostics.ts");
  const row = classifierRow({ ...report, classifier: { ...report.classifier, enabled: true, readiness: "blocked" } });
  assert.match(row.label, /paused/);
  assert.ok(row.children?.some((child) => child.label === "Runtime setting: on"));
});

test("diagnostic tree retains formatter facts and filters unsafe paths", async () => {
  const { diagnosticsRow, warningRows, classifierRow } = await import("../ui/inspect-diagnostics.ts");
  const full = {
    ...report,
    registry: { ...report.registry, bifrostLastRefreshAgeMs: 42 },
    classifier: { ...report.classifier, backend: "prompt", errors: ["backend error"] },
    tiers: [{ ...report.tiers[0], candidates: [{ model: "p/m", available: true, auth: "configured", circuit: "open", openUntil: 123, failureEvidence: { category: "allowance_exhausted", evidence: "structured", scope: "model-only" } }] }],
    diagnostics: [
      { severity: "warning", code: "safe-code", path: "tierPolicies", tier: "quick", entryIndex: 2, ruleIndex: 3, model: "p/m", repair: "fix" },
      { severity: "info", code: "info-code", path: "private-canary", repair: "note" },
    ],
    economics: { mode: "advisory", sources: [{ source: "source-a", scope: "scope-a", authority: "authoritative", freshness: "current", observedAgeMs: 55, periods: [{ window: "daily", period: "day", applicability: "current" }] }], diagnostics: [{ severity: "warning", code: "reserve-code" }] },
    reliabilityV2: { status: "initialized", revision: 9, observationsEnabled: true, cooldownOnAllowanceExhausted: true, observationCount: 201, scopes: [{ model: "p/m", generation: 4, recentFailureCount: 2 }], observations: [{ model: "p/m", category: "rate_limit", categoryEvidence: "structured", observedAt: 100, source: "test" }] },
    affinity: { mode: "on", status: "active", source: "session", anchor: { model: "p/m", provider: "p", lastSuccessfulAt: 5, ageMs: 6 } },
  } as never;
  const flatten = (rows: readonly any[]): string => rows.map((r) => `${r.label}\n${flatten(r.children ?? [])}`).join("\n");
  const output = flatten([...warningRows(full), classifierRow(full), diagnosticsRow(full)]);
  for (const fact of ["42 ms", "safe-code", "tierPolicies", "entryIndex", "ruleIndex", "allowance_exhausted", "structured", "source-a", "scope-a", "freshness", "daily", "reserve-code", "revision", "observationCount", "201", "generation", "categoryEvidence", "lastSuccessfulAt", "backend error", "info-code", "Info: note"]) assert.ok(output.includes(fact), fact);
  assert.match(output, /Observed: 1970-01-01T00:00:01\.000Z/);
  assert.match(output, /Open until: 1970-01-01T00:00:00\.123Z/);
  assert.doesNotMatch(output, /private-canary/);
  assert.match(flatten([diagnosticsRow({ ...report, diagnostics: [] })]), /Diagnostics: none/);
});
