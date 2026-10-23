import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { processGroupExists, terminateProcessGroup } from "../../scripts/acceptance/core.mjs";
import { startFakeProviderServer } from "../fixtures/http-pi-harness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PI = join(ROOT, "node_modules", ".bin", "pi");
const OUTBOUND_GUARD = join(ROOT, "scripts", "test-outbound-guard.cjs");

/** Configured cache threshold; every fuzzy expectation is calculated against this value. */
const THRESHOLD = 0.85;
const TTL_HOURS = 720;
/** Models registered in the fixture but never placed in a routed tier: forbidden decoys. */
const DECOY_MODELS = ["alt", "decoy"];
/** Second routed tier, used by the late-eligibility scenario. */
const ALTERNATE_MODEL = "quick";

let server;

function piEnvironment(home, extension) {
  const base = Object.fromEntries(["PATH", "TMPDIR", "LANG", "TERM"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  return {
    ...base,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    NODE_OPTIONS: `--require=${OUTBOUND_GUARD}`,
    BIFROST_TEST_ALLOWED_ORIGIN: `http://127.0.0.1:${server.port}`,
    BIFROST_TEST_NETWORK_VIOLATIONS: join(home, "network-violations.log"),
    BIFROST_TEST_EXTENSION_PATH: extension,
  };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ── fake provider ───────────────────────────────────────────────
// Sole owner: tests/fixtures/http-pi-harness.mjs. Ownership is cancellation-
// safe because the provider stays in this worker's process group.

async function stats() {
  const response = await fetch(`http://127.0.0.1:${server.port}/_stats`);
  assert.equal(response.ok, true);
  return response.json();
}

/** Exact per-model provider attempt delta between two /_stats snapshots. */
function delta(before, after, model) {
  return (after.attempts[model] ?? 0) - (before.attempts[model] ?? 0);
}

/** Every routed fixture model plus every registered decoy. */
const OBSERVED_MODELS = ["chat", "classifier", ALTERNATE_MODEL, ...DECOY_MODELS];

function assertExactRequestDelta(before, after, expected, label) {
  const actual = Object.fromEntries(OBSERVED_MODELS.map((model) => [model, delta(before, after, model)]));
  assert.deepEqual(actual, expected, `${label}: exact provider request identity/count`);
}

// ── fixture ─────────────────────────────────────────────────────

function fixture({ cacheEnabled = true, cacheThreshold = THRESHOLD, extension = join(ROOT, "index.ts") } = {}) {
  const home = mkdtempSync(join(tmpdir(), "bifrost-cache-lifecycle-home-"));
  const work = mkdtempSync(join(tmpdir(), "bifrost-cache-lifecycle-work-"));
  const agent = join(home, ".pi", "agent");
  const project = join(work, ".pi");
  mkdirSync(agent, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(home, "network-violations.log"), "");
  writeFileSync(join(agent, "models.json"), JSON.stringify({
    providers: {
      fake: {
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          { id: "chat", reasoning: false, contextWindow: 8192, maxTokens: 512 },
          { id: "classifier", reasoning: false, contextWindow: 8192, maxTokens: 512 },
          { id: ALTERNATE_MODEL, reasoning: false, contextWindow: 8192, maxTokens: 512 },
          ...DECOY_MODELS.map((id) => ({ id, reasoning: false, contextWindow: 8192, maxTokens: 512 })),
        ],
      },
    },
  }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enabledModels: ["fake/*"] }));
  writeConfig(project, { cacheEnabled, cacheThreshold });
  return { home, work, project, extension, agent };
}

function env_config(project, { cacheEnabled, cacheThreshold }) {
  return {
    path: join(project, "bifrost.json"),
    value: {
      enabled: true,
      default: "general",
      classifier: { enabled: true, backend: "prompt", model: "fake/classifier" },
      models: { general: ["fake/chat"], quick: [`fake/${ALTERNATE_MODEL}`] },
      cache: { enabled: cacheEnabled, maxEntries: 50, ...(cacheThreshold === null ? {} : { threshold: cacheThreshold }), ttlHours: TTL_HOURS },
    },
  };
}

function writeConfig(project, { cacheEnabled, cacheThreshold }) {
  const { path, value } = env_config(project, { cacheEnabled, cacheThreshold });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readConfig(project) {
  return JSON.parse(readFileSync(join(project, "bifrost.json"), "utf8"));
}

function writeConfigObject(project, config) {
  writeFileSync(join(project, "bifrost.json"), JSON.stringify(config, null, 2));
}

// ── owned RPC session ───────────────────────────────────────────

function startRpc({ home, work, extension }) {
  const child = spawn(PI, ["-e", extension, "--mode", "rpc", "--no-session", "--no-tools", "--model", "fake/chat"], {
    cwd: work,
    stdio: ["pipe", "pipe", "pipe"],
    env: piEnvironment(home, extension),
    detached: true,
  });
  const records = [];
  let incompleteLine = "";
  let stderr = "";
  let wake;
  let closePromise;
  let closeInfo;
  let spawnError;
  const childClosed = new Promise((resolve) => child.once("close", (code, signal) => {
    closeInfo = { code, signal };
    wake?.();
    resolve(closeInfo);
  }));
  child.once("error", (error) => { spawnError = error; wake?.(); });
  child.stdin.on("error", (error) => { spawnError ??= error; wake?.(); });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = `${incompleteLine}${chunk}`.split("\n");
    incompleteLine = lines.pop();
    for (const line of lines) {
      try { records.push(JSON.parse(line)); }
      catch { /* malformed output stays a protocol assertion failure */ }
    }
    wake?.();
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; wake?.(); });

  function waitForActivity(deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    return new Promise((resolve) => {
      let timer;
      const finish = () => {
        clearTimeout(timer);
        if (wake === finish) wake = undefined;
        resolve();
      };
      wake = finish;
      timer = setTimeout(finish, remaining);
    });
  }

  async function prompt(message, timeoutMs = 60_000) {
    const id = `cache-${records.length}-${Date.now()}`;
    // Turn start index is recorded before the prompt is written so an
    // already-buffered settlement for this turn can never be missed.
    const startIndex = records.length;
    const stderrStart = stderr.length;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    let index = startIndex;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "extension_ui_request" && record.method === "confirm") {
          child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, confirmed: true })}\n`);
        } else if (record.id === id && record.type === "response") {
          assert.equal(record.success, true, JSON.stringify(record));
          return { response: record, stderr: stderr.slice(stderrStart), startIndex };
        }
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before responding: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC timed out on ${message}`);
  }

  async function userTurn(message) {
    const accepted = await prompt(message);
    if (accepted.response.data?.disposition !== "started") return accepted;
    const deadline = Date.now() + 60_000;
    let index = accepted.startIndex;
    while (Date.now() < deadline) {
      while (index < records.length) {
        const record = records[index++];
        if (record.type === "agent_settled") return accepted;
      }
      assert.ifError(spawnError);
      if (closeInfo) throw new Error(`Pi RPC exited before settling: ${message}`);
      await waitForActivity(deadline);
    }
    throw new Error(`Pi RPC turn did not settle: ${message}`);
  }

  function close(home) {
    closePromise ??= (async () => {
      try { child.stdin.end(); } catch {}
      await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (!closeInfo) {
        const terminated = await terminateProcessGroup(child, { graceMs: 1_000, cleanupTimeoutMs: 2_000 });
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
        // On a denied-signaling path the child's pipes may still be open; destroy
        // and unref them so the test worker can exit, while keeping the cleanup
        // failure observable for releaseScratch.
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        try { child.unref(); } catch {}
        if (!terminated) return { closed: Boolean(closeInfo), groupGone: !processGroupExists(child.pid) };
      }
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.unref(); } catch {}
      return { closed: Boolean(closeInfo), groupGone: !processGroupExists(child.pid), code: closeInfo?.code, signal: closeInfo?.signal };
    })();
    return closePromise.then(async (result) => {
      // A missing violations log is a failure, not an empty pass: a blocked
      // request whose log write failed must not pass undetected.
      let violations;
      try { violations = readFileSync(join(home, "network-violations.log"), "utf8"); }
      catch (error) {
        if (error.code === "ENOENT") throw new Error("network-violations log is missing");
        throw error;
      }
      // Captured stderr indicating a blocked request is also a failure.
      if (/blocked|network.?violation|violation/i.test(stderr)) {
        throw new Error(`blocked request observed in captured stderr: ${stderr.trim()}`);
      }
      return { ...result, violations };
    });
  }

  return { prompt, userTurn, close };
}

