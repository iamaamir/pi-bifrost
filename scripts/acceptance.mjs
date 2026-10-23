#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gateDirectory, git, gitTruth, installedToolVersions, matchNamedTestEvent, parseArgs, processGroupExists, sourceFingerprint, summarizeCases, terminateProcessGroup, verificationGateEnvironment } from "./acceptance/core.mjs";
import { exportCiReportIfConfigured } from "./ci-report.mjs";
import { changeEvidenceCase } from "./acceptance/change-evidence.mjs";
export { processGroupExists, terminateProcessGroup, verificationGateEnvironment };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_FILES = {
  contract: "./acceptance/profiles/contract.mjs",
  live: "./acceptance/profiles/live.mjs",
};
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_REPORTER_LINE_BYTES = 1024 * 1024;
const MAX_REPORTER_EVENTS = 20_000;
const MAX_REPORTER_EVENT_BYTES = 16 * 1024 * 1024;
const NODE_TEST_GATES = new Map([
  ["test", { paths: ["tests/*.test.ts", "tests/*.test.mjs"] }],
  ["test:integration", { paths: ["tests/integration/*.test.mjs"] }],
  // The bounded caller executes the current declaration's exact witnesses,
  // plus the fixed push-base controls, instead of a prior PR's test inventory.
  ["test:manifest-evidence", {
    paths: ["tests/change-evidence.test.mjs"],
    pattern: [
      "multi-commit push validates full event.before diff and rejects intermediate base",
      "event-driven push and pull request bases fail closed despite competing env",
      "a real stale ancestor base fails declaration equality with named detail",
      "fault control: selecting HEAD parent instead of event.before turns push base RED",
    ].join("|"),
  }],
]);
let activeChild;
let activeTermination;
let receivedSignal;
const SUPPORTING_TESTS = [
  { id: "support:manifest:single-commit", requirement: "R16", file: "tests/acceptance-runner.test.mjs", name: "single-commit checkout runs the actual workflow caller without inventing an intermediate", boundary: "owned one-commit fixture; real submitted CLI and context/declaration/predecessor faults, no contributor-history precondition" },
  { id: "support:manifest:actual-caller", requirement: "R16", file: "tests/acceptance-runner.test.mjs", name: "merged-push checkout runs the actual workflow caller with event.before", boundary: "actual submitted declaration witnesses through sanitized unit gate and real CLI; private context/declaration-selection/predecessor faults" },
  { id: "support:controller:final-authorization", requirement: "R16", file: "tests/merge-controller.test.mjs", name: "source fault controls exercise server protection, final authorization, and saved intent", boundary: "actual fake-gh CLI; private source faults hit each named assertion and exact restoration passes" },
  {"id": "support:g07:campaign", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "matches the independent model with the campaign default seed", "boundary": "single-scope/no-observation independent model; campaign FC_SEED varies this sample, pinned replays retained"},
  {"id": "support:g02:01", "requirement": "R06", "file": "tests/integration/activation-cancellation-acceptance.test.mjs", "name": "handles false and throwing physical activation without late dispatch", "boundary": "registered handler with fake pi/ctx; physical activation failure and cancellation"},
  {"id": "support:g02:02", "requirement": "R06", "file": "tests/integration/activation-cancellation-acceptance.test.mjs", "name": "stops an aborted registry wait and preserves a newer editor draft", "boundary": "registered handler with fake pi/ctx; physical activation failure and cancellation"},
  {"id": "support:g02:03", "requirement": "R06", "file": "tests/integration/activation-cancellation-acceptance.test.mjs", "name": "does not dispatch after a late classifier result", "boundary": "registered handler with fake pi/ctx; physical activation failure and cancellation"},
  {"id": "support:g02:04", "requirement": "R06", "file": "tests/integration/activation-cancellation-acceptance.test.mjs", "name": "lets a manual pin win over an in-flight registry refresh", "boundary": "registered handler with fake pi/ctx; physical activation failure and cancellation"},
  {"id": "support:g02:05", "requirement": "R06", "file": "tests/integration/activation-cancellation-acceptance.test.mjs", "name": "fault control: removing the late-abort guard allows forbidden late dispatch", "boundary": "registered handler with fake pi/ctx; physical activation failure and cancellation"},
  {"id": "support:g02-native:01", "requirement": "R06", "file": "tests/integration/native-activation-cancel.test.mjs", "name": "cancels real AgentSession activation behind a proven deny-all fence", "boundary": "real pinned AgentSession streaming-steer cancellation and manual override; mutant proves selected-model flip, not provider dispatch"},
  {"id": "support:g04:01", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "exact cache hit avoids the classifier and decoy models", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:02", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "fuzzy cache hit avoids the classifier and an unrelated prompt still misses", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:03", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "restart preserves the cache hit with empty network violations", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:04", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "TTL expiry invalidates the entry using a persisted out-of-window timestamp", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:05", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "a cache hit with no eligible candidate recomputes selection instead of dispatching the cached model", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:06", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "cache disabled skips lookup and write without deleting prior entries", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:07", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "persists normalized prompt words and no response content", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:08", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "a changed classifier criterion (semantic key) invalidates the cached decision", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g04:09", "requirement": "R12", "file": "tests/integration/cache-lifecycle-acceptance.test.mjs", "name": "fault control: removing the semantic-key guard turns the named invalidation assertion RED", "boundary": "real Pi with local fake providers; cache requests, persistence and semantic-key fault"},
  {"id": "support:g03-lifecycle:01", "requirement": "R16", "file": "tests/integration/replay-fault-lifecycle.test.mjs", "name": "accepts exactly one GREEN pass and rejects a reporter pass count of 10", "boundary": "owned test-process lifecycle controls; not product generation"},
  {"id": "support:g03-lifecycle:02", "requirement": "R16", "file": "tests/integration/replay-fault-lifecycle.test.mjs", "name": "terminates a hung owned run, verifies group absence, and refuses a timeout as RED evidence", "boundary": "owned test-process lifecycle controls; not product generation"},
  {"id": "support:g03-lifecycle:03", "requirement": "R16", "file": "tests/integration/replay-fault-lifecycle.test.mjs", "name": "retains the proof scratch and preserves the pending failure when owned-group signals are denied", "boundary": "owned test-process lifecycle controls; not product generation"},
  {"id": "support:g03-lifecycle:04", "requirement": "R16", "file": "tests/integration/replay-fault-lifecycle.test.mjs", "name": "retains scratch when an injected runner throws after spawning, then reclaims after verified death", "boundary": "owned test-process lifecycle controls; not product generation"},
  {"id": "support:g03-lifecycle:05", "requirement": "R16", "file": "tests/integration/replay-fault-lifecycle.test.mjs", "name": "preserves a real assertion failure and reclaims scratch once the owned group is verified dead", "boundary": "owned test-process lifecycle controls; not product generation"},
  {"id": "support:g07:01", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "matches the independent model across generated operation sequences", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:02", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "matches the independent model across a wider generated sample", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:03", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "releases an expired receipt lease when pruning during unrelated admission", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:04", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "keeps durable history after an invalid owner operation", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:05", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "shrinks and replays a faulty model control to a minimal sequence", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:06", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "predicts exact half-open lease expiry boundaries", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:07", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "continues meaningful operations after a real v2 store restart", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:08", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "accepts the unmodified production transitions", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:09", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "rejects the settleFailureSkipsGenerationBump control", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:10", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "rejects the leaseMaximumLifetimeIgnored control", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:11", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "rejects the settledOutcomeDedupLedgerDropped control", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:12", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "rejects the revisionSkipsTwo control", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g07:13", "requirement": "R08", "file": "tests/reliability-v2-state-machine.test.ts", "name": "rejects the unexpectedAdmissionReason control", "boundary": "independent single-scope/no-observation transition model and in-process durable store restart"},
  {"id": "support:g03:guard-1", "requirement": "R06", "file": "tests/integration/auto-virtual.test.mjs", "name": "anchors the baseline source hash and proves isSideEffectFreeAllowanceFailure faults the output-effect no-replay assertion", "boundary": "real Pi guard fault proof; first permissive unsafe-replay bypass, remaining restrictive safe-path sensitivity"},
  {"id": "support:g03:guard-2", "requirement": "R06", "file": "tests/integration/auto-virtual.test.mjs", "name": "proves autoBoundaryStillActive faults the synthetic tool side-effect no-replay assertion", "boundary": "real Pi guard fault proof; first permissive unsafe-replay bypass, remaining restrictive safe-path sensitivity"},
  {"id": "support:g03:guard-3", "requirement": "R06", "file": "tests/integration/reliability-v2-auto.test.mjs", "name": "proves allowanceRetryBoundaryStillSafe faults the v2 Auto allowance-retry assertion", "boundary": "real Pi guard fault proof; first permissive unsafe-replay bypass, remaining restrictive safe-path sensitivity"},
  {"id": "support:g01:01", "requirement": "R16", "file": "tests/integration/native-faux-lifecycle.test.mjs", "name": "routes real AgentSession turns by direct rules, tier override precedence, and default", "boundary": "shared bounded native faux harness; owned detached group receipts; deny-all probe; credential canaries absent"},
  {"id": "support:g01:02", "requirement": "R16", "file": "tests/integration/native-lifecycle-cleanup.test.mjs", "name": "bounds the submitted lifecycle parent with denied cleanup and ignore descendant pipes", "boundary": "shared bounded native faux harness; owned detached group receipts; deny-all probe; credential canaries absent"},
  {"id": "support:g01:03", "requirement": "R16", "file": "tests/integration/native-lifecycle-cleanup.test.mjs", "name": "bounds the submitted lifecycle parent with denied cleanup and inherit descendant pipes", "boundary": "shared bounded native faux harness; owned detached group receipts; deny-all probe; credential canaries absent"},
  {"id": "support:g05:01", "requirement": "R06", "file": "tests/integration/classifier-transport-acceptance.test.mjs", "name": "counts one registry classifier attempt and one final generation on success", "boundary": "registered transports (registry/endpoint/subprocess) with injected seam; one total budget; abort boundaries"},
  {"id": "support:g05:02", "requirement": "R06", "file": "tests/integration/classifier-transport-acceptance.test.mjs", "name": "does not start the paid subprocess fallback after abort while the registry transport is pending", "boundary": "registered transports (registry/endpoint/subprocess) with injected seam; one total budget; abort boundaries"},
  {"id": "support:g05:03", "requirement": "R06", "file": "tests/integration/classifier-transport-acceptance.test.mjs", "name": "does not retry a TypeSafe auth failure or a native auth failure", "boundary": "registered transports (registry/endpoint/subprocess) with injected seam; one total budget; abort boundaries"},
  {"id": "support:g05:04", "requirement": "R06", "file": "tests/integration/classifier-transport-acceptance.test.mjs", "name": "keeps the TypeSafe official endpoint pin and uses the injected transport at that boundary", "boundary": "registered transports (registry/endpoint/subprocess) with injected seam; one total budget; abort boundaries"},
  {"id": "support:g05:05", "requirement": "R06", "file": "tests/integration/classifier-transport-acceptance.test.mjs", "name": "records the unsupported composition: an endpoint classifier never uses the subprocess transport", "boundary": "registered transports (registry/endpoint/subprocess) with injected seam; one total budget; abort boundaries"},
  {"id": "support:g05:06", "requirement": "R06", "file": "tests/integration/classifier-transport-acceptance.test.mjs", "name": "fault control: removing the aborted-session guard starts a forbidden fallback prompt", "boundary": "registered transports with injected seam; isolated source-copy mutation; named AssertionError RED then restored hash-verified"},
  {"id": "support:r10:reserve-positive", "requirement": "R10", "file": "tests/integration/economic-policy-acceptance.test.mjs", "name": "dispatches the reserve-positive candidate and records the exact allowed-model set", "boundary": "configured explicit reserve policy; synthetic economic signals and fake-provider dispatch"},
  {"id": "support:r10:reserve-equality", "requirement": "R10", "file": "tests/integration/economic-policy-acceptance.test.mjs", "name": "rejects a candidate whose remaining ratio equals the reserve ratio", "boundary": "configured explicit reserve policy; equality boundary with synthetic signal"},
  {"id": "support:g06:03", "requirement": "R11", "file": "tests/integration/affinity-policy-acceptance.test.mjs", "name": "retains an eligible same-tier anchor over the strategy winner", "boundary": "pure resolver + registered handler; independent oracles; observe/retain/off composed"},
  {"id": "support:g06:04", "requirement": "R11", "file": "tests/integration/affinity-policy-acceptance.test.mjs", "name": "hard-excludes an anchor that leaves the eligible pool", "boundary": "pure resolver + registered handler; independent oracles; observe/retain/off composed"},
  {"id": "support:r10:reserve-mutation", "requirement": "R10", "file": "tests/integration/economic-policy-acceptance.test.mjs", "name": "fails the named reserve-equality assertion under a hard-filter-bypass fault in an isolated copy", "boundary": "synthetic economic signal; isolated source-copy mutation; named AssertionError RED then restored hash-verified"},
  {"id": "support:g06:06", "requirement": "R11", "file": "tests/integration/affinity-policy-acceptance.test.mjs", "name": "fails the named hard-exclusion assertion under a hard-filter-bypass fault in an isolated copy", "boundary": "pure resolver with independent oracles; isolated source-copy mutation; named AssertionError RED then restored hash-verified"},
  {"id": "support:g08:01", "requirement": "R08", "file": "tests/integration/provider-control-acceptance.test.mjs", "name": "applies a persisted Retry-After pause in real Pi, blocks the provider until expiry, then recovers a healthy same-provider model", "boundary": "real pinned Pi pause/recovery journeys + migration fence; deterministic clocks below Pi"},
  {"id": "support:g08:02", "requirement": "R08", "file": "tests/integration/provider-control-acceptance.test.mjs", "name": "admits one recovery trial at the exact Retry-After expiry and refuses reset until it settles", "boundary": "real pinned Pi pause/recovery journeys + migration fence; deterministic clocks below Pi"},
  {"id": "support:g08:03", "requirement": "R08", "file": "tests/integration/reliability-migration-acceptance.test.mjs", "name": "migrates a nonempty v1 source to an exact backup and restarts into v2 state", "boundary": "real pinned Pi pause/recovery journeys + migration fence; deterministic clocks below Pi"},
  {"id": "support:g08:04", "requirement": "R08", "file": "tests/integration/reliability-migration-acceptance.test.mjs", "name": "rejects a held active v1 source writer before backup or v2 mutation at the deterministic fence boundary", "boundary": "real pinned Pi pause/recovery journeys + migration fence; deterministic clocks below Pi"},
  {"id": "support:g08:05", "requirement": "R08", "file": "tests/integration/reliability-migration-acceptance.test.mjs", "name": "RED-proves the migration mutation-before-validation guard in an isolated source copy", "boundary": "real Pi journeys with task-local fault runner; isolated source-copy mutation; named AssertionError RED then restored hash-verified"},
  {"id": "support:g08:06", "requirement": "R08", "file": "tests/integration/provider-control-acceptance.test.mjs", "name": "RED-proves the provider pause/expiry guard in an isolated source copy", "boundary": "real Pi journeys with task-local fault runner; isolated source-copy mutation; named AssertionError RED then restored hash-verified"},
  {"id": "support:g09:01", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "keeps the debug trace inside an explicit key allowlist and free of canaries", "boundary": "command/artifact privacy: canaries + explicit allowlists; footer stays Pi-owned"},
  {"id": "support:g09:02", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "persists the classifier opt-out across restart and suppresses classifier dispatch", "boundary": "command/artifact privacy: canaries + explicit allowlists; footer stays Pi-owned"},
  {"id": "support:g09:03", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "gates the pi-native detailed trace on global debug and the typesafe trace on both gates", "boundary": "actual pi-native/TypeSafe trace gate rows; missing-model/credential boundary, not completed classification"},
  {"id": "support:g09:04", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "fault control: leaking the prompt projection turns the named redaction assertion RED", "boundary": "command/artifact privacy; isolated source-copy mutation; named AssertionError RED then restored hash-verified"},
  {"id": "support:g10:01", "requirement": "R16", "file": "tests/integration/decision-parity-acceptance.test.mjs", "name": "aligns active economic reserve decisions across all three surfaces", "boundary": "installed packed API + runtime + preview parity; hand-written scenario source; no circular oracle"},
  {"id": "support:g10:02", "requirement": "R16", "file": "tests/integration/decision-parity-acceptance.test.mjs", "name": "returns a cancelled envelope with no classifier call before or after cancellation on the installed API", "boundary": "installed packed API + runtime + preview parity; hand-written scenario source; no circular oracle"},
  {"id": "support:g10:03", "requirement": "R16", "file": "tests/router-package.test.mjs", "name": "installs the packed JS API and resolves without loader flags on Node 22.19+", "boundary": "installed packed API + runtime + preview parity; hand-written scenario source; no circular oracle"},
  {"id": "support:g11:01", "requirement": "R16", "file": "tests/integration/command-policy-acceptance.test.mjs", "name": "dispatches to the fresh declared billing-class preference and makes no classifier call", "boundary": "shared HTTP/Pi RPC fixture: mechanics-only consolidation; titles byte-identical; guarded shutdown"},
  {"id": "support:g11:02", "requirement": "R16", "file": "tests/integration/legacy-behavior.test.mjs", "name": "keeps the last-good strict boundary after a null project reload and blocks active-model generation", "boundary": "shared HTTP/Pi RPC fixture: mechanics-only consolidation; titles byte-identical; guarded shutdown"},
  {"id": "runtime-preview-router-parity", "requirement": "R01", "file": "tests/integration/decision-parity-acceptance.test.mjs", "name": "keeps selected, excluded, fallback, and no-route decisions aligned across all three surfaces", "boundary": "pinned Pi physical runtime, pinned Pi offline preview, and installed packed resolve-only API", "caseArtifact": "cases/runtime-preview-router-parity/parity.json"},
  {"id": "support:r06:strict-activation", "requirement": "R06", "file": "tests/strict-runtime.test.ts", "name": "handles false and throwing physical activation inside a strict policy", "boundary": "registered runtime handler; not Pi RPC"},
  {"id": "support:r06:cancelled-registry-wait", "requirement": "R06", "file": "tests/strict-runtime.test.ts", "name": "stops an aborted registry wait and preserves a newer editor draft", "boundary": "registered runtime handler; not Pi RPC"},
  {"id": "support:r09:invalid-reload", "requirement": "R09", "file": "tests/strict-runtime.test.ts", "name": "blocks invalid policy at startup and retains last-good config on invalid reload", "boundary": "config/runtime unit boundary"},
  {"id": "support:r10:declared-billing-class", "requirement": "R10", "file": "tests/integration/command-policy-acceptance.test.mjs", "name": "dispatches to the fresh declared billing-class preference and makes no classifier call", "boundary": "real Pi RPC with synthetic registry; no live billing adapter"},
  {"id": "support:r10:observe-mode", "requirement": "R10", "file": "tests/integration/economic-policy-acceptance.test.mjs", "name": "reports would-reject in observe mode without excluding or blocking the candidate", "boundary": "explicit observe policy; decision evidence without admission effect"},
  {"id": "support:r10:multi-window", "requirement": "R10", "file": "tests/economic-signals.test.ts", "name": "requires all configured windows to pass and treats absolute values without a limit as unknown", "boundary": "pure typed signal evaluation; multiple independent windows and units"},
  {"id": "support:r10:window-expiry", "requirement": "R10", "file": "tests/economic-signals.test.ts", "name": "expires each window independently when another window in its signal resets", "boundary": "pure typed signal evaluation; per-window expiry and reset"},
  {"id": "support:r10:account-scope", "requirement": "R10", "file": "tests/economic-signals.test.ts", "name": "keeps account scope matching gated by explicit host capability and exact binding", "boundary": "opaque account scope requires explicit host capability and exact binding"},
  {"id": "support:r10:source-provenance", "requirement": "R10", "file": "tests/economic-signals.test.ts", "name": "validates explicit source authority and alias-keyed source ordering", "boundary": "source authority and alias provenance"},
  {"id": "support:r10:no-hidden-fetch", "requirement": "R10", "file": "tests/integration/economic-policy-acceptance.test.mjs", "name": "makes no hidden quota fetch or external socket while routing and previewing", "boundary": "explicit local observations only; no automatic quota adapter or network fetch"},
  {"id": "support:r11:eligible-affinity", "requirement": "R11", "file": "tests/routing.test.ts", "name": "retains an automatic anchor only inside the selected tier's final strategy pool", "boundary": "pure resolver; branch/session lifecycle not proven"},
  {"id": "support:r11:explicit-target-origin", "requirement": "R11", "file": "tests/routing.test.ts", "name": "does not restore an anchor excluded by preferred-class selection or explicit intent", "boundary": "pure resolver; direct/exact target origin is not promoted or overridden by affinity"},
  {"id": "support:r13:packed-experimental-api", "requirement": "R13", "file": "tests/router-package.test.mjs", "name": "installs the packed JS API and resolves without loader flags on Node 22.19+", "boundary": "installed experimental consumer API; stable versioned contract deferred"},
  {"id": "support:r14:redacted-observation", "requirement": "R14", "file": "tests/typesafe-classifier.test.ts", "name": "persists only redacted TypeSafe debug metadata", "boundary": "unit privacy projection; not complete local trace contract"},
  {"id": "support:r17:generic-strategy", "requirement": "R17", "file": "tests/routing.test.ts", "name": "defaults to first", "boundary": "pure generic strategy resolver; arbitrary tier strings separately configured"},
  {"id": "support:r17:arbitrary-tier-strategy", "requirement": "R17", "file": "tests/routing.test.ts", "name": "uses generic strategies for arbitrary custom tier keys across providers", "boundary": "pure resolver; custom tier key and provider-neutral cheapest strategy"},
  {"id": "support:r17:model-free-defaults", "requirement": "R17", "file": "tests/config.test.ts", "name": "keeps bundled starter pools empty and free of maintainer model IDs", "boundary": "bundled public bifrost.json template"},
  {"id": "support:r17:public-defaults", "requirement": "R17", "file": "tests/integration/init-regression.test.mjs", "name": "adds public starter defaults when reconciliation has no membership changes", "boundary": "pinned Pi init; generated default policy with no maintainer model IDs"},
  {"id": "support:g09:05", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "persists reliability and runtime state inside declared key sets without canaries", "boundary": "generated reliability sidecars: envelope/nested key allowlists, witnessed markers and canaries; not all future record values"},
  {"id": "support:g09:06", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "fault control: an undeclared pi-native trace key turns the per-backend allowlist assertion RED", "boundary": "actual emitted pi-native trace row contract with isolated source-copy fault; not completed native classification"},
  {"id": "support:g09:07", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "cleanup control: an uncertain reported receipt retains the private source copy and preserves the real cleanup error", "boundary": "real owned Pi run safely closed before uncertain reported receipt injection; exact path retention and error identity"},
  {"id": "support:g09:08", "requirement": "R14", "file": "tests/integration/command-privacy-acceptance.test.mjs", "name": "cleanup control: a missing actual receipt retains every owned path and preserves the real cleanup error", "boundary": "real owned Pi run safely closed before losing the reported receipt; post-teardown retained paths and error identity"},
  {"id": "support:g09:09", "requirement": "R14", "file": "tests/acceptance-runner.test.mjs", "name": "projects real Node test events into a declared allowlist without leaking off-channel diagnostics", "boundary": "actual Node reporter/writer projection; intentional source and bounded diagnostic fields are outside content exclusion"},
  {"id": "support:g09:10", "requirement": "R14", "file": "tests/acceptance-runner.test.mjs", "name": "fault control: an undeclared acceptance projection key turns the named allowlist assertion RED", "boundary": "generated acceptance projection with an isolated undeclared-key fault; not global artifact redaction"},
];

