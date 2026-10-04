import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectDetectionFacts,
  createDetectionEngine,
  resolveDefaultClassifierBackend,
  selectEffectiveBackend,
  type DetectionDeps,
  type DetectionResult,
} from "../classifier-detection.ts";
import { classifierCacheKey } from "../classifier-semantics.ts";
import { CLASSIFIER_BACKEND_IDS, type ClassifierBackend } from "../classifier-backends.ts";
import type { BifrostConfig } from "../config.ts";

function deps(overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  return {
    readStoredCredential: () => undefined,
    getProviderAuthStatus: () => ({ configured: false }),
    env: {},
    ...overrides,
  };
}

describe("resolveDefaultClassifierBackend", () => {
  it("maps piManaged to pi-native", () => {
    assert.equal(resolveDefaultClassifierBackend({ piManaged: true, envPresent: true }).backend, CLASSIFIER_BACKEND_IDS.piNative);
    assert.equal(resolveDefaultClassifierBackend({ piManaged: true, envPresent: false }).backend, CLASSIFIER_BACKEND_IDS.piNative);
  });

  it("maps envPresent to typesafe and neither fact to prompt", () => {
    assert.equal(resolveDefaultClassifierBackend({ piManaged: false, envPresent: true }).backend, CLASSIFIER_BACKEND_IDS.typesafe);
    const quiet = resolveDefaultClassifierBackend({ piManaged: false, envPresent: false });
    assert.equal(quiet.backend, CLASSIFIER_BACKEND_IDS.prompt);
  });
});

describe("collectDetectionFacts", () => {
  it("treats a stored credential as managed even when the snapshot says unconfigured", () => {
    // Fix 6: the registry snapshot can be cold; the auth.json read cannot lie.
    const facts = collectDetectionFacts(deps({ readStoredCredential: () => ({ type: "api_key" }) }));
    assert.deepEqual(facts, { piManaged: true, envPresent: false });
  });

  it("treats runtime and models.json sources as managed", () => {
    for (const source of ["stored", "runtime", "models_json_key", "models_json_command", "fallback"]) {
      const facts = collectDetectionFacts(deps({ getProviderAuthStatus: () => ({ configured: true, source }) }));
      assert.deepEqual(facts, { piManaged: true, envPresent: false }, source);
    }
  });

  it("treats a models.json environment interpolation as managed, not envPresent", () => {
    // Fix 7: source "environment" without TYPESAFE_API_KEY is interpolation
    // that only Pi resolves. Bifrost cannot consume that key.
    const facts = collectDetectionFacts(deps({ getProviderAuthStatus: () => ({ configured: true, source: "environment" }) }));
    assert.deepEqual(facts, { piManaged: true, envPresent: false });
  });

  it("keys envPresent strictly on TYPESAFE_API_KEY", () => {
    const facts = collectDetectionFacts(deps({
      getProviderAuthStatus: () => ({ configured: true, source: "environment" }),
      env: { TYPESAFE_API_KEY: "key" },
    }));
    assert.deepEqual(facts, { piManaged: false, envPresent: true });
  });
});

describe("selectEffectiveBackend", () => {
  it("an explicit classifier.backend beats detection in every case", () => {
    const detected: DetectionResult[] = [
      { backend: CLASSIFIER_BACKEND_IDS.piNative, reason: "Pi-managed TypeSafe credential" },
      { backend: CLASSIFIER_BACKEND_IDS.typesafe, reason: "env key detected" },
      { backend: CLASSIFIER_BACKEND_IDS.prompt, reason: "no credential detected" },
    ];
    for (const configured of [CLASSIFIER_BACKEND_IDS.prompt, CLASSIFIER_BACKEND_IDS.typesafe, CLASSIFIER_BACKEND_IDS.piNative] as ClassifierBackend[]) {
      for (const result of detected) {
        const effective = selectEffectiveBackend(configured, result);
        assert.equal(effective.backend, configured);
        assert.equal(effective.reason, "explicit config");
        assert.equal(effective.auto, false);
      }
    }
  });

  it("takes detection when classifier.backend is absent", () => {
    const effective = selectEffectiveBackend(undefined, { backend: CLASSIFIER_BACKEND_IDS.piNative, reason: "Pi-managed TypeSafe credential" });
    assert.deepEqual(effective, { backend: CLASSIFIER_BACKEND_IDS.piNative, reason: "Pi-managed TypeSafe credential", auto: true });
  });
});

describe("createDetectionEngine", () => {
  it("locks the first result per extension load, so reload cannot flip it", () => {
    const engine = createDetectionEngine();
    assert.equal(engine.detect(() => ({ piManaged: true, envPresent: false })).backend, CLASSIFIER_BACKEND_IDS.piNative);
    assert.equal(engine.detect(() => ({ piManaged: false, envPresent: true })).backend, CLASSIFIER_BACKEND_IDS.piNative);
  });
});

describe("classifierCacheKey follows effectiveBackend", () => {
  const config: BifrostConfig = {
    models: { quick: ["provider/a"], general: ["provider/b"] },
    classifier: { backend: "pi-native", piNative: { model: "typesafe/jev-latest" } },
  };
  const tiers = ["quick", "general"];

  it("changes the key when the effective backend changes", () => {
    const asNative = classifierCacheKey(config, tiers, { effectiveBackend: CLASSIFIER_BACKEND_IDS.piNative });
    const asTypeSafe = classifierCacheKey(config, tiers, { effectiveBackend: CLASSIFIER_BACKEND_IDS.typesafe });
    assert.notEqual(asNative, asTypeSafe);
  });

  it("changes the key when piNative.model changes", () => {
    const other: BifrostConfig = {
      ...config,
      classifier: { backend: "pi-native", piNative: { model: "typesafe/jev-9" } },
    };
    assert.notEqual(
      classifierCacheKey(config, tiers, { effectiveBackend: CLASSIFIER_BACKEND_IDS.piNative }),
      classifierCacheKey(other, tiers, { effectiveBackend: CLASSIFIER_BACKEND_IDS.piNative }),
    );
  });
});
