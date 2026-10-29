import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import {
  REPO_ROOT,
  assertNoViolations,
  assertOutboundFence,
  fixtureChildEnv,
  isolateAmbientCredentials,
  runFauxFixtureChild,
} from "../fixtures/faux-harness.mjs";

const CHILD = join(REPO_ROOT, "tests", "fixtures", "native-faux-provider-child.mjs");

it("routes real AgentSession behind tested HTTP, HTTPS, TCP, and UDP outbound fence", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bifrost-native-faux-"));
  const violations = join(scratch, "network-violations.log");
  const restoreCredentials = isolateAmbientCredentials();
  const server = createServer((_request, response) => response.end("allowed loopback fixture"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const env = fixtureChildEnv({
      scratch,
      violations,
      allowedOrigin: `http://127.0.0.1:${port}`,
    });
    writeFileSync(violations, "");
    await assertOutboundFence({
      env,
      violations,
      allowedUrl: `http://127.0.0.1:${port}`,
      blockedPort: port + 1,
      expectAllowedText: "allowed loopback fixture",
    });

    for (const testCase of [
      // pi-subagents 0.77.0 producer marker: child host must preserve Pi's
      // explicitly selected physical model, even without a run id.
      { expectedModel: "physical-fast", child: "1" },
      // Ordinary parent sessions, including empty marker values, still route.
      { expectedModel: "physical-capable" },
      { expectedModel: "physical-capable", child: "" },
    ]) {
      writeFileSync(violations, "");
      const childEnv = {
        ...env,
        BIFROST_NATIVE_FAUX_SCRATCH: scratch,
        BIFROST_EXPECTED_MODEL: testCase.expectedModel,
      };
      delete childEnv.PI_SUBAGENT_RUN_ID;
      if (testCase.child === undefined) delete childEnv.PI_SUBAGENT_CHILD;
      else childEnv.PI_SUBAGENT_CHILD = testCase.child;
      await runFauxFixtureChild({ child: CHILD, env: childEnv });
      assertNoViolations(violations, "faux AgentSession made a blocked outbound attempt");
    }
  } finally {
    restoreCredentials();
    await new Promise((resolve) => server.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  }
});