function usage() {
  return [
    "Usage: npm run acceptance -- [--profile deterministic|contract|live]",
    "Live only: --allow-live --allow-model provider/model (exactly one model)",
    "           [--max-requests-per-model 1..4] [--deadline-seconds 1..300]",
  ].join("\n");
}

function sanitize(text) {
  return text
    .replace(/((?:proxy-)?authorization|cookie|set-cookie|x-api-key)\s*[:=]\s*[^\r\n]+/gim, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_TOKEN]");
}

function signalExitCode(signal) {
  return signal === "SIGINT" ? 130 : 143;
}

function signalProcessGroup(child) {
  if (!child?.pid) return;
  activeTermination ??= terminateProcessGroup(child);
}

export function registerTerminationHandlers() {
  const onSignal = (signal) => {
    receivedSignal ??= signal;
    signalProcessGroup(activeChild);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    return receivedSignal;
  };
}

function enforceGateNetworkBoundary(result, violationPath) {
  let violations = "";
  try { violations = readFileSync(violationPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (violations.length) {
    result.status = 1;
    result.stderr += "\nOutbound network guard recorded a blocked request; the deterministic gate failed.";
  }
  result.networkGuardArtifact = violationPath;
  return result;
}

function createOutputCapture(limit = MAX_CAPTURE_BYTES) {
  const segmentLimit = Math.floor(limit / 2);
  let size = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return {
    append(chunk) {
      let bytes = Buffer.from(chunk);
      size += bytes.length;
      if (head.length < segmentLimit) {
        const count = Math.min(segmentLimit - head.length, bytes.length);
        head = Buffer.concat([head, bytes.subarray(0, count)]);
        bytes = bytes.subarray(count);
      }
      if (bytes.length) tail = Buffer.concat([tail, bytes]).subarray(-segmentLimit);
    },
    text() {
      const truncated = size > limit;
      if (!truncated) return Buffer.concat([head, tail]).toString("utf8");
      return `${head.toString("utf8")}\n[stream output truncated]\n${tail.toString("utf8")}`;
    },
    truncated() { return size > limit; },
  };
}

export function runChild(command, args, {
  cwd,
  env,
  timeoutMs = 20 * 60 * 1000,
  captureLimit = MAX_CAPTURE_BYTES,
  onStdoutLine,
  reporterMaxEvents = MAX_REPORTER_EVENTS,
  reporterMaxBytes = MAX_REPORTER_EVENT_BYTES,
}) {
  return new Promise((resolveResult) => {
    if (receivedSignal) {
      resolveResult({ status: signalExitCode(receivedSignal), stdout: "", stderr: `Gate skipped after ${receivedSignal}.`, outputTruncated: false, reporterLineTooLarge: false });
      return;
    }
    const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    const stdout = createOutputCapture(captureLimit);
    const stderr = createOutputCapture(captureLimit);
    const decoder = new StringDecoder("utf8");
    let reporterRemainder = "";
    let reporterLineTooLarge = false;
    let reporterEventOverflowed = false;
    let reporterEventCount = 0;
    let reporterEventBytes = 0;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child);
    }, timeoutMs);
    const consumeStdoutText = (text) => {
      if (!onStdoutLine || reporterLineTooLarge) return;
      reporterRemainder += text;
      if (Buffer.byteLength(reporterRemainder) > MAX_REPORTER_LINE_BYTES && !reporterRemainder.includes("\n")) {
        reporterLineTooLarge = true;
        reporterRemainder = "";
        return;
      }
      const lines = reporterRemainder.split("\n");
      reporterRemainder = lines.pop() ?? "";
      for (const line of lines) {
        if (Buffer.byteLength(line) > MAX_REPORTER_LINE_BYTES) {
          reporterLineTooLarge = true;
          reporterRemainder = "";
          return;
        }
        const eventBytes = Buffer.byteLength(line);
        if (reporterEventCount >= reporterMaxEvents || reporterEventBytes + eventBytes > reporterMaxBytes) {
          reporterEventOverflowed = true;
          continue;
        }
        reporterEventCount++;
        reporterEventBytes += eventBytes;
        onStdoutLine(line.replace(/\r$/u, ""));
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
      consumeStdoutText(decoder.write(chunk));
    });
    child.stderr.on("data", (chunk) => stderr.append(chunk));
    child.on("error", async (error) => {
      clearTimeout(timeout);
      let cleanupFailed = false;
      try { cleanupFailed = activeTermination !== undefined && !(await activeTermination); }
      catch { cleanupFailed = true; }
      if (activeChild === child) activeChild = undefined;
      activeTermination = undefined;
      resolveResult({
        status: 1,
        stdout: stdout.text(),
        stderr: stderr.text() + error.message + (cleanupFailed ? "\nCould not confirm that the child process group terminated." : ""),
        outputTruncated: stdout.truncated() || stderr.truncated(),
        reporterLineTooLarge,
        reporterEventOverflowed,
      });
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timeout);
      if (!activeTermination && process.platform !== "win32" && processGroupExists(child.pid)) {
        activeTermination = terminateProcessGroup(child);
      }
      let cleanupFailed = false;
      try { cleanupFailed = activeTermination !== undefined && !(await activeTermination); }
      catch { cleanupFailed = true; }
      if (activeChild === child) activeChild = undefined;
      activeTermination = undefined;
      consumeStdoutText(decoder.end());
      if (reporterRemainder && Buffer.byteLength(reporterRemainder) > MAX_REPORTER_LINE_BYTES) reporterLineTooLarge = true;
      if (onStdoutLine && !reporterLineTooLarge && reporterRemainder) onStdoutLine(reporterRemainder.replace(/\r$/u, ""));
      resolveResult({
        status: cleanupFailed ? 1 : timedOut ? 124 : receivedSignal ? signalExitCode(receivedSignal) : reporterLineTooLarge || reporterEventOverflowed ? 1 : code ?? 1,
        stdout: stdout.text(),
        stderr: (timedOut ? stderr.text() + `\nCommand timed out after ${timeoutMs} ms.` : signal ? stderr.text() + `\nProcess ended by ${signal}.` : stderr.text())
          + (cleanupFailed ? "\nCould not confirm that the child process group terminated." : ""),
        outputTruncated: stdout.truncated() || stderr.truncated(),
        reporterLineTooLarge,
        reporterEventOverflowed,
        processCleanupFailed: cleanupFailed,
      });
    });
  });
}

