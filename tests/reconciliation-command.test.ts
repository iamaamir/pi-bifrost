import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import {
  buildInitOwnershipReceipt,
  parseReconciliationCommandArgs,
  runReconciliationCommand,
  type ReconciliationCommandDependencies,
  type ReconciliationCommandSnapshot,
} from "../reconciliation-command.ts";
import {
  ReconciliationStoreError,
  type ApplyReconciliationTransactionInput,
} from "../reconciliation-store.ts";

const CONFIG = Buffer.from(JSON.stringify({
  enabled: true,
  models: { general: ["manual/model"], frontier: ["openai/old"] },
  unrelated: { retained: true },
}, null, 2) + "\n");

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshot(overrides: Partial<ReconciliationCommandSnapshot> = {}): ReconciliationCommandSnapshot {
  return {
    source: {
      source: "project",
      configPath: "/project/.pi/bifrost.json",
      ownershipPath: "/project/.pi/bifrost-ownership.json",
      journalPath: "/project/.pi/bifrost-reconcile.journal",
      configBytes: CONFIG,
      ownershipBytes: null,
    },
    registry: {
      models: [
        { provider: "openai", id: "gpt-5.4", virtual: false },
        { provider: "openai", id: "auto", virtual: true },
        { provider: "anthropic", id: "sonnet", virtual: false },
      ],
      knownProviders: ["openai", "anthropic"],
      authConfigured: true,
      hasRegistryError: false,
      forceRefresh: false,
      refreshEvidence: { status: "complete", refreshedAt: 9_000 },
      now: 10_000,
      freshnessTtlMs: 30_000,
    },
    ...overrides,
  };
}

function dependencies(overrides: Partial<ReconciliationCommandDependencies> = {}): ReconciliationCommandDependencies {
  return {
    validateMergedConfig: () => true,
    apply: () => ({ status: "committed", transactionId: "00000000-0000-4000-8000-000000000001" }),
    recover: () => ({ status: "nothing_to_recover" }),
    ...overrides,
  };
}

function preview(overrides: {
  readonly snapshot?: Partial<ReconciliationCommandSnapshot>;
  readonly dependencies?: Partial<ReconciliationCommandDependencies>;
} = {}) {
  return runReconciliationCommand(
    { action: "preview", source: "project", tier: "general", provider: "openai", json: true },
    snapshot(overrides.snapshot),
    dependencies(overrides.dependencies),
  );
}

