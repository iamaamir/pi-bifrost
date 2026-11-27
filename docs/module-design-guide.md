# Module design guide

**Status: Proposed engineering guidance.** Validate the guide through authorized capability work and representative applicability reviews before repository-wide adoption. It does not authorize production refactoring or new gates.

**Audience:** Developers, coding agents and reviewers.

Design around behavioral contracts. Implement with the simplest suitable techniques. Establish confidence through evidence.

## Purpose and authority

A module makes a coherent capability easier to understand, change, verify and replace. Modularity controls knowledge and the impact of change; file counts and directory structure are not measures of architectural success.

This guide supplements [AGENTS.md](../AGENTS.md), [PRODUCT.md](../PRODUCT.md), [product philosophy](product-philosophy.md) and accepted architectural decisions. The [coverage contract](testing-coverage.md), [developer tooling](dev-tooling.md) and [agent governance](agent-governance.md) retain their existing authority. Follow their full requirements, including applicable challenge, adjudication, correction bounds, verification, evidence and independent review. This guide creates no additional approval lifecycle, gate substitution or merge authority. Resolve conflicts with the owner before affected work proceeds.

In this proposal, **MUST** and **MUST NOT** describe candidate requirements for adopted capability modules; **SHOULD** describes a preference whose material trade-offs merit explanation; **MAY** identifies an optional technique. Research directions are not implementation authorization.

## Scope: what constitutes an adopted capability

A capability owns a coherent domain responsibility or integration responsibility, with identifiable consumers, behavioral guarantees and a meaningful verification boundary. An adopted module is a capability whose ownership, scope and applicable constraints are explicitly established through the existing authorized issue or architecture process.

A directory, exported function, source file or helper does not automatically constitute an adopted module. Small cohesive helpers remain with their owners. Neither file size nor number of callers alone determines adoption.

For new or extracted capabilities, identify actual owners, callers, state, effects and contracts at the delivery revision. Compare keeping the current implementation, a minimal extraction and any justified larger boundary. Establish which knowledge should remain private and which consumers should depend on it. Record the adopted boundary and relevant constraints in the existing delivery contract. Do not create a registry or a separate approval process merely to classify modules.

Adoption is incremental. Ordinary maintenance does not require converting all legacy files into modules. A capability directory is appropriate when it provides meaningful locality for implementation, documentation, instructions and tests.

## Architectural guarantees

An adopted module MUST:

- Own a coherent responsibility with explicit non-responsibilities. Keep each policy decision with one authoritative owner.
- Hide internal representations, algorithms and state behind the smallest useful behavioral contract. Preserve change locality and consumer substitutability.
- Maintain explicit dependency direction; avoid cycles, reverse coupling to consumers and competing implementations of the same policy.
- Preserve authorized behavior, existing configuration semantics, eligibility, user intent and lifecycle ownership. Do not introduce product features or public APIs through extraction.
- Reuse suitable existing domain contracts, language facilities and host capabilities. Check official host documentation and relevant implementation before introducing an alternative.
- Keep reusable policy host-neutral and independently executable. Justify even type-only host dependencies at the appropriate integration boundary.
- Preserve consumer-specific effect authority and compatibility, not just import compatibility.
- Provide accessible local documentation, instructions, module-owned verification and evidence at the natural boundary.
- Remain subject to all applicable repository verification and governance.

### Host neutrality and effect authority

Host neutrality describes which technology a capability depends on. Effect authority describes what the capability is permitted to do for a particular consumer. Neither implies the other.

Reusable capabilities MAY own intrinsic state, I/O, storage or bounded subprocess work. Host-specific adapters MAY depend on the actual host when that is their responsibility. Do not introduce synthetic portability layers to disguise legitimate dependencies.

Extraction MUST NOT grant new authority. Keep decision-making, execution, credential ownership, persistence, settlement, cancellation and dispatch with their established owners unless an authorized change establishes a different contract. Check the transitive call graph and observable effects, not only direct imports.

