# Bifrost product philosophy

Bifrost is a **configuration-first router**, not a general policy engine.

Its job is to select a suitable configured model for each coding-agent turn, safely and visibly. Research helps Bifrost improve that choice; it does not justify opaque automation or uncontrolled scope.

## Core promises

1. **Direct** — select the host's actual active model before generation when the host supports it.
2. **Safe** — preserve user work. Do not automatically replay a turn that may have edited files, invoked tools, or touched external systems.
3. **Inspectable** — show what was selected, why it was selected, what was excluded, and how a user can change it.
4. **User-owned** — configuration and explicit user actions remain the primary policy surface.
5. **Portable** — share routing/reliability policy where host capabilities permit; keep adapters thin; do not make a proxy the default architecture.

## Gradual intelligence ladder

Bifrost may add intelligence only in this order:

```text
explicit configuration
  → observable signal
  → advisory recommendation
  → explicit user/config opt-in
  → bounded automation
```

A new signal starts as visible evidence. It must not silently change a route until users can inspect, override, and test its effect.

Examples:

- Probe freshness may appear in a decision trace before it reorders candidates.
- Context fit may warn before it excludes a model.
- A routing mode must be explicit, named, visible in status, and reversible.
- Failure categories may improve repair guidance before they alter cooldown policy.

## Feature gate

Before approving a feature or ADR, answer all five questions:

1. **User value** — Does it choose better, act safer, or improve explanation/control?
2. **Explicit policy** — Can a user configure or deliberately invoke it?
3. **Visibility** — Does preview/trace/status show its effect and reason?
4. **Override** — Can a user pin, bypass, disable, or otherwise reverse it?
5. **Proof** — Does deterministic scenario coverage validate its behavior and regressions?

If any answer is no, ship the smaller advisory or observability version first, or keep it in research.

## Boundaries

Bifrost does not grow by copying every competitor feature.

- No hidden replay of arbitrary user work.
- No opaque model scoring that overrides declared policy without trace or opt-in.
- No prompt-guided delegation as a substitute for direct host model selection.
- No proxy-first architecture when a host exposes a safe native model-switching capability.
- No generic multi-agent orchestrator scope.

## Decision rule

Adopt smallest product-shaped version of a researched idea. Upgrade only after real user need, visible evidence, and regression coverage support next step.
