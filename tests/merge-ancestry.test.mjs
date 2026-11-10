import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("preserves resolved main ancestry when a squash merge lost it", () => {
  const root = mkdtempSync(join(tmpdir(), "bifrost-merge-ancestry-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (value) => writeFileSync(join(root, "shared.txt"), `${value}\n`);
  try {
    git("init", "-q", "-b", "v2");
    git("config", "user.name", "Merge fixture");
    git("config", "user.email", "merge-fixture@example.invalid");
    write("base"); git("add", "shared.txt"); git("commit", "-qm", "base");
    git("switch", "-qc", "main");
    write("main"); git("commit", "-qam", "main change");
    git("switch", "-q", "v2");
    write("v2"); git("commit", "-qam", "v2 change");
    git("switch", "-qc", "resolution");
    assert.equal(spawnSync("git", ["merge", "--no-commit", "main"], { cwd: root, stdio: "ignore" }).status, 1);
    write("resolved"); git("add", "shared.txt"); git("commit", "-qm", "resolve merge");
    const resolvedMerge = git("rev-parse", "HEAD");
    git("switch", "-q", "v2");
    git("merge", "-q", "--squash", "resolution"); git("commit", "-qm", "squash resolution");
    const beforeTree = git("rev-parse", "HEAD^{tree}");
    assert.equal(spawnSync("git", ["merge-base", "--is-ancestor", "main", "HEAD"], { cwd: root }).status, 1);
    assert.notEqual(spawnSync("git", ["merge-tree", "--write-tree", "HEAD", "main"], { cwd: root, stdio: "ignore" }).status, 0);
    git("merge", "-q", "--no-ff", "-m", "restore ancestry", resolvedMerge);
    assert.equal(git("rev-parse", "HEAD^{tree}"), beforeTree);
    git("merge-base", "--is-ancestor", "main", "HEAD");
    git("merge-tree", "--write-tree", "HEAD", "main");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
