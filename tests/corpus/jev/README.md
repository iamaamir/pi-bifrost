# Jev development corpus

`scenarios.jsonl` is labelled **DEVELOPMENT** data for evaluation-only comparison of the current regex/default baseline and TypeSafe Jev. Labels describe task complexity, not preferred price or model. They do not authorize production routing.

Each record includes stable ID, synthetic prompt, task family, gold tier, rationale, ambiguity, and split. The harness computes baseline metadata from current rules at run time so it cannot become stale. Keep prompts synthetic/redacted: do not add source files, tool output, session history, secrets, or real user prompts. Append records; do not reuse IDs.

## Tier policy

- `quick`: bounded, reversible, obvious work such as formatting, lookup, or small mechanical edits.
- `general`: normal implementation, tests, API changes, and moderate reasoning with clear scope.
- `frontier`: complex debugging, architecture, security, ambiguity, concurrency, or consequential work.

Use contrastive pairs where possible. Record ambiguity and acceptable alternatives rather than hiding disagreements. Unresolved records stay out of primary strict accuracy. Baseline is current default regex behavior, not gold truth.

Run offline:

```sh
npm run --silent benchmark:jev -- --baseline tests/corpus/jev/scenarios.jsonl --split dev > report.json
```

Run live only by explicit opt-in after exporting `TYPESAFE_API_KEY` outside shell history:

```sh
npm run --silent benchmark:jev -- --live tests/corpus/jev/scenarios.jsonl --split dev > report.json
```

The default split is `dev`. Running `review` requires explicit `--split review`; do not use review results to tune criteria and then present the same split as untouched evidence.

Live output is preliminary development evidence. It does not change routing, persist prompts, or establish a promotion claim.
