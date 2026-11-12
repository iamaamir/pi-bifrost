// Test-only network fence for Pi child processes using fake providers.
const net = require("node:net");
const dgram = require("node:dgram");
const fs = require("node:fs");

const rawOrigin = process.env.BIFROST_TEST_ALLOWED_ORIGIN;
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
if (!violationPath) throw new Error("BIFROST_TEST_NETWORK_VIOLATIONS is required by the test network guard");

const nativeChild = process.env.BIFROST_NATIVE_TOOL_CONTINUATION_CHILD === "1";
const denyAll = process.env.BIFROST_TEST_DENY_ALL === "1" || nativeChild;
const allowLoopback = process.env.BIFROST_TEST_ALLOW_LOOPBACK === "1";
if (process.env.BIFROST_TEST_ALLOW_LOOPBACK && !allowLoopback) {
  throw new Error("BIFROST_TEST_ALLOW_LOOPBACK must be exactly 1 when set");
}
if (process.env.BIFROST_TEST_DENY_ALL && process.env.BIFROST_TEST_DENY_ALL !== "1") {
  throw new Error("BIFROST_TEST_DENY_ALL must be exactly 1 when set");
}
if (denyAll && (rawOrigin || allowLoopback)) {
  throw new Error("deny-all guard cannot be combined with allowed origins");
}
if (!denyAll && !rawOrigin && !allowLoopback) throw new Error("BIFROST_TEST_ALLOWED_ORIGIN is required by the test network guard");

const allowed = denyAll ? null : (rawOrigin ? new URL(rawOrigin) : null);
if (allowed && (allowed.protocol !== "http:" || allowed.hostname !== "127.0.0.1" || !allowed.port)) {
  throw new Error("test network guard requires an exact 127.0.0.1 HTTP origin");
}
const allowedPort = allowed ? Number(allowed.port) : null;

function isAllowed(host, port) {
  if (denyAll) return false;
  if (allowLoopback) return host === "127.0.0.1" && Number(port) > 0;
  return allowed && host === allowed.hostname && Number(port) === allowedPort;
}
function deny(message) {
  try {
    fs.appendFileSync(violationPath, message + "\n", { encoding: "utf8", mode: 0o600 });
  } catch {
    process.stderr.write("[test network guard] blocked network request; violation log could not be written\n");
  }
  throw new Error(message);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof target === "object" && target !== null
    ? target
    : { port: target, host: args[1] };
  const host = options.host ?? options.hostname ?? "localhost";
  if (!isAllowed(host, options.port)) {
    deny("blocked socket connection to " + host + ":" + options.port);
  }
  return connect.apply(this, args);
};

dgram.Socket.prototype.send = function (...args) {
  const address = typeof args[2] === "string" ? args[2] : "unknown";
  deny("blocked UDP datagram to " + address);
};

const fetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  const localAllowed = url.protocol === "http:" && isAllowed(url.hostname, url.port);
  if (!localAllowed) deny("blocked fetch to " + url.origin);
  return fetch(input, ...args);
};
