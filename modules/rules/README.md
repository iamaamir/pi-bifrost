# Rules

The route-rule engine: compile configured regex rules once, verify their safety, and match
prompts against the compiled set.

## Ownership

This capability owns:

- the rule contract (`RouteRule`, `CompiledRule`) and compilation (`compileRules`)
- compiled matching (`classifyCompiled`) and the deprecated per-call reference matcher
  (`classify`)
- pattern verification: the textual scan, the out-of-process canary probe, probe runtime
  selection and the verdict cache (`safety.ts`)

It owns nothing else. Rule discovery and route-file precedence (`config-load.ts`), the default
rule set (`config.ts`), live probe enablement (`config-agent.ts`), tier resolution, provider
scope, reliability, fallback and dispatch (`routing.ts`) stay with their existing owners.

`routing.ts` re-exports the five public names, so `pi-bifrost/routing` keeps every published
signature. `classification-pipeline.ts`, `config-agent.ts`, `config.ts`, `config-load.ts` and
`scripts/jev-benchmark.ts` import this owner file directly.

## Contract

`compileRules(rules)` compiles each `pattern` with the `i` flag and returns only the rules the
verifier accepts, in input order. An invalid pattern is logged and dropped. Rules match in
order: the first compiled rule whose pattern matches wins, so a rule earlier in the list beats
a later match that appears earlier in the text.

`classifyCompiled(text, compiled)` is a pure loop over already-compiled rules: it constructs no
`RegExp`, reads no environment, verifies nothing and spawns nothing. `classify(text, rules)` is
deprecated and exists as the parity reference; production uses compilation. `classify` constructs
a `RegExp` and verifies each rule on every call, so an uncached verdict can spawn one bounded
child process. Consumers that must not spawn use `classifyCompiled`.

## Safety checks are heuristic

Two independent checks decide whether a pattern may run. Neither is a proof of safety.

1. **Textual scan** — rejects a group repeated without a finishing bound whose body carries a
   variable quantifier, and repeated alternations whose branches ambiguously overlap. It is
   textual, cheap and never executes a pattern. Constructs it does not model are treated
   permissively, and it is deliberately conservative only in the shapes it enumerates.
2. **Canary probe** — runs the pattern against ten fixed canaries in a child process with a
   10 ms budget per match, twice per canary, batches of 32, a timeout of
   `500 + 20 × patterns` ms, `SIGKILL`, and a bounded output buffer.

A pattern is rejected when either check rejects it. Decoded verdicts are honored first: a line
`0` accepts and `1` rejects in batch order; the first line that is neither stops decoding for
that batch, the un-decoded remainder is rejected, and verdicts beyond the batch size are ignored.
A short, malformed or otherwise incomplete stream rejects the un-decoded remainder of its batch.
A timeout is the narrow exception: it rejects only the first still-pending pattern and then
continues. Later batches still run in every case.

Accepted does not mean "safe in general". It means these two heuristics found no problem on the
canaries they used. Documentation and comments must say "heuristic" and "fail closed for
unverifiable patterns", never "safe".

## Effects and state

`compileRules` (and `classify` for a pattern without a cached verdict) may read
`BIFROST_PROBE_NODE` and forward the ambient environment to one bounded child process per batch,
with `NODE_OPTIONS` cleared for the child. On a Node host the probe uses `process.execPath` so its
verdict cannot be chosen through `PATH`. On Bun or Deno it resolves `node` through `PATH` and,
if no Node binary exists, falls back to the hosting runtime; `BIFROST_PROBE_NODE` overrides the
choice on every host. The probe writes nothing to disk and opens no network connection.
`classifyCompiled` spawns nothing.

Verdicts are cached in memory by pattern text for the life of the process, so a rejection is
reported once and later compilations of the same patterns are spawn-free. The cache is
intentional module state: it is not exported, not configurable and not persisted. Tests must use
fresh pattern text rather than assuming an empty cache.

## Compatibility

`routing.ts` re-exports `RouteRule`, `CompiledRule`, `compileRules`, `classifyCompiled` and
`classify`. Configuration, schema, defaults, diagnostics and lifecycle ownership are unchanged.
`safety.ts` is internal: its `verifyRulePatterns` and `isPatternAccepted` exports exist so the
verification behavior is testable directly, and nothing outside this module imports it.

## Verification

```
node --test --experimental-strip-types modules/rules/tests/rules.test.ts
node --test --experimental-strip-types modules/rules/tests/safety.test.ts
```

Module tests bind the mutation targets directly; the isolation cases run compile-and-match in a
bounded child that imports the module under test by URL, so a mutant executes the real code and
cannot hang the runner.

## Extending or replacing

A different verifier can replace `safety.ts` behind `verifyRulePatterns` + `isPatternAccepted`
without touching routing policy. Do not weaken fail-closed rejection, do not spawn on the match
path, do not resolve the verifier through `PATH`, and do not persist verdicts. See
[AGENTS.md](AGENTS.md).
