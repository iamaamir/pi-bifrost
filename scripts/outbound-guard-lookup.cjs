// Resolution checks for the test-only outbound guard. Kept separate so the
// guard's own complexity stays within its committed budget.
const dns = require("node:dns");

const OCTET = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const LOOPBACK = new RegExp(`^(?:::1|(?:::ffff:)?127\\.${OCTET}\\.${OCTET}\\.${OCTET})$`);

function isLoopbackAddress(address) {
  return typeof address === "string" && LOOPBACK.test(address.split("%", 1)[0]);
}

function makeGuardedLookup({ host, lookup, recordViolation }) {
  const resolve = typeof lookup === "function" ? lookup : dns.lookup;
  return function guardedLookup(hostname, options, callback) {
    resolve(hostname, options, (error, address, family) => {
      if (error) return callback(error);
      const entries = Array.isArray(address) ? address : [{ address, family }];
      const rejected = entries.find((entry) => !entry || !isLoopbackAddress(entry.address));
      if (rejected) {
        const message = "blocked non-loopback resolution for " + host + ": " + (rejected.address ?? "unknown");
        recordViolation(message);
        return callback(new Error(message));
      }
      callback(undefined, address, family);
    });
  };
}

function parseConnectArgs(args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof target === "object" && target !== null ? target : { port: target, host: args[1] };
  return { options, host: options.host ?? options.hostname ?? "localhost" };
}

function withGuardedLookup(args, options, host, recordViolation) {
  const guardedOptions = { ...options, lookup: makeGuardedLookup({ host, lookup: options.lookup, recordViolation }) };
  const objectForm = typeof args[0] === "object" && args[0] !== null && !Array.isArray(args[0]);
  return objectForm ? [guardedOptions, ...args.slice(1)] : [guardedOptions, ...args.slice(2)];
}

module.exports = { parseConnectArgs, withGuardedLookup };
