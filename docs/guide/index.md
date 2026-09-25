# Pi-Bifrost guide

Pi-Bifrost is a configuration-first model router for [Pi](https://pi.dev) and [OMP](https://omp.sh) (oh-my-pi). It resolves a configured tier for a user prompt, filters unhealthy candidates, applies that tier's model-selection strategy, and activates the host's actual provider/model before generation.

New to Bifrost? Start with [Install and initialize](getting-started.md). It explains prerequisites, host-specific paths, probe usage, generated classifier behavior, preview privacy, and the first routed prompt.

## Start here

1. [Install and initialize](getting-started.md)
2. [Choose adaptive, explicit-tier, or pinned control](routing-controls.md)
3. [Configure tiers, model pools, strategies, and rules](configuration.md)
4. [Understand provider prompt caching across model switches](prompt-caching.md)
5. [Configure optional prompt or TypeSafe/Jev classifiers](classifiers.md)
6. [Troubleshoot setup and routing](troubleshooting.md)
7. [Use the command reference](commands.md)
8. [Understand reliability and Bifrost's local cache](reliability-and-cache.md)

## Four terms first

- **Tier:** named capability group such as `quick`, `general`, or `frontier`.
- **Model pool:** provider/model candidates you allow for one tier.
- **Strategy:** rule that selects one healthy candidate from a pool.
- **Classifier:** optional tier judge. It does not choose the exact provider model.

## Core model

```text
prompt
  → pick a tier
  → configured model pool
  → reliability filtering
  → per-tier strategy
  → the host's active provider/model
```

Bifrost separates two decisions:

- **Which tier fits this prompt?** A tier name in the message, the local classification cache, an optional classifier, a regex rule, or the configured default.
- **Which model serves that tier?** User-owned model pool, reliability filtering, and configured strategy.

Optional classifiers, including TypeSafe/Jev, choose a tier. They do not receive the provider model pool or choose the exact provider/model. Bifrost applies configured task-fit policy; it does not claim to identify one universally best model or guarantee savings.

## Choose what to read

| Question | Direct answer |
|----------|---------------|
| What do I need before installing? | [Prerequisites](getting-started.md#before-installing) |
| Will init contact models or cost money? | [Probe usage warning](getting-started.md#probe-usage-warning) |
| Does preview send my prompt anywhere? | [Preview before generation](getting-started.md#preview-before-generation) |
| How do prefixes and pinning interact? | [Routing controls](routing-controls.md) |
| What happens across A → B → A or N model switches? | [Provider prompt caching](prompt-caching.md) |
| What does Jev decide? | [TypeSafe/Jev](classifiers.md#typesafejev) |
| Why was a model skipped or route unexpected? | [Troubleshooting](troubleshooting.md) |
| What does Bifrost store locally? | [Local classification cache](reliability-and-cache.md#local-classification-cache) |

## Product boundaries

- Bifrost activates the host's real model; it does not hide routing behind a virtual profile.
- Bifrost never automatically replays a failed user prompt.
- Reliability circuits protect future turns; they are not provider quota guards.
- Provider prompt caches remain controlled by the host's provider integration and each provider.
- Adaptive routing may trade prompt-cache locality for per-turn task fit. It cannot guarantee better results, lower cost, lower latency, or cache savings.
- `/bifrost pin` is a session-local hard lock. Use it when continuity or one exact model matters more than per-message routing. A tier name at the start of a message is ignored while pinned.

## More references

- [README](../../README.md)
- [Configuration examples](../../examples/README.md)
