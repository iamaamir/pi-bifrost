import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifierMetricsEnabled, ClassifierMetricsStore } from "../classifier-metrics.ts";
import type { BifrostConfig } from "../config.ts";

describe("classifierMetricsEnabled", () => {
  const config: BifrostConfig = { models: {}, classifier: { typesafe: {}, piNative: {} } };

  it("enables each direct backend by default, not prompt", () => {
    assert.equal(classifierMetricsEnabled(config, "typesafe"), true);
    assert.equal(classifierMetricsEnabled(config, "pi-native"), true);
    assert.equal(classifierMetricsEnabled(config, "prompt"), false);
  });

  it("respects backend-specific disablement", () => {
    const disabled: BifrostConfig = {
      models: {}, classifier: { typesafe: { metrics: { enabled: false } }, piNative: { metrics: { enabled: false } } },
    };
    assert.equal(classifierMetricsEnabled(disabled, "typesafe"), false);
    assert.equal(classifierMetricsEnabled(disabled, "pi-native"), false);
  });

  it("loads persisted data on first enable, instead of erasing history", () => {
    const prior = new ClassifierMetricsStore({ cwd: "/tmp", enabled: true, io: {
      load: () => undefined, save: () => {},
    } }).snapshot();
    const store = new ClassifierMetricsStore({ cwd: "/tmp", enabled: false, io: {
      load: () => ({ ...prior, total: 7 }), save: () => {},
    } });
    store.setEnabled(true);
    assert.equal(store.snapshot().total, 7);
    store.setEnabled(false);
    assert.equal(store.snapshot().total, 0);
  });
});