For example, the [resolve-only Router SDK](router-api.md) evaluates explicit snapshots and returns advisory decisions. It does not autonomously load configuration, credentials or environment data, persist state, dispatch requests, reserve capacity or update sessions. External classification requires an explicitly supplied and granted classifier port and the applicable configuration. Reusing a stateful host-neutral capability MUST NOT introduce unauthorized effects into this path. Preserve the existing authoritative routing resolver and host-owned execution and revalidation.

## Documentation and local instructions

Each **adopted capability module** MUST carry a concise developer-facing README.md, module-local AGENTS.md and colocated module-owned tests. These requirements do not apply to every helper or implementation file. Scale the documentation to the actual responsibility; a short contract and a few local instructions may suffice.

### README.md: understand the capability

**Context before implementation.** The README MUST be self-contained. An unfamiliar
reader must understand the module's purpose, contribution to Bifrost, behavior,
integration boundaries and design rationale without reading source or historical records.

Cover:

- Purpose and product context, including relevant configuration or workflows.
- A valid, representative input/output example that distinguishes module results from system decisions.
- Consumers, entry points, dependency direction, lifecycle and ownership boundaries.
- Contracts, invariants, dependencies, effects, state and failure behavior.
- Design rationale, relevant alternatives, trade-offs, limitations and compatibility.
- An exact isolated verification command and safe extension or replacement guidance.

Use diagrams where they clarify the mental model. Keep examples and diagrams consistent
with actual behavior; illustrative examples are not execution evidence.

Scale detail to the capability. These are information requirements, not a template.
Link to authoritative contracts and ADRs for depth; do not duplicate invariants or
implementation details. Follow repository writing guidelines.

Reviewers MUST check standalone comprehensibility and accuracy against actual source
and consumers within existing module review. No additional automated gate is implied.

### AGENTS.md: govern changes

Reference repository-wide instructions and the local README. Include only local boundaries, prohibited dependencies, safety constraints and relevant verification instructions. A short file is sufficient when the root instructions and README already express most requirements.

Agents MUST read applicable ancestor and module-local instructions before modifying a capability, regardless of harness-specific discovery. Reviewers apply the same constraints. Reading is a responsibility, not a mechanically provable claim of comprehension; verify observable compliance through source, tests and review. Local instructions MUST NOT weaken repository-wide rules.

### Illustrative layout

    capability/
      README.md
      AGENTS.md
      selection.ts
      tests/
        selection.test.ts
        selection-properties.test.ts

Use domain-specific names. The implementation can remain one cohesive file or grow into meaningful internal responsibilities. Do not mandate types, constants, utilities, factories or index files. No independent package, build system, TypeScript project or test framework is required.

## Contracts and implementation

A contract is not merely a TypeScript signature. Specify the behavior consumers rely on, including relevant:

| Aspect | Contract questions |
| --- | --- |
| Input and preconditions | Accepted values, units, ranges, ordering, trust and invalid input. |
| Output and postconditions | Results, absence, identity, ordering and guarantees. |
| Invariants | Conditions that remain true across operations and implementations. |
| Effects and authority | What may be read, mutated, written, dispatched or logged; who authorizes it. |
| Errors and uncertainty | Returned, thrown or propagated failures; unknown evidence and safe behavior. |
| Lifecycle and resources | Initialization, concurrency, cancellation, deadlines, cleanup and bounded work. |
| Compatibility | Existing consumers, configuration, data formats, package imports and supported behavior. |

Use runtime validation at untrusted boundaries. Do not silently convert missing or uncertain data into authoritative facts. Use TypeScript to represent valid states and communicate guarantees, without mistaking static types for runtime validation.

A replacement MUST preserve observable guarantees, not merely compatible signatures. Behavior-oriented tests should survive changes to internal algorithms. A different language or WebAssembly implementation is a possible future technique, not a requirement. Use an alternative prototype only when it resolves material uncertainty; do not build a second production implementation or dynamic registry to demonstrate ordinary substitutability.

### Imports and encapsulation

Import directly from the file that owns the contract or actual behavior. Keep implementation details unexported where possible. For multi-file capabilities, restrict cross-boundary imports to appropriate contract-owning entry points.

New barrel files MUST NOT be introduced, including re-export-only aggregation layers. A meaningful entry point that owns actual behavior or composition is not a barrel. Preserve necessary existing compatibility exports from legitimate implementation modules during extraction. This does not authorize a new convenience barrel. A stable behavior-owning entry point can delegate to private algorithms without exposing their file layout.

Use explicit relative imports by default. Native package import aliases are a research direction, not required architecture. Do not use a TypeScript-only alias that breaks runtime resolution. Any future alias adoption must establish Pi source loading, Node and TypeScript resolution, emitted SDK and declaration behavior, installed-package imports, dependency and mutation discovery. No third-party resolver is justified solely to shorten paths.

### Implementation preferences (non-normative)

Choose techniques by responsibility, correctness and measured workload. Prefer clear, idiomatic TypeScript: narrow structural types, generics preserving caller identity, readonly inputs when mutation is prohibited, discriminated unions, exhaustive checks, satisfies, and unknown at trust boundaries. Use explicit time and randomness inputs where deterministic verification requires them.

Separate deterministic decisions from external effects when beneficial. The existing authorized effect owner executes and revalidates where required. Prefer composition and native facilities to unnecessary abstractions. Classes, mutable state and effect-owning implementations are legitimate when their responsibilities warrant them.

| Technique | When useful |
| --- | --- |
| Strategy, switch or typed function table | A closed set of selection behaviors shares a contract. |
| Adapter | External or host representations need translation. |
| State machine | Invalid states and lifecycle transitions matter. |
| Pipeline | Ordered stages have distinct semantics and owners. |
| Policy or specification | Interpretation or authorization needs independent evaluation. |
| Factory | Stateful construction or resource preparation is necessary. |
| Command, decorator, repository, observer | Actual execution, instrumentation, persistence or notification needs justify the pattern; prefer existing native mechanisms. |

No design pattern is mandatory. Do not create classes, interfaces, factories, generic rule engines or dependency-injection frameworks to satisfy a pattern checklist.

For performance-sensitive operations, assess actual workload, expected scale, time and space complexity, worst cases, order, identity and resource bounds. Use simple appropriate structures: linear selection when only one winner is needed; sets for membership; maps for justified repeated lookup; precompiled bounded matching; bounded caches, queues and time-window state. More complex algorithms need a demonstrated benefit. Characterize numeric and missing-value behavior before changing contractual semantics. Complexity is not a runtime benchmark.

### Loading and initialization (non-normative)

Keep lightweight synchronous hot paths eager by default. Avoid unnecessary expensive initialization at import time. Distinguish dynamic module loading, lazy resource initialization and deferred operation execution. Consider selective lazy loading only with evidence of startup or memory benefit, acceptable first-use latency, concurrent initialization safety, failure behavior, reload/disposal and native host/SDK compatibility. Do not change a synchronous contract merely to introduce dynamic imports.

## Verification

Independent verification means exercising a capability at its natural boundary without initializing unrelated responsibilities. It does not mean removing intrinsic dependencies.

| Capability shape | Appropriate verification |
| --- | --- |
| Stateless reusable policy | Direct contract tests without host initialization; deterministic fixtures and injected randomness when applicable. |
| Stateful reusable capability | Direct transitions and invariants, controlled clocks, legitimate resource fixtures and integration evidence. |
| Host-specific capability | Focused tests using the actual host where behavior depends on native events or lifecycle. |
| Composition and cross-capability behavior | System-owned integration and acceptance verification. |

For stateful capabilities, identify applicable ownership, concurrency, interruption, restart, stale evidence, cancellation and late results, clock boundaries, disabled behavior, persisted compatibility, bounded recovery, resource cleanup and privacy contracts. Do not introduce a generic state framework.

### Module-owned and system-owned tests

Module-owned tests MUST be colocated and independently invocable using the shared toolchain. They establish the capability's behavior and invariants, using property tests and independent oracles where useful. Favor assertions on outcomes rather than incidental private calls. Implementation-specific tests are appropriate for meaningful algorithm, state or resource risks.

System-owned tests remain with the integration, host, SDK, package or acceptance boundary that they exercise. Verify that consumers supply correct inputs, preserve authorization, use the output correctly and maintain their own effects. Avoid replicating algorithm oracles in every consumer suite. Host-neutral tests should be reusable by future hosts; host-specific behavior requires its own evidence.

