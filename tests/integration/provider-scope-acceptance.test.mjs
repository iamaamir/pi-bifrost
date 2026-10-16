// ── Provider routing scope acceptance ────────────────────────────
// Drives a real Pi AgentSession through the real Bifrost extension with two
// faux providers and a hard `routingScope`. Proves that a real Auto dispatch
// selects only the permitted provider and the excluded provider is never
// called, in both directions, and that an empty allowlist denies every
// provider. The child runs behind the outbound fence, so the excluded
// provider cannot be reached over the network either.

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

const CHILD = join(REPO_ROOT, "tests", "fixtures", "provider-scope-faux-child.mjs");

describe("provider routing scope dispatch", () => {
  let scratch;
  let violations;
  let env;
  let server;
  let restoreCredentials;

  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), "bifrost-provider-scope-"));
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

  for (const [permitted, excluded, order] of [
    ["fake", "scoped", ["scoped/chat", "fake/chat"]],
    ["scoped", "fake", ["fake/chat", "scoped/chat"]],
  ]) {
    it(`dispatches only to ${permitted} and never reaches ${excluded}`, async () => {
      writeFileSync(violations, "");
      await runFauxFixtureChild({
        child: CHILD,
        env: {
          ...env,
          BIFROST_FAUX_SCRATCH: scratch,
          BIFROST_SCOPE_PERMITTED: permitted,
          BIFROST_SCOPE_EXCLUDED: excluded,
          BIFROST_SCOPE_ORDER: JSON.stringify(order),
        },
      });
      assertNoViolations(violations, `${permitted} scope run made a blocked outbound attempt`);
    });
  }

  it("denies every provider when the allowlist is empty", async () => {
    writeFileSync(violations, "");
    await runFauxFixtureChild({
      child: CHILD,
      env: {
        ...env,
        BIFROST_FAUX_SCRATCH: scratch,
        BIFROST_SCOPE_PERMITTED: "fake",
        BIFROST_SCOPE_EXCLUDED: "scoped",
        BIFROST_SCOPE_ORDER: JSON.stringify(["fake/chat", "scoped/chat"]),
        BIFROST_SCOPE_DENY_ALL: "1",
      },
    });
    assertNoViolations(violations, "deny-all scope run made a blocked outbound attempt");
  });
});
