// Owned-child process runner shared by the native integration tests.
//
// Each child is a detached process-group leader with an explicit deadline. On
// expiry the whole group gets SIGTERM, then SIGKILL, then a bounded wait for the
// group to disappear. The result reports whether the group is gone, so the
// caller can refuse to delete scratch while a child might still live. The runner
// never deletes scratch itself.
//
// Extracted from two near-identical copies in
// tests/integration/native-classifier.test.mjs and
// tests/integration/native-tool-continuation.test.mjs. The copies differed only
// in the default timeout, which is now a parameter.
import { spawn } from "node:child_process";
import { execPath } from "node:process";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return null;
  } catch (error) {
    return error;
  }
}

async function waitForGroupTermination(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error("owned process group did not terminate: " + pid);
}

/** A runner bound to one default timeout, with the last run's cleanup verdict. */
export function createOwnedRunner({ defaultTimeoutMs }) {
  // Read by the caller after a run: false means a group may still be alive, so
  // the scratch directory must not be removed.
  const state = { cleanupSafeForCaller: true };

  function runNode(args, options = {}) {
    return new Promise((resolve, reject) => {
      const childProcess = spawn(execPath, args, {
        ...options,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = childProcess.pid;
      let stdout = "";
      let stderr = "";
      if (childProcess.stdout) childProcess.stdout.setEncoding("utf8");
      if (childProcess.stderr) childProcess.stderr.setEncoding("utf8");
      if (childProcess.stdout) childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
      if (childProcess.stderr) childProcess.stderr.on("data", (chunk) => { stderr += chunk; });

      let closed = false;
      let exitCode = null;
      let exitSignal = null;
      const closePromise = new Promise((resolveClose) => {
        childProcess.once("close", (code, signal) => {
          closed = true;
          exitCode = code;
          exitSignal = signal;
          resolveClose();
        });
      });

      const timeoutMs = options.timeoutMs || defaultTimeoutMs;
      let escalationTimer = null;
      let settled = false;

      function succeed() {
        if (settled) return;
        settled = true;
        if (escalationTimer) clearTimeout(escalationTimer);
        try { childProcess.stdout?.destroy(); } catch {}
        try { childProcess.stderr?.destroy(); } catch {}
        try { childProcess.unref(); } catch {}
        state.cleanupSafeForCaller = true;
        resolve({ status: exitCode, signal: exitSignal, stdout, stderr, closeObserved: closed, groupTerminated: true });
      }

      function fail(error) {
        if (settled) return;
        settled = true;
        if (escalationTimer) clearTimeout(escalationTimer);
        try { childProcess.stdout?.destroy(); } catch {}
        try { childProcess.stderr?.destroy(); } catch {}
        try { childProcess.unref(); } catch {}
        state.cleanupSafeForCaller = false;
        reject(error instanceof Error ? error : new Error(String(error)));
      }

      childProcess.once("error", (error) => fail(error));

      escalationTimer = setTimeout(async () => {
        const termError = killProcessGroup(pid, "SIGTERM");
        if (termError && termError.code !== "ESRCH") {
          fail(new Error("SIGTERM failed for owned process group " + pid + ": " + termError.message + "\n" + stdout + "\n" + stderr));
          return;
        }
        await delay(2000);
        const killError = killProcessGroup(pid, "SIGKILL");
        if (killError && killError.code !== "ESRCH") {
          fail(new Error("SIGKILL failed for owned process group " + pid + ": " + killError.message + "\n" + stdout + "\n" + stderr));
          return;
        }
        const closedInTime = await Promise.race([
          closePromise.then(() => true),
          delay(2000).then(() => false),
        ]);
        if (!closedInTime) {
          fail(new Error("owned child did not close after escalation\n" + stdout + "\n" + stderr));
          return;
        }
        try {
          await waitForGroupTermination(pid, 1000);
        } catch (error) {
          fail(error);
          return;
        }
        succeed();
      }, timeoutMs);

      closePromise.then(async () => {
        if (settled) return;
        clearTimeout(escalationTimer);
        escalationTimer = null;
        try {
          await waitForGroupTermination(pid, 200);
        } catch {
          const killError = killProcessGroup(pid, "SIGKILL");
          if (killError && killError.code !== "ESRCH") {
            fail(new Error("SIGKILL failed for owned process group " + pid + ": " + killError.message + "\n" + stdout + "\n" + stderr));
            return;
          }
          try {
            await waitForGroupTermination(pid, 1000);
          } catch (error) {
            fail(error);
            return;
          }
        }
        succeed();
      });
    });
  }

  return { state, runNode };
}
