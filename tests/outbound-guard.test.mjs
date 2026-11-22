import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const GUARD = fileURLToPath(new URL("../scripts/test-outbound-guard.cjs", import.meta.url));
const CONNECT_STUB = fileURLToPath(new URL("./fixtures/outbound-guard-connect-stub.cjs", import.meta.url));

const PROBE = `
import net from "node:net";
const socket = new net.Socket();
socket.on("error", () => {});
const options = { host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT ?? 1), family: 4 };
if (process.env.PROBE_LOOKUP) {
  const address = process.env.PROBE_LOOKUP;
  options.lookup = (_host, _opts, callback) => callback(null, address, address === "::1" ? 6 : 4);
}
try {
  if (process.env.PROBE_POSITIONAL === "1") {
    socket.connect(options.port, options.host);
  } else {
    socket.connect(options);
  }
  console.log("CONNECT_ATTEMPTED");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`;

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function runProbe({ host, mode, lookup, stub = false, positional = false }) {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-outbound-guard-"));
  const violations = join(directory, "violations.log");
  const stubLog = join(directory, "stub.log");
  try {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      PROBE_HOST: host,
      PROBE_PORT: "1",
    };
    if (mode === "loopback") env.BIFROST_TEST_ALLOW_LOOPBACK = "1";
    if (mode === "origin") env.BIFROST_TEST_ALLOWED_ORIGIN = "http://127.0.0.1:1";
    if (mode === "deny") env.BIFROST_TEST_DENY_ALL = "1";
    if (lookup) env.PROBE_LOOKUP = lookup;
    if (positional) env.PROBE_POSITIONAL = "1";
    if (stub) env.GUARD_STUB_LOG = stubLog;
    const preloads = stub ? [CONNECT_STUB, GUARD] : [GUARD];
    const result = spawnSync(process.execPath, ["--input-type=module", ...preloads.flatMap((path) => ["--require", path]), "-e", PROBE], {
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    return { result, violations: readIfExists(violations), stubLog: readIfExists(stubLog) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("test outbound guard", () => {
  it("allows the localhost loopback alias when loopback is enabled", () => {
    const { result, violations } = runProbe({ host: "localhost", mode: "loopback" });
    assert.equal(result.stdout.trim(), "CONNECT_ATTEMPTED", result.stderr);
    assert.equal(violations, "");
  });

  it("guards Stryker-style positional localhost connections", () => {
    const { violations, stubLog } = runProbe({
      host: "localhost", mode: "loopback", stub: true, positional: true,
    });
    assert.match(stubLog, /LOOKUP_ADDRESS (127\.|::1)/u);
    assert.equal(violations, "");
  });

  it("blocks a non-loopback hostname in loopback mode", () => {
    const { result, violations } = runProbe({ host: "example.com", mode: "loopback" });
    assert.equal(result.stdout.includes("CONNECT_ATTEMPTED"), false);
    assert.match(violations, /blocked socket connection to example\.com:1/);
  });

  it("blocks a custom localhost lookup that resolves outside loopback", () => {
    const { result, violations, stubLog } = runProbe({
      host: "localhost", mode: "loopback", lookup: "203.0.113.7", stub: true,
    });
    assert.equal(result.stdout.trim(), "CONNECT_ATTEMPTED", result.stderr);
    assert.match(stubLog, /LOOKUP_ERROR/u);
    assert.doesNotMatch(stubLog, /LOOKUP_ADDRESS 203\.0\.113\.7/u);
    assert.match(violations, /blocked non-loopback resolution for localhost: 203\.0\.113\.7/u);
  });

  it("allows an IPv6 loopback resolution", () => {
    const { violations, stubLog } = runProbe({
      host: "localhost", mode: "loopback", lookup: "::1", stub: true,
    });
    assert.match(stubLog, /LOOKUP_ADDRESS ::1/u);
    assert.equal(violations, "");
  });

  it("preserves exact-origin mode", () => {
    const allowed = runProbe({ host: "127.0.0.1", mode: "origin" });
    assert.equal(allowed.result.stdout.trim(), "CONNECT_ATTEMPTED", allowed.result.stderr);
    assert.equal(allowed.violations, "");

    const blocked = runProbe({ host: "example.com", mode: "origin" });
    assert.equal(blocked.result.stdout.includes("CONNECT_ATTEMPTED"), false);
    assert.match(blocked.violations, /blocked socket connection to example\.com:1/);
  });

  it("keeps deny-all authoritative", () => {
    const { result, violations } = runProbe({ host: "localhost", mode: "deny" });
    assert.equal(result.stdout.includes("CONNECT_ATTEMPTED"), false);
    assert.match(violations, /blocked socket connection to localhost:1/);
  });
});
