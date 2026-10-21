// ── Shared native faux test harness (reviewed G01 rebase) ────────
//
// ONE copyable helper for tests that drive the real Pi AgentSession with Pi's
// in-process `fauxProvider` (`@earendil-works/pi-ai`) instead of the HTTP fake
// provider server. It merges the proposed #83 fixture API with the #86 bounded
// parent-lifecycle controls, so a faux scenario can be copied without losing
// process-group ownership proof. No provider abstraction is introduced: this is
// test-only plumbing around the pinned Pi SDK and the real Bifrost extension.
//
// SCRATCH LIFETIME BELONGS TO THE CALLER. This harness never deletes scratch.
// Remove scratch only after `runOwnedNode` (or `runFauxFixtureChild`) reports
// `closeObserved === true` and `groupGone === true`; otherwise retain it and say
// so, because in-process cleanup can no longer prove absence.
//
// ── Driver side (parent test process) ───────────────────────────
//   REPO_ROOT                    repository root resolved from this file
//   CHILD_DEADLINE_MS            default bounded deadline for one child (120000)
//   CREDENTIAL_ENV_NAMES         ambient credentials that must never leak
//   isolateAmbientCredentials()  set canaries, return a restore function
//   fixtureChildEnv({...})       minimal guarded env for a child process
//   fenceProbeScript({...})      HTTP/HTTPS/TCP/UDP outbound-fence probe source
//   assertFenceBlocked(...)      prove the fence rejected every transport
//   assertNoViolations(...)      prove a child made zero outbound attempts
//   runOwnedNode(args, options)  bounded detached process-group runner; returns
//                                { status, signal, stdout, stderr,
//                                  deadlineExceeded, groupId, groupGone,
//                                  closeObserved }
//   runFauxFixtureChild({...})   run a fixture child and require exit 0
//
// ── Child side (fixture child process) ──────────────────────────
//   assertCredentialsAbsent(label)  fail if an ambient credential leaked in
//   writeIsolatedWorkspace({...})   isolated HOME/agentDir/workspace + config
//   startFauxHarness({...})         register faux providers, open a real session
//                                   through the real extension; returns
//                                   { runtime, session, invocations, paths,
//                                     providers, getModel, dispose }
//   assertProviderCallCounts(...)   exact per-provider dispatch assertions
//
// ── Copyable native scenario recipe ─────────────────────────────
// Parent (see tests/integration/native-faux-lifecycle.test.mjs for the full
// physical/Auto/child marker matrix):
//   1. scratch = mkdtempSync(...); violations = join(scratch, "network-violations.log")
//   2. restoreCredentials = isolateAmbientCredentials()
//   3. env = fixtureChildEnv({ scratch, violations, denyAll: true, extra: { <SCRATCH_ENV>: scratch } })
//   4. writeFileSync(violations, "")
//   5. probe = await runOwnedNode(["-e", fenceProbeScript({ blockedPort: 2 })], { cwd: REPO_ROOT, env })
//      assert probe.deadlineExceeded === false, probe.status === 0, probe.groupGone === true
//      assertFenceBlocked(violations, [...])  // positive HTTP/HTTPS/TCP/UDP probe
//   6. result = await runFauxFixtureChild({ child, env: { ...env, <SCENARIO_ENV>: name } })
//      require result.groupGone === true && result.closeObserved === true before rmSync(scratch)
//      assertNoViolations(violations)         // zero scenario violations
// Child fixture:
//   assertCredentialsAbsent("scenario")
//   const harness = await startFauxHarness({ scratch, wipeEnv: true, preserveEnv: [], bifrost, providers, startModel, selectModel })
//   try { ...await harness.session.prompt(...); assert identities + callCounts... } finally { harness.dispose() }
//
// A test that cannot prove owned-group death must FAIL and retain scratch. A
// controlled fault in a private scratch copy must fail a named AssertionError,
// never a startup/syntax error (see tests/integration/native-lifecycle-cleanup.test.mjs).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Bounded deadline for one owned child process. The cleanup control keys off 120000. */
export const CHILD_DEADLINE_MS = 120_000;

/** Ambient credentials that must never reach an isolated fixture child. */
export const CREDENTIAL_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
  "HF_TOKEN",
  "HUGGINGFACE_HUB_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
];

