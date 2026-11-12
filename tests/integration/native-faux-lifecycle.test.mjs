import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  CHILD_DEADLINE_MS,
  REPO_ROOT,
  assertFenceBlocked,
  assertNoViolations,
  fenceProbeScript,
  fixtureChildEnv,
  isolateAmbientCredentials,
  runOwnedNode,
} from "../fixtures/faux-harness.mjs";

const CHILD = join(REPO_ROOT, "tests", "fixtures", "native-faux-lifecycle-child.mjs");

// Bounded ownership stays with this parent. `runOwnedNode` returns a
// creation-time detached group id plus the observed close and independently
// observed group absence; scratch is reclaimed only when both hold for every
// owned child. A denied kill or an unverified close fails a named assertion and
// retains scratch instead of guessing.
it("routes real AgentSession turns by direct rules, tier override precedence, and default", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-lifecycle-"));
  const violations = join(scratch, "network-violations.log");
  const restoreCredentials = isolateAmbientCredentials();
  let cleanupVerified = true;
  async function runOwned(args, options) {
    try {
      const result = await runOwnedNode(args, options);
      if (result.groupGone !== true || result.closeObserved !== true) cleanupVerified = false;
      return result;
    } catch (error) {
      cleanupVerified = false;
      throw error;
    }
  }
  try {
    // Deny-all fence: no origin is allowed, so the positive probe must prove
    // every transport is rejected before any scenario runs.
    const env = fixtureChildEnv({
      scratch,
      violations,
      denyAll: true,
      extra: { BIFROST_NATIVE_LIFECYCLE_SCRATCH: scratch },
    });
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "TYPESAFE_API_KEY", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
      assert.equal(env[name], undefined, `${name} must not enter child env`);
    }

    writeFileSync(violations, "");
    const probe = await runOwned(["-e", fenceProbeScript({ blockedPort: 2 })], { cwd: REPO_ROOT, env });
    assert.equal(probe.deadlineExceeded, false, `guard probe must finish inside its bounded deadline\n${probe.stdout}\n${probe.stderr}`);
    if (process.platform !== "win32") assert.equal(probe.groupGone, true, "guard probe process group must be gone before scratch deletion");
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assertFenceBlocked(violations, [
      /blocked fetch to https?:\/\/[^:\s]+:\d/,
      /blocked socket connection to [^\s]+:\d/,
      /blocked UDP datagram to/,
    ]);

    for (const scenario of [
      // Baseline: direct rules, inline tier precedence, and the default tier on a physical seed.
      { name: "physical-default", env: {} },
      // Unmarked host explicitly selects Auto: expected physical routed target and inline handoff.
      { name: "auto-unmarked", env: {} },
      // Marked child host with an explicit physical model: never rerouted.
      { name: "child-physical", env: { PI_SUBAGENT_CHILD: "1" } },
      // Same marked child host with an explicit Auto selection: ordinary routing plus inline handoff.
      { name: "child-auto", env: { PI_SUBAGENT_CHILD: "1" } },
    ]) {
      const runScratch = join(scratch, scenario.name);
      mkdirSync(runScratch, { recursive: true });
      writeFileSync(violations, "");
      const result = await runOwned(["--test", "--experimental-strip-types", CHILD], {
        cwd: REPO_ROOT,
        env: { ...env, BIFROST_NATIVE_LIFECYCLE_SCRATCH: runScratch, BIFROST_NATIVE_LIFECYCLE_SCENARIO: scenario.name, ...scenario.env },
        timeoutMs: CHILD_DEADLINE_MS,
      });
      assert.equal(result.deadlineExceeded, false, `${scenario.name} must complete inside its bounded deadline\n${result.stdout}\n${result.stderr}`);
      if (process.platform !== "win32") assert.equal(result.groupGone, true, `${scenario.name} owned process group must be gone before scratch deletion`);
      assert.equal(result.status, 0, `${scenario.name}\n${result.stdout}\n${result.stderr}`);
      assertNoViolations(violations, `${scenario.name} AgentSession made a blocked outbound attempt`);
    }
  } finally {
    restoreCredentials();
    if (cleanupVerified) {
      rmSync(scratch, { recursive: true, force: true });
    } else {
      process.stderr.write(`[native-lifecycle] retaining scratch without verified owned-group death: ${scratch}\n`);
    }
  }
});
