import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join, sep } from "node:path";

const PROFILES = new Set(["deterministic", "contract", "live"]);

export function parseArgs(argv) {
  const values = { profile: "deterministic", allowLive: false, allowModels: [], maxRequestsPerModel: 4, deadlineSeconds: 300 };
  const present = new Set();
  const valueFlags = new Set(["--profile", "--allow-model", "--max-requests-per-model", "--deadline-seconds"]);
  const booleanFlags = new Set(["--allow-live"]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === "--help" || raw === "-h") return { help: true };
    const equals = raw.indexOf("=");
    const flag = equals < 0 ? raw : raw.slice(0, equals);
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) throw new Error("Unknown acceptance flag: " + flag);
    if (booleanFlags.has(flag)) {
      if (equals >= 0) throw new Error(flag + " does not take a value");
      if (present.has(flag)) throw new Error(flag + " may only be specified once");
      present.add(flag);
      values.allowLive = true;
      continue;
    }
    const value = equals < 0 ? argv[++i] : raw.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) throw new Error(flag + " requires a value");
    if (flag !== "--allow-model" && present.has(flag)) throw new Error(flag + " may only be specified once");
    present.add(flag);
    if (flag === "--profile") values.profile = value;
    else if (flag === "--allow-model") values.allowModels.push(value);
    else if (flag === "--max-requests-per-model" || flag === "--deadline-seconds") {
      if (!/^[1-9]\d*$/.test(value)) throw new Error(flag + " must be a positive integer");
      values[flag === "--max-requests-per-model" ? "maxRequestsPerModel" : "deadlineSeconds"] = Number(value);
    }
  }
  if (!PROFILES.has(values.profile)) throw new Error("Unknown acceptance profile: " + values.profile);
  if (values.profile === "live") {
    if (!values.allowLive) throw new Error("Live acceptance requires explicit --allow-live opt-in");
    if (values.allowModels.length !== 1 || values.allowModels.some((model) => !/^[^/\s*?]+\/[^/\s*?]+(?:\/[^/\s*?]+)*$/.test(model))) {
      throw new Error("Live acceptance requires exactly one exact --allow-model provider/model");
    }
    if (values.maxRequestsPerModel > 4) throw new Error("--max-requests-per-model may not exceed 4");
    if (values.deadlineSeconds > 300) throw new Error("--deadline-seconds may not exceed 300");
  } else if (present.has("--allow-live") || present.has("--allow-model") || present.has("--max-requests-per-model") || present.has("--deadline-seconds")) {
    throw new Error("Live-only flags require --profile live");
  }
  return { help: false, ...values };
}

export function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function sourceFingerprint(root) {
  const files = [...new Set(
    git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean),
  )].sort().filter((file) => !file.startsWith("screenshots" + sep + "acceptance" + sep));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file).update("\0");
    try {
      const fullPath = join(root, file);
      const stats = lstatSync(fullPath);
      if (stats.isSymbolicLink()) hash.update("symlink\0").update(readlinkSync(fullPath));
      else if (stats.isFile()) hash.update(stats.mode & 0o111 ? "executable\0" : "regular\0").update(readFileSync(fullPath));
      else hash.update("other\0");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      hash.update("deleted\0");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function gitTruth(root) {
  const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  return output
    .split("\n").filter(Boolean).map((line) => ({ index: line.slice(0, 2), path: line.slice(3) }));
}

function commandVersion(path, args = ["--version"]) {
  if (!path) return null;
  const result = spawnSync(path, args, { encoding: "utf8", timeout: 5000 });
  return result.status === 0 ? (result.stdout + result.stderr).trim() : null;
}

export function installedToolVersions(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const findExecutable = (paths) => paths.map((path) => join(root, path)).find((path) => {
    try { return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink(); } catch { return false; }
  });
  const piPath = findExecutable(["node_modules/.bin/pi", "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"]);
  const tuiPath = findExecutable(["node_modules/.bin/agent-tui"]);
  const resolvedAgentTui = resolveAgentTui(root);
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: 5000 });
  const python = spawnSync("python3", ["-c", "import PIL; print(PIL.__version__)"], { encoding: "utf8", timeout: 5000 });
  return {
    runtime: { node: process.version, npm: npm.status === 0 ? npm.stdout.trim() : null },
    installed: {
      pi: commandVersion(piPath),
      piCodingAgent: installedPackageVersion(root, "@earendil-works/pi-coding-agent"),
      piAi: installedPackageVersion(root, "@earendil-works/pi-ai"),
      agentTui: commandVersion(tuiPath),
      agentTuiNative: resolvedAgentTui,
      typescript: installedPackageVersion(root, "typescript"),
      pythonPillow: python.status === 0 ? python.stdout.trim() : null,
    },
    declared: {
      pi: pkg.devDependencies?.["@earendil-works/pi-coding-agent"] ?? null,
      agentTui: pkg.devDependencies?.["agent-tui"] ?? null,
      typescript: pkg.devDependencies?.typescript ?? null,
    },
  };
}

