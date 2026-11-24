# Bifrost product philosophy

Bifrost is a **configuration-first router**, not a general policy engine.

Its job is to select a suitable configured model for each coding-agent turn, safely and visibly. Research helps Bifrost improve that choice; it does not justify opaque automation or uncontrolled scope.

## Core promises

1. **Direct** — select the host's actual active model before generation when the host supports it. Where the host offers native virtual models, an explicitly selected virtual mode may dispatch the physical model per request as long as selection and dispatch stay visible.
2. **Safe** — preserve user work. Do not replay a turn that may have emitted assistant content, invoked tools, or touched external systems. The narrow, configurable allowance-recovery exception in [ADR 0023](adr/0023-bounded-allowance-recovery.md) applies only when Pi proves the failed initial Auto generation had no such effects.
3. **Inspectable** — show what was selected, why it was selected, what was excluded, and how a user can change it.
4. **User-owned** — configuration and explicit user actions remain the primary policy surface.
5. **Portable** — share routing/reliability policy where host capabilities permit; keep adapters thin; do not make a proxy the default architecture.

## Reusable capabilities and host boundaries

**Reusable Bifrost policy should not depend on the host that invokes it.** Routing decisions and other reusable domain capabilities belong behind focused contracts; Pi-specific events, active-model switching, command execution, UI and lifecycle effects belong in host adapters. Keep dependencies directed from adapters toward reusable capabilities, not the reverse.

When extracting or evolving a **reusable** capability, assess three questions:

1. **Independent execution** — Can it run and be tested without initializing Pi, a Pi session or its UI?
2. **Host-neutral contract** — Could another host or SDK consumer use it without importing Pi-specific contexts, registry objects, event types or UI concepts? Translate host data at the boundary; even type-only host imports should be justified.
3. **Replaceable implementation** — Could its implementation change behind a small contract without requiring consumers to be rewritten?

Prove the boundary with direct contract tests where appropriate, supported import-boundary checks, and existing integration/package tests. Focused mutation tests may strengthen behavioral evidence; smaller test runs are not a substitute for cross-boundary verification.

**Host-neutral does not mean side-effect-free.** A capability may legitimately own focused I/O, persistence or bounded subprocess safety checks. Pi-only adapters need not pass the host-neutrality test; they should keep those host effects out of reusable policy. Prefer existing interfaces and the smallest meaningful extraction over generic ports or speculative dependency injection.

**Reuse native capabilities before rebuilding them.** Extend where necessary, compose where appropriate, and delegate when the host already provides the required functionality. Check the host's official documentation and relevant implementation before introducing an alternative. Reuse native APIs, types and functions when their contracts meet Bifrost's requirements. Introduce new abstractions only for a distinct responsibility or a meaningful boundary. Keep host-specific dependencies within the appropriate integration boundary; reuse must preserve separation of concerns, replaceability and independent testability.

Internal module contracts are **not automatically public SDK APIs**. Broader SDK exposure and additional host integrations require concrete consumer needs, explicit compatibility decisions and their own evaluation; portability alone does not authorize new packages, extension mechanisms or a proxy-first architecture.

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

- No hidden replay of arbitrary user work; see the bounded, observable exception in ADR 0023.
- No opaque model scoring that overrides declared policy without trace or opt-in.
- No prompt-guided delegation as a substitute for direct host model selection.
- No proxy-first architecture when a host exposes a safe native model-switching capability.
- No generic multi-agent orchestrator scope.

## Decision rule

Adopt smallest product-shaped version of a researched idea. Upgrade only after real user need, visible evidence, and regression coverage support next step.
