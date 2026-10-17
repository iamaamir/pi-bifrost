---
name: configure-bifrost
description: Compose and safely apply Pi-Bifrost routing configuration from a plain-language goal — pick tiers and strategies for cheap coding, strong reasoning, review or multi-agent workflows, cost limits, and subscription-only preferences. Use when asked to configure Bifrost for my workflow, optimize Bifrost routing for cost or quality, set up model tiers from my available models, prefer subscription models and avoid metered fallback, improve or explain my current routing config, or create a quality-first, budget-conscious, or multi-agent routing policy.
---

# Configure Bifrost

Turn a routing goal in plain language into a **valid, reviewed, ordinary
`bifrost.json`**. Bifrost owns the primitives, validation, and write safety. You
own the goal, the composition, and the explanation.

You never invent configuration fields, models, prices, or guarantees. If the
goal needs something Bifrost does not do, say so.

## Workflow

1. **Read the goal.** Extract: primary objective (quality, cost, latency,
   reliability, continuity), kind of work (coding, review, debugging,
   architecture, routine automation), model preferences and restrictions,
   billing constraints, and how much routing flexibility is wanted. If the
   request already answers these, do not ask anything.
2. **Inspect before proposing.** Call `bifrost_config` with
   `{"operation":"inspect"}`. This returns the real model inventory with exact
   `provider/id` keys, cost and context metadata, the config layers with their
   precedence, the current effective policy, the baseline tiers, and current
   restrictions. Never use a model id from memory or from documentation. When the
   inventory is long, repeat inspect with `"provider": "<id>"` to list one
   provider's models; the filter only narrows what is reported.
3. **Compose the smallest policy that meets the goal.** See
   [references/configuration-reference.md](references/configuration-reference.md)
   for the fields, strategies, and worked examples. Prefer few tiers and
   explicit pools; add classifier, economics, affinity, or reliability only when
   the goal needs them.
4. **Check the candidate.** Call `bifrost_config` with
   `{"operation":"check", ...}`. Fix every reported error. Read the reported
   warnings, pool references, and `newlyEligibleModels` before showing anything
   to the user.
5. **Preview routing outcomes.** Call `bifrost_config` with
   `{"operation":"preview", ...}` and 2–5 representative prompts drawn from the
   user's real work. Preview is offline: it sends nothing anywhere.
6. **Explain the proposal in a few lines.** Model assignments per role or tier,
   the tradeoffs you chose, and the honest limits. No JSON dump unless the user
   asks.
7. **Ask, then apply.** Get explicit approval in the conversation, then call
   `bifrost_config` with `{"operation":"apply", ...}` and pass back the
   `proposalDigest`, `sourceDigest`, `effectiveDigest`, and `catalogDigest`
   printed under "apply digests" by check or preview — copy them exactly,
   character for character. The tool asks for approval again in the Pi UI and
   refuses if any input changed. Never apply without the user's agreement, and
   never after the check reported an error. Without an interactive session the
   tool fails closed and writes nothing.

`check`, `preview`, and `apply` all take the same candidate form:

```json
{ "operation": "check",
  "source": "project",
  "patch": { "default": "implement", "models": { "implement": ["provider/cheap-model"] } },
  "remove": ["tierPolicies"] }
```

- `source`: `project` (`.pi/bifrost.json`, default), `workspace`
  (`./bifrost.json`), or `user` (`~/.pi/agent/bifrost.json`).
- `patch`: top-level fields to merge into the selected source.
- `candidate`: the complete new content of the selected source (mutually
  exclusive with `patch`).
- `remove`: top-level fields to delete; only with `patch`.

## Rules that change what you can propose

**Layers merge; the baseline never disappears.** The bundled extension config is
the lowest layer and always contributes the baseline tiers `quick`, `general`,
and `frontier` (empty pools until a user or init fills them) plus their
`categoryStrategies` entries and the default `rules`. Consequences:

- Custom tier names are *additive*. A candidate that lists only `orchestrator`,
  `implement`, and `review` still has the three baseline tiers, with empty pools.