function resolveAgentTui(root) {
  try {
    const require = createRequire(join(root, "node_modules", "agent-tui", "package.json"));
    const resolved = require("agent-tui/scripts/platform.js").resolveBinaryPath();
    if (!resolved.binPath || !resolved.pkgName) return null;
    const packagePath = require.resolve(`${resolved.pkgName}/package.json`);
    const packageInfo = JSON.parse(readFileSync(packagePath, "utf8"));
    const binary = readFileSync(resolved.binPath);
    return {
      package: resolved.pkgName,
      version: packageInfo.version,
      platformArch: resolved.platformArch,
      executableVersion: commandVersion(resolved.binPath),
      binarySha256: createHash("sha256").update(binary).digest("hex"),
    };
  } catch {
    return null;
  }
}

function installedPackageVersion(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

export function summarizeCases(cases) {
  const failures = cases.filter((item) => item.required !== false
    && (item.status === "failed" || item.status === "blocked" || item.status === "missing"));
  return {
    required: cases.filter((item) => item.required !== false).length,
    passed: cases.filter((item) => item.status === "passed").length,
    failed: cases.filter((item) => item.status === "failed").length,
    blocked: cases.filter((item) => item.status === "blocked").length,
    missing: cases.filter((item) => item.status === "missing").length,
    deferred: cases.filter((item) => item.status === "deferred").length,
    exitCode: failures.length > 0 ? 1 : 0,
  };
}

export function matchNamedTestEvent(events, { file, name }) {
  const matches = events.filter((event) => event.file?.endsWith(file) && event.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

export function processGroupExists(groupId) {
  if (!groupId || process.platform === "win32") return false;
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

function signalGroup(groupId, signal) {
  try { process.kill(-groupId, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

export async function terminateProcessGroup(child, {
  graceMs = 2000,
  cleanupTimeoutMs = 5000,
  groupExists: isGroupAlive = processGroupExists,
  signalGroup: sendGroupSignal = signalGroup,
  wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms)),
} = {}) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { child.kill("SIGTERM"); } catch {}
    return true;
  }
  const groupId = child.pid;
  try { sendGroupSignal(groupId, "SIGTERM"); }
  catch { return false; }
  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline && isGroupAlive(groupId)) await wait(25);
  if (!isGroupAlive(groupId)) return true;
  try { sendGroupSignal(groupId, "SIGKILL"); }
  catch { return false; }
  const cleanupDeadline = Date.now() + cleanupTimeoutMs;
  while (Date.now() < cleanupDeadline && isGroupAlive(groupId)) await wait(25);
  return !isGroupAlive(groupId);
}

export function verificationGateEnvironment({ root, artifactDir, script }) {
  const gateRoot = gateDirectory(artifactDir, script);
  const home = join(gateRoot, "home");
  const violationPath = join(gateRoot, "network-violations.log");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true, mode: 0o700 });
  mkdirSync(gateRoot, { recursive: true, mode: 0o700 });
  writeFileSync(violationPath, "", { mode: 0o600 });
  const env = {
    PATH: [join(root, "node_modules", ".bin"), process.env.PATH ?? "/usr/bin:/bin"].join(delimiter),
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    CI: "1",
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    BIFROST_ACCEPTANCE_ARTIFACT_DIR: artifactDir,
    BIFROST_TEST_ALLOW_LOOPBACK: "1",
    BIFROST_TEST_NETWORK_VIOLATIONS: violationPath,
    NODE_OPTIONS: `--require=${join(root, "scripts", "test-outbound-guard.cjs")}`,
  };
  for (const key of ["TMPDIR", "LANG", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { env, violationPath };
}

export function gateDirectory(artifactDir, script) {
  return join(artifactDir, "gates", script.replace(/[^a-z0-9-]/gi, "-"));
}
