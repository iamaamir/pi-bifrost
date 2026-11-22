// Replaces net.Socket.connect so guard tests never open a real socket.
// The guard must still authorize before this stub is reached.
const fs = require("node:fs");
const net = require("node:net");

net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof target === "object" && target !== null ? target : { port: target, host: args[1] };
  const log = process.env.GUARD_STUB_LOG;
  if (typeof options.lookup === "function") {
    options.lookup(options.host, {}, (error, address) => {
      fs.appendFileSync(log, error ? "LOOKUP_ERROR\n" : `LOOKUP_ADDRESS ${address}\n`);
    });
  } else {
    fs.appendFileSync(log, `LOOKUP_NONE ${options.host}\n`);
  }
  return this;
};
