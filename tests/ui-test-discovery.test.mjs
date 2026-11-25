import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const runner = join(process.cwd(), "scripts/run-ui-tests.py");

test("UI discovery sorts test files, ignores helpers, and propagates failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "bifrost-ui-discovery-"));
  try {
    const run = () => spawnSync("python3", [runner, dir], { encoding: "utf8" });
    assert.notEqual(run().status, 0);
    writeFileSync(join(dir, "helper.py"), "raise Exception('helper executed')\n");
    writeFileSync(join(dir, "b.test.py"), "raise SystemExit(7)\n");
    writeFileSync(join(dir, "a.test.py"), "print('first')\n");
    writeFileSync(join(dir, "c.test.py"), "print('unexpected')\n");
    const result = run();
    assert.equal(result.status, 7);
    assert.match(result.stdout, /Running a\.test\.py\s+first\s+Running b\.test\.py/);
    assert.doesNotMatch(result.stdout, /unexpected|helper/);

    writeFileSync(join(dir, "b.test.py"), "print('second')\n");
    const success = run();
    assert.equal(success.status, 0);
    assert.match(success.stdout, /Running a\.test\.py\s+first\s+Running b\.test\.py\s+second\s+Running c\.test\.py\s+unexpected/);
    assert.doesNotMatch(success.stdout, /helper/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UI discovery wrappers include the four existing checks", () => {
  const dir = join(process.cwd(), "scripts/ui-tests");
  const wrappers = {
    "01-smoke.test.py": "ui-smoke.py",
    "02-probe-cancel.test.py": "test-probe-cancel-tui.py",
    "03-init-cancel.test.py": "test-init-cancel-tui.py",
    "04-server-process.test.py": "test-tui-server-process.py",
  };
  const discovered = readdirSync(dir).filter((name) => name.endsWith(".test.py"));
  for (const [wrapper, target] of Object.entries(wrappers)) {
    assert.ok(discovered.includes(wrapper), `${wrapper} is discoverable`);
    assert.ok(readFileSync(join(dir, wrapper), "utf8").includes(`runpy.run_path(str(scripts / "${target}"), run_name="__main__")`), `${wrapper} runs ${target}`);
  }
});
