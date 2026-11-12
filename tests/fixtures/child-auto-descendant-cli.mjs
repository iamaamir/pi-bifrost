// Stand-in for the Pi CLI in the owned-descendant regression. It reproduces the
// shape that leaves an outer runner waiting for close forever: the child exits
// while a descendant it spawned keeps the inherited stdout pipe open. The
// descendant pid is recorded so the test can assert it is really gone.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.env.BIFROST_DESCENDANT_PID_FILE;
await new Promise(resolve => setTimeout(resolve, Number(process.env.BIFROST_DESCENDANT_STARTUP_DELAY_MS ?? 0)));
if (!pidFile) throw new Error("BIFROST_DESCENDANT_PID_FILE is required by the descendant fixture");

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
writeFileSync(pidFile, String(descendant.pid));
if (process.env.BIFROST_DESCENDANT_NEVER_READY === "1") process.exit(0);
process.stdout.write("descendant-ready\n", () => process.exit(0));
