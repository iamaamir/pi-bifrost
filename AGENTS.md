# Pi-Bifrost agent guide

## Read first

Before non-trivial work, read:

1. [`PRODUCT.md`](PRODUCT.md) — users, product intent, brand constraints.
2. [`docs/product-philosophy.md`](docs/product-philosophy.md) — product guardrails.
3. Relevant ADRs in [`docs/adr/`](docs/adr/) — proposed ADRs are not implementation approval.
4. [`ROADMAP.md`](ROADMAP.md) — priority and deferral context.

## Product boundary

Bifrost is a **configuration-first router**, not a general policy engine.

It selects a suitable configured model for a coding-agent turn. It may gain routing intelligence gradually, but every signal must be observable, overridable, and testable before it silently changes a route.

```text
explicit configuration
  → observable signal
  → advisory recommendation
  → explicit user/config opt-in
  → bounded automation
```

Use the feature gate in [`docs/product-philosophy.md`](docs/product-philosophy.md) before proposing or implementing policy changes.

## Non-negotiable behavior

- Select Pi's actual active model before generation. Do not hide it behind a virtual profile.
- Never automatically replay a failed user prompt, including behind config opt-in. A prior turn may have edited files, called tools, or caused external side effects. Any future retry design requires explicit per-incident user confirmation, host-proven zero-side-effect boundary, deterministic E2E coverage, and an approved ADR.
- Persist reliability state. Circuits must survive restart and use controlled half-open recovery.
- Keep defaults model-agnostic. Do not ship maintainer-specific provider/model IDs in default routing policy.
- Keep routing inspectable: selected model, source, exclusions, fallback, and user override must be explainable.
- Keep Pi's default footer intact. Use `setStatus("bifrost-state", ...)` for Bifrost status.
- Treat normalized prompt cache data as potentially sensitive user text. Do not add response caching or prompt replay by default.

## Architecture

Keep policy separate from host adaptation.

- **Core policy:** config, classification, routing, cache, reliability, inline overrides.
- **Pi adapter:** events, `setModel`, commands, status, result rendering, probe transport.

Do not introduce a proxy as the default design. Do not build multi-agent orchestration into Bifrost.

## Change discipline

- Preserve unrelated working-tree changes. Stage only files relevant to requested work.
- Do not implement speculative ADRs, research proposals, or competitor features without explicit approval.
- Prefer smallest product-shaped change. Ship advisory/visible behavior before automatic behavior.
- Make behavior changes with deterministic tests. Prefer fake registry/provider tests over live-provider dependence.
- Keep docs, schema, examples, defaults, and generated init behavior consistent when changing config semantics.
- Use accessible semantic HTML for site work. Native `<details>/<summary>` for FAQs/disclosure unless a custom interaction is necessary.
- Treat prototypes as throwaway. Mark them clearly; do not promote prototype code directly to production.

## Verification

Run relevant checks before claiming work complete:

```bash
npm test
npm run typecheck
```

For Pi UI/routing changes, also run relevant targeted checks:

```bash
npm run test:ui
npm run test:ui:reliability
```

For landing/docs HTML changes, run at minimum:

```bash
git diff --check
```

Use local browser screenshots when layout or animation changes. Check desktop and narrow mobile viewports. Respect `prefers-reduced-motion`.

## Git

Use Conventional Commits. Keep commits atomic and scoped. Do not commit unrelated changes, generated prototypes, screenshots, research, or ADR drafts unless explicitly requested.
