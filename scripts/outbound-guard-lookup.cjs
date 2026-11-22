// Resolution checks for the test-only outbound guard. Kept separate so the
// guard's own complexity stays within its committed budget.
const { isIP } = require("node:net");
const { lookup: dnsLookup } = require("node:dns");

function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const literal = address.split("%", 1)[0].toLowerCase();
  const version = isIP(literal);
  if (version === 4) return literal.startsWith("127.");
  if (version !== 6) return false;
  let canonical;
  try {
    canonical = new URL(`http://[${literal}]/`).hostname.slice(1, -1);
  } catch {
    return false;
  }
  if (canonical === "::1") return true;
  if (!canonical.startsWith("::ffff:")) return false;
  const groups = canonical.slice(7).split(":");
  if (groups.length !== 2) return false;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return false;
  const mapped = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  return isIP(mapped) === 4 && mapped.startsWith("127.");
}

function makeGuardedLookup({ host, lookup, recordViolation }) {
  const resolve = typeof lookup === "function" ? lookup : dnsLookup;
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
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const target = normalized[0];
  const options = typeof target === "object" && target !== null ? target : { port: target, host: normalized[1] };
  return { options, host: options.host ?? options.hostname ?? "localhost", rest: normalized.slice(1) };
}

function withGuardedLookup(args, options, host, rest, recordViolation) {
  const guardedOptions = { ...options, lookup: makeGuardedLookup({ host, lookup: options.lookup, recordViolation }) };
  return [guardedOptions, ...rest];
}

module.exports = { isLoopbackAddress, parseConnectArgs, withGuardedLookup };
