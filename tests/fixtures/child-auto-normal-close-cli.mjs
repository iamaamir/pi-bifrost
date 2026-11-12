// Stand-in for the Pi CLI when it completes normally with code 0 while a
// descendant it spawned is still running. The descendant takes no inherited
// pipes, so the leader's close event carries no information about it. Its pid
// is recorded so the test can assert it is gone before any scratch is removed.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.env.BIFROST_DESCENDANT_PID_FILE;
if (!pidFile) throw new Error("BIFROST_DESCENDANT_PID_FILE is required by the normal-close fixture");

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
writeFileSync(pidFile, String(descendant.pid));
descendant.once("spawn", () => process.exit(0));
