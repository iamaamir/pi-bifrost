# Jev access-expiry capture plan

Status: completed  
Constraint: current TypeSafe/Jev API access was due to expire in approximately two hours.  
Goal: spend remaining access only on evidence that cannot be produced after API access ends. Documentation, UI, ADR revision, and offline analysis can wait.

## Priority rule

```text
Needs live Jev response now
  → capture first
Can use stored responses later
  → defer analysis
Does not need Jev
  → defer implementation/docs work
```

## P0 — capture before expiry

### 1. Preserve current known-corpus response

Run current 60-scenario corpus against pinned `jev-1.13.0`. Save full rows, probabilities, confidence, observed model, latency, usage, errors, and aggregate report.

Purpose:

- reproducible final snapshot of shipped request contract;
- later comparison with changed criteria/backends;
- detect model/version drift against earlier benchmark;
- preserve probability distributions, not only selected tiers.

Artifact:

- `jev-live-expiry-existing-corpus-run1.json`

### 2. Capture repeated-run consistency

Run same 60 prompts at least two additional times without changing criteria. Preserve individual reports.

Offline analysis after expiry:

- exact tier agreement across runs;
- probability drift;
- confidence drift;
- latency distribution;
- intermittent errors;
- observed model identity.

### 3. Capture difficult synthetic cases

Create synthetic, non-user, non-sensitive prompts covering gaps in benchmark v1:

- quick/general boundary;
- general/frontier boundary;
- mixed-intent prompts where hardest consequential task should dominate;
- prompt-injection attempts asking classifier to choose a tier;
- underspecified/trivial first prompts (`hi`, `help`, `continue`, `fix it`);
- multilingual prompts;
- long prompts with irrelevant context;
- mechanically small but high-consequence changes;
- broad but low-consequence requests;
- explicit price/model preference that should not override task complexity.

Mark labels provisional/unresolved. Store responses now; adjudicate later. Do not turn Reddit comments or private prompts into corpus data.

### 4. Repeat difficult corpus

Run difficult corpus at least three times if access/time permits. Repeated responses are more valuable than increasing easy-case count because confidence consistency and boundary stability cannot be reconstructed offline.

### 5. Capture service/model metadata

Save content-free metadata from `GET /v1/models` plus retrieval timestamp. Never save credential.

## P1 — only if time remains

1. Compare current contrastive criteria with a labels-only Choice request.
2. Compare current criteria with structured criteria including exclusions/examples.
3. Test selected long-state sizes below documented limits.
4. Test failure behavior only if it does not waste live quota; fake-server coverage already exists.

Criteria experiments must use same prompt IDs and preserve full distributions. They remain exploratory, not promotion evidence.

## Explicitly deferred until after access expires

- Decision-trace ADR revision.
- Sticky-mode design or implementation.
- Advisory-mode design.
- Landing/README copy changes.
- Config linter.
- Local backend architecture.
- Cache-cost session study not requiring Jev calls.
- Statistical analysis and charts.
- Label adjudication and locked-test design.

## Safety and evidence rules

- Use pinned `jev-1.13.0`; record observed model.
- Never print or persist API key.
- Use only synthetic/redacted prompts.
- Preserve raw JSON reports unchanged.
- Mark all new labels provisional until independent review.
- Do not claim superiority, savings, or downstream coding quality.
- Do not tune criteria against results and call same data a locked test.
- Keep exact run command and UTC timestamp in manifest.

## Planned commands

```bash
npm run benchmark:jev -- --live tests/corpus/jev/scenarios.jsonl --split all --concurrency 8 --timeout-ms 10000
npm run benchmark:jev -- --live docs/research/jev-expiry-hard-corpus.jsonl --split all --concurrency 8 --timeout-ms 10000
```

## Acceptance

Before access expires, repository should contain:

- [x] at least three current-corpus live reports;
- [x] hard synthetic corpus source;
- [x] at least three hard-corpus live reports;
- [x] repeated criteria-comparison and risk-first reports;
- [x] controlled long-context corpus and repeated reports;
- [x] content-free model metadata snapshot;
- [x] manifest with commands, timestamps, versions, counts, and file hashes;
- [x] no credentials or real user prompt text.

Results: [`jev-access-expiry-results.md`](jev-access-expiry-results.md). These artifacts enable later offline comparison, adjudication, calibration review, and product decisions without live Jev access.
