// Stand-in for the Pi CLI in the pipe-race regression. Its descendant closes
// the inherited stdout/stderr when signalled but keeps running, so the leader's
// close event arrives while a member of the owned process group is still alive.
// That is the shape that made the runner settle on close alone and report a
// clean timeout while the group descendant survived. The descendant pid is
// recorded so the test can assert it is really gone.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.env.BIFROST_DESCENDANT_PID_FILE;
if (!pidFile) throw new Error("BIFROST_DESCENDANT_PID_FILE is required by the pipe-race fixture");

// Closes only its own copies of the inherited pipes, then keeps running. The
// group is still alive after every inherited descriptor has been released.
const descendant = spawn(process.execPath, ["-e", [
  "process.on('SIGTERM', () => {",
  "  try { require('node:fs').closeSync(1); } catch {}",
  "  try { require('node:fs').closeSync(2); } catch {}",
  "});",
  "setInterval(() => {}, 1000);",
].join("\n")], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});

writeFileSync(pidFile, String(descendant.pid));
descendant.once("spawn", () => process.exit(0));