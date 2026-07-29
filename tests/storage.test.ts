import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJsonFile, resolveStoragePath, writeJsonFile } from "../storage.ts";

describe("storage", () => {
  it("resolves absolute, tilde, relative, and default paths", () => {
    const cwd = "/project";
    const home = process.env.HOME;
    process.env.HOME = "/home/user";
    try {
      assert.equal(resolveStoragePath(cwd, undefined, ".pi/state.json"), "/project/.pi/state.json");
      assert.equal(resolveStoragePath(cwd, "/var/lib/state.json", ".pi/state.json"), "/var/lib/state.json");
      assert.equal(resolveStoragePath(cwd, "~/state.json", ".pi/state.json"), "/home/user/state.json");
      assert.equal(resolveStoragePath(cwd, "state.json", ".pi/state.json"), "/project/state.json");
    } finally {
      process.env.HOME = home;
    }
  });

  it("writes and reads json files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bifrost-storage-"));
    try {
      const path = join(cwd, "nested", "state.json");
      writeJsonFile(path, { ok: true, count: 2 });
      assert.deepEqual(readJsonFile<{ ok: boolean; count: number }>(path), { ok: true, count: 2 });
      assert.equal(readJsonFile(join(cwd, "missing.json")), undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
