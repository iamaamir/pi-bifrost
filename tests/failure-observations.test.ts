import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNormalizedFailureObservation, normalizeFailureObservation, type FailureCategory } from "../failure-observations.ts";

const base = {
  outcomeId: "turn-7:dispatch-2",
  modelKey: "openai/gpt-5.4",
  source: "runtime",
};

describe("failure observation normalization", () => {
  it("accepts the full normalized taxonomy from structured adapter facts", () => {
    const categories: FailureCategory[] = [
      "rate_limit",
      "allowance_exhausted",
      "authentication",
      "billing_denied",
      "overload",
      "transport",
      "model_unavailable",
      "invalid_request",
      "capability_mismatch",
      "context_limit",
      "tool_protocol",
      "activation_failed",
      "unknown",
    ];

    for (const category of categories) {
      const observation = normalizeFailureObservation({
        ...base,
        structured: { category },
      }, { now: 1_800_000_000_000 });
      assert.equal(observation?.category, category);
      assert.equal(observation?.categoryEvidence, "structured");
    }
  });

  it("prefers structured categories, then recognized HTTP evidence, then text hints", () => {
    const structured = normalizeFailureObservation({
      ...base,
      structured: { category: "invalid_request", httpStatus: 503 },
      errorText: "quota exhausted",
    }, { now: 1000 });
    assert.equal(structured?.category, "invalid_request");
    assert.equal(structured?.categoryEvidence, "structured");

    const status = normalizeFailureObservation({
      ...base,
      structured: { httpStatus: 503 },
      errorText: "quota exhausted",
    }, { now: 1000 });
    assert.equal(status?.category, "overload");
    assert.equal(status?.categoryEvidence, "http_status");

    const heuristic = normalizeFailureObservation({
      ...base,
      error: { message: "The model hit its context limit" },
    }, { now: 1000 });
    assert.equal(heuristic?.category, "context_limit");
    assert.equal(heuristic?.categoryEvidence, "text_heuristic");
  });

  it("recognizes the reported exhausted-usage wording without retaining its text", () => {
    const errorText = "Error: Codex error: The usage limit has been reached";
    const observation = normalizeFailureObservation({ ...base, errorText }, { now: 1000 });
    assert.equal(observation?.category, "allowance_exhausted");
    assert.equal(observation?.categoryEvidence, "text_heuristic");
    assert.equal(JSON.stringify(observation).includes(errorText), false);
  });

  it("recognizes explicit exhausted-credit wording while ignoring generic 402 and incidental credit mentions", () => {
    const errorText = 'Error: 402 "You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get monthly included credits."';
    const observation = normalizeFailureObservation({ ...base, errorText }, { now: 1000 });
    assert.equal(observation?.category, "allowance_exhausted");
    assert.equal(observation?.categoryEvidence, "text_heuristic");
    assert.deepEqual(observation?.scope, { kind: "model", modelKey: base.modelKey });
    assert.equal(observation?.scopeEvidence, "model-only");
    assert.equal(JSON.stringify(observation).includes(errorText), false);

    const generic402 = normalizeFailureObservation({ ...base, structured: { httpStatus: 402 } }, { now: 1000 });
    assert.equal(generic402?.category, "unknown");
    assert.equal(generic402?.categoryEvidence, "unknown");
    const incidentalCredits = normalizeFailureObservation({
      ...base,
      errorText: "This feature requires credits to use with the selected model",
    }, { now: 1000 });
    assert.equal(incidentalCredits?.category, "unknown");
    assert.equal(incidentalCredits?.categoryEvidence, "unknown");
  });

  it("does not treat Pi's ambiguous friendly usage-limit message as hard exhaustion", () => {
    const observation = normalizeFailureObservation({
      ...base,
      errorText: "You have hit your ChatGPT usage limit",
    }, { now: 1000 });
    assert.equal(observation?.category, "unknown");
    assert.equal(observation?.categoryEvidence, "unknown");
  });

  it("treats specific usage quota codes as allowance exhaustion but generic rate limits as rate limits", () => {
    for (const code of ["usage_limit_reached", "insufficient_quota"]) {
      const observation = normalizeFailureObservation({ ...base, error: { code } }, { now: 1000 });
      assert.equal(observation?.category, "allowance_exhausted", code);
      assert.equal(observation?.categoryEvidence, "structured", code);
      assert.equal(JSON.stringify(observation).includes(code), false);
    }

    const rateLimitCode = normalizeFailureObservation({ ...base, error: { code: "rate_limit_exceeded" } }, { now: 1000 });
    assert.equal(rateLimitCode?.category, "rate_limit");
    assert.equal(rateLimitCode?.categoryEvidence, "structured");

    const friendlyRateLimit = normalizeFailureObservation({
      ...base,
      error: { code: "rate_limit_exceeded", message: "You have hit your ChatGPT usage limit" },
    }, { now: 1000 });
    assert.equal(friendlyRateLimit?.category, "rate_limit");
    assert.equal(friendlyRateLimit?.categoryEvidence, "structured");

    const explicitRateLimit = normalizeFailureObservation({
      ...base,
      structured: { httpStatus: 429 },
      errorText: "The usage limit has been reached",
    }, { now: 1000 });
    assert.equal(explicitRateLimit?.category, "rate_limit");
    assert.equal(explicitRateLimit?.categoryEvidence, "http_status");

    const status = normalizeFailureObservation({ ...base, structured: { httpStatus: 429 } }, { now: 1000 });
    assert.equal(status?.category, "rate_limit");
    assert.equal(status?.categoryEvidence, "http_status");
  });

  it("keeps HTTP 429 and 503 model-scoped and ignores supplied broader scopes", () => {
    for (const [httpStatus, category] of [[429, "rate_limit"], [503, "overload"]] as const) {
      const observation = normalizeFailureObservation({
        ...base,
        structured: {
          httpStatus,
          scope: { kind: "provider", provider: "secret-account-name" },
          accountRef: "credential-secret",
        },
      }, { now: 1000 });
      assert.equal(observation?.category, category);
      assert.deepEqual(observation?.scope, { kind: "model", modelKey: base.modelKey });
      assert.equal(observation?.scopeEvidence, "model-only");
    }
  });

  it("returns only bounded codes and times when raw errors contain prompts, secrets, and paths", () => {
    const secretPrompt = "Please inspect /Users/alice/private/project and use sk-live-secret-token";
    const input = {
      ...base,
      errorText: `${secretPrompt}; HTTP 429`,
      error: {
        message: `${secretPrompt}; rate limit exceeded`,
        code: "secret-provider-code",
        path: "/Users/alice/private/project/config.json",
        prompt: secretPrompt,
        headers: { authorization: "Bearer sk-live-secret-token" },
        accountId: "customer-private-id",
      },
      rawResponse: { body: secretPrompt },
      provider: "secret-private-provider-label",
      arbitraryMetadata: "private diagnostic metadata",
    };
    const observation = normalizeFailureObservation(input, { now: 1000 });

    assert.equal(observation?.category, "rate_limit");
    assert.equal(observation?.scope.kind, "model");
    const serialized = JSON.stringify(observation);
    for (const secret of ["Users/alice", "sk-live", "private/project", "secret-provider-code", "customer-private-id", "private diagnostic"]) {
      assert.equal(serialized.includes(secret), false, `normalized observation leaked ${secret}`);
    }
  });

  it("uses safe defaults for unknown text and clamps past retry times to observation time", () => {
    const observation = normalizeFailureObservation({
      ...base,
      observedAt: 2000,
      structured: { retryAt: 1500 },
      errorText: "provider returned an unusual response",
    }, { now: 2500 });
    assert.equal(observation?.category, "unknown");
    assert.equal(observation?.categoryEvidence, "unknown");
    assert.equal(observation?.observedAt, 2000);
    assert.equal(observation?.retryAt, 2000);
  });

  it("validates normalized unknown and text evidence when structured retry timing is present", () => {
    const unknown = normalizeFailureObservation({
      ...base,
      observedAt: 2000,
      structured: { retryAt: 2100 },
      errorText: "provider returned an unusual response",
    }, { now: 2500 });
    assert.equal(unknown?.categoryEvidence, "unknown");
    assert.equal(unknown?.retryAt, 2100);
    assert.equal(isNormalizedFailureObservation(unknown, { now: 2500 }), true);

    const heuristic = normalizeFailureObservation({
      ...base,
      observedAt: 2000,
      structured: { retryAt: 2200 },
      errorText: "connection reset while sending request",
    }, { now: 2500 });
    assert.equal(heuristic?.category, "transport");
    assert.equal(heuristic?.categoryEvidence, "text_heuristic");
    assert.equal(heuristic?.retryAt, 2200);
    assert.equal(isNormalizedFailureObservation(heuristic, { now: 2500 }), true);
    assert.equal(isNormalizedFailureObservation({ ...heuristic, errorText: "private metadata" }, { now: 2500 }), false);
    assert.equal(isNormalizedFailureObservation({ ...heuristic, scopeEvidence: "provider" }, { now: 2500 }), false);
  });

  it("rejects future observations and accepts model IDs with slashes after the provider", () => {
    assert.equal(normalizeFailureObservation({
      ...base,
      observedAt: 1001,
    }, { now: 1000 }), undefined);

    const observation = normalizeFailureObservation({
      ...base,
      modelKey: "openai/org/model-family/model-v2",
    }, { now: 1000 });
    assert.equal(observation?.modelKey, "openai/org/model-family/model-v2");
    assert.deepEqual(observation?.scope, { kind: "model", modelKey: "openai/org/model-family/model-v2" });
    assert.equal(normalizeFailureObservation({ ...base, modelKey: "/model" }, { now: 1000 }), undefined);
    assert.equal(normalizeFailureObservation({ ...base, modelKey: "provider/" }, { now: 1000 }), undefined);
  });

  it("drops invalid optional retry times and rejects invalid observed clocks", () => {
    const withBadRetry = normalizeFailureObservation({
      ...base,
      structured: { category: "rate_limit", retryAt: Number.POSITIVE_INFINITY },
    }, { now: 1000 });
    assert.equal(withBadRetry?.category, "rate_limit");
    assert.equal("retryAt" in (withBadRetry ?? {}), false);

    assert.equal(normalizeFailureObservation({ ...base, observedAt: -1 }, { now: 1000 }), undefined);
    assert.equal(normalizeFailureObservation(base, { now: Number.NaN }), undefined);
    assert.equal(normalizeFailureObservation(base, { now: Number.MAX_VALUE }), undefined);
  });

  it("drops transient retry hints beyond the one-day bound", () => {
    const observation = normalizeFailureObservation({
      ...base,
      structured: { category: "transport", retryAt: 86_401_001 },
    }, { now: 1000 });
    assert.equal(observation?.category, "transport");
    assert.equal("retryAt" in (observation ?? {}), false);
  });

  it("rejects malformed identities, sources, arrays, and accessor-backed inputs", () => {
    assert.equal(normalizeFailureObservation({ ...base, outcomeId: "../../private" }, { now: 1000 }), undefined);
    assert.equal(normalizeFailureObservation({ ...base, modelKey: "openai/secret model" }, { now: 1000 }), undefined);
    assert.equal(normalizeFailureObservation({ ...base, source: "adapter named with secret data" }, { now: 1000 }), undefined);
    assert.equal(normalizeFailureObservation([base], { now: 1000 }), undefined);

    const accessorInput = Object.defineProperty({ ...base }, "errorText", {
      enumerable: true,
      get() { throw new Error("must not execute"); },
    });
    assert.equal(normalizeFailureObservation(accessorInput, { now: 1000 })?.category, "unknown");

    const accessorClock = Object.defineProperty({}, "now", {
      enumerable: true,
      get() { throw new Error("must not execute"); },
    });
    assert.equal(Number.isFinite(normalizeFailureObservation(base, accessorClock)?.observedAt), true);
  });

  it("bounds untrusted text before combining fields", () => {
    const observation = normalizeFailureObservation({
      ...base,
      errorText: "x".repeat(100_000),
      error: { message: "rate limit exceeded", code: "private-provider-code" },
    }, { now: 1000 });
    assert.equal(observation?.category, "unknown");
    assert.equal(JSON.stringify(observation).includes("private-provider-code"), false);
  });

  it("does not promote weak or unrecognized structured values into categories", () => {
    const observation = normalizeFailureObservation({
      ...base,
      structured: { category: "provider-outage", httpStatus: "503" },
      errorText: "ordinary provider response",
    }, { now: 1000 });
    assert.equal(observation?.category, "unknown");
    assert.equal(observation?.categoryEvidence, "unknown");
  });
});
