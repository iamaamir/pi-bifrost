// Independent differential properties for reliability filtering in `resolveHealthyModel`.
//
// The existing partition property (`tests/model-selection-properties.test.ts`) can
// pass when filtering is bypassed entirely: all candidates stay healthy, nothing
// is skipped, and the partition still holds. These properties compare exact
// eligible identities/order, excluded identities/reasons, and selected
// membership against a small oracle derived from raw generated catalogs and
// explicit circuit records/clock — never from production discovery, key,
// circuit, or filter helpers.
//
// Oracle rules (from raw specs):
// - identity is the qualified `provider/id` string built locally;
// - missing state or `enabled === false` bypasses filtering entirely;
// - otherwise `open` is `typeof openUntil === "number" && openUntil > now`;
// - `open` skips as `open_circuit`, else `trialActive === true` skips as
//   `trial_active`, else the candidate stays eligible;
// - eligible and skipped pools preserve configured order;
// - `first` selects the earliest eligible candidate (or undefined when empty).
//
// Seeds are pinned so every failure replays exactly.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { resolveHealthyModel } from "../routing.ts";
import type { ReliabilityRecord, ReliabilityState } from "../reliability.ts";
import { makeCtx, makeModel } from "./helpers.ts";

const NOW = 1_700_000_000_000;
const COOLDOWN_MS = 60_000;
const ENABLED_CONFIG = { enabled: true, failureThreshold: 1, windowMinutes: 5, cooldownMinutes: 10 };
const DISABLED_CONFIG = { ...ENABLED_CONFIG, enabled: false };

interface CatalogEntry {
  readonly provider: string;
  readonly id: string;
}

interface OracleRecord {
  readonly openUntil?: number;
  readonly trialActive?: boolean;
}

interface OracleExpectation {
  readonly configured: string[];
  readonly eligible: string[];
  readonly skippedKeys: string[];
  readonly skippedReasons: Array<"open_circuit" | "trial_active">;
  readonly skippedOpenUntil: Array<number | undefined>;
}

function localKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function localKeyOf(entry: CatalogEntry): string {
  return localKey(entry.provider, entry.id);
}

function isOpen(record: OracleRecord | undefined, now: number): boolean {
  return typeof record?.openUntil === "number"
    && Number.isFinite(record.openUntil)
    && (record.openUntil as number) > now;
}

function isTrial(record: OracleRecord | undefined): boolean {
  return record?.trialActive === true;
}

/** Independent filter oracle: no production discovery/key/circuit helpers. */
function expectFilter(
  orderedKeys: readonly string[],
  records: ReadonlyMap<string, OracleRecord>,
  now: number,
  enabled: boolean,
  missingState: boolean,
): OracleExpectation {
  if (missingState || enabled === false) {
    return {
      configured: [...orderedKeys],
      eligible: [...orderedKeys],
      skippedKeys: [],
      skippedReasons: [],
      skippedOpenUntil: [],
    };
  }
  const eligible: string[] = [];
  const skippedKeys: string[] = [];
  const skippedReasons: Array<"open_circuit" | "trial_active"> = [];
  const skippedOpenUntil: Array<number | undefined> = [];
  for (const key of orderedKeys) {
    const record = records.get(key);
    if (isOpen(record, now)) {
      skippedKeys.push(key);
      skippedReasons.push("open_circuit");
      skippedOpenUntil.push(record?.openUntil);
    } else if (isTrial(record)) {
      skippedKeys.push(key);
      skippedReasons.push("trial_active");
      skippedOpenUntil.push(record?.openUntil);
    } else {
      eligible.push(key);
    }
  }
  return { configured: [...orderedKeys], eligible, skippedKeys, skippedReasons, skippedOpenUntil };
}

function toState(records: ReadonlyMap<string, OracleRecord>): ReliabilityState {
  const models: Record<string, ReliabilityRecord> = {};
  for (const [key, record] of records) {
    models[key] = {
      failures: [NOW],
      ...(record.openUntil !== undefined ? { openUntil: record.openUntil } : {}),
      ...(record.trialActive !== undefined ? { trialActive: record.trialActive } : {}),
    };
  }
  return { version: 1, models };
}

function dedupeKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(key);
    }
  }
  return ordered;
}

interface Fixture {
  readonly entries: CatalogEntry[];
  readonly patterns: string[];
  readonly records: Map<string, OracleRecord>;
  readonly orderedKeys: string[];
}

/** Build production inputs from raw entries; expected order comes from patterns. */
function buildFixture(entries: readonly CatalogEntry[], records: ReadonlyMap<string, OracleRecord>): Fixture {
  const patterns = entries.map((entry) => localKeyOf(entry));
  const orderedKeys = dedupeKeys(patterns);
  return { entries: [...entries], patterns, records: new Map(records), orderedKeys };
}

