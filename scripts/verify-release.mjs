#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTestBinary } from "./resolve-test-binary.mjs";

const REQUIRED_GATES = [
  ["unit", "test"],
  ["typecheck", "typecheck"],
  ["router-build", "build:router"],
  ["pinned-pi-integration", "test:integration"],
  ["pinned-pi-ui", "test:ui"],
  ["pinned-pi-reliability-ui", "test:ui:reliability"],
];
const MAX_LOG_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = (MAX_LOG_BYTES - 64) / 2;

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sourceHash(root) {
  const files = [...new Set(
    git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean),
  )].sort()
    .filter((file) => !file.startsWith(`screenshots${sep}verification${sep}`));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0");
    try {
      const fullPath = join(root, file);
      const stats = lstatSync(fullPath);
      if (stats.isSymbolicLink()) hash.update("symlink\0").update(readlinkSync(fullPath));
      else if (stats.isFile()) hash.update(stats.mode & 0o111 ? "executable\0" : "regular\0").update(readFileSync(fullPath));
      else hash.update("other\0");
    }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      hash.update("deleted\0");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function captureStream(limit = MAX_STREAM_BYTES) {
  const segmentLimit = Math.floor(limit / 2);
  let size = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    append(chunk) {
      size += chunk.length;
      if (head.length < segmentLimit) {
        const count = Math.min(segmentLimit - head.length, chunk.length);
        head = Buffer.concat([head, chunk.subarray(0, count)]);
        chunk = chunk.subarray(count);
      }
      if (chunk.length) tail = Buffer.concat([tail, chunk]).subarray(-segmentLimit);
    },
    text() {
      if (size <= limit) return Buffer.concat([head, tail]).toString();
      return `${head.toString()}\n[stream output truncated]\n${tail.toString()}`;
    },
  };
}

function boundedOutput(result) {
  const stdout = captureStream();
  const stderr = captureStream();
  stdout.append(Buffer.from(result.stdout ?? ""));
  stderr.append(Buffer.from(result.stderr ?? ""));
  return `${stdout.text()}${result.stderr ? `\n[stderr]\n${stderr.text()}` : ""}`;
}

function preflight(root) {
  const checkBinary = (name, envVar) => {
    try { resolveTestBinary({ envVar, name, root }); return `${name}: available`; }
    catch { throw new Error(`${name} is missing. Install project dependencies or set ${envVar} to its executable.`); }
  };
  checkBinary("agent-tui", "AGENT_TUI_BIN");
  let pi;
  try { pi = resolveTestBinary({ envVar: "PI_BIN", name: "pi", root }).path; }
  catch { throw new Error("Pinned Pi is missing. Install project dependencies or set PI_BIN to Pi 1.0.1."); }
  const version = spawnSync(pi, ["--version"], { encoding: "utf8", timeout: 5000 });
  if (version.status !== 0 || version.stdout.trim() !== "1.0.1") {
    throw new Error("Pi 1.0.1 is required. Install the pinned project dependency or set PI_BIN to Pi 1.0.1.");
  }
  const pillow = spawnSync("python3", ["-c", "import PIL"], { encoding: "utf8", timeout: 5000 });
  if (pillow.status !== 0) throw new Error("Python Pillow is required by test:ui. Install it with `python3 -m pip install Pillow`.");
  return "Pi 1.0.1, agent-tui, and Python Pillow are available.";
}

function executeGate(root, script) {
  const stdout = captureStream();
  const stderr = captureStream();
  const child = spawn("npm", ["run", script], { cwd: root, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolveResult) => {
    let settled = false;
    let timedOut = false;
    let forceKill;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      resolveResult({
        ...result,
        stdout: stdout.text(),
        stderr: `${stderr.text()}${result.stderr ? `\n${result.stderr}` : ""}`,
      });
    };
    const kill = (signal) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* The process may exit between timeout and signal delivery. */ }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      forceKill = setTimeout(() => kill("SIGKILL"), 2000);
    }, 20 * 60 * 1000);
    child.stdout.on("data", (chunk) => stdout.append(chunk));
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.on("error", (error) => finish({ status: 1, stderr: error.message }));
    child.on("close", (code, signal) => finish({
      status: timedOut ? 124 : code ?? 1,
      stderr: timedOut ? "Verification gate timed out after 20 minutes." : signal ? `Process ended by ${signal}.` : "",
    }));
  });
}

function workingTreeClean(root) {
  return git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length === 0;
}

export async function runVerification({
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  execute = ({ script }) => executeGate(root, script),
  checkPreflight = () => preflight(root),
} = {}) {
  root = resolve(root);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = join(root, "screenshots", "verification", runId);
  const logDir = join(artifactDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const manifestPath = relative(root, join(artifactDir, "result.json"));
  const startedAt = new Date().toISOString();
  const headSha = git(root, ["rev-parse", "HEAD"]);
  const workingTreeCleanAtStart = workingTreeClean(root);
  const sourceHashAtStart = sourceHash(root);
  const results = [];
  let error;
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const missingGates = REQUIRED_GATES.filter(([, script]) => !packageJson.scripts?.[script]).map(([, script]) => script);

  const record = async (id, script, index) => {
    const started = new Date().toISOString();
    process.stdout.write(`[verify] ${id}: started\n`);
    let outcome;
    try {
      outcome = script === null
        ? { status: 0, stdout: checkPreflight(), stderr: "" }
        : await execute({ root, script, index });
    } catch (cause) {
      outcome = { status: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) };
    }
    const logPath = relative(root, join(logDir, `${id}.log`));
    writeFileSync(join(root, logPath), boundedOutput(outcome));
    results.push({ id, script, exitCode: outcome.status, startedAt: started, endedAt: new Date().toISOString(), logPath });
    process.stdout.write(`[verify] ${id}: ${outcome.status === 0 ? "passed" : "failed"} (log: ${logPath})\n`);
    return outcome.status === 0;
  };

  try {
    if (missingGates.length) throw new Error(`Required verification scripts are missing: ${missingGates.join(", ")}`);
    if (!(await record("preflight", null, -1))) throw new Error("Verification preflight failed; see its log.");
    for (const [index, [id, script]] of REQUIRED_GATES.entries()) {
      if (!(await record(id, script, index))) error = `${id} failed; see its log.`;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const sourceHashAtEnd = sourceHash(root);
  const headShaAtEnd = git(root, ["rev-parse", "HEAD"]);
  const workingTreeCleanAtEnd = workingTreeClean(root);
  const manifest = {
    version: 1,
    headSha,
    headShaAtEnd,
    workingTreeCleanAtStart,
    workingTreeCleanAtEnd,
    revisionChangedDuringRun: headSha !== headShaAtEnd,
    sourceHashAtStart,
    sourceHashAtEnd,
    sourceChangedDuringRun: sourceHashAtStart !== sourceHashAtEnd,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: error || headSha !== headShaAtEnd || sourceHashAtStart !== sourceHashAtEnd || results.some(({ exitCode }) => exitCode !== 0) ? 1 : 0,
    ...(error ? { error } : {}),
    gates: results,
  };
  writeFileSync(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, manifestPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runVerification();
  process.stdout.write(`Verification ${result.exitCode === 0 ? "passed" : "failed"}; manifest: ${result.manifestPath}\n`);
  if (result.error) process.stderr.write(`${result.error}\n`);
  if (result.sourceChangedDuringRun) process.stderr.write("Repository source changed during verification; rerun against a frozen candidate.\n");
  if (result.revisionChangedDuringRun) process.stderr.write("HEAD changed during verification; rerun against a frozen candidate.\n");
  process.exitCode = result.exitCode;
}
