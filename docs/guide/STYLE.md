# Guide writing standard

This standard applies to all user-facing documentation, including public SDK and reference documentation where present. The paths listed here (`docs/guide/`, `README.md`, `docs/index.html`, `docs/llms.txt`, and `examples/README.md`) are representative examples, not an exhaustive allowlist. Maintainer documents stay exempt. ADRs, PRDs, research notes, release ledgers, and process files may keep implementation detail.

`STYLE.md` is a maintainer process document. It is not a user guide page.

Factual accuracy comes first. Preserve security, privacy, operational safety, compatibility limits, failure boundaries, cost and retention disclosures, and recovery safeguards even when that requires negative language or conditions. Rewrite only when the replacement keeps the same behavior and consequence.

## One page, one primary form

Use [Diátaxis](https://diataxis.fr/). Each substantive guide page has one primary form recorded in the `Guide map` table in [`index.md`](index.md). Update the table when you add or move a page.

| Form | Primary reader need | The page contains |
| --- | --- | --- |
| Tutorial | Learn through a successful experience | A first successful path in order |
| How-to | Achieve a specific practical outcome | Actions for a reader who already knows the basics |
| Reference | Retrieve accurate, sufficiently complete facts | Austere lookup material with clear scope and conditions |
| Explanation | Understand behavior, relationships, and tradeoffs | Background, design reasons, and tradeoffs |

Use this table to judge fit. Do not split content only because a short supporting sentence could belong elsewhere if the split would hurt navigation or flow.

**Navigational and hybrid entry points.** README files, landing pages, indexes, and examples collections may combine orientation, navigation, and practical instructions when that helps readers find work. Record a primary form for substantive guide pages; for hybrid entry points, state the primary purpose in context (for example, “index: navigation and orientation”) and keep factual claims aligned with the canonical pages they point to. Do not create extra documentation categories.

When a page truly needs two jobs, prefer adding links and keeping one clear primary job over multiplying pages without benefit.

## Writing rules (apply to every paragraph)

1. **Serve the form.** Name what the reader needs in that form: to learn, to do a task, to look up facts, or to understand tradeoffs. If a paragraph serves none of these for that page, move it or remove it.
2. **Preserve what readers need to be safe and correct.** Keep information required for understanding, accurate interpretation, informed decisions, safe execution, verification, and recovery. Remove only redundant prose or material that belongs in maintainer documents. A shorter sentence that broadens, narrows, hides an exception, or changes a guarantee is not an improvement.
3. **Use an observability and consequence test (not “who acts”).** Keep information that is externally observable or materially affects the reader: limits the reader can hit, errors the reader sees, required flags or prerequisites, data boundaries, costs, privacy and retention effects, security and operational consequences, compatibility constraints, and recovery actions. The fact that the reader does not directly control a mechanism does not remove it from user docs if it affects outcomes. Move implementation internals to maintainer documents: parser or storage mechanics, internal function names, file-resolution helpers, symlink internals, version semantics the reader does not set, and repository workflow or ADR citations used as authority. A public configuration key the reader must type stays in user docs (including JSON examples); explain its implementation elsewhere only if needed.
4. **Choose one authoritative explanation, with contextual repetition when needed.** Each guarantee has one canonical page that carries the full explanation. Other pages may repeat important points concisely at the point of use when readers need them there: defaults, prerequisites, privacy disclosures, costs, destructive operations, compatibility restrictions, and recovery safeguards. Repeated summaries must not contradict the canonical page. Links help discovery but are not enough when a materially affecting safeguard must be stated before the reader acts (for example, a preview workflow must state before running it that an enabled classifier may receive the prompt, with a link to classifier details).
5. **Place content by job.** Put learning steps in tutorials, task steps in how-tos, lookup material in reference, and reasons in explanations. Do not mix forms on a substantive page without a clear reason.

## Semantic preservation (required for edits)

When you rewrite documentation, preserve the meaning, scope, conditions, exceptions, and externally observable consequences of existing claims unless you correct a verified inaccuracy.

- Distinguish editorial rewrites from factual corrections. If a factual claim changes, verify the new claim against relevant evidence before publishing it.
- Do not soften, remove, or relocate a boundary (security, privacy, compatibility, failure, cost, retention, or recovery) for style. State it plainly.
- Negative language is fine when it is more precise than a positive paraphrase.

## Evidence policy

Verify behavioral claims against relevant implementation, tests, schemas, defaults, and supported host contracts when practical.

- Distinguish **shipped behavior**, **experimental behavior**, **historical observations**, **proposed functionality**, and **product guarantees**. Do not present proposals or plans as current guarantees.
- ADRs and PRDs express intent; they are not proof that current code behaves as written. When implementation, tests, and existing docs disagree, investigate and report the discrepancy. Do not silently rephrase a claim to avoid the conflict.
- For benchmarks, performance statements, compatibility notes, costs, and provider behavior, state the relevant scope and conditions (environment, version, account or plan assumptions, or “as observed in…” when historical).
- If a material new or changed behavioral claim cannot be verified, do not publish it as an established guarantee. Preserve previously verified wording where appropriate, qualify the uncertainty, or report the unresolved discrepancy. Routine grammatical edits do not require new evidence collection beyond the normal review of the change.

## Precedence when rules conflict

Use this order:

1. Factual accuracy and preservation of meaning.
2. Security, privacy, and operational safety.
3. Completeness appropriate to the reader’s need.
4. Clarity and discoverability.
5. Consistency and conciseness.
6. Mechanical style preferences.

Prefer clear sentences. Never split or remove conditions in a way that changes meaning.

## Keep internals out

The guide serves readers who install and use Bifrost. Exclude implementation details from guide prose when they do not materially help the intended reader understand, interpret, decide, operate, verify, or recover.

Examples of details to keep in maintainer docs when they have no material effect on readers: parser mechanics, internal function names, file-resolution helpers, symlink implementation details, version semantics that the reader does not set, and repository workflow, document ownership tables used as process, or ADR citations used as authority.

Include material details when they affect readers’ outcomes or interpretation: externally observable limits, errors the reader sees, required flags or prerequisites, file permissions or credential paths that affect use, retry or rotation limits that change behavior, unsupported transports, data boundaries, costs, privacy and retention effects, security and operational consequences, compatibility constraints, and recovery actions. State the effect and the reader’s action when relevant; put mechanism-only explanation in maintainer docs.

Public configuration keys the reader must type stay in user docs (including JSON examples). Their implementation explanation belongs in maintainer docs when helpful. Do not exclude consequential public contracts from user docs because the reader does not directly control an underlying mechanism.

## Write in plain English

Follow [ASD-STE100](https://www.asd-ste100.org/) practices for added prose where practical:

- prefer one term for one meaning;
- use active voice when it is clearer;
- give one instruction per sentence when possible;
- put conditions before commands when it aids understanding.

Use [Vale](https://vale.sh/) with Google and Microsoft styles for mechanical checks when configured. Vale reports findings; a human decides whether a finding is a defect. Lint counts are observations, not goals.

## Examples (verified patterns from this repository)

These examples show the standard in use. They are drawn from current Pi-Bifrost docs and code behavior, not invented.

1. **Appropriate deletion of an irrelevant implementation detail (how-to context).** In a task page, remove “how the parser walks nested objects internally.” Keep “a tier key must be a single lowercase alphabetic word or the message is not treated as a prefix” if the reader can trigger that rule.
2. **Preserve a necessary operational limitation (reference/context).** Keep “Preview does not submit a generation turn or activate the selected model.” State it before examples so readers do not assume side effects.
3. **Necessary repetition of a privacy disclosure (point of use).** In a preview workflow, repeat that an enabled classifier may receive the prompt before the command, and link to the classifier page for details. Do not rely only on a link from a different section.
4. **A negative statement that should remain negative.** Keep “Pi does not fetch billing data or provide an account-level spend cap.” A positive rewrite would misstate capability.
5. **A rewrite that becomes inaccurate through excessive simplification.** Avoid changing “offline preview bypasses classifier calls for that request and does not change session classifier settings” to “offline preview is private.” The original preserves scope (that request, session settings unchanged) and does not overclaim no other network activity.

## Review checklist

- The page has one primary form (or a justified hybrid/navigational purpose) consistent with the guide map for substantive pages.
- Paragraphs serve that form’s reader need; nothing essential for safe, correct use was removed for brevity.
- Externally observable effects, limits, errors, and safeguards are stated where readers need them.
- Implementation details stay out of user docs when they do not materially help the intended reader understand, interpret, decide, operate, verify, or recover; consequential public contracts remain in user docs even if the reader does not directly control the underlying mechanism.
- Each guarantee has a canonical explanation; repeated summaries at point of use are consistent and include critical disclosures before action when required.
- No security, privacy, failure, compatibility, cost, or retention boundary was removed or weakened for style.
- Claims that changed as facts were verified against evidence; proposals are not stated as shipped guarantees.
- Language is clear and consistent with project terms; negative phrasing remains when it is more precise.
- Mechanical lint results, if any, are treated as signals, not success criteria.

## Sources

- Diátaxis: <https://diataxis.fr/>
- ISO/IEC/IEEE 26514:2022: <https://www.iso.org/standard/77451.html>
- ASD-STE100: <https://www.asd-ste100.org/>
- Vale: <https://vale.sh/>
- Carroll, *The Nurnberg Funnel* (1990)