function checkFixture(
  fixture: Fixture,
  now: number,
  config: typeof ENABLED_CONFIG,
  missingState: boolean,
  expected: OracleExpectation,
): void {
  const models = fixture.entries.map((entry) => makeModel(entry.provider, entry.id));
  const ctx = makeCtx(models);
  const state = missingState ? undefined : toState(fixture.records);
  const resolution = resolveHealthyModel(
    ctx,
    fixture.patterns,
    "first",
    state,
    config,
    now,
    undefined,
    () => 0.5,
  );
  const candidateKeys = resolution.candidates.map((model) => localKey(model.provider, model.id));
  const healthyKeys = resolution.healthyCandidates.map((model) => localKey(model.provider, model.id));
  const skippedKeys = resolution.skipped.map((entry) => entry.key);
  const skippedReasons = resolution.skipped.map((entry) => entry.reason);
  const skippedOpenUntil = resolution.skipped.map((entry) => entry.openUntil);

  assert.deepEqual(candidateKeys, expected.configured, "configured candidates must match exact patterns in order");
  assert.deepEqual(healthyKeys, expected.eligible, "eligible identities must match the oracle in order");
  assert.deepEqual(skippedKeys, expected.skippedKeys, "excluded identities must match the oracle in order");
  assert.deepEqual(skippedReasons, expected.skippedReasons, "excluded reasons must match the oracle");
  assert.deepEqual(skippedOpenUntil, expected.skippedOpenUntil, "excluded openUntil must match the oracle");
  if (expected.eligible.length === 0) {
    assert.equal(resolution.selected, undefined, "no eligible candidate must select nothing");
  } else {
    assert.ok(resolution.selected, "an eligible pool must select a candidate");
    const selectedKey = localKey(resolution.selected!.provider, resolution.selected!.id);
    assert.equal(selectedKey, expected.eligible[0], "first must select the earliest eligible candidate");
    assert.ok(expected.eligible.includes(selectedKey), "selected candidate must be eligible");
  }
}

const PROVIDER_ARB = fc.constantFrom("fix-alpha", "fix-beta", "FIX-GAMMA");

function entriesArbitrary(): fc.Arbitrary<CatalogEntry[]> {
  return fc.array(
    fc.record({ provider: PROVIDER_ARB, suffix: fc.integer({ min: 0, max: 50 }) }),
    { minLength: 3, maxLength: 6 },
  ).map((rows) => rows.map((row, index) => ({ provider: row.provider, id: `pool-${index}-${row.suffix}` })));
}

type Marker = "open" | "trial" | "eligible" | "expired";

const MARKER_ARB: fc.Arbitrary<Marker> = fc.constantFrom("open", "trial", "eligible", "expired");

function recordFor(marker: Marker): OracleRecord | undefined {
  switch (marker) {
    case "open":
      return { openUntil: NOW + COOLDOWN_MS, trialActive: false };
    case "trial":
      return { openUntil: NOW - 1, trialActive: true };
    case "expired":
      return { openUntil: NOW - 1, trialActive: false };
    case "eligible":
      return undefined;
  }
}

/** Generated catalogs always carry open, trial, and eligible witnesses. */
function witnessedFixtureArbitrary(): fc.Arbitrary<Fixture> {
  return fc.tuple(entriesArbitrary(), fc.array(MARKER_ARB, { minLength: 3, maxLength: 6 })).map(([entries, markers]) => {
    const records = new Map<string, OracleRecord>();
    const forced: Marker[] = ["open", "trial", "eligible"];
    entries.forEach((entry, index) => {
      const marker = index < forced.length ? forced[index] : markers[index % Math.max(markers.length, 1)];
      const record = recordFor(marker ?? "eligible");
      if (record) records.set(localKeyOf(entry), record);
    });
    return buildFixture(entries, records);
  });
}

const SEQUENCE_SEED = 20260791;
const WITNESS_SEED = 20260792;
const BOUNDARY_SEED = 20260793;

