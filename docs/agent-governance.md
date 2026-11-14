# Issue challenge and final review

The lifecycle in [AGENTS.md](../AGENTS.md#delivery-lifecycle) is the authority.
The [Issue Challenger](../.agents/issue-challenger.md) checks readiness before coding;
[Axiom](../.agents/axiom.md) checks the actual final candidate. Use separate fresh
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

For [#176](https://github.com/iamaamir/pi-bifrost/issues/176), fetch the current
protocol, issue/comments, wave parent and native blockers before challenge.
Require the local-only roadmap for programme execution; never commit it. Preserve
all dependency, SDK-first, RED/GREEN, privacy and wave/promotion gates. Previously
adjudicated facts need reconciliation with current source, not another full audit
without new evidence. #146 remains baseline-only and source-change-free.

## Using the definitions

The definitions reuse the existing `.agents/*.md` layout. Installed
pi-subagents 0.88.1 documents legacy project discovery there; `.pi/agents` can
override a same-name definition. Inspect the selected definition and effective
tools before relying on it. Use project scope and explicit fresh context when
launching through pi-subagents. Both roles declare only read, grep, find and ls;
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

## Handoff prompts

Replace angle-bracket fields with real revisions, snapshots and evidence. These
are task templates, not commands or claims of an executed challenge/review.

**Challenge (future #146 work, after governance approval):**

> Act as issue-challenger, independently of the author. Read AGENTS.md and
> .agents/issue-challenger.md. Challenge #146 against <delivery branch and SHA>.
> Inputs: <current #176 protocol, #146/comments, #169 and native blocker snapshot>,
> <local roadmap path>, <prior adjudication/report>. Trace current owners and
> map every acceptance criterion to evidence. Preserve source-change-free scope.
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
> Verify target binding, applicable invariants and acceptance criteria. Separate
> evidenced blockers, missing required checks and nonblocking observations.
> Return the revision-bound code verdict, CI evidence and merge-authority status.
> Do not edit files/issues, run commands or merge.
