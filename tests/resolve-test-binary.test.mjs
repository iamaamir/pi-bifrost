import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestBinary } from "../scripts/resolve-test-binary.mjs";

function makeExecutableScript(filePath, body = "#!/usr/bin/env bash\necho ok\n") {
  writeFileSync(filePath, body);
  chmodSync(filePath, 0o755);
}

describe("resolveTestBinary", () => {
  it("prefers explicit env value", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "resolve-bin-"));
    const bin = join(tempDir, "custom-agent-tui");
    makeExecutableScript(bin);

    try {
      const resolved = resolveTestBinary({
        envVar: "AGENT_TUI_BIN",
        name: "agent-tui",
        root: tempDir,
        env: { AGENT_TUI_BIN: ` ${bin} `, PATH: "" },
      });

      assert.equal(resolved.path, bin);
      assert.equal(resolved.source, "env:AGENT_TUI_BIN");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves repo-local bin before PATH", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "resolve-bin-"));
    const repoBinDir = join(tempDir, "node_modules", ".bin");
    const pathBinDir = join(tempDir, "path-bin");
    mkdirSync(repoBinDir, { recursive: true });
    mkdirSync(pathBinDir, { recursive: true });

    const repoBin = join(repoBinDir, "pi");
    const pathBin = join(pathBinDir, "pi");
    makeExecutableScript(repoBin, "#!/usr/bin/env bash\necho repo\n");
    makeExecutableScript(pathBin, "#!/usr/bin/env bash\necho path\n");

    try {
      const resolved = resolveTestBinary({
        envVar: "PI_BIN",
        name: "pi",
        root: tempDir,
        env: { PATH: pathBinDir },
      });

      assert.equal(resolved.path, repoBin);
      assert.equal(resolved.source, "repo:pi");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back to PATH when repo bin missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "resolve-bin-"));
    const pathBinDir = join(tempDir, "path-bin");
    mkdirSync(pathBinDir, { recursive: true });

    const pathBin = join(pathBinDir, "agent-tui");
    makeExecutableScript(pathBin, "#!/usr/bin/env bash\necho path\n");

    try {
      const resolved = resolveTestBinary({
        envVar: "AGENT_TUI_BIN",
        name: "agent-tui",
        root: tempDir,
        env: { PATH: pathBinDir },
      });

      assert.equal(resolved.path, pathBin);
      assert.equal(resolved.source, "PATH:agent-tui");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws actionable error when binary missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "resolve-bin-"));

    try {
      assert.throws(
        () =>
          resolveTestBinary({
            envVar: "AGENT_TUI_BIN",
            name: "agent-tui",
            root: tempDir,
            env: { PATH: "" },
          }),
        /Could not resolve agent-tui\./,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("throws when explicit env is not executable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "resolve-bin-"));
    const bin = join(tempDir, "not-executable");
    writeFileSync(bin, "#!/usr/bin/env bash\necho nope\n");

    try {
      assert.throws(
        () =>
          resolveTestBinary({
            envVar: "PI_BIN",
            name: "pi",
            root: tempDir,
            env: { PI_BIN: bin, PATH: "" },
          }),
        new RegExp(`PI_BIN="${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" is set but is not an executable file\.`),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