- `default` must name a tier that exists in the merged config.
- Every key of `categoryStrategies` must exist in the merged `models`.
- The bundled default `rules` route to `quick`, `general`, and `frontier`. A
  policy with custom roles should supply its own `rules`, or use the baseline
  tier names, or the user's review prompts will fall back to the default tier.
- A file-based `.pi/bifrost-routes.json` (or `./bifrost-routes.json`) overrides
  `rules` entirely while it exists. `inspect` reports it.

**A proposed source replaces only what the user asked for.** Use `patch` to add
or change named top-level fields; the other sources and unrelated keys stay
untouched. `apply` writes exactly one source atomically, and reports the exact
fields it adds, replaces, and removes.

**Only claim what Bifrost does.** Read
[references/configuration-reference.md](references/configuration-reference.md)
before describing behavior. In particular:

- Bifrost enforces no spending cap. Economic settings are declared or estimated
  facts that inform routing; they are not a budget.
- Price metadata cannot predict cost per successful task and does not prove
  savings. Say "cheaper per token for the models you have", never "guaranteed
  cheaper".
- Bifrost does not manage provider prompt caches and cannot promise cache reuse.
  Session affinity keeps a proven same-tier model for continuity, but it stays
  inside the tier that resolved last and does not cross tiers.
- Preview is not execution. No prompt is sent, no model is called, no classifier
  runs.
- Auto affinity, reliability v2, and allowance recovery have their own limits;
  do not present them as general guarantees.

**Uncertainty is normal.** When the catalog metadata cannot tell you which model
is better, use the user's stated preference, or a defensible conservative default
(the model the user already pays for, or the stronger model for the riskier
role), and say what you could not determine.

## Composing a policy

Pick the shape from the goal, then the smallest set of primitives:

| Goal signal | Shape |
| --- | --- |
| Fixed roles (orchestrator, implementer, reviewer) | One tier per role, one model per tier, `classifier.enabled: false`, role `rules` and inline tier prefixes |
| "Cheap by default, strong when it matters" | A cheap default tier with a `cheapest`/`cheapest_input` strategy plus a reasoning tier reached by rules |
| "Never silently spend more" | Explicit `tierPolicies[tier].fallbackTiers`; an empty list is terminal |
| Several eligible models in one role | Ordered pool plus `first`, `cheapest`, `largest_context`, or `random` |
| Long sessions, model continuity | Consider `affinity.mode` and explain its limits; do not promise cache reuse |
| Subscription-first with metered fallbacks | `economics.preference.billingClass` with declared observations, and say that it is a preference, not a cap |
| Mixed requests that need judgment | Keep the classifier enabled and give every custom tier explicit `classifier.criteria` |

Leave out anything the goal does not need. If you keep the classifier enabled,
write criteria for every custom tier; if the roles are fixed, prefer
`classifier.enabled: false`. Do not add economics, affinity, or reliability
fields as decoration.

## Reporting

Aim for five to ten lines:

```text
Tiers: orchestrator -> provider/strong (first)
       implement -> provider/cheap (cheapest), fallback: review
       review -> provider/reviewer (first), no fallback
Classifier: off (roles are chosen by rules and inline tier prefixes)
Tradeoff: review prompts that do not match a rule use the default tier.
Not covered: Bifrost cannot cap spending; the metered preference is advisory.
Apply to .pi/bifrost.json? (adds models, default, rules, schemaVersion)
```

After a successful apply, state that the configuration is active, or that
`/bifrost reload` is required, and name the tier prefixes or rules the user can
use per turn.

## Do not

- Do not edit configuration files by hand or with shell tools; use the tool so
  validation, layering, and writes stay safe.
- Do not run `/bifrost init`, model probing, or a registry refresh to satisfy a
  goal: those operations can send provider requests and spend credits. Work with
  the inventory `inspect` reports.
- Do not retry `apply` after a `stale` result with the same digests. Re-inspect,
  re-check, and re-confirm with the user. A project with no configuration yet
  can receive Bifrost's automatic first-use starter pools while you work, so a
  proposal made before that save goes stale — re-run check and confirm again.
- Do not claim Bifrost controls a model that another orchestration extension
  pins explicitly.
