import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const GUARD = fileURLToPath(new URL("../scripts/test-outbound-guard.cjs", import.meta.url));

const LOOPBACK_PROBE = `
import net from "node:net";
const server = net.createServer((connection) => {
  connection.on("data", (chunk) => connection.write(chunk));
  connection.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  let callbacks = 0;
  const socket = net.createConnection(port, "localhost", () => { callbacks += 1; });
  socket.on("connect", () => socket.write("PING"));
  socket.on("data", (chunk) => {
    console.log("DATA " + chunk.toString());
    console.log("CALLBACKS " + callbacks);
    socket.end();
    server.close();
  });
  socket.on("error", (error) => {
    console.log("SOCKET_ERROR " + error.code);
    server.close();
  });
});
`;

const FETCH_PROBE = `
const url = process.env.FETCH_URL;
try {
  const response = await fetch(url);
  console.log("FETCH_OK " + response.status);
} catch (error) {
  console.log("FETCH_ERROR " + (error.cause?.code ?? error.code ?? "unknown"));
}
`;

const LOOKUP_FAILURE_PROBE = `
import net from "node:net";
const server = net.createServer(() => console.log("SERVER_CONNECTION"));
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const socket = net.createConnection({
    host: "localhost",
    port,
    lookup(_host, _options, callback) { callback(new Error("lookup failed")); },
  });
  socket.on("connect", () => console.log("CONNECTED"));
  socket.on("error", (error) => {
    console.log("LOOKUP_ERROR " + (error.code ?? error.message));
    setTimeout(() => server.close(), 50);
  });
});
`;

const UDP_PROBE = `
import dgram from "node:dgram";
const socket = dgram.createSocket("udp4");
try {
  socket.send(Buffer.from("x"), 1234, "localhost");
  console.log("UDP_SENT");
} catch (error) {
  console.log("UDP_BLOCKED " + error.message);
}
socket.close();
`;

function runProbe({ script, mode = "loopback", env = {} }) {
  const directory = mkdtempSync(join(tmpdir(), "bifrost-guard-real-"));
  const violations = join(directory, "violations.log");
  try {
    const childEnv = {
      PATH: process.env.PATH ?? "",
      HOME: directory,
      BIFROST_TEST_NETWORK_VIOLATIONS: violations,
      ...env,
    };
    if (mode === "loopback") childEnv.BIFROST_TEST_ALLOW_LOOPBACK = "1";
    if (mode === "origin") childEnv.BIFROST_TEST_ALLOWED_ORIGIN = "http://127.0.0.1:1";
    if (mode === "deny") childEnv.BIFROST_TEST_DENY_ALL = "1";
    const result = spawnSync(process.execPath, ["--input-type=module", "--require", GUARD, "-e", script], {
      encoding: "utf8", timeout: 15_000, env: childEnv,
    });
    return {
      result,
      violations: existsSync(violations) ? readFileSync(violations, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("outbound guard real loopback connections", () => {
  it("preserves the Stryker-style connection callback and data flow", () => {
    const { result, violations } = runProbe({ script: LOOPBACK_PROBE });
    assert.match(result.stdout, /DATA PING/u, result.stderr);
    assert.match(result.stdout, /CALLBACKS 1/u, result.stderr);
    assert.equal(violations, "");
  });

  it("does not authorize a destination when lookup fails", () => {
    const { result, violations } = runProbe({ script: LOOKUP_FAILURE_PROBE });
    assert.doesNotMatch(result.stdout, /SERVER_CONNECTION|CONNECTED/u, result.stderr);
    assert.match(result.stdout, /LOOKUP_ERROR/u, result.stderr);
    assert.equal(violations, "");
  });

  it("still denies all UDP sends", () => {
    const { result, violations } = runProbe({ script: UDP_PROBE });
    assert.match(result.stdout, /UDP_BLOCKED blocked UDP datagram/u, result.stderr);
    assert.doesNotMatch(result.stdout, /UDP_SENT/u);
    assert.match(violations, /blocked UDP datagram to localhost/u);
  });

  it("keeps localhost fetch unauthorized in loopback mode", () => {
    const { result, violations } = runProbe({
      script: FETCH_PROBE,
      env: { FETCH_URL: "http://localhost:1/" },
    });
    assert.doesNotMatch(result.stdout, /FETCH_OK/u);
    assert.match(violations, /blocked fetch to http:\/\/localhost:1/u);
  });
});
