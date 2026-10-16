// ── Provider routing scope acceptance ────────────────────────────
// Drives a real Pi AgentSession through the real Bifrost extension with two
// faux providers and a hard `routingScope`. Proves that a real Auto dispatch
// selects only the permitted provider and the excluded provider is never
// called, in both directions. The child runs behind the outbound fence, so
// the excluded provider cannot be reached over the network either.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  REPO_ROOT,
  assertFenceBlocked,
  assertNoViolations,
  fenceProbeScript,
  fixtureChildEnv,
  isolateAmbientCredentials,
  runFauxFixtureChild,
  runNode,
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
    writeFileSync(violations, "");
    const probe = await runNode(["-e", fenceProbeScript({
      allowedUrl: `http://127.0.0.1:${port}`,
      blockedPort: port + 1,
      expectAllowedText: "allowed loopback fixture",
    })], { cwd: REPO_ROOT, env });
    assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
    assertFenceBlocked(violations, [
      /blocked fetch to https:\/\/127\.0\.0\.1:/,
      /blocked fetch to http:\/\/127\.0\.0\.1:/,
      /blocked socket connection to 127\.0\.0\.1:/,
      /blocked UDP datagram to 127\.0\.0\.1/,
    ]);
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
});
