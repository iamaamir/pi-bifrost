import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadRuntimeState,
  resolveClassifierEnablement,
  runtimeStatePath,
  saveRuntimeState,
  isPassiveModelSelection,
  type RuntimeModeState,
} from "../runtime-state.ts";

describe("isPassiveModelSelection", () => {
  it("treats session restore as passive and user-driven selection as active", () => {
    assert.equal(isPassiveModelSelection("restore"), true);
    assert.equal(isPassiveModelSelection("set"), false);
    assert.equal(isPassiveModelSelection("cycle"), false);
  });
});

describe("classifier enablement", () => {
  it("uses configured state unless conflicting legacy state requires an explicit choice", () => {
    assert.deepEqual(resolveClassifierEnablement(true), { enabled: true, source: "configuration" });
    assert.deepEqual(resolveClassifierEnablement(false, true), {
      enabled: false, source: "legacy-conflict", legacyConflict: { saved: true, configured: false },
    });
    assert.deepEqual(resolveClassifierEnablement(true, false), {
      enabled: false, source: "legacy-conflict", legacyConflict: { saved: false, configured: true },
    });
  });

  it("lets explicit session choice resolve conflict without changing durable state", () => {
    assert.deepEqual(resolveClassifierEnablement(false, true, true), {
      enabled: true, source: "session", legacyConflict: { saved: true, configured: false },
    });
    assert.deepEqual(resolveClassifierEnablement(true, false, false), {
      enabled: false, source: "session", legacyConflict: { saved: false, configured: true },
    });
    assert.deepEqual(resolveClassifierEnablement(true, undefined, true, "invalid-json"), {
      enabled: false, source: "runtime-state-invalid", runtimeStateIssue: "invalid-json",
    });
  });
});

describe("runtime state", () => {
  it("loads global mode and treats saved classifierEnabled as legacy conflict data", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(path, JSON.stringify({ enabled: false, classifierEnabled: true, unknown: "preserved" }));
      const loaded = loadRuntimeState(path, {
        enabled: true, pinned: false, classifierEnabled: false, classifierSource: "configuration",
      });
      assert.deepEqual(loaded, {
        enabled: false, pinned: false, classifierEnabled: false, classifierSource: "legacy-conflict",
        legacyClassifierEnabled: true, classifierConflict: { saved: true, configured: false },
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses fallback when file missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      const fallback: RuntimeModeState = {
        enabled: false, pinned: true, classifierEnabled: false, classifierSource: "configuration",
      };
      assert.deepEqual(loadRuntimeState(path, fallback), fallback);
      assert.equal(saveRuntimeState(path, {}), true);
      assert.equal(existsSync(path), false, "no override must not create a state file");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed on corrupt state and preserves bytes until repair", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      const corrupt = "{not json";
      writeFileSync(path, corrupt, "utf8");
      const fallback: RuntimeModeState = {
        enabled: true, pinned: true, classifierEnabled: true, classifierSource: "configuration",
      };
      assert.deepEqual(loadRuntimeState(path, fallback), {
        enabled: true, pinned: false, classifierEnabled: false,
        classifierSource: "runtime-state-invalid", runtimeStateIssue: "invalid-json",
      });
      assert.equal(saveRuntimeState(path, { enabled: false }), false);
      assert.equal(readFileSync(path, "utf8"), corrupt);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed on non-object state and unreadable paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      for (const text of ["[]", "null", "false", "{\"classifierEnabled\":\"false\"}", "{\"enabled\":\"bad\",\"unknown\":7}"]) {
        writeFileSync(path, text, "utf8");
        assert.equal(loadRuntimeState(path).classifierSource, "runtime-state-invalid", text);
        assert.equal(loadRuntimeState(path).classifierEnabled, false, text);
        for (const next of [{}, { enabled: true }, { enabled: false }]) {
          assert.equal(saveRuntimeState(path, next), false, text);
          assert.equal(readFileSync(path, "utf8"), text, "invalid bytes must remain unchanged");
        }
      }
      rmSync(path);
      rmSync(join(cwd, ".pi"), { recursive: true, force: true });
      writeFileSync(join(cwd, ".pi"), "not a directory", "utf8");
      assert.equal(loadRuntimeState(path).classifierSource, "runtime-state-invalid");
      assert.equal(loadRuntimeState(path).classifierEnabled, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("updates only durable Bifrost mode and preserves legacy plus unknown fields", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(path, JSON.stringify({ enabled: true, classifierEnabled: false, unknown: "keep" }));
      assert.equal(saveRuntimeState(path, {}), true);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { classifierEnabled: false, unknown: "keep" });
      assert.equal(saveRuntimeState(path, { enabled: false }), true);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { classifierEnabled: false, unknown: "keep", enabled: false });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