const OUTBOUND_GUARD = join(REPO_ROOT, "scripts", "test-outbound-guard.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGroupGone(groupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(groupId)) return true;
    await delay(25);
  }
  return !processGroupExists(groupId);
}

// ── Driver side ─────────────────────────────────────────────────

/**
 * Bounded, owned-child runner. Every child is a detached process-group leader
 * with an explicit deadline; on expiry the whole group is terminated through the
 * shared acceptance helper. The result reports the creation-time group id, the
 * observed close, and whether the owned group is independently gone, so the
 * caller can refuse to delete scratch while a group might still live. This
 * runner never deletes scratch.
 */
export function runOwnedNode(args, options = {}) {
  const timeoutMs = options.timeoutMs ?? CHILD_DEADLINE_MS;
  return new Promise((resolve, reject) => {
    const childProcess = spawn(execPath, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const groupId = childProcess.pid;
    let stdout = "";
    let stderr = "";
    let exitCode = null;
    let exitSignal = null;
    let deadlineExceeded = false;
    let settled = false;
    let closeObserved = false;
    let timer = null;

    if (childProcess.stdout) childProcess.stdout.setEncoding("utf8");
    if (childProcess.stderr) childProcess.stderr.setEncoding("utf8");
    childProcess.stdout?.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr?.on("data", (chunk) => { stderr += chunk; });

    const closePromise = new Promise((resolveClose) => {
      childProcess.once("close", (code, signal) => {
        closeObserved = true;
        exitCode = code;
        exitSignal = signal;
        resolveClose();
      });
    });

    async function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Group absence is a POSIX observation, never inferred from the platform.
      let groupGone = false;
      if (process.platform !== "win32" && Number.isInteger(groupId) && groupId > 0) {
        groupGone = await waitForGroupGone(groupId, 500);
        if (!groupGone) {
          try { await terminateProcessGroup(childProcess, { graceMs: 2_000, cleanupTimeoutMs: 5_000 }); } catch { /* denied cleanup: absence stays unproven */ }
          groupGone = !processGroupExists(groupId);
        }
      }
      if (!closeObserved) {
        let drainTimer;
        await Promise.race([closePromise, new Promise((resolveDrain) => { drainTimer = setTimeout(resolveDrain, 500); })]);
        clearTimeout(drainTimer);
      }
      // Inherited pipes must not keep the parent alive after denied cleanup.
      if (!closeObserved) {
        childProcess.stdout?.destroy();
        childProcess.stderr?.destroy();
      }
      childProcess.unref();
      resolve({ status: exitCode, signal: exitSignal, stdout, stderr, deadlineExceeded, groupId, groupGone, closeObserved });
    }

    timer = setTimeout(() => {
      deadlineExceeded = true;
      void settle();
    }, timeoutMs);

    closePromise.then(() => { if (!deadlineExceeded) void settle(); });
    childProcess.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * Neutralize the ambient credential variables for the duration of a run and
 * return a restore function. A child that still sees one of these has leaked.
 */
export function isolateAmbientCredentials() {
  const previous = Object.fromEntries(CREDENTIAL_ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of CREDENTIAL_ENV_NAMES) process.env[name] = "ambient-secret-fixture";
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/**
 * Minimal guarded environment for a fixture child: only what it needs. `denyAll`
 * selects the deny-all fence; `allowedOrigin` selects an exact loopback origin.
 * The guard rejects combining the two.
 */
export function fixtureChildEnv({ scratch, violations, allowedOrigin, denyAll = false, extra = {} }) {
  const env = {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    BIFROST_TEST_NETWORK_VIOLATIONS: violations,
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    ...extra,
  };
  if (denyAll) env.BIFROST_TEST_DENY_ALL = "1";
  if (allowedOrigin !== undefined) env.BIFROST_TEST_ALLOWED_ORIGIN = allowedOrigin;
  return env;
}

/**
 * Source for an inline `-e` probe that exercises the outbound fence on HTTP,
 * HTTPS, TCP, and UDP and fails when an ambient credential is visible.
 *
 * Deny-all mode (no `allowedUrl`) positively asserts that each transport is
 * blocked. Allowed mode fetches `allowedUrl`, checks `expectAllowedText`, then
 * proves the neighbouring blocked transports are still rejected.
 */
export function fenceProbeScript({ blockedPort, allowedUrl, expectAllowedText } = {}) {
  const credentialCheck = `${JSON.stringify(CREDENTIAL_ENV_NAMES)}.some((name) => process.env[name] !== undefined) ? 9 : 0`;
  if (allowedUrl === undefined) {
    return `
      const net = require("node:net");
      const tls = require("node:tls");
      const dgram = require("node:dgram");
      const assert = require("node:assert/strict");
      (async () => {
        await assert.rejects(async () => fetch("http://127.0.0.1:${blockedPort}"), /blocked fetch/);
        await assert.rejects(async () => fetch("https://127.0.0.1:${blockedPort}"), /blocked fetch/);
        for (const socket of [new net.Socket(), new tls.TLSSocket()]) {
          socket.on("error", () => {});
          try { assert.throws(() => socket.connect({ port: ${blockedPort}, host: "127.0.0.1" }), /blocked socket connection/); }
          finally { socket.destroy(); }
        }
        const udp = dgram.createSocket("udp4");
        udp.on("error", () => {});
        try { assert.throws(() => udp.send(Buffer.from("fixture"), ${blockedPort}, "127.0.0.1"), /blocked UDP datagram/); }
        finally { try { udp.close(); } catch {} }
        if (${credentialCheck}) process.exitCode = 9;
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
  }
  const blockedHttps = allowedUrl.replace(/^http:/, "https:");
  const allowedFetch = expectAllowedText === undefined
    ? ""
    : `const allowed = await fetch(${JSON.stringify(allowedUrl)});
      if (await allowed.text() !== ${JSON.stringify(expectAllowedText)}) process.exitCode = 8;`;
  return `const net = require("node:net");
    const tls = require("node:tls");
    const dgram = require("node:dgram");
    (async () => {
      ${allowedFetch}
      for (const attempt of [
        () => fetch(${JSON.stringify(blockedHttps)}),
        () => fetch("http://127.0.0.1:${blockedPort}"),
        () => new net.Socket().connect({ port: ${blockedPort}, host: "127.0.0.1" }),
        () => tls.connect({ port: ${blockedPort}, host: "127.0.0.1" }),
        () => dgram.createSocket("udp4").send(Buffer.from("fixture"), ${blockedPort}, "127.0.0.1"),
      ]) { try { await attempt(); } catch {} }
      if (${credentialCheck}) process.exitCode = 9;
    })();`;
}

/** Prove the fence recorded a rejection for every transport the probe tried. */
export function assertFenceBlocked(violations, patterns = [
  /blocked fetch to/,
  /blocked socket connection to/,
  /blocked UDP datagram to/,
]) {
  const text = readFileSync(violations, "utf8");
  for (const pattern of patterns) assert.match(text, pattern);
  return text;
}

/** Run a fixture child under `node --test` and require a clean exit. */
export async function runFauxFixtureChild({ child, env, cwd = REPO_ROOT, timeoutMs = CHILD_DEADLINE_MS }) {
  const result = await runOwnedNode(["--test", "--experimental-strip-types", child], { cwd, env, timeoutMs });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

/** Prove a fixture child recorded no blocked outbound attempt. */
export function assertNoViolations(violations, message = "faux AgentSession made a blocked outbound attempt") {
  assert.equal(existsSync(violations) ? readFileSync(violations, "utf8") : "", "", message);
}

// ── Child side ──────────────────────────────────────────────────

/** Fail if the ambient credential set leaked into this child. */
export function assertCredentialsAbsent(label) {
  for (const name of CREDENTIAL_ENV_NAMES) {
    assert.equal(process.env[name], undefined, `${name} leaked into the isolated ${label} child`);
  }
}

/**
 * Build the isolated HOME/agentDir/workspace tree and write fixture config.
 * Returns the paths; scratch deletion stays with the caller.
 */
export function writeIsolatedWorkspace({ scratch, bifrost }) {
  const home = join(scratch, "home");
  const cwd = join(scratch, "workspace");
  const agentDir = join(home, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  if (bifrost !== undefined) writeFileSync(join(cwd, ".pi", "bifrost.json"), JSON.stringify(bifrost));
  return { home, cwd, agentDir };
}

function resolveModel(runtime, key) {
  const separator = key.indexOf("/");
  assert.ok(separator > 0, `model key must be "provider/id": ${key}`);
  return runtime.getModel(key.slice(0, separator), key.slice(separator + 1));
}

/**
 * Register faux providers on a real ModelRuntime and open a real AgentSession
 * through the real Bifrost extension.
 *
 *   scratch      parent-owned temp directory
 *   bifrost      config object written to <cwd>/.pi/bifrost.json
 *   providers    [{ provider, models: [{ id, reasoning }], response }]
 *   startModel   "provider/model" or (runtime) => Model, bootstraps the session
 *   selectModel  optional "provider/model" or (runtime) => Model, selected after
 *                the extension loads (needed for the virtual `bifrost/auto`,
 *                which only exists once the extension has registered it)
 *   wipeEnv      true to strip the environment to PATH/TMPDIR/LANG/TERM before
 *                boot; `preserveEnv` names extra variables to keep (for example
 *                PI_SUBAGENT_CHILD for the marked child-host matrix)
 *
 * Returns per-provider faux handles plus the recorded dispatch invocations.
 */
export async function startFauxHarness({ scratch, bifrost, providers, startModel, selectModel, wipeEnv = false, preserveEnv = [] }) {
  assertCredentialsAbsent("faux");
  const previous = { cwd: process.cwd(), env: { ...process.env } };
  if (wipeEnv) {
    const keep = ["PATH", "TMPDIR", "LANG", "TERM", ...preserveEnv];
    const preserved = Object.fromEntries(
      keep.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
    );
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, preserved);
  }
  const paths = writeIsolatedWorkspace({ scratch, bifrost });
  process.chdir(paths.cwd);
  process.env.HOME = paths.home;
  process.env.PI_CODING_AGENT_DIR = paths.agentDir;
  const release = () => {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previous.env);
    process.chdir(previous.cwd);
  };

  const [{ createAgentSession, ModelRuntime, DefaultResourceLoader }, { fauxProvider, fauxAssistantMessage, fauxText }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-ai"),
  ]);
  const invocations = [];
  const handles = providers.map(({ provider, models, response }) => {
    const faux = fauxProvider({ provider, models });
    faux.setResponses([(_context, _options, _state, model) => {
      invocations.push(`${model.provider}/${model.id}`);
      return fauxAssistantMessage(fauxText(typeof response === "function" ? response(model) : response));
    }]);
    return faux;
  });

  let runtime;
  let session;
  try {
    runtime = await ModelRuntime.create({ authPath: join(paths.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    for (const faux of handles) {
      runtime.registerNativeProvider(faux.provider);
      await runtime.setRuntimeApiKey(faux.provider.id, "fixture-only");
    }
    await runtime.refresh({ allowNetwork: false });
    const { default: bifrostExtension } = await import(join(REPO_ROOT, "index.ts"));
    const resourceLoader = new DefaultResourceLoader({ cwd: paths.cwd, agentDir: paths.agentDir, extensionFactories: [bifrostExtension] });
    // The extension factory runs while the session is created, so the virtual
    // `bifrost/auto` model exists only after createAgentSession. Bootstrap on a
    // physical model, then let `selectModel` switch to any virtual model.
    await resourceLoader.reload();
    const model = typeof startModel === "function" ? startModel(runtime) : resolveModel(runtime, startModel);
    assert.ok(model, "the session start model must exist on the runtime");
    ({ session } = await createAgentSession({
      cwd: paths.cwd, agentDir: paths.agentDir, modelRuntime: runtime, model, noTools: "all", resourceLoader,
    }));
    await session.bindExtensions({ mode: "print" });
    if (selectModel !== undefined) {
      const selected = typeof selectModel === "function" ? selectModel(runtime) : resolveModel(runtime, selectModel);
      assert.ok(selected, "the selected model must exist on the runtime");
      await session.setModel(selected);
    }
  } catch (error) {
    release();
    throw error;
  }

  return {
    runtime,
    session,
    invocations,
    paths,
    providers: new Map(handles.map((faux) => [faux.provider.id, faux])),
    getModel: (key) => resolveModel(runtime, key),
    dispose() {
      try { session?.dispose(); } catch { /* best effort */ }
      for (const faux of handles) { try { runtime.unregisterProvider(faux.provider.id); } catch { /* best effort */ } }
      release();
    },
  };
}

/** Assert each provider's faux callCount matches the expected map (absent = 0). */
export function assertProviderCallCounts(providers, expected) {
  for (const [provider, faux] of providers) {
    const want = expected[provider] ?? 0;
    assert.equal(faux.state.callCount, want, `${provider} must receive ${want} call(s), saw ${faux.state.callCount}`);
  }
}
