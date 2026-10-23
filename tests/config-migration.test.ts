import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  applyConfigMigration,
  ConfigMigrationError,
  parseConfigMigrationArgs,
  planConfigMigration,
} from "../config-migration.ts";

const directories: string[] = [];
after(() => { for (const path of directories) rmSync(path, { recursive: true, force: true }); });

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "bifrost-config-migration-"));
  directories.push(path);
  return path;
}

describe("config migration proposal", () => {
  it("parses preview and requires a reviewed digest for apply", () => {
    assert.deepEqual(parseConfigMigrationArgs("--source workspace --json"), {
      ok: true, request: { source: "workspace", apply: false, json: true },
    });
    assert.deepEqual(parseConfigMigrationArgs(`--apply --proposal ${"a".repeat(64)}`), {
      ok: true, request: { source: "project", apply: true, proposalDigest: "a".repeat(64), json: false },
    });
    assert.equal(parseConfigMigrationArgs("--apply").ok, false);
    assert.equal(parseConfigMigrationArgs("--proposal abc").ok, false);
    assert.equal(parseConfigMigrationArgs("--source extension").ok, false);
  });

  it("changes only schemaVersion, preserving unrelated field order and values", () => {
    const source = Buffer.from('{\n  "enabled": true,\n  "models": {"custom-tier": ["provider/model"]},\n  "retained": {"private": "fixture"}\n}\n');
    const plan = planConfigMigration("project", source);
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") return;
    const migrated = JSON.parse(plan.replacementBytes.toString("utf8"));
    assert.deepEqual(Object.keys(migrated), ["enabled", "models", "retained", "schemaVersion"]);
    assert.deepEqual(migrated, {
      enabled: true,
      models: { "custom-tier": ["provider/model"] },
      retained: { private: "fixture" },
      schemaVersion: 2,
    });
    assert.equal(plan.proposalDigest.length, 64);
    const userPlan = planConfigMigration("user", source);
    assert.equal(userPlan.status, "ready");
    if (userPlan.status !== "ready") return;
    assert.notEqual(plan.proposalDigest, userPlan.proposalDigest, "proposal is bound to its source layer");
  });

  it("leaves current and unsupported versions unchanged", () => {
    assert.equal(planConfigMigration("project", Buffer.from('{"schemaVersion":2}')).status, "current");
    assert.deepEqual(planConfigMigration("project", Buffer.from('{"schemaVersion":3}')), {
      status: "blocked", reason: "unsupported_version",
    });
    assert.deepEqual(planConfigMigration("project", Buffer.from("[]")), {
      status: "blocked", reason: "invalid_config",
    });
  });
});

describe("config migration apply", () => {
  it("backs up exact source bytes before atomic replacement and preserves target mode", () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "bifrost.json");
    const original = Buffer.from('{\n  "models": {"quick": []},\n  "retained": "exact bytes"\n}\n');
    writeFileSync(sourcePath, original, { mode: 0o640 });
    const plan = planConfigMigration("project", original);
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") return;

    const backupPath = applyConfigMigration({ sourcePath, expectedSourceBytes: original, replacementBytes: plan.replacementBytes });
    assert.deepEqual(readFileSync(backupPath), original);
    assert.equal(statSync(backupPath).mode & 0o777, 0o600);
    assert.equal(statSync(sourcePath).mode & 0o777, 0o640);
    assert.deepEqual(JSON.parse(readFileSync(sourcePath, "utf8")), {
      models: { quick: [] }, retained: "exact bytes", schemaVersion: 2,
    });
    assert.equal(readdirSync(directory).length, 2);
  });

  it("refuses a source changed after preview without creating a backup", () => {
    const directory = temporaryDirectory();
    const sourcePath = join(directory, "bifrost.json");
    const original = Buffer.from('{"models":{"quick":[]}}\n');
    writeFileSync(sourcePath, original);
    const plan = planConfigMigration("project", original);
    assert.equal(plan.status, "ready");
    if (plan.status !== "ready") return;
    writeFileSync(sourcePath, '{"models":{"quick":["new/model"]}}\n');
    assert.throws(() => applyConfigMigration({ sourcePath, expectedSourceBytes: original, replacementBytes: plan.replacementBytes }),
      (error) => error instanceof ConfigMigrationError && error.code === "source_changed");
    assert.deepEqual(readdirSync(directory), ["bifrost.json"]);
  });
});
