# Install and initialize Pi-Bifrost

[Guide index](index.md) · [Routing controls](routing-controls.md) · [Troubleshooting](troubleshooting.md)

## What Bifrost does

Pi-Bifrost chooses from models already available in [Pi](https://pi.dev) or [OMP](https://omp.sh) (oh-my-pi). For each message it resolves a configured capability tier, filters unhealthy candidates, applies your tier strategy, and activates the host's actual provider/model before generation.

Bifrost does not provide model credentials or a model proxy.

## Before installing

You need:

- Pi `0.86.0` or newer, or OMP `18.2.11` (the validated OMP version);
- at least one model provider configured and authenticated in the host;
- at least one model visible in the host's model registry;
- network access for installation and provider requests.

Check the host:

```bash
pi --version
omp --version
```

Confirm you can select and use at least one provider model before diagnosing Bifrost.

## Install

Pi, from npm:

```bash
pi install npm:pi-bifrost
```

OMP:

```bash
omp plugin install pi-bifrost
```

Or directly from GitHub (Pi) or a local checkout (OMP):

```bash
pi install git:github.com/iamaamir/pi-bifrost
omp plugin link /path/to/pi-bifrost
```

Restart the host if the extension is not loaded in the current session.

OMP reads the same `bifrost.json` schema but its own paths: `.omp/bifrost.json` for the project config and `~/.omp/agent/bifrost.json` for the global one. Local cache and reliability state live under `.omp/`. Manual model selection in OMP does not pin Bifrost (use `/bifrost pin`), and `/bifrost classifier`'s interactive model picker is Pi-only — set `classifier.model` in config on OMP.

## Understand four terms

- **Tier:** named capability group such as `quick`, `general`, or `frontier`.
- **Model pool:** provider/model IDs allowed in one tier.
- **Strategy:** rule that chooses one healthy model from a tier pool.
- **Classifier:** optional backend that judges the tier. It never chooses the exact provider model.

## Initialize

Inside the host, run:

```text
/bifrost init
```

Initialization:

1. refreshes the host's model registry;
2. reuses probe results newer than one hour or probes every available registry model (results are cached in `.pi/bifrost-probe.json` on Pi or `.omp/bifrost-probe.json` on OMP); pass `-f` to force a fresh probe regardless of cache age;
3. proposes `quick`, `general`, and `frontier` pools;
4. orders candidates using one-time probe latency;
5. proposes a prompt classifier when a working classifier model is found;
6. shows the complete proposed configuration;
7. writes the host's project config (`.pi/bifrost.json` on Pi or `.omp/bifrost.json` on OMP) only after confirmation.

Bifrost does not ship maintainer-specific provider/model IDs as routing defaults.

### Probe usage warning

When a fresh result is unavailable, the probe sends `1+1=` to every available registry model. The primary transport caps output at 5 tokens; an empty response may trigger one minimal-session fallback request on Pi. Default concurrency is 50 and per-model timeout is 10 seconds. Requests may incur provider usage, consume credits, or trigger burst rate limits.

For providers with tight limits, create a config file before init. Use `~/.pi/agent/bifrost.json` (Pi) or `~/.omp/agent/bifrost.json` (OMP) for all projects, or the matching project config (`.pi/bifrost.json` / `.omp/bifrost.json`):

```json
{
  "probe": {
    "concurrency": 4,
    "timeoutMs": 10000
  }
}
```

See [Troubleshooting](troubleshooting.md#lower-probe-pressure) for symptoms and repair.

## Review the proposal

Before confirming, check:

1. Every model ID belongs to a provider/account you intend to use.
2. Expensive or quota-sensitive models are not in broad adaptive tiers.
3. Each tier strategy matches your intent.
4. The default tier exists and has candidates.
5. Classifier behavior matches your privacy and cost requirements.

Init normally enables the prompt classifier when it finds a working classifier model. Prompt classification sends the current prompt to that configured model on local-cache misses and adds tokens and latency.

For rules/default-only routing, disable it after init:

```text
/bifrost classifier off
```

Or set this in the host's project config (`.pi/bifrost.json` on Pi or `.omp/bifrost.json` on OMP):

```json
{
  "classifier": {
    "enabled": false
  }
}
```

## Preview before generation

```text
/bifrost preview debug this race condition
```

Preview resolves and displays the source, tier, candidates, strategy, and selected model. It does **not** start a generation turn or activate the selected model.

Preview does run the normal tier pipeline. It does not read a tier name from the prompt, so a forced tier cannot be previewed. If a prompt classifier or TypeSafe/Jev is enabled and no local cache entry resolves first, that classifier may receive the preview prompt and incur classifier usage.

For local-only preview:

```text
/bifrost classifier off
/bifrost preview debug this race condition
```

Regex rules, configured default, and local classification cache still apply. Use `/bifrost cache clear` when testing rules/default without a prior cached tier.

## Send the first routed prompt

With routing on and nothing pinned, send an ordinary prompt. Bifrost picks a configured tier for that message, then a model from that tier's list, before generation.

Force one configured tier by putting its name first:

```text
quick commit the changes
```

Bifrost strips `quick` before the model receives the prompt. The tier's configured strategy still chooses the exact model.

Pin the active exact model for a long continuous session:

```text
/bifrost pin
```

Resume adaptive routing:

```text
/bifrost unpin
```

## Configuration locations

Config merges in this order; later layers win:

1. extension default: `<extensionDir>/bifrost.json`
2. user-global: `~/.pi/agent/bifrost.json` (`~/.omp/agent/bifrost.json` on OMP)
3. project root: `bifrost.json`
4. project config: `.pi/bifrost.json` (`.omp/bifrost.json` on OMP)

Project-specific rules may also live in `bifrost-routes.json` or the host-specific `.pi/bifrost-routes.json` / `.omp/bifrost-routes.json`; the host directory file wins.

After editing configuration:

```text
/bifrost reload
```

Use full `provider/id` values when ambiguity matters. Short patterns may substring-match more than one registry model.

## Next steps

- Learn adaptive, explicit-tier, and pinned behavior: [Routing controls](routing-controls.md).
- Edit pools, strategies, and rules: [Configuration](configuration.md).
- Understand N model switches and provider prompt caches: [Provider prompt caching](prompt-caching.md).
- Configure prompt or TypeSafe/Jev classification: [Classifier backends](classifiers.md).
- Diagnose setup and routing failures: [Troubleshooting](troubleshooting.md).
