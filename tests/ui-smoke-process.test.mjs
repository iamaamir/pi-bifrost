import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const teardown = `
import importlib.util, os, signal, subprocess, sys, tempfile
spec = importlib.util.spec_from_file_location("ui_smoke", "scripts/ui-smoke.py")
module = importlib.util.module_from_spec(spec)
sys.modules["ui_smoke"] = module
spec.loader.exec_module(module)
fixture = tempfile.mkdtemp(prefix="bifrost-ui-smoke-teardown-")
proc = subprocess.Popen(
    [sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(30)"],
    start_new_session=True,
    stdout=subprocess.PIPE,
    text=True,
)
try:
    assert proc.stdout.readline().strip() == "ready", "test child did not start"
    module.stop_process_group(proc, timeout=0.1)
    assert proc.poll() is not None, "timed-out smoke process survived teardown"
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    os.rmdir(fixture)
`;

describe("ui-smoke process teardown", () => {
  it("kills and reaps a process group that ignores SIGTERM before fixture cleanup", () => {
    assert.doesNotThrow(() => execFileSync("python3", ["-B", "-c", teardown], { cwd: ROOT }));
  });
});
