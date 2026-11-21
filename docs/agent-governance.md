# Issue challenge and final review

The lifecycle in [AGENTS.md](../AGENTS.md#delivery-lifecycle) is the authority.
The [Issue Challenger](../.agents/issue-challenger.md) checks readiness before coding;
[Axiom](../.agents/axiom.md) checks the actual final candidate. Axiom screens the
diff for material product/UX changes and refers qualifying candidates to the
[Product & UX Reviewer](../.agents/product-ux-reviewer.md). Use separate fresh
runs from the implementation author, with the accepted contract and evidence,
rather than the author's full conversation. An author may not approve their own work.

## Readiness and adjudication

The challenger recommends READY, NEEDS_REVISION, BLOCKED, ALREADY_SATISFIED or
DEFERRED. READY requires clear contracts, satisfied blockers and applicable gates;
ALREADY_SATISFIED requires demonstrated acceptance evidence. DEFERRED never waives
a mandatory criterion. These dispositions are review records, not new labels.

The implementation owner records each finding ID as ACCEPT, REJECT, DEFER or
NEEDS EVIDENCE, with rationale, existing owner, required control and acceptance
impact. Resolve material uncertainty before affected coding; ask the human owner
when resolution changes scope, requirements or authority. Optional observations
need not trigger another review round. Keep cross-issue findings in the existing
consolidated report and accepted local decisions on their owner tickets only
when issue edits are authorized. This setup does not authorize such edits.

Before challenge, obtain the current issue/comments, native blockers and any
applicable parent plan or approved delivery protocol. Resolve required planning
documents from that context; ask when they are missing and respect their privacy
constraints. Preserve existing ownership, dependency, evidence and promotion
gates. Reconcile prior adjudication with current source; repeat a full audit only
when new evidence warrants it. An issue's non-goals, including source-change-free
scope where specified, remain authoritative.

## Using the definitions

The definitions reuse the existing `.agents/*.md` layout. Installed
pi-subagents 0.88.1 documents legacy project discovery there; `.pi/agents` can
override a same-name definition. Inspect the selected definition and effective
tools before relying on it. Use project scope and explicit fresh context when
launching through pi-subagents. All three roles declare only read, grep, find and ls;
they request live GitHub snapshots and executed checks from the owner. Tool
allowlists and prose are not an operating-system security boundary. Do not
assume a different host supports this metadata or silently grant extra tools.
No runtime extension, global settings change or paid call is needed for the
focused documentation check:

```bash
node --test tests/agent-governance.test.mjs
```

This check validates documentation structure and selected instruction contracts.
It does not launch a model, establish behavioral compliance or replace release
verification. Axiom's code verdict, current CI results and merge authority remain
separate. Review/repair bounds never turn a missing gate into a pass.

## Conditional Product & UX Review

Axiom reports `REQUIRED` or `NOT REQUIRED` for every candidate, with a reason
from the actual diff. A separate review is required when a change makes a
material user-facing choice, such as a new configuration option, meaningful
status/error wording, command interaction, recovery action, public output
contract or user task. A file path alone does not qualify a change. Purely
mechanical changes and trivial copy edits normally do not trigger the review.

Axiom returns REVIEW INCOMPLETE when a required specialist review of the same
head is missing, incomplete or stale. The owner launches the specialist as a
fresh non-author run and supplies the accepted contract, diff and captured
observable output. The reviewer returns APPROVED, CHANGES REQUIRED or REVIEW
INCOMPLETE with specific evidence. Axiom incorporates the result and rechecks
only affected behavior after fixes. A material contract change needs owner
adjudication before implementation. The specialist never merges, changes the
issue or replaces existing technical/CI gates; the usual correction-round limit
still applies. No agent is automatically dispatched by these instructions.


## Handoff prompts

Replace angle-bracket fields with real revisions, snapshots and evidence. These
are task templates, not commands or claims of an executed challenge/review.

**Challenge:**

> Act as issue-challenger, independently of the author. Read AGENTS.md and
> .agents/issue-challenger.md. Challenge <issue> against <delivery branch and SHA>.
> Inputs: <current issue/comments and native blocker snapshot>, <applicable parent
> plan, approved protocol and required planning documents>, <prior adjudication/report>.
> Trace current owners and map every acceptance criterion to evidence. Preserve
> the issue's non-goals.
> Report readiness, material blockers, nonblocking observations and proof limits.
> Do not edit files or issues, implement, run commands or approve a PR.

**Adjudication and implementation:**

> Use <challenge report> at <baseline SHA>. Record ACCEPT / REJECT / DEFER /
> NEEDS EVIDENCE for each finding with reasons and owner. Escalate material
> scope/authority conflicts. Once READY under the existing gates, implement only
> <accepted authorized contract>; exclusions: <non-goals>. Record actual check
> output, required failure controls and limitations for <candidate SHA>. Do not
> change roadmap issue bodies or merge without their existing authorization.

**Final review:**

> Act as Axiom in a separate non-author run. Read AGENTS.md and .agents/axiom.md.
> Review <PR> from <base SHA> to <head SHA>; changed files: <list>; diff: <path>.
> Accepted contract/adjudication: <paths>; evidence: <commands, output, manifest>.
> Verify target binding, applicable invariants and acceptance criteria. Screen
> for material Product & UX Review needs and record REQUIRED / NOT REQUIRED with
> diff-based reasons. Separate evidenced blockers, missing required checks and
> nonblocking observations.
> Return the revision-bound code verdict, CI evidence and merge-authority status.
> Do not edit files/issues, run commands or merge.

**Conditional product review (only when Axiom requires it):**

> Act as product-ux-reviewer in a fresh, independent run. Read AGENTS.md and
> .agents/product-ux-reviewer.md. Review <PR> from <base SHA> to <head SHA>;
> changed files: <list>; accepted product contract: <path>; Axiom referral:
> <finding>; observable evidence: <captured output and screenshots>. Compare
> the current experience with the proposed one and the smallest alternative,
> including no change. Report evidenced defects separately from preferences.
> Return APPROVED / CHANGES REQUIRED / REVIEW INCOMPLETE for Axiom. Do not edit,
> run commands, approve code or merge.