export function manifestEvidenceGate(root) {
  const path = join(root, "change-evidence.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Manifest evidence declaration exceeds its bound");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(manifest.contracts) || !manifest.contracts.length || manifest.contracts.length > 100) {
    throw new Error("Manifest evidence contracts are unavailable or unbounded");
  }
  const base = NODE_TEST_GATES.get("test:manifest-evidence");
  const paths = new Set(base.paths);
  const patterns = [base.pattern];
  for (const contract of manifest.contracts) {
    for (const dimension of ["boundaryTest", "invariant", "fault"]) {
      const witness = contract?.[dimension];
      if (witness && Object.keys(witness).length === 1 && typeof witness.exception === "string" && witness.exception.trim()) continue;
      if (!witness || typeof witness.file !== "string" || witness.file.length > 512
        || !/^tests\/[\w./-]+\.test\.(?:mjs|ts)$/.test(witness.file)
        || witness.file.split("/").some((part) => !part || part === "." || part === "..")
        || typeof witness.name !== "string" || !witness.name.trim() || witness.name.length > 1024) {
        throw new Error("Manifest evidence witness is malformed");
      }
      paths.add(witness.file);
      patterns.push(witness.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  if (paths.size > 100 || patterns.join("|").length > 64 * 1024) throw new Error("Manifest evidence selection exceeds its bound");
  return { paths: [...paths], pattern: patterns.join("|") };
}

async function executeVerificationGate({ root, script, testEvents, artifactDir }) {
  const gateEnvironment = verificationGateEnvironment({ root, artifactDir, script });
  const testGate = script === "test:manifest-evidence" ? manifestEvidenceGate(root) : NODE_TEST_GATES.get(script);
  if (!testGate) {
    return enforceGateNetworkBoundary(await runChild("npm", ["run", script], { cwd: root, env: gateEnvironment.env }), gateEnvironment.violationPath);
  }
  const reporterPath = join(root, "scripts", "acceptance", "test-event-reporter.mjs");
  let malformedEvent = false;
  const result = await runChild(process.execPath, [
    "--test",
    "--experimental-strip-types",
    `--test-reporter=${reporterPath}`,
    ...(testGate.pattern ? [`--test-name-pattern=${testGate.pattern}`] : []),
    ...testGate.paths,
  ], {
    cwd: root,
    env: gateEnvironment.env,
    onStdoutLine(line) {
      if (!line) return;
      try { testEvents.push(JSON.parse(line)); }
      catch { malformedEvent = true; }
    },
  });
  if (malformedEvent || result.reporterLineTooLarge) {
    result.status = 1;
    result.stderr += malformedEvent
      ? "\nNode test reporter returned malformed JSONL."
      : "\nNode test reporter emitted a line larger than the 1 MiB safety limit; structured event capture is incomplete.";
  }
  if (result.reporterEventOverflowed) {
    result.status = 1;
    result.stderr += "\nNode test reporter exceeded the structured event count or total-byte limit; structured event capture is incomplete.";
  }
  return enforceGateNetworkBoundary(result, gateEnvironment.violationPath);
}

async function runDeterministic({ root, artifactDir }) {
  const { runVerification } = await import("./verify-release.mjs");
  const runStartedMs = Date.now();
  const testEvents = [];
  const verification = await runVerification({
    root,
    execute: ({ script }) => executeVerificationGate({ root, script, testEvents, artifactDir }),
  });
  const testEventsArtifact = writeNodeTestEventsArtifact({ root, artifactDir, testEvents });
  if (receivedSignal) {
    return [{
      id: "deterministic:interrupted",
      requirements: [],
      boundary: "deterministic-release-gates",
      status: "failed",
      required: true,
      attempts: testEvents.length,
      exclusions: [],
      artifacts: [relative(root, testEventsArtifact)],
      detail: `The deterministic profile stopped after ${receivedSignal}; active child process groups were terminated and awaited.`,
    }];
  }
  const terminalCaptures = [];
  const uiCaptureDir = join(root, "screenshots", "ui-smoke");
  try {
    const targetDir = join(artifactDir, "terminal");
    for (const name of readdirSync(uiCaptureDir)) {
      const source = join(uiCaptureDir, name);
      if (!statSync(source).isFile() || statSync(source).mtimeMs < runStartedMs || !/\.(?:png|txt|ansi\.log)$/.test(name)) continue;
      mkdirSync(targetDir, { recursive: true });
      const target = join(targetDir, name);
      if (/\.(?:txt|ansi\.log)$/.test(name)) writeFileSync(target, sanitize(readFileSync(source, "utf8")));
      else copyFileSync(source, target);
      terminalCaptures.push(relative(root, target));
    }
  } catch {}
  const cases = buildGateEvidenceCases({ verification, root, artifactDir, terminalCaptures });
  const eventPath = relative(root, testEventsArtifact);
  const changeEvidence = changeEvidenceCase({ root, testEvents });
  if (changeEvidence) cases.push({ ...changeEvidence, artifacts: [eventPath], detail: changeEvidence.detail });
  for (const target of SUPPORTING_TESTS) {
    cases.push(supportingTestCase({ target, testEvents, artifactDir, root, eventPath }));
  }
  cases.push({
    id: "deferred:r13:stable-versioned-api",
    requirements: ["R13"],
    boundary: "stable public API contract",
    status: "deferred",
    required: false,
    attempts: [],
    exclusions: ["The installed consumer smoke covers the existing experimental API only."],
    artifacts: [eventPath],
    detail: "A stable versioned resolve-only TypeScript contract is deferred; see RELEASE-PLAN.md.",
  });
  cases.push({
    id: "node-test-event-capture",
    requirements: [],
    boundary: "unit-and-pinned-pi-integration-test-events",
    status: testEvents.length > 0 ? "passed" : "blocked",
    required: true,
    startedAt: new Date(runStartedMs).toISOString(),
    endedAt: new Date().toISOString(),
    attempts: testEvents.length,
    exclusions: ["UI verification and non-test gates do not emit Node test events."],
    artifacts: [relative(root, testEventsArtifact)],
    ...(testEvents.length === 0 ? { detail: "Neither Node test gate emitted structured per-test results." } : {}),
  });
  const hasTerminalImage = terminalCaptures.some((path) => path.endsWith(".png"));
  const hasTerminalText = terminalCaptures.some((path) => path.endsWith(".txt"));
  cases.push({
    id: "terminal-captures",
    requirements: ["R16"],
    boundary: "pinned-Pi-terminal-ui",
    status: hasTerminalImage && hasTerminalText ? "passed" : "blocked",
    required: true,
    startedAt: new Date(runStartedMs).toISOString(),
    endedAt: new Date().toISOString(),
    attempts: 1,
    exclusions: [],
    artifacts: terminalCaptures,
    ...(!(hasTerminalImage && hasTerminalText) ? { detail: "The UI gate produced no fresh terminal image and text capture for this run." } : {}),
  });
  let journeys;
  try {
    ({ runJourneys: journeys } = await import("./acceptance/journeys.mjs"));
    const result = await journeys({ root, artifactDir, options: { shouldStop: () => Boolean(receivedSignal) } });
    cases.push(...result.cases);
  } catch (error) {
    cases.push({
      id: "journeys:runner",
      requirements: [],
      boundary: "critical-user-journeys",
      status: "blocked",
      required: true,
      attempts: 0,
      exclusions: [],
      artifacts: [],
      detail: "Journey profile unavailable or failed: " + (error instanceof Error ? error.message : String(error)),
    });
  }
  return cases;
}

export function supportingTestCase({ target, testEvents, artifactDir, root, eventPath }) {
  const result = matchNamedTestEvent(testEvents, target, root);
  const caseArtifact = target.caseArtifact ? join(artifactDir, target.caseArtifact) : undefined;
  const hasCaseArtifact = caseArtifact ? existsSync(caseArtifact) : true;
  const status = !result ? "blocked" : !result.passed ? "failed" : !hasCaseArtifact ? "blocked" : "passed";
  return {
      id: target.id,
      requirements: [target.requirement],
      boundary: target.boundary,
      status,
      required: true,
      durationMs: result?.durationMs ?? null,
      attempts: result ? [{ durationMs: result.durationMs, result: result.passed ? "passed" : "failed", testFile: target.file, testName: target.name, ...(result.failure ? { failure: result.failure } : {}) }] : [],
      exclusions: [],
      artifacts: [eventPath, ...(hasCaseArtifact && caseArtifact ? [relative(root, caseArtifact)] : [])],
      ...(status === "failed" && result?.failure?.message ? { detail: sanitize(result.failure.message) } : {}),
      ...(status === "blocked" ? { detail: !result
        ? `The pinned test runner did not emit the exact required test result: ${target.file} — ${target.name}`
        : "The required structured parity evidence artifact was not written for this acceptance run." } : {}),
    };
}

export function buildGateEvidenceCases({ verification, root, artifactDir, terminalCaptures = [] }) {
  return verification.gates.map((gate) => {
    const sourceLog = join(root, gate.logPath);
    let artifact = null;
    try {
      const logText = sanitize(readFileSync(sourceLog, "utf8"));
      const target = join(artifactDir, "gates", gate.id + ".log");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, logText);
      artifact = relative(root, target);
    } catch {}
    const networkPath = gate.script ? join(gateDirectory(artifactDir, gate.script), "network-violations.log") : null;
    return {
      id: "gate:" + gate.id,
      requirements: ["R16"],
      boundary: gate.id === "preflight" ? "installed-tool-preflight" : "release-verification-gate",
      status: gate.exitCode === 0 ? "passed" : "failed",
      required: true,
      startedAt: gate.startedAt,
      endedAt: gate.endedAt,
      attempts: gate.script === null ? 0 : 1,
      exclusions: [],
      artifacts: [
        ...(artifact ? [artifact] : []),
        ...(networkPath && existsSync(networkPath) ? [relative(root, networkPath)] : []),
        ...(gate.id === "pinned-pi-ui" ? terminalCaptures : []),
      ],
      detail: gate.logPath,
    };
  });
}

export function writeNodeTestEventsArtifact({ root, artifactDir, testEvents }) {
  const target = join(artifactDir, "gates", "node-test-events.jsonl");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, testEvents.map((event) => sanitize(JSON.stringify({
    ...event,
    file: event.file?.startsWith(root) ? relative(root, event.file) : event.file,
  }))).join("\n") + "\n");
  return target;
}

