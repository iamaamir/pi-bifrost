// ── Pre-dispatch sign-in eligibility acceptance ──────────────────
// Drives a real Pi AgentSession through the real Bifrost extension with two faux
// providers, one registered without a credential. Proves that an opted-in Auto
// turn dispatches the provider whose sign-in resolves and never calls the
// unauthenticated one, and that the same scenario without the opt-in attempts
// the dead provider — so the exclusion is attributable to the configuration.
// The child runs behind the outbound fence.

import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  REPO_ROOT,
  assertNoViolations,
  assertOutboundFence,
  fixtureChildEnv,
  isolateAmbientCredentials,
  runFauxFixtureChild,
} from "../fixtures/faux-harness.mjs";

const CHILD = join(REPO_ROOT, "tests", "fixtures", "sign-in-faux-child.mjs");

describe("pre-dispatch sign-in eligibility dispatch", () => {
  let scratch;
  let violations;
  let env;
  let server;
  let restoreCredentials;

  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), "bifrost-sign-in-acceptance-"));
    violations = join(scratch, "network-violations.log");
    restoreCredentials = isolateAmbientCredentials();
    server = createServer((_request, response) => response.end("allowed loopback fixture"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    env = fixtureChildEnv({ scratch, violations, allowedOrigin: `http://127.0.0.1:${port}` });
    await assertOutboundFence({
      env,
      violations,
      allowedUrl: `http://127.0.0.1:${port}`,
      blockedPort: port + 1,
      expectAllowedText: "allowed loopback fixture",
    });
  });

  after(async () => {
    restoreCredentials();
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });

  for (const mode of ["exclude", "off"]) {
    it(mode === "exclude"
      ? "dispatches the resolvable provider and never calls the unauthenticated one"
      : "fault control: without the opt-in the unauthenticated provider is attempted", async () => {
      writeFileSync(violations, "");
      await runFauxFixtureChild({
        child: CHILD,
        env: {
          ...env,
          BIFROST_FAUX_SCRATCH: scratch,
          BIFROST_SIGN_IN_LIVE: "fake",
          // The unauthenticated provider heads the pool, so selection order alone
          // would pick it in the off control.
          BIFROST_SIGN_IN_DEAD: "unauth",
          BIFROST_SIGN_IN_ORDER: JSON.stringify(["unauth/chat", "fake/chat"]),
          BIFROST_SIGN_IN_MODE: mode,
        },
      });
      assertNoViolations(violations, `${mode} sign-in run made a blocked outbound attempt`);
    });
  }
});
