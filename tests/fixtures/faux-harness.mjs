// ── Shared native faux test harness ─────────────────────────────
// One reusable path for tests that drive the real Pi AgentSession with Pi's
// in-process `fauxProvider` (`@earendil-works/pi-ai`) instead of the HTTP fake
// provider server. Both sides of the child-process boundary live here:
//
//   Driver side (parent test process)
//     isolateAmbientCredentials  fence the ambient credential variables
//     fixtureChildEnv            minimal guarded environment for a child
//     runNode                    bounded stdout/stderr capture
//     fenceProbeScript           HTTP/HTTPS/TCP/UDP fence probe source
//     assertFenceBlocked         prove the fence rejected every attempt
//     assertOutboundFence        run the probe in a guarded child and assert it
//     runFauxFixtureChild        run a fixture child and require exit 0
//     assertNoViolations         prove the child made no outbound attempt
//
//   Child side (fixture child process)
//     assertCredentialsAbsent    fail if an ambient credential leaked in
//     writeIsolatedWorkspace     isolated HOME/agentDir/workspace + config
//     startFauxHarness           register faux providers, open a real session
//     assertProviderCallCounts   exact per-provider dispatch assertions
//
// Scratch lifetime belongs to the caller. This harness never deletes scratch,
// so no in-process work can recreate fixture files after the parent removes it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

/** Violations every guarded child must record: HTTP, HTTPS, TCP, and UDP. */
const DEFAULT_FENCE_PATTERNS = Object.freeze([
  /blocked fetch to https:\/\/127\.0\.0\.1:/,
  /blocked fetch to http:\/\/127\.0\.0\.1:/,
  /blocked socket connection to 127\.0\.0\.1:/,
  /blocked UDP datagram to 127\.0\.0\.1/,
]);

// ── Driver side ─────────────────────────────────────────────────

/** Run one Node process and capture its stdout and stderr. */
export function runNode(args, options) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    childProcess.stdout.setEncoding("utf8");
    childProcess.stderr.setEncoding("utf8");
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    childProcess.once("error", reject);
    childProcess.once("close", (status) => resolve({ status, stdout, stderr }));
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

/** Minimal guarded environment for a fixture child: only what it needs. */
export function fixtureChildEnv({ scratch, violations, allowedOrigin, extra = {} }) {
  return {
    PATH: process.env.PATH,
    HOME: join(scratch, "home"),
    BIFROST_TEST_ALLOWED_ORIGIN: allowedOrigin,
    BIFROST_TEST_NETWORK_VIOLATIONS: violations,
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    ...extra,
  };
}

/**
 * Source for an inline `-e` probe that exercises the outbound fence on HTTP,
 * HTTPS, TCP, and UDP and fails when an ambient credential is visible.
 */
export function fenceProbeScript({ allowedUrl, blockedPort, expectAllowedText }) {
  const allowedFetch = expectAllowedText === undefined
    ? ""
    : `const allowed = await fetch(${JSON.stringify(allowedUrl)});
      if (await allowed.text() !== ${JSON.stringify(expectAllowedText)}) process.exitCode = 8;`;
  const blockedHttps = allowedUrl.replace(/^http:/, "https:");
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
      if (${JSON.stringify(CREDENTIAL_ENV_NAMES)}.some((name) => process.env[name] !== undefined)) process.exitCode = 9;
    })();`;
}

/** Prove the fence recorded a rejection for every transport the probe tried. */
export function assertFenceBlocked(violations, patterns = DEFAULT_FENCE_PATTERNS) {
  const text = readFileSync(violations, "utf8");
  for (const pattern of patterns) assert.match(text, pattern);
  return text;
}

/**
 * Run the fence probe in a guarded child and require the recorded violations.
 * Drivers call this once before running any fixture child.
 */
export async function assertOutboundFence({
  env,
  violations,
  allowedUrl,
  blockedPort,
  expectAllowedText,
  patterns = DEFAULT_FENCE_PATTERNS,
}) {
  writeFileSync(violations, "");
  const probe = await runNode(["-e", fenceProbeScript({ allowedUrl, blockedPort, expectAllowedText })], { cwd: REPO_ROOT, env });
  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
  return assertFenceBlocked(violations, patterns);
}

/** Run a fixture child under `node --test` and require a clean exit. */
export async function runFauxFixtureChild({ child, env, cwd = REPO_ROOT }) {
  const result = await runNode(["--test", "--experimental-strip-types", child], { cwd, env });
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

/**
 * Register faux providers on a real ModelRuntime and open a real AgentSession
 * through the real Bifrost extension.
 *
 *   scratch    parent-owned temp directory
 *   bifrost    config object written to <cwd>/.pi/bifrost.json
 *   providers  [{ provider, models: [{ id, reasoning }], response }]
 *   startModel "provider/model" or (runtime) => Model, bootstraps the session
 *   selectModel optional "provider/model" or (runtime) => Model, selected after
 *               the extension loads (needed for the virtual `bifrost/auto`,
 *               which only exists once the extension has registered it)
 *   wipeEnv    true to strip the environment to PATH/TMPDIR/LANG/TERM first
 *
 * Returns per-provider faux handles plus the recorded dispatch invocations.
 */
export async function startFauxHarness({ scratch, bifrost, providers, startModel, selectModel, wipeEnv = false }) {
  assertCredentialsAbsent("faux");
  const previous = { cwd: process.cwd(), env: { ...process.env } };
  if (wipeEnv) {
    const preserved = Object.fromEntries(
      ["PATH", "TMPDIR", "LANG", "TERM"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]),
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

function resolveModel(runtime, key) {
  const separator = key.indexOf("/");
  assert.ok(separator > 0, `model key must be "provider/id": ${key}`);
  return runtime.getModel(key.slice(0, separator), key.slice(separator + 1));
}
