# Pi-Bifrost guide

Pi-Bifrost is a configuration-first model router for [Pi](https://pi.dev). It resolves a configured tier for a user prompt, filters unhealthy candidates, and applies that tier's model-selection strategy. Physical selection before generation is the default. If you select `bifrost/auto`, Pi dispatches the physical model per request instead.

New to Bifrost? Start with [Install and initialize](getting-started.md). Init is optional on a fresh install. The guide explains first-use model lists, the physical-model default, classifier privacy, and how to review saved lists before generation.

## Start here

1. [Install and initialize](getting-started.md)
2. [Select and dispatch a model with Auto](auto-routing.md)
3. [Choose adaptive, explicit-tier, or pinned control](routing-controls.md)
4. [Configure tiers, model pools, strategies, and rules](configuration.md)
5. [Understand provider prompt caching across model switches](prompt-caching.md)
6. [Configure optional prompt, TypeSafe/Jev, or Pi-native classifiers](classifiers.md)
7. [Troubleshoot setup and routing](troubleshooting.md)
8. [Use the command reference](commands.md)
9. [Perform common routing tasks](workflows.md)
10. [Understand reliability and Bifrost's local cache](reliability-and-cache.md)

## Guide map

| Page | Form | Reader task |
|------|------|-------------|
| [Guide index](index.md) | Navigational (hybrid) | Find the right page and orient to the guide |
| [Install and initialize](getting-started.md) | Tutorial | Install Bifrost and send a first routed prompt |
| [Auto routing](auto-routing.md) | Explanation | Understand per-request model selection and dispatch |
| [Routing controls](routing-controls.md) | How-to | Choose and apply a routing control |
| [Configuration](configuration.md) | Reference | Look up tiers, pools, strategies, rules, and fields |
| [Commands](commands.md) | Reference | Look up a command and its flags |
| [Common workflows](workflows.md) | How-to | Perform a routing task |
| [Classifiers](classifiers.md) | Explanation | Understand classifier backends and privacy |
| [Prompt caching](prompt-caching.md) | Explanation | Understand provider cache behavior across model switches |
| [Reliability and local cache](reliability-and-cache.md) | Explanation | Understand circuits, pauses, and local state |
| [Troubleshooting](troubleshooting.md) | How-to | Diagnose and repair a problem |

The guide index combines navigation with short orientation. Substantive pages keep one primary Diátaxis form. [Writing standard](STYLE.md) is a maintainer process document, not a guide page.

## Four terms first

- **Tier:** named capability group such as `quick`, `general`, or `frontier`.
- **Model pool:** provider/model candidates you allow for one tier.
- **Strategy:** rule that selects one healthy candidate from a pool.
- **Classifier:** optional tier judge. The tier strategy chooses the exact provider model.

## Core model

```text
prompt
  → pick a tier
  → configured model pool
  → reliability filtering
  → per-tier strategy
  → Pi's active provider/model
```

Bifrost separates two decisions:

- **Which tier fits this prompt?** A tier name in the message, the local classification cache, an optional classifier, a regex rule, or the configured default.
- **Which model serves that tier?** User-owned model pool, reliability filtering, and configured strategy.

Optional classifiers, including TypeSafe/Jev and Pi-native, choose a tier. Bifrost applies your configured task-fit policy to that tier's model pool, so a route reflects your policy rather than a claim about one universally best model. See [Classifier backends](classifiers.md).

## Choose what to read

| Question | Direct answer |
|----------|---------------|
| What do I need before installing? | [Prerequisites](getting-started.md#before-installing) |
| Will init contact models or cost money? | [Probe usage warning](getting-started.md#probe-usage-warning) |
| Does preview send my prompt anywhere? | [Preview before generation](workflows.md#preview-before-generation) |
| How do prefixes and pinning interact? | [Routing controls](routing-controls.md) |
| What happens across A → B → A or N model switches? | [Provider prompt caching](prompt-caching.md) |
| What does Jev decide? | [TypeSafe/Jev](classifiers.md#typesafejev) |
| Why was a model skipped or route unexpected? | [Troubleshooting](troubleshooting.md) |
| What does Bifrost store locally? | [Local classification cache](reliability-and-cache.md#local-classification-cache) |

## Product boundaries

- Bifrost uses Pi's real provider/model. In Auto, Pi shows the virtual selection and dispatched physical model together.
- Automatic retries are limited to one usage or billing rejection after Pi proves the initial Auto generation had no output or tool activity; see [the recovery boundary](reliability-and-cache.md#reliability-circuits).
- Reliability state records model failures. Usage and billing errors pause models that use the same configured provider ID by default. See [provider pauses](reliability-and-cache.md#provider-pauses-are-not-account-checks) for the pause boundary.
- Provider prompt caches remain controlled by Pi's provider integration and each provider.
- Adaptive routing may trade prompt-cache locality for per-turn task fit. It does not guarantee better results, lower cost, lower latency, or cache savings; see [Provider prompt caching](prompt-caching.md).
- `/bifrost pin` is a session-local hard lock. Use it when continuity or one exact model matters more than per-message routing. A tier name at the start of a message stays ordinary text while pinned.

## More references

- [README](../../README.md)
- [Configuration examples](../../examples/README.md)
