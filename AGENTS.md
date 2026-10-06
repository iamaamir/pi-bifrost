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

- Select Pi's actual active model before generation. Physical selection is the default. The explicitly selected `bifrost/auto` virtual model may dispatch physical models per request when selection and dispatch both stay visible.
- Never automatically replay a failed user prompt, including behind config opt-in. A prior turn may have edited files, called tools, or caused external side effects. Any future retry design requires explicit per-incident user confirmation, host-proven zero-side-effect boundary, deterministic E2E coverage, and an approved ADR.
- Persist reliability state. Circuits must survive restart and use controlled half-open recovery.
- Keep defaults model-agnostic. Do not ship maintainer-specific provider/model IDs in default routing policy.
- Keep routing inspectable: selected model, source, exclusions, fallback, and user override must be explainable.
- Keep Pi's default footer intact. Use `setStatus("bifrost-state", ...)` for Bifrost status.
- Treat normalized prompt cache data as potentially sensitive user text. Do not add response caching or prompt replay by default.

## Universal architectural constraints
- Keep responsibilities focused and dependencies explicit.
- Prefer extending existing project patterns over introducing new architectural patterns.
- Make the smallest change necessary to solve the task correctly.

## Architecture

Keep policy separate from host adaptation.

- **Core policy:** config, classification, routing, cache, reliability, inline overrides.
- **Pi adapter:** events, `setModel`, virtual model registration, commands, status, result rendering, probe transport.

Do not introduce a proxy as the default design. Do not build multi-agent orchestration into Bifrost.

## Change discipline

- Preserve unrelated working-tree changes. Stage only files relevant to requested work.
- Do not implement speculative ADRs, research proposals, or competitor features without explicit approval.
- Prefer smallest product-shaped change. Ship advisory/visible behavior before automatic behavior.
- Make behavior changes with deterministic tests. Prefer fake registry/provider tests over live-provider dependence.
- Keep docs, schema, examples, defaults, and generated init behavior consistent when changing config semantics.
- Use accessible semantic HTML for site work. Native `<details>/<summary>` for FAQs/disclosure unless a custom interaction is necessary.
- Treat prototypes as throwaway. Mark them clearly; do not promote prototype code directly to production.
- Validate a specification against running code before building on it. When a decision cannot be checked yet, prototype rather than committing to prose across several revisions. Unverified specs surface their errors late, during review, when they cost most to fix.

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

## Evidence discipline

A passing suite is a floor, not proof. On this project a fully green run has hidden a function that contradicted the code it was copied from, four guards no test exercised, and a documented command that could not parse its own advertised output. Run the checks, then show what they do not cover.

- **Never transcribe output.** Any sample in a spec, plan, doc, or PR body must be captured from a real run and diffed against live output. A hand-written sample described as generated is a defect, not a shortcut.
- **Execute every command you document.** If a doc claims machine-readable output, pipe it into a parser and paste the result.
- **Mutation-check assertions that guard a contract.** Revert the guard, confirm the test goes red, report the count. An assertion never seen failing is not evidence. Scope this to behavioural contracts — routing, model selection, reliability, state precedence, escaping, output shape — and leave pure wiring tests alone.
- **Claim with evidence attached.** Say "verified" only alongside the command and its output in the same message. Never assert a suite passed without the count.
- **Correct an instruction you were given.** If a prescribed step is wrong, say so and show the contradiction rather than reporting the expected result.

### Reviewing

Confirm the target before reviewing: base and head refs, both SHAs, and the changed-file list. Abort if the diff does not match the branch under discussion. A review of the wrong branch yields confident findings about unrelated code and costs a full round.

## Git

Use Conventional Commits. Keep commits atomic and scoped. Do not commit unrelated changes, generated prototypes, screenshots, research, or ADR drafts unless explicitly requested.

Never add a `Co-Authored-By` trailer to a commit, in any form. Do not add agent, assistant, or tool attribution to a commit message, and do not add "generated with" footers to a pull request body. Authorship belongs to the human author only.