/**
 * Owns scratch removal. Every owned session is closed first; scratch is removed
 * only when every session produced an observed close AND confirmed group
 * absence. Any failure keeps scratch on disk and is reported to the caller.
 */
async function releaseScratch(env, sessions) {
  const failures = [];
  const receipts = [];
  for (const session of sessions) {
    if (!session) continue;
    let receipt;
    try {
      receipt = await session.close(env.home);
    } catch (error) {
      failures.push(error);
      continue;
    }
    receipts.push(receipt);
    if (!receipt.closed) failures.push(new Error("owned RPC session did not close"));
    if (!receipt.groupGone) failures.push(new Error("owned RPC process group still present"));
    if (receipt.violations !== "") failures.push(new Error(`network violations observed: ${receipt.violations}`));
  }
  if (failures.length > 0) {
    return { removed: false, failures, receipts, retained: [env.home, env.work] };
  }
  rmSync(env.home, { recursive: true, force: true });
  rmSync(env.work, { recursive: true, force: true });
  return { removed: !existsSync(env.home) && !existsSync(env.work), failures, receipts, retained: [] };
}

/** Runs one scenario body with owned scratch; body failures never hide cleanup failures. */
async function scenario(run) {
  const env = fixture(run.fixtureOptions ?? {});
  const sessions = [];
  let bodyError;
  try {
    await run.body({ env, sessions });
  } catch (error) {
    bodyError = error;
  }
  const released = await releaseScratch(env, sessions);
  if (!released.removed || released.failures.length > 0) {
    const cleanup = new Error(`cache lifecycle scratch retained at ${released.retained.join(", ")}: ${released.failures.map((f) => f.message).join("; ")}`);
    if (bodyError) {
      cleanup.cause = bodyError;
      throw cleanup;
    }
    throw cleanup;
  }
  if (bodyError) throw bodyError;
  return released;
}

