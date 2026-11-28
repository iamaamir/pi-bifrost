# 0030 — Native Auto model failover

## Status

**Proposed delivery contract; not permission to activate broader recovery.** Owner-delegated adjudication is recorded in [#230](https://github.com/iamaamir/pi-bifrost/issues/230#issuecomment-7201144139). ADR 0023 and 0024 remain in force until the native path and action-authority contract are verified and the governing documents are reconciled. This proposal supersedes the abandoned request-budget-specific draft, not the accepted allowance path.

## Context

The research at [816281e](https://github.com/iamaamir/pi-bifrost/commit/816281e4b2b3f2773d9e307e37caab5f7c30464f) reports 22 passing characterization/composition experiments. They demonstrate host and owner feasibility, not a production transition. The review requires proof at the registered adapter. Pi's native retry and compaction may both route as retry, while its retry count resets on successful assistant responses. A failure category is not permission to dispatch.

## Proposed contract

- Auto only; opt-in `reliability.failover` (default false). Physical, pinned, explicit model bindings and resolve-only APIs retain their existing semantics.
- Use Pi's native failed-generation retry opportunity; do not initiate, schedule, sleep for, or extend retries. Require exact persisted failed attempt, empty output, exact omission and unchanged authorized user boundary. Reject compaction, partial output, cancelled, local and unproven attempts. Preserve same-model host behavior when failover is off.
- Preserve original route intent, tier and fallback boundaries; do not rerun classification or consume overrides. An explicit tier may recover only within its originally selected requested tier. Never revive a failed or excluded model via affinity or sticky degradation. The attempted physical identities are scoped to the original user boundary; frozen routing authority and normal eligibility bound candidate changes. No independent configurable retry count. Verify native exhaustion, a three-candidate pool and retry reset behavior before accepting the bound.
- Confirm old model and provider settlement through existing owners before new admission; never mutate receipt identity. Revalidate authority and cancellation after asynchronous effects; cleanup only owned resources. A failed write or rejected admission stops without alternate dispatch. V1/V2, provider pauses and provider/model leases remain owned by their existing components. Coordinate [#349](https://github.com/iamaamir/pi-bifrost/issues/349): attributable evidence and action authority must be resolved before enabling the new dispatch path.
- Existing affinity promotion uses confirmed successful settlement and original automatic origin. Retain normal continuation stickiness on the new model after a successful switch. Post-tool switching requires separate registered-path proof of committed results, projection compatibility and no repeated effects; remain out of activated first slice until verified.
- Preserve existing terminal allowance behavior and its explicit setting under ADR 0023. No expansion of terminal continuation or combined extra retries; do not remove proof/ownership machinery without parity and an approved retirement contract.
- If a module is extracted, it is a small internal, host-neutral decision boundary. No new effectful SDK API, parallel resolver, persistence, classifier or retry engine.

## Verification and release

First characterize actual registered Auto behavior on the original TPM rejection with native retries enabled and disabled. Next prove the narrow changed-model path using production owners and the accepted evidence/action boundary. Require discriminating failure controls for settlement/admission, authority, native cancellation, candidate exhaustion, projection and affinity. Include minimum host compatibility, existing allowance regressions, content-free notices/logs, unchanged installed resolve-only API and all existing static, complexity, head/merge, UI and release gates. Independent Axiom review and relevant Prism remain required. No gate waiver.

If exact native opportunity or owner transition cannot be established, stop and retain existing behavior rather than build another retry engine.
