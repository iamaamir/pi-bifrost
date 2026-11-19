// Preload that makes `process.chdir()` safe under Stryker's TAP runner.
//
// The TAP runner writes a handshake file (`stryker-output-<pid>.json`) on
// process exit and the parent reads it relative to the working directory it
// launched from. A bound test that calls `process.chdir()` and does not restore
// before the process exits — which is exactly what happens when a mutant makes
// the test throw before its `cleanup()` runs — writes the handshake somewhere
// else, and the parent reports:
//
//   Error running file "tests/…". ENOENT: no such file or directory,
//   open 'stryker-output-<pid>.json'
//
// Those show up as `RuntimeError`, which Stryker excludes from the score, so the
// module silently reports a score over a smaller population.
//
// Restoring the original directory in an `exit` handler fixes it: Node runs
// `exit` listeners in registration order, and this preload is registered before
// the runner's own hook (it is passed earlier on the `-r` list), so the
// directory is back to its starting value before the handshake is written.

import process from "node:process";

const initialCwd = process.cwd();

process.on("exit", () => {
  try {
    if (process.cwd() !== initialCwd) process.chdir(initialCwd);
  } catch {
    // A directory can disappear under us; nothing useful to do during exit.
  }
});
