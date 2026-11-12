// Whole-run worker for the unverified-cleanup regression. It calls the same
// runPi the suite calls — imported, never copied — against a fixture whose
// descendant keeps an inherited pipe open, with the owned-group signal step
// denied. The report it prints is what the outer test asserts; whether this
// process can then actually exit is the property under test, so it must not
// delete its scratch or kill anything on the way out.
import { existsSync } from "node:fs";
import { runPi, setFakePort, setOwnedGroupSignalDenial, DESCENDANT_CLI } from "./child-auto-inline-harness.mjs";

setFakePort(64321);
const home = process.argv[2];
const start = Date.now();

// A signal this process is not permitted to send: deterministic stand-in for a
// denied owned-group kill. The group survives, so cleanup cannot be verified.
setOwnedGroupSignalDenial(() => { throw new Error("controlled owned-group signal denial"); });

await runPi({
  home,
  work: home,
  model: "bifrost/auto",
  prompt: "native faux dispatch marker",
  child: "1",
  command: process.execPath,
  args: [DESCENDANT_CLI],
  windowMs: 1_000,
  terminationGraceMs: 200,
  extraEnv: { BIFROST_DESCENDANT_PID_FILE: `${home}/descendant.pid` },
}).then(
  () => {
    process.exitCode = 1;
    console.log(JSON.stringify({ event: "unexpected-resolution", elapsedMs: Date.now() - start, scratchRetained: existsSync(home) }));
  },
  (error) => {
    process.exitCode = 1;
    console.log(JSON.stringify({
      event: "bounded-rejection",
      elapsedMs: Date.now() - start,
      message: error.message,
      scratchRetained: existsSync(home),
    }));
  },
);
