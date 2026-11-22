import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const GUARD = fileURLToPath(new URL("../scripts/test-outbound-guard.cjs", import.meta.url));

const PROBE = `
import net from "node:net";
const socket = new net.Socket();
socket.on("error", () => { /* a refused loopback port still proves the guard allowed it */ });
try {
  socket.connect({ host: process.env.PROBE_HOST, port: 1, family: 4 });
  console.log("CONNECT_ATTEMPTED");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`;

function runProbe({ host, allowLoopback, allowedOrigin }) {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-outbound-guard-"));
  const violations = join(directory, "violations.log");
  try {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      PROBE_HOST: host,
    };
    if (allowLoopback) env.BIFROST_TEST_ALLOW_LOOPBACK = "1";
    if (allowedOrigin) env.BIFROST_TEST_ALLOWED_ORIGIN = allowedOrigin;
    const result = spawnSync(process.execPath, ["--input-type=module", "--require", GUARD, "-e", PROBE], {
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    return { result, violations: existsSync(violations) ? readFileSync(violations, "utf8") : "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("test outbound guard", () => {
  it("allows the localhost loopback alias when loopback is enabled", () => {
    const { result, violations } = runProbe({ host: "localhost", allowLoopback: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "CONNECT_ATTEMPTED");
    assert.equal(violations, "");
  });

  it("still blocks a non-loopback host under the exact-origin mode", () => {
    const { result, violations } = runProbe({ host: "example.com", allowedOrigin: "http://127.0.0.1:1" });
    assert.notEqual(result.status, 0);
    assert.match(violations, /blocked socket connection to example\.com:\d+/);
  });
});