// ── cache file helpers ──────────────────────────────────────────

function cacheFile(project) {
  return join(project, "bifrost-cache.jsonl");
}

function readCacheEntries(project) {
  if (!existsSync(cacheFile(project))) return [];
  return readFileSync(cacheFile(project), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .join(" ");
}

function tokenSet(text) {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

/** Independently calculated Jaccard score for the fuzzy-hit scenario. */
function jaccard(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

const SEED_PROMPT = "CANARY_Alpha please implement a simple feature for the routing cache today";
const FUZZY_PROMPT = "CANARY_Alpha please implement a simple feature for the routing cache today with tests";
const FUZZY_SCORE = jaccard(SEED_PROMPT, FUZZY_PROMPT);
const MISS_PROMPT = "CANARY_Alpha unrelated wording that shares no tokens with the seed request";

// ── scenarios ───────────────────────────────────────────────────

describe("cache lifecycle acceptance", { timeout: 600_000, concurrency: 1 }, () => {
  before(async () => { server = await startFakeProviderServer(); });
  after(async () => { await server?.stop(); });

  it("exact cache hit avoids the classifier and decoy models", async () => {
    await scenario({
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(rpc);
        const first = await stats();
        await rpc.userTurn(SEED_PROMPT);
        const afterFirst = await stats();
        assertExactRequestDelta(first, afterFirst, { chat: 1, classifier: 1, quick: 0, alt: 0, decoy: 0 }, "first turn classifies once");

        await rpc.userTurn(SEED_PROMPT);
        const afterSecond = await stats();
        assertExactRequestDelta(afterFirst, afterSecond, { chat: 1, classifier: 0, quick: 0, alt: 0, decoy: 0 }, "exact hit avoids classifier");
      },
    });
  });

  it("default cache misses prompts with reordered tokens", async () => {
    await scenario({
      fixtureOptions: { cacheThreshold: null },
      body: async ({ env, sessions }) => {
        const seeded = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(seeded);
        await seeded.userTurn(SEED_PROMPT);
        const entries = readCacheEntries(env.project);
        assert.equal(entries.length, 1, "seed turn should persist one classifier decision");
        entries[0].category = "quick";
        writeFileSync(cacheFile(env.project), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
        const closed = await seeded.close(env.home);
        assert.equal(closed.closed, true);
        assert.equal(closed.groupGone, true);
        assert.equal(closed.violations, "");

        const rpc = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(rpc);
        const before = await stats();
        await rpc.userTurn("today cache routing the for feature simple a implement please Alpha CANARY");
        const after = await stats();
        assertExactRequestDelta(before, after, { chat: 1, classifier: 1, quick: 0, alt: 0, decoy: 0 }, "default exact cache must not reuse reordered prompt");
      },
    });
  });

  it("skips persisted cache decisions when classifier is disabled", async () => {
    await scenario({
      body: async ({ env, sessions }) => {
        const seeded = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(seeded);
        await seeded.userTurn(SEED_PROMPT);
        const entries = readCacheEntries(env.project);
        assert.equal(entries.length, 1, "enabled classifier should persist one decision");
        // Force a different valid tier so a stale cache hit is observable.
        entries[0].category = "quick";
        writeFileSync(cacheFile(env.project), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
        const closed = await seeded.close(env.home);
        assert.equal(closed.closed, true);
        assert.equal(closed.groupGone, true);
        assert.equal(closed.violations, "");

        const config = readConfig(env.project);
        config.classifier.enabled = false;
        writeConfigObject(env.project, config);
        const disabled = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(disabled);
        const before = await stats();
        await disabled.userTurn(SEED_PROMPT);
        const after = await stats();
        assertExactRequestDelta(before, after, { chat: 1, classifier: 0, quick: 0, alt: 0, decoy: 0 }, "disabled classifier ignores the persisted decision");
      },
    });
  });

  it("fuzzy cache hit avoids the classifier and an unrelated prompt still misses", async () => {
    assert.ok(FUZZY_SCORE >= THRESHOLD, `fuzzy fixture must be a real hit, score ${FUZZY_SCORE} < ${THRESHOLD}`);
    assert.notEqual(normalize(SEED_PROMPT), normalize(FUZZY_PROMPT), "fuzzy prompt must not normalize identically");
    await scenario({
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(rpc);
        const first = await stats();
        await rpc.userTurn(SEED_PROMPT);
        const afterFirst = await stats();
        assertExactRequestDelta(first, afterFirst, { chat: 1, classifier: 1, quick: 0, alt: 0, decoy: 0 }, "seed turn classifies once");

        await rpc.userTurn(FUZZY_PROMPT);
        const afterFuzzy = await stats();
        assertExactRequestDelta(afterFirst, afterFuzzy, { chat: 1, classifier: 0, quick: 0, alt: 0, decoy: 0 }, `fuzzy hit (jaccard ${FUZZY_SCORE})`);

        await rpc.userTurn(MISS_PROMPT);
        const afterMiss = await stats();
        assertExactRequestDelta(afterFuzzy, afterMiss, { chat: 1, classifier: 1, quick: 0, alt: 0, decoy: 0 }, "unrelated prompt is a miss control");
      },
    });
  });

  it("restart preserves the cache hit with empty network violations", async () => {
    await scenario({
      body: async ({ env, sessions }) => {
        const first = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(first);
        await first.userTurn(SEED_PROMPT);
        const closed = await first.close(env.home);
        assert.equal(closed.closed, true);
        assert.equal(closed.groupGone, true);
        assert.equal(closed.violations, "", "seed session must record no network violations");

        const before = await stats();
        const restarted = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(restarted);
        await restarted.userTurn(SEED_PROMPT);
        const after = await stats();
        assertExactRequestDelta(before, after, { chat: 1, classifier: 0, quick: 0, alt: 0, decoy: 0 }, "restart preserves hit");
        const restartReceipt = await restarted.close(env.home);
        assert.equal(restartReceipt.violations, "", "restarted session must record no network violations");
      },
    });
  });

  it("TTL expiry invalidates the entry using a persisted out-of-window timestamp", async () => {
    await scenario({
      body: async ({ env, sessions }) => {
        const seed = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(seed);
        await seed.userTurn(SEED_PROMPT);
        const seedReceipt = await seed.close(env.home);
        assert.equal(seedReceipt.violations, "", "seed session must record no network violations");

        // Deterministic TTL control: age the persisted entry past the configured window.
        const entries = readCacheEntries(env.project);
        assert.equal(entries.length, 1);
        entries[0].lastUsed = Date.now() - (TTL_HOURS + 1) * 60 * 60 * 1000;
        writeFileSync(cacheFile(env.project), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

        const before = await stats();
        const rpc = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(rpc);
        await rpc.userTurn(SEED_PROMPT);
        const after = await stats();
        assertExactRequestDelta(before, after, { chat: 1, classifier: 1, quick: 0, alt: 0, decoy: 0 }, "expired entry reclassifies");
        const receipt = await rpc.close(env.home);
        assert.equal(receipt.violations, "", "expiry session must record no network violations");
      },
    });
  });

  it("a cache hit with no eligible candidate recomputes selection instead of dispatching the cached model", async () => {
    await scenario({
      body: async ({ env, sessions }) => {
        const seed = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(seed);
        await seed.userTurn(SEED_PROMPT);
        const seedReceipt = await seed.close(env.home);
        assert.equal(seedReceipt.violations, "", "seed session must record no network violations");

        // The cached tier "general" keeps its name but loses every candidate, so
        // late eligibility must be recomputed rather than honouring the stale
        // cached physical identity.
        const config = readConfig(env.project);
        config.models = { general: [], quick: [`fake/${ALTERNATE_MODEL}`] };
        config.default = "quick";
        writeConfigObject(env.project, config);

        const before = await stats();
        const rpc = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(rpc);
        await rpc.userTurn(SEED_PROMPT);
        const after = await stats();
        // The cached tier still short-circuits the classifier, but the stale
        // cached model is never generated on and selection lands on the only
        // eligible pool.
        assertExactRequestDelta(before, after, { chat: 0, classifier: 0, quick: 1, alt: 0, decoy: 0 }, "stale cached identity is not dispatched");
        const receipt = await rpc.close(env.home);
        assert.equal(receipt.violations, "", "late-eligibility session must record no network violations");
      },
    });
  });

  it("cache disabled skips lookup and write without deleting prior entries", async () => {
    await scenario({
      body: async ({ env, sessions }) => {
        const seed = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(seed);
        await seed.userTurn(SEED_PROMPT);
        const seedReceipt = await seed.close(env.home);
        assert.equal(seedReceipt.violations, "", "seed session must record no network violations");

        const beforeBytes = readFileSync(cacheFile(env.project));
        const config = readConfig(env.project);
        config.cache.enabled = false;
        writeConfigObject(env.project, config);

        const before = await stats();
        const rpc = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(rpc);
        await rpc.userTurn(SEED_PROMPT);
        const after = await stats();
        assertExactRequestDelta(before, after, { chat: 1, classifier: 1, quick: 0, alt: 0, decoy: 0 }, "disabled cache reclassifies");
        const receipt = await rpc.close(env.home);
        assert.equal(receipt.violations, "", "disabled-cache session must record no network violations");

        assert.deepEqual(readFileSync(cacheFile(env.project)), beforeBytes, "disabled cache must not delete or rewrite prior entries");
      },
    });
  });

  it("persists normalized prompt words and no response content", async () => {
    await scenario({
      body: async ({ env, sessions }) => {
        const rpc = startRpc({ home: env.home, work: env.work, extension: env.extension });
        sessions.push(rpc);
        await rpc.userTurn(SEED_PROMPT);
        const receipt = await rpc.close(env.home);
        assert.equal(receipt.violations, "", "privacy session must record no network violations");

        const raw = readFileSync(cacheFile(env.project), "utf8");
        const entries = readCacheEntries(env.project);
        assert.equal(entries.length, 1);
        const entry = entries[0];
        assert.equal(entry.category, "general");
        assert.equal(entry.normalized, normalize(SEED_PROMPT));
        assert.deepEqual(
          Object.keys(entry).sort(),
          ["category", "hits", "lastUsed", "normalized", "semanticKey", "seq"],
          "persisted entry must hold only cache contract fields",
        );
        // Normalized prompt words only: no original casing, punctuation, or model output.
        assert.doesNotMatch(raw, /CANARY_Alpha/u, "cache must not persist original prompt casing");
        assert.doesNotMatch(raw, /"response"|"content"|"messages"/u, "cache must not persist response payloads");
        assert.doesNotMatch(raw, /gate released|"ok"/u, "cache must not persist provider output");
        assert.equal(Number.isFinite(entry.lastUsed), true);
        assert.equal(entry.hits >= 1, true);
      },
    });
  });

  it("a changed classifier criterion (semantic key) invalidates the cached decision", async () => {
    assert.equal(await semanticInvalidationScenario(join(ROOT, "index.ts")), true, "semantic-key change must reclassify");
  });

  it("fault control: removing the semantic-key guard turns the named invalidation assertion RED", async () => {
    const sourcePath = join(ROOT, "cache.ts");
    const original = readFileSync(sourcePath, "utf8");
    const originalHash = sha256(original);
    const guard = "entry.lastUsed >= cutoff && (semanticKey === undefined || entry.semanticKey === semanticKey)";
    assert.ok(original.includes(guard), "semantic-key guard must exist before mutation");
    const mutated = original.replace(guard, "entry.lastUsed >= cutoff");
    assert.notEqual(mutated, original, "semantic-key guard mutation must apply");
    assert.notEqual(sha256(mutated), originalHash, "mutation must be a real source change");

    const copy = mkdtempSync(join(tmpdir(), "bifrost-cache-lifecycle-fault-"));
    try {
      for (const file of readdirSync(ROOT)) {
        if (file.endsWith(".ts") || file === "schema.json" || file === "package.json") copyFileSync(join(ROOT, file), join(copy, file));
      }
      symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
      writeFileSync(join(copy, "cache.ts"), mutated);

      // RED: the mutated private copy must fail the named assertion, not merely
      // start up or time out.
      const redError = await semanticInvalidationScenario(join(copy, "index.ts")).then(
        () => undefined,
        (error) => error,
      );
      assert.ok(redError, "mutated source must fail the semantic-key invalidation assertion");
      assert.match(String(redError.message), /semantic-key change reclassifies/u, "mutation must fail the named assertion");
      assert.equal(redError.name, "AssertionError", "mutation must fail by assertion, not by startup or runtime error");
      assert.equal(sha256(readFileSync(join(copy, "cache.ts"), "utf8")), sha256(mutated), "mutated copy must stay mutated");

      // GREEN: the untouched production source is still green and unchanged.
      const restored = await semanticInvalidationScenario(join(ROOT, "index.ts")).then(
        (value) => value,
        (error) => error,
      );
      assert.equal(restored, true, `restored source must reclassify after a semantic-key change: ${restored}`);
      assert.equal(sha256(readFileSync(sourcePath, "utf8")), originalHash, "production source must be unchanged");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

/**
 * Shared body for the semantic-key case and its fault control: seed the cache,
 * change the classifier criteria (which changes the semantic key), then assert
 * that the next turn reclassified instead of reusing the stale decision.
 *
 * The named assertion lives here so the fault control observes exactly the
 * assertion a real regression would break.
 */
async function semanticInvalidationScenario(extension) {
  await scenario({
    fixtureOptions: { extension },
    body: async ({ env, sessions }) => {
      const seed = startRpc({ home: env.home, work: env.work, extension });
      sessions.push(seed);
      await seed.userTurn(SEED_PROMPT);
      const seedReceipt = await seed.close(env.home);
      assert.equal(seedReceipt.violations, "", "semantic-key seed session must record no network violations");

      const config = readConfig(env.project);
      config.classifier.criteria = { general: "changed criteria for the semantic key" };
      writeConfigObject(env.project, config);

      const before = await stats();
      const rpc = startRpc({ home: env.home, work: env.work, extension });
      sessions.push(rpc);
      await rpc.userTurn(SEED_PROMPT);
      const after = await stats();
      assertExactRequestDelta(before, after, { chat: 1, classifier: 1, quick: 0, alt: 0, decoy: 0 }, "semantic-key change reclassifies");
      const receipt = await rpc.close(env.home);
      assert.equal(receipt.violations, "", "semantic-key session must record no network violations");
    },
  });
  return true;
}