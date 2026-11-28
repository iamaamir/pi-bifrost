import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  classifierStatusPanel,
  type ClassifierStatusFacts,
} from "../ui/classifier-status.ts";
import { summaryPanel, summaryText } from "../ui/summary-panel.ts";

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
} as never;

function facts(overrides: Partial<ClassifierStatusFacts> = {}): ClassifierStatusFacts {
  return {
    enabled: true,
    source: "configuration",
    configured: true,
    readiness: "ready",
    backend: {
      name: "typesafe",
      auto: true,
      reason: "env key detected",
      model: "jev-1.13.0",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      minConfidence: 0.8,
      credential: "environment",
      fallback: "prompt",
      fallbackModel: "fixture/classifier",
    },
    activity: { observations: 12, outcomes: { success: 10, low_confidence: 2 }, averageLatencyMs: 850 },
    ...overrides,
  };
}

describe("classifier status panel", () => {
  it("shows the answer first, then settings, then persisted activity", () => {
    const lines = summaryText(classifierStatusPanel(facts()));
    // Label width follows the longest label ("Minimum confidence"), plus the
    // two-column gap from docs/ui-design-system.md.
    const row = (label: string, value: string) => label.padEnd(20) + value;
    assert.deepEqual(lines, [
      row("Status", "On · ready (configuration)"),
      "",
      row("Configured", "On"),
      row("Backend", "auto: typesafe (env key detected)"),
      row("Model", "jev-1.13.0"),
      row("Endpoint", "https://api.typesafe.ai/v1/systemone"),
      row("Minimum confidence", "0.8"),
      row("Credential", "environment"),
      row("Fallback", "prompt"),
      row("Fallback model", "fixture/classifier"),
      "",
      row("Activity", "12 observations (persisted aggregate)"),
      row("Outcomes", "low_confidence 2 · success 10"),
      row("Average latency", "850 ms"),
    ]);
  });

  it("keeps prompt-backend settings and omits direct-backend-only rows", () => {
    const lines = summaryText(
      classifierStatusPanel(
        facts({
          backend: { name: "prompt", auto: false, model: "fixture/classifier", endpoint: "registry", method: "auto" },
          activity: undefined,
        }),
      ),
    );
    assert(lines.includes("Backend     prompt"));
    assert(lines.includes("Model       fixture/classifier"));
    assert(lines.includes("Endpoint    registry"));
    assert(lines.includes("Method      auto"));
    assert(!lines.some((line) => line.startsWith("Minimum confidence")));
    assert(!lines.some((line) => line.startsWith("Activity")));
  });

  it("names the legacy conflict and the fail-closed runtime state", () => {
    const conflict = summaryText(
      classifierStatusPanel(
        facts({
          enabled: false,
          source: "legacy-conflict",
          configured: false,
          readiness: "inactive",
          legacyConflict: {
            saved: true,
            configured: false,
            note: "configured off takes precedence; /bifrost classifier on overrides only this session",
          },
        }),
      ),
    );
    assert.match(conflict[0]!, /^Status\s+Off · inactive \(legacy-conflict\)$/);
    assert.equal(
      conflict[1],
      "! Legacy saved classifierEnabled=true conflicts with configured=false; configured off takes precedence; /bifrost classifier on overrides only this session",
    );

    const invalid = summaryText(
      classifierStatusPanel(
        facts({
          enabled: false,
          source: "runtime-state-invalid",
          readiness: "blocked",
          runtimeStateIssue: "invalid-json",
        }),
      ),
    );
    assert.match(invalid[0]!, /^Status\s+Off · blocked \(runtime-state-invalid\)$/);
    assert.match(
      invalid[1]!,
      /^✗ Classification is paused because \.pi\/bifrost-state\.json is unreadable or invalid \(invalid-json\)\./,
    );
    assert.match(invalid[1]!, /then run \/bifrost reload\.$/);
  });

  it("uses the theme roles the design system assigns to each part", () => {
    const roles: Array<[string, string]> = [];
    const recording = {
      fg: (role: string, text: string) => {
        roles.push([role, text]);
        return text;
      },
      bg: (role: string, text: string) => {
        roles.push([`bg:${role}`, text]);
        return text;
      },
      bold: (text: string) => text,
    } as never;
    summaryPanel(
      recording,
      classifierStatusPanel(facts({ enabled: false, source: "runtime-state-invalid", readiness: "blocked", runtimeStateIssue: "invalid-json" })),
    ).render(120);

    assert(roles.some(([role, text]) => role === "accent" && text.includes("classifier status")));
    assert(roles.some(([role, text]) => role === "dim" && /^─+$/.test(text)));
    assert(roles.some(([role, text]) => role === "muted" && text === "Status"));
    assert(roles.some(([role, text]) => role === "text" && text.startsWith("Off · blocked")));
    // The error marker carries the severity; the sentence stays body-colored.
    assert(roles.some(([role, text]) => role === "error" && text === "✗ "));
    assert(roles.some(([role, text]) => role === "text" && text.startsWith("Classification is paused")));
    assert(roles.some(([role]) => role === "bg:toolPendingBg"));
  });

  it("renders every line inside the available width", () => {
    for (const width of [120, 60, 40]) {
      const lines = summaryPanel(theme, classifierStatusPanel(facts())).render(width);
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `${width}-wide render overflowed: ${JSON.stringify(line)}`);
      }
      const text = lines.join("\n");
      assert.match(text, /Bifrost · classifier status/);
      assert.match(text, /Status/);
      assert.match(text, /On · ready/);
    }
  });

  it("keeps the narrow render readable after wrapping", () => {
    const lines = summaryPanel(
      theme,
      classifierStatusPanel(facts({ enabled: false, readiness: "blocked", runtimeStateIssue: "invalid-shape" })),
    ).render(40);
    const text = lines.join("\n");
    assert.match(text, /Status/);
    assert.match(text, /Off ·/);
    assert.match(text, /blocked \(configuration\)/);
    assert.match(text, /Classification is paused/);
    assert.match(text, /Endpoint/);
  });
});