async function executeProfile(profile, context) {
  if (profile === "deterministic") return runDeterministic(context);
  const modulePath = PROFILE_FILES[profile];
  try {
    const { runProfile } = await import(modulePath);
    const result = await runProfile(context);
    if (!result || !Array.isArray(result.cases)) throw new Error("Profile did not return a cases array");
    return result.cases;
  } catch (error) {
    return [{
      id: profile + ":runner",
      requirements: [],
      boundary: profile + "-profile",
      status: "blocked",
      required: true,
      attempts: 0,
      exclusions: [],
      artifacts: [],
      detail: "Profile unavailable or failed: " + (error instanceof Error ? error.message : String(error)),
    }];
  }
}

function normalizeCases(cases, root) {
  const valid = new Set(["passed", "failed", "blocked", "missing", "deferred"]);
  return cases.map((item, index) => {
    const durationMs = Number.isFinite(item.durationMs)
      ? item.durationMs
      : item.startedAt && item.endedAt ? Date.parse(item.endedAt) - Date.parse(item.startedAt) : null;
    return {
      order: index + 1,
      id: String(item.id ?? "case-" + (index + 1)),
      requirements: Array.isArray(item.requirements) ? item.requirements : [],
      boundary: item.boundary ?? "unspecified",
      status: valid.has(item.status) ? item.status : "failed",
      required: item.required !== false,
      startedAt: item.startedAt ?? null,
      endedAt: item.endedAt ?? null,
      durationMs,
      attempts: item.attempts ?? 0,
      exclusions: Array.isArray(item.exclusions) ? item.exclusions : [],
      artifacts: Array.isArray(item.artifacts) ? item.artifacts.map((path) => path.startsWith(root) ? relative(root, path) : path) : [],
      ...(item.detail ? { detail: sanitize(String(item.detail)) } : {}),
    };
  });
}

