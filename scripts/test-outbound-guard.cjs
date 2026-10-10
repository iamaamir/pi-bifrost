// Test-only network fence for Pi child processes using fake providers.
const net = require("node:net");
const fs = require("node:fs");

const rawOrigin = process.env.BIFROST_TEST_ALLOWED_ORIGIN;
const violationPath = process.env.BIFROST_TEST_NETWORK_VIOLATIONS;
if (!rawOrigin) throw new Error("BIFROST_TEST_ALLOWED_ORIGIN is required by the test network guard");
if (!violationPath) throw new Error("BIFROST_TEST_NETWORK_VIOLATIONS is required by the test network guard");

const allowed = new URL(rawOrigin);
if (allowed.protocol !== "http:" || allowed.hostname !== "127.0.0.1" || !allowed.port) {
  throw new Error("test network guard requires an exact 127.0.0.1 HTTP origin");
}

const allowedPort = Number(allowed.port);
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
  if (host !== allowed.hostname || Number(options.port) !== allowedPort) {
    deny("blocked socket connection to " + host + ":" + options.port);
  }
  return connect.apply(this, args);
};

const fetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== allowed.origin) deny("blocked fetch to " + url.origin);
  return fetch(input, ...args);
};
