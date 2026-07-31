import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeState, runtimeStatePath, saveRuntimeState, type RuntimeModeState } from "../runtime-state.ts";

describe("runtime state", () => {
  it("saves and loads persisted mode", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      const state: RuntimeModeState = { enabled: false, pinned: true, classifierEnabled: false };
      saveRuntimeState(path, state);
      // pinned is ephemeral — always false on load regardless of file
      const loaded = loadRuntimeState(path);
      assert.deepEqual(loaded, { ...state, pinned: false });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses fallback when file missing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      const fallback: RuntimeModeState = { enabled: false, pinned: true, classifierEnabled: false };
      assert.deepEqual(loadRuntimeState(path, fallback), fallback);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back on corrupt file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-runtime-state-"));
    try {
      const path = runtimeStatePath(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(path, "{not json", "utf8");
      const fallback: RuntimeModeState = { enabled: true, pinned: true, classifierEnabled: false };
      assert.deepEqual(loadRuntimeState(path, fallback), fallback);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