describe("config reconciliation command boundary", () => {
  it("parses only explicit source, tier, provider, apply digest, and recovery flags", () => {
    assert.deepEqual(parseReconciliationCommandArgs("--tier general --provider openai"), {
      ok: true,
      request: { action: "preview", source: "project", tier: "general", provider: "openai", json: false },
    });
    assert.deepEqual(parseReconciliationCommandArgs("--source user --tier general --provider openai --refresh"), {
      ok: true,
      request: { action: "preview", source: "user", tier: "general", provider: "openai", json: false, refresh: true },
    });
    assert.equal(parseReconciliationCommandArgs(`--tier general --provider openai --refresh --apply --proposal ${"a".repeat(64)}`).ok, false);
    assert.equal(parseReconciliationCommandArgs("--recover --tier general").ok, false);
    assert.equal(parseReconciliationCommandArgs("--apply --tier general --provider openai").ok, false);
    assert.equal(parseReconciliationCommandArgs(`--apply --tier general --provider openai --proposal ${"a".repeat(64)}`).ok, true);
  });

  it("previews additions from the selected layer without writes or flattening unrelated config", () => {
    let applied = false;
    let validatedSource: string | undefined;
    let candidate: Record<string, unknown> | undefined;
    const report = preview({ dependencies: {
      validateMergedConfig: (source, bytes) => {
        validatedSource = source;
        candidate = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
        return true;
      },
      apply: () => { applied = true; return { status: "committed", transactionId: "not-used" }; },
    } });

    assert.equal(report.status, "ready");
    assert.equal(report.inventoryStatus, "complete");
    assert.deepEqual(report.changes, [
      { kind: "add", disposition: "apply", tier: "general", modelKey: "openai/gpt-5.4" },
    ]);
    assert.equal(validatedSource, "project");
    assert.deepEqual((candidate?.models as Record<string, unknown>).general, ["manual/model", "openai/gpt-5.4"]);
    assert.deepEqual((candidate?.models as Record<string, unknown>).frontier, ["openai/old"]);
    assert.deepEqual(candidate?.unrelated, { retained: true });
    assert.equal(applied, false);
    assert.equal(JSON.stringify(report).includes("transactionInput"), false);
  });

  it("blocks preview when an unrelated source tier violates the store config shape", () => {
    const invalidConfig = Buffer.from(JSON.stringify({
      models: { general: ["manual/model"], frontier: ["openai/old", "openai/old"] },
    }));
    let applied = false;
    const report = preview({
      snapshot: { source: { ...snapshot().source, configBytes: invalidConfig } },
      dependencies: { apply: () => { applied = true; return { status: "committed", transactionId: "not-used" }; } },
    });

    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "source_invalid");
    assert.equal(applied, false);
  });

  it("binds apply to the exact reviewed proposal and passes only selected-source bytes to the journal store", () => {
    const proposal = preview();
    assert.equal(proposal.status, "ready");
    assert.ok(proposal.proposalDigest);
    let transaction: ApplyReconciliationTransactionInput | undefined;
    const result = runReconciliationCommand({
      action: "apply", source: "project", tier: "general", provider: "openai",
      proposalDigest: proposal.proposalDigest!, json: true,
    }, snapshot(), dependencies({ apply: (input) => {
      transaction = input;
      return { status: "committed", transactionId: "00000000-0000-4000-8000-000000000001" };
    } }));

    assert.equal(result.status, "committed");
    assert.equal(transaction?.expectedConfigDigest, digest(CONFIG));
    assert.equal(transaction?.expectedOwnershipDigest, null);
    assert.equal(transaction?.configPath, "/project/.pi/bifrost.json");
    assert.equal(transaction?.ownershipPath, "/project/.pi/bifrost-ownership.json");
    assert.equal(transaction?.journalPath, "/project/.pi/bifrost-reconcile.journal");
    assert.ok(transaction?.nextOwnershipBytes.byteLength);
    assert.equal(Buffer.from(transaction!.nextConfigBytes).toString("utf8").includes("manual/model"), true);
  });

  it("reports store rejection of invalid config input as a source error", () => {
    const proposal = preview();
    const result = runReconciliationCommand({
      action: "apply", source: "project", tier: "general", provider: "openai",
      proposalDigest: proposal.proposalDigest!, json: true,
    }, snapshot(), dependencies({
      apply: () => { throw new ReconciliationStoreError("invalid_input"); },
    }));

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "source_invalid");
  });

  it("keeps exact config bytes when only a user removal needs an ownership tombstone", () => {
    const original = Buffer.from('{\n  "models" : { "general" : [] },\n  "keep" : true\n}\n');
    const receipt = buildInitOwnershipReceipt({ general: ["openai/retired"] });
    assert.ok(receipt);
    const ownershipBytes = Buffer.from(JSON.stringify(receipt));
    const input = snapshot({
      source: { ...snapshot().source, configBytes: original, ownershipBytes },
      registry: { ...snapshot().registry, models: [] },
    });
    const previewReport = runReconciliationCommand(
      { action: "preview", source: "project", tier: "general", provider: "openai", json: true },
      input,
      dependencies(),
    );
    assert.equal(previewReport.status, "ready");
    assert.deepEqual(previewReport.changes, []);
    assert.ok(previewReport.proposalDigest);

    let candidateBytes: Uint8Array | undefined;
    let applied = false;
    const appliedReport = runReconciliationCommand({
      action: "apply", source: "project", tier: "general", provider: "openai",
      proposalDigest: previewReport.proposalDigest!, json: true,
    }, input, dependencies({
      validateMergedConfig: (_source, bytes) => { candidateBytes = bytes; return true; },
      apply: (transaction) => {
        applied = true;
        assert.deepEqual(transaction.nextConfigBytes, original);
        return { status: "committed", transactionId: "00000000-0000-4000-8000-000000000001" };
      },
    }));
    assert.equal(appliedReport.status, "committed");
    assert.equal(applied, true);
    assert.deepEqual(candidateBytes, original);
  });

  it("rejects a source receipt whose claimed memberships belong to another tier", () => {
    const receipt = buildInitOwnershipReceipt({ general: ["openai/owned"] });
    assert.ok(receipt);
    const sourceId = Object.keys(receipt.sources)[0]!;
    const malformed = {
      version: 1,
      sources: {
        [sourceId]: { generated: { frontier: ["openai/owned"] }, tombstones: {} },
      },
    };
    const report = preview({ snapshot: { source: {
      ...snapshot().source,
      ownershipBytes: Buffer.from(JSON.stringify(malformed)),
    } } });
    assert.equal(report.status, "blocked");
    assert.equal(report.reason, "source_invalid");
    assert.deepEqual(report.changes, []);
  });

  it("rejects a changed reviewed snapshot before calling apply", () => {
    const proposal = preview();
    let applied = false;
    const changed = snapshot({ source: {
      ...snapshot().source,
      configBytes: Buffer.from(CONFIG.toString("utf8").replace("manual/model", "edited/model")),
    } });
    const result = runReconciliationCommand({
      action: "apply", source: "project", tier: "general", provider: "openai",
      proposalDigest: proposal.proposalDigest!, json: true,
    }, changed, dependencies({ apply: () => {
      applied = true;
      return { status: "committed", transactionId: "not-used" };
    } }));
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "proposal_changed");
    assert.equal(applied, false);
  });

  it("does not authorize removals from partial, stale, unknown-auth, unconfigured-auth, or forced-refresh evidence", () => {
    const cases: Array<{ label: string; registry: Partial<ReconciliationCommandSnapshot["registry"]>; reason: string }> = [
      { label: "partial", registry: { refreshEvidence: { status: "partial", refreshedAt: 9_000 } }, reason: "inventory_partial" },
      { label: "stale", registry: { refreshEvidence: { status: "stale", refreshedAt: 9_000 } }, reason: "inventory_stale" },
      { label: "unknown auth", registry: { authConfigured: undefined }, reason: "auth_unknown" },
      { label: "not configured", registry: { authConfigured: false }, reason: "auth_not_configured" },
      { label: "forced refresh pending", registry: { forceRefresh: true }, reason: "inventory_stale" },
    ];
    for (const testCase of cases) {
      let applied = false;
      const report = preview({
        snapshot: { registry: { ...snapshot().registry, ...testCase.registry } },
        dependencies: { apply: () => { applied = true; return { status: "committed", transactionId: "not-used" }; } },
      });
      assert.equal(report.status, "advisory", testCase.label);
      assert.equal(report.reason, testCase.reason, testCase.label);
      assert.ok(report.changes.every((change) => change.disposition === "advisory"), testCase.label);
      assert.equal(applied, false, testCase.label);
    }
  });

  it("blocks unknown providers, registry errors, and expired inventory", () => {
    assert.equal(preview({ snapshot: { registry: { ...snapshot().registry, knownProviders: [] } } }).reason, "provider_unknown");
    assert.equal(preview({ snapshot: { registry: { ...snapshot().registry, hasRegistryError: true } } }).reason, "inventory_stale");
    assert.equal(preview({ snapshot: { registry: { ...snapshot().registry, now: 40_000 } } }).reason, "inventory_stale");
  });

  it("requires an explicit tier in the selected source and validates the prospective merged result", () => {
    assert.equal(preview({ snapshot: { source: { ...snapshot().source, configBytes: Buffer.from('{"models":{"frontier":[]}}') } } }).reason, "tier_not_explicit");
    let applyCalls = 0;
    const report = runReconciliationCommand({
      action: "apply", source: "project", tier: "general", provider: "openai",
      proposalDigest: preview().proposalDigest!, json: true,
    }, snapshot(), dependencies({ validateMergedConfig: () => false, apply: () => {
      applyCalls++;
      return { status: "committed", transactionId: "not-used" };
    } }));
    assert.equal(report.reason, "prospective_config_invalid");
    assert.equal(applyCalls, 0);
  });

  it("maps stale lock repair and journal recovery states to explicit operator-facing outcomes", () => {
    const request = { action: "apply", source: "project", tier: "general", provider: "openai", proposalDigest: preview().proposalDigest!, json: true } as const;
    const locked = runReconciliationCommand(request, snapshot(), dependencies({
      apply: () => { throw new ReconciliationStoreError("locked"); },
    }));
    assert.equal(locked.reason, "operator_repair_required");
    assert.doesNotMatch(JSON.stringify(locked), /private provider|config text/u);

    const recovery = runReconciliationCommand(
      { action: "recover", source: "user", json: true },
      snapshot({ source: { ...snapshot().source, source: "user" } }),
      dependencies({ recover: () => ({ status: "conflict", transactionId: "00000000-0000-4000-8000-000000000001" }) }),
    );
    assert.equal(recovery.status, "conflict");
    assert.equal(recovery.reason, "recovery_conflict");
    assert.doesNotMatch(JSON.stringify(recovery), /private provider|config text/u);
  });

  it("creates init ownership only for exact memberships generated by that run", () => {
    const receipt = buildInitOwnershipReceipt({
      general: ["openai/gpt-5.4", "anthropic/sonnet"],
      quick: ["openai/gpt-5.4-mini"],
    }, { general: ["openai/gpt-5.4", "manual/preserved"] });
    assert.ok(receipt);
    assert.equal(receipt.version, 1);
    assert.equal(Object.keys(receipt.sources).length, 2);
    const generated = Object.values(receipt.sources).flatMap((source) =>
      Object.entries(source.generated).flatMap(([tier, models]) => models.map((model) => `${tier}:${model}`)));
    assert.deepEqual(generated.sort(), [
      "general:anthropic/sonnet",
      "quick:openai/gpt-5.4-mini",
    ]);
    assert.equal(Object.values(receipt.sources).some((source) => Object.keys(source.tombstones).length > 0), false);
    assert.equal(buildInitOwnershipReceipt({ general: ["openai/*"] }), undefined);
  });
});
