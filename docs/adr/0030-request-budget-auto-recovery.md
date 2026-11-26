# 0030 — Bounded request-budget Auto recovery

## Status

**Proposed for #230, not accepted.** Review and owner adjudication required before promotion. This draft proposes a narrow amendment to ADR 0023 and ADR 0024; it does not change the existing accepted allowance or ordinary 429 policies.

## Decision candidate

A qualified, model-bound TPM rejection reports that the requested budget exceeds the limit. Pi may expose only flattened provider prose. Treat that as inferred request-specific evidence, not as authoritative HTTP status or provider-wide incapacity. The separate `reliability.retryOnRequestBudgetExceeded` opt-in defaults to false and requires reliability to be enabled. Do not allow generic 429, contradictory structured evidence, unqualified prose or unknown lifecycle ownership to authorize replay.

Reuse ADR 0023's existing terminal user-boundary proof, empty assistant and exact null context-edit lineage, ownership rechecks, confirmed V1/V2 settlement, normal candidate eligibility and single alternate limit. Do not reclassify or probe. Retain the original transcript. The failed candidate is excluded from the recovery's selection and revalidation only, with distinct request-failure evidence in the route trace. No immediate allowance cooldown or new provider-wide pause may be justified by this hint alone. Ordinary model circuit accounting and separately authorized pauses are unchanged. The existing allowance flag does not authorize this new case. Generic rate throttling remains unchanged.

The policy does not guarantee the alternate can accept the budget; its terminal failure ends the recovery. Physical routes, direct rules, strict exhausted tier boundaries, output, tools, queued work, abort and unknown ownership remain outside the exception.

## Verification and coordination

The candidate must prove exact real-Pi dispatches and settlement, negative controls, fault sensitivity, smoke evidence, no raw error retention and full release gates. Coordinate the qualified-legacy-evidence/action authority seam with #349. A passed baseline or green CI alone is not acceptance. Before merge, reconcile the final accepted contract in ADR 0023/0024, governance, product docs and release guidance.