describe("reliability filter properties", () => {
  it("matches the independent oracle across generated catalogs", () => {
    fc.assert(
      fc.property(witnessedFixtureArbitrary(), (fixture) => {
        const expected = expectFilter(fixture.orderedKeys, fixture.records, NOW, true, false);
        assert.ok(expected.eligible.length > 0, "generated fixture must keep an eligible witness");
        assert.ok(expected.skippedReasons.includes("open_circuit"), "generated fixture must keep an open witness");
        assert.ok(expected.skippedReasons.includes("trial_active"), "generated fixture must keep a trial witness");
        checkFixture(fixture, NOW, ENABLED_CONFIG, false, expected);
      }),
      { seed: SEQUENCE_SEED, numRuns: 200 },
    );
  });

  it("keeps qualified identity and stable order", () => {
    fc.assert(
      fc.property(fc.constantFrom("fix-alpha", "fix-beta"), (provider) => {
        void provider;
        const entries: CatalogEntry[] = [
          { provider: "fix-alpha", id: "same" },
          { provider: "fix-beta", id: "same" },
          { provider: "FIX-GAMMA", id: "pool-2" },
        ];
        const records = new Map<string, OracleRecord>([
          [localKey("fix-alpha", "same"), { openUntil: NOW + COOLDOWN_MS, trialActive: false }],
          [localKey("fix-beta", "same"), { openUntil: NOW - 1, trialActive: true }],
        ]);
        const fixture = buildFixture(entries, records);
        const expected = expectFilter(fixture.orderedKeys, fixture.records, NOW, true, false);
        assert.deepEqual(expected.configured, ["fix-alpha/same", "fix-beta/same", "FIX-GAMMA/pool-2"]);
        assert.deepEqual(expected.eligible, ["FIX-GAMMA/pool-2"]);
        assert.deepEqual(expected.skippedKeys, ["fix-alpha/same", "fix-beta/same"]);
        assert.deepEqual(expected.skippedReasons, ["open_circuit", "trial_active"]);
        checkFixture(fixture, NOW, ENABLED_CONFIG, false, expected);
      }),
      { seed: WITNESS_SEED, numRuns: 20 },
    );
  });

  it("treats cooldown before as excluded and equal/after as eligible", () => {
    const entries: CatalogEntry[] = [
      { provider: "fix-alpha", id: "before" },
      { provider: "fix-alpha", id: "equal" },
      { provider: "fix-alpha", id: "after" },
    ];
    const records = new Map<string, OracleRecord>([
      [localKey("fix-alpha", "before"), { openUntil: NOW + 1, trialActive: false }],
      [localKey("fix-alpha", "equal"), { openUntil: NOW, trialActive: false }],
      [localKey("fix-alpha", "after"), { openUntil: NOW - 1, trialActive: false }],
    ]);
    const fixture = buildFixture(entries, records);
    const expected = expectFilter(fixture.orderedKeys, fixture.records, NOW, true, false);
    assert.deepEqual(expected.eligible, ["fix-alpha/equal", "fix-alpha/after"]);
    assert.deepEqual(expected.skippedKeys, ["fix-alpha/before"]);
    assert.deepEqual(expected.skippedReasons, ["open_circuit"]);
    checkFixture(fixture, NOW, ENABLED_CONFIG, false, expected);

    // One millisecond before expiry is still open; expiry itself is half-open eligible.
    const before = expectFilter(["fix-alpha/before"], records, NOW, true, false);
    assert.deepEqual(before.eligible, []);
    const atEdge = expectFilter(["fix-alpha/equal"], records, NOW, true, false);
    assert.deepEqual(atEdge.eligible, ["fix-alpha/equal"]);
    fc.assert(
      fc.property(fc.constantFrom(0), () => {
        checkFixture(fixture, NOW, ENABLED_CONFIG, false, expected);
      }),
      { seed: BOUNDARY_SEED, numRuns: 5 },
    );
  });

  it("bypasses filtering when state is missing or reliability is disabled", () => {
    const entries: CatalogEntry[] = [
      { provider: "fix-alpha", id: "pool-0" },
      { provider: "fix-beta", id: "pool-1" },
      { provider: "FIX-GAMMA", id: "pool-2" },
    ];
    const records = new Map<string, OracleRecord>([
      [localKey("fix-alpha", "pool-0"), { openUntil: NOW + COOLDOWN_MS, trialActive: false }],
      [localKey("fix-beta", "pool-1"), { openUntil: NOW - 1, trialActive: true }],
    ]);
    const fixture = buildFixture(entries, records);

    const missing = expectFilter(fixture.orderedKeys, fixture.records, NOW, true, true);
    assert.deepEqual(missing.eligible, fixture.orderedKeys);
    assert.deepEqual(missing.skippedKeys, []);
    checkFixture(fixture, NOW, ENABLED_CONFIG, true, missing);

    const disabled = expectFilter(fixture.orderedKeys, fixture.records, NOW, false, false);
    assert.deepEqual(disabled.eligible, fixture.orderedKeys);
    assert.deepEqual(disabled.skippedKeys, []);
    checkFixture(fixture, NOW, DISABLED_CONFIG, false, disabled);
  });

  it("keeps mixed eligible and excluded pools exact", () => {
    const entries: CatalogEntry[] = [
      { provider: "fix-alpha", id: "pool-0" },
      { provider: "fix-beta", id: "pool-1" },
      { provider: "fix-alpha", id: "pool-2" },
      { provider: "fix-beta", id: "pool-3" },
    ];
    const records = new Map<string, OracleRecord>([
      [localKey("fix-alpha", "pool-0"), { openUntil: NOW + COOLDOWN_MS, trialActive: false }],
      [localKey("fix-beta", "pool-1"), { openUntil: NOW - 1, trialActive: true }],
      [localKey("fix-beta", "pool-3"), { openUntil: NOW - 1, trialActive: false }],
    ]);
    const fixture = buildFixture(entries, records);
    const expected = expectFilter(fixture.orderedKeys, fixture.records, NOW, true, false);
    assert.deepEqual(expected.eligible, ["fix-alpha/pool-2", "fix-beta/pool-3"]);
    assert.deepEqual(expected.skippedKeys, ["fix-alpha/pool-0", "fix-beta/pool-1"]);
    assert.deepEqual(expected.skippedReasons, ["open_circuit", "trial_active"]);
    checkFixture(fixture, NOW, ENABLED_CONFIG, false, expected);
  });
});
