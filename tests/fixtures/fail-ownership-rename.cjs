// Fault injector for init commit-failure smoke tests.
// When BIFROST_TEST_FAIL_OWNERSHIP_RENAME=1, the first renameSync that installs
// the reconciliation ownership sidecar throws after the config rename has
// already happened, leaving a journal in config_installed state.
"use strict";
const fs = require("node:fs");
if (process.env.BIFROST_TEST_FAIL_OWNERSHIP_RENAME === "1") {
  const real = fs.renameSync;
  let fired = false;
  fs.renameSync = function patchedRenameSync(oldPath, newPath) {
    if (!fired && typeof newPath === "string" && /bifrost-reconcile-ownership\.json$/.test(newPath)) {
      fired = true;
      const err = new Error("BIFROST_TEST_FAIL_OWNERSHIP_RENAME");
      err.code = "EIO";
      throw err;
    }
    return real.call(this, oldPath, newPath);
  };
}