Passing one boundary does not prove another. The existing coverage contract determines required tests and release evidence.

### Safe extraction and test discovery

Establish the current revision, named test inventory, existing expectations and relevant consumer imports before moving code. Add characterization tests where gaps exist and demonstrate fault sensitivity as required by existing governance.

Extract with minimal caller changes and preserve established imports where applicable. Do not rewrite behavioral expectations to make an extraction pass. Move only module-owned tests; retain system-owned coverage and reconcile source-path assertions explicitly.

Verify execution and discovery in full and applicable quick suites, TypeScript, coverage, mutation bindings, architecture and other quality checks. Compare named inventories, not only totals. A missing, skipped or unbound required test is not a pass. Verify installed consumers on the actual reviewed candidate.

### Module-aware mutation testing

Preserve existing contract-sensitive fault controls and issue-specific focused mutation acceptance. Manual fault controls and a scoped Stryker campaign are distinct evidence.

Mutation measurement is optional. Follow the [mutation-testing contract](mutation-testing.md#capability-owned-enrollment) and [shared tooling instructions](../mutation/README.md) when enrolling a capability.

- Modules own implementation scope, behavioral contracts, relevant tests and explicit opt-in through authorized policy. Enrolled capabilities declare measured source files and target-specific facts in an optional data-only `mutation.json`.
- Shared tooling owns discovery, validation, runner defaults, test binding, execution, planning, sharding, reporting and CI orchestration. Use the existing runner and normalized inventory; do not introduce separate configs, registries or workflows.
- Preserve direct-consumer mutation bindings. Widen only for a demonstrated relevant and instrumentable gap. Missing required bindings MUST fail explicitly; module-local tests do not establish every consumer contract.
- Review enrollment population changes explicitly. Preserve scheduled obligations, verify actual binding and planning parity, and require fresh measurement provenance when inputs change. Distinguish mutation status categories and measurement usability from contract correctness.

Affected-test selection remains deferred until evidence demonstrates safe, meaningful feedback improvements. No implicit enrollment, mandatory per-module mutation campaigns, weakened verification gates or automatic test skipping is implied.

## Compatibility and distribution

Distinguish documented public APIs (preserve accepted compatibility policy), previously exposed package subpaths (assess reachability and compatibility before removal), and internal module contracts (may evolve with authorized consumers). External addressability is not automatically a perpetual support commitment, but undocumented paths are not automatically safe to delete.

Establish the applicable baseline and obtain explicit compatibility decisions before breaking established imports, declarations, persisted formats or behavior. Do not expose new public APIs merely to improve internal organization.

When distribution changes, verify the actual tarball and installed consumer, including Pi extension loading and standalone router consumption without Pi dependencies where applicable. Preserve compiled JavaScript and declarations, correct import resolution and existing supported subpaths. Avoid unintentionally shipping tests and internal artifacts or broadening wildcard export exposure.

Repository tools may assume root source files or a particular test tree. Verify applicable test and coverage discovery, quick-suite policy, TypeScript, router build, Knip, dependency-cruiser, AST/lint, duplication, complexity, mutation and package checks include new paths in their intended scopes. Relocation MUST NOT exempt production code from existing restrictions or quality measurement.

## Enforcement and review

Use the existing tooling and governance to enforce outcomes independently of the implementation agent. Do not create an AI compliance score, new reviewer persona, universal module framework or new required pipeline.

| Guarantee | Appropriate evidence |
| --- | --- |
| Dependency direction, cycles and prohibited imports | Scoped dependency-cruiser checks with verified graph coverage. |
| No new barrels | Reliable AST predicates where possible; review semantic intent and legitimate existing compatibility exports. |
| Local documentation, instructions and tests | Presence and discovery checks for explicitly adopted capabilities; review usefulness and accuracy. |
| Static contracts | TypeScript and existing structural checks. |
| Behavioral guarantees | Direct, property, consumer and fault-control tests. |
| Effect authority and distribution | Relevant call paths, runtime and installed-package tests. |
| Cohesion, simplicity, patterns and algorithms | Independent engineering judgment supported by evidence. |

A deterministic rule needs an explicit scope, violation predicate, mechanism, legitimate allowed cases, owner, and positive and negative controls. Validate actual coverage of nested source and test paths. Prefer existing checks; add only a small deterministic check for a demonstrated gap. A passing check proves only the predicate it evaluates.

Examples of controlled experiments include rejecting a reusable capability's prohibited host dependency or a nested production import of test tooling while accepting a legitimate host adapter's native import; detecting a cycle, new aggregation barrel, omitted named test, changed stable tie, out-of-pool result, unintended input mutation, missing packaged implementation or unauthorized SDK effect. Apply only relevant controls; use isolated fixtures or controlled copies, record actual results and restore changes. Do not claim these experiments have already run.

Implementation agents MUST NOT weaken contracts, tests, discovery, architecture restrictions or gates to make their changes pass. Material policy changes require existing owner authorization and independent review. Evaluate detector bypass and scope reductions, not just compliant candidates. Reuse existing trusted-policy precedents where appropriate; never introduce privileged workflows executing untrusted candidate code. Do not treat candidate-controlled policy as independent proof of compliance.

Record architectural decisions, applicable exceptions and material trade-offs in existing adjudication and revision-bound evidence. Exceptions need a scoped rationale, owner and review/retirement condition where applicable. N/A means genuinely inapplicable; it cannot waive an existing mandatory gate. Reuse existing reports rather than create parallel evidence records.

## Adoption

Validate proposed requirements through an authorized stateless capability pilot and applicability reviews of representative stateful and host-specific capabilities. The latter may use source, existing tests and narrowly scoped prototypes; no additional production refactor is implied.

Evaluate change locality, actual independent verification, compatibility, administration cost and detector effectiveness. Preserve local documentation, agent instructions and tests for adopted capabilities while avoiding artificial adoption of small helpers. Reconcile findings with existing authorities before promoting the standard. No repository-wide retroactive restructuring is authorized.

Keep issue-specific research, prototypes, acceptance criteria, execution evidence and sequencing with their existing issues and delivery contracts, not in this enduring guide.

## Research foundations (informative)

- David Parnas, [On the Criteria to Be Used in Decomposing Systems into Modules](https://www.cs.lafayette.edu/~gexia/cs301/resources/parnas.html): information hiding.
- John Ousterhout, [Modular Design](https://web.stanford.edu/~ouster/cgi-bin/cs190-winter18/lecture.php?topic=modularDesign): depth and interface complexity.
- Alistair Cockburn, [Hexagonal Architecture](https://alistair.cockburn.us/hexagonal-architecture): independent execution and adapters.
- Martin Fowler, [Refactoring Module Dependencies](https://martinfowler.com/articles/refactoring-dependencies.html) and [YAGNI](https://martinfowler.com/bliki/Yagni.html): change locality and simplicity.
- Bertrand Meyer, Design by Contract; Barbara Liskov and Jeannette Wing, A Behavioral Notion of Subtyping: behavioral guarantees and substitutability.
- Go, [Package names](https://go.dev/blog/package-names) and [slices sorting implementation](https://go.dev/src/slices/sort.go): cohesive interfaces and explicit edge semantics.
- VS Code, [Source Code Organization](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) and [source at 1.96.4](https://github.com/microsoft/vscode/tree/1.96.4/src/vs/base): direct dependencies and layer enforcement.
- SQLite, [Virtual File System](https://www.sqlite.org/vfs.html): ownership of intrinsic effects.
- Google, [Software Engineering at Google: Unit Testing](https://abseil.io/resources/swe-book/html/ch12.html): behavioral verification.
- [TypeScript module reference](https://www.typescriptlang.org/docs/handbook/modules/reference.html), [narrowing](https://www.typescriptlang.org/docs/handbook/2/narrowing.html), [Node package resolution](https://nodejs.org/api/packages.html) and [ECMAScript modules](https://nodejs.org/api/esm.html): native contracts and loading.
- [AGENTS.md](https://agents.md/): local agent instructions; harness discovery varies.

These sources inform the guide; they are not additional policy, evidence of a successful pilot or authorization for a new package topology.