export async function runAcceptance(argv = process.argv.slice(2), runtime = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n" + usage() + "\n");
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return;
  }

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = join(root, "screenshots", "acceptance", runId);
  mkdirSync(artifactDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const before = {
    revision: git(root, ["rev-parse", "HEAD"]),
    sourceFingerprint: sourceFingerprint(root),
    dirtyPaths: gitTruth(root),
  };
  const toolVersions = installedToolVersions(root);
  let cases;
  const removeSignalHandlers = registerTerminationHandlers();
  try {
    cases = normalizeCases(await executeProfile(options.profile, { root, artifactDir, options }), root);
  } catch (error) {
    cases = normalizeCases([{
      id: options.profile + ":runner",
      requirements: [],
      boundary: options.profile + "-profile",
      status: "failed",
      required: true,
      attempts: 0,
      exclusions: [],
      artifacts: [],
      detail: error instanceof Error ? error.message : String(error),
    }], root);
  }
  const receivedRunSignal = removeSignalHandlers();
  const after = {
    revision: git(root, ["rev-parse", "HEAD"]),
    sourceFingerprint: sourceFingerprint(root),
    dirtyPaths: gitTruth(root),
  };
  const candidateChanged = before.revision !== after.revision || before.sourceFingerprint !== after.sourceFingerprint;
  const candidateDirty = before.dirtyPaths.length > 0 || after.dirtyPaths.length > 0;
  cases.push({
    order: cases.length + 1,
    id: "candidate-stable",
    requirements: ["R16"],
    boundary: "source-provenance",
    status: candidateChanged || candidateDirty ? "failed" : "passed",
    required: true,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: null,
    attempts: 1,
    exclusions: [],
    artifacts: [],
    ...(candidateChanged || candidateDirty ? { detail: "Source changed or the working tree was dirty; run again on a clean, frozen candidate." } : {}),
  });
  const summary = summarizeCases(cases);
  const evidence = {
    schemaVersion: 1,
    profile: options.profile,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: summary.exitCode,
    source: {
      revisionAtStart: before.revision,
      revisionAtEnd: after.revision,
      fingerprintAtStart: before.sourceFingerprint,
      fingerprintAtEnd: after.sourceFingerprint,
      dirtyPathsAtStart: before.dirtyPaths,
      dirtyPathsAtEnd: after.dirtyPaths,
      changedDuringRun: before.revision !== after.revision || before.sourceFingerprint !== after.sourceFingerprint,
    },
    toolVersions,
    options: options.profile === "live" ? {
      allowModels: options.allowModels,
      maxRequestsPerModel: options.maxRequestsPerModel,
      deadlineSeconds: options.deadlineSeconds,
      credentials: "Pi-managed; values not recorded",
    } : {},
    summary,
    cases,
  };
  const evidencePath = join(artifactDir, "evidence.json");
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  let ciReportFailed = false;
  try {
    exportCiReportIfConfigured({ isMain: runtime.isMain === true, profile: options.profile, evidence, artifactDir });
  } catch (error) {
    ciReportFailed = true;
    process.stderr.write(`CI report export failed; acceptance evidence is preserved at ${relative(root, evidencePath)}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.stdout.write("Acceptance " + options.profile + ": " + (summary.exitCode === 0 ? "passed" : "failed") +
    " (" + summary.passed + " passed, " + summary.failed + " failed, " + summary.blocked + " blocked)\n");
  process.stdout.write("Evidence: " + relative(root, join(artifactDir, "evidence.json")) + "\n");
  process.exitCode = receivedRunSignal ? signalExitCode(receivedRunSignal) : ciReportFailed ? 1 : summary.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAcceptance(process.argv.slice(2), { isMain: true });
}
