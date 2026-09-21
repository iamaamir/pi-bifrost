# Troubleshoot Pi-Bifrost

[Guide index](index.md) · [Getting started](getting-started.md) · [Commands](commands.md) · [Classifier backends](classifiers.md)

Start with:

```text
/bifrost debug
```

It shows effective routing and reliability state after configuration layers merge. Add the focused command from the table below.

| Symptom | Inspect | Likely cause | Repair |
|---------|---------|--------------|--------|
| `pi` command is missing | Run `pi --version` in a terminal | Pi is not installed or not on `PATH` | Install [Pi](https://pi.dev), then reopen the terminal |
| Pi rejects the package | Check `pi --version` | Pi is older than `0.86.0` | Upgrade Pi, then rerun `pi install npm:pi-bifrost` |
| Init reports zero registry models | Open Pi's model picker; run `/bifrost debug` | No provider is configured or authenticated in Pi | Configure at least one Pi provider and credential, then restart or refresh Pi |
| Probe returns errors or timeouts | `/bifrost probe`; inspect provider account/network | Invalid credentials, no credits, network failure, provider outage, or burst rate limit | Fix provider access; lower `probe.concurrency`; probe again |
| Init finds no usable models | Read probe summary | Every registry model failed, timed out, or was unsupported | Fix provider access before accepting generated pools |
| Preview resolves an unexpected tier | `/bifrost preview <prompt>`; `/bifrost classifier status`; `/bifrost cache stats` | Earlier cache/classifier result beat regex, rule order differs, or default tier applied | Inspect preview `source`; clear stale local cache; test classifier; reorder rules or change default |
| Wrong exact model is selected | `/bifrost preview <prompt>`; `/bifrost debug` | Broad substring pattern, tier strategy, candidate order, or health exclusion | Use exact `provider/id`; inspect strategy and candidate list; probe unhealthy model |
| A configured model is skipped | `/bifrost debug`; `/bifrost probe` | Reliability circuit is open after repeated failures | Fix provider/model health and run a successful probe; otherwise wait for controlled recovery |
| Config edit has no effect | `/bifrost debug` | Higher-precedence config overrides it or config was not reloaded | Check all config locations; edit winning layer; run `/bifrost reload` |
| Prompt classifier fails | `/bifrost classifier test`; `/bifrost classifier status` | Missing model, provider error, invalid response, or fallback configuration | Select a working classifier model or disable classifier for rules/default-only routing |
| TypeSafe/Jev is unavailable | `/bifrost classifier status` | Missing TypeSafe credential, timeout, rate limit, or open classifier circuit | Configure credential; test backend; inspect safe status; use prompt/regex fallback |
| Tier prefix reaches model unchanged | `/bifrost debug` | Session is pinned, prefix is unknown, or tier key is unsupported syntax | Unpin; use a configured lowercase alphabetic single-word tier followed by whitespace |

## Lower probe pressure

`/bifrost probe` sends a tiny request to every model available in Pi's registry. `/bifrost init` does the same when no probe result newer than one hour exists. Default concurrency is 50. Before the first init, lower it in `~/.pi/agent/bifrost.json` or `.pi/bifrost.json` when providers enforce tight burst limits:

```json
{
  "probe": {
    "concurrency": 4,
    "timeoutMs": 10000
  }
}
```

The primary probe transport uses `1+1=` and caps output at 5 tokens. An empty response may trigger one minimal-session fallback request. Probes may incur provider usage or rate limits.

## Understand preview output

Preview reports:

- `source`: cache, classifier, rule, or fallback;
- classifier backend/model/confidence when available;
- resolved tier;
- requested and fallback candidates;
- strategy;
- selected model;
- reliability fallback reason when applicable.

Preview does not start the generation turn or activate the selected model. It does run the normal tier pipeline. An enabled prompt or TypeSafe/Jev classifier may receive the preview prompt and incur classifier usage. Preview does not read a tier name from the prompt, so a forced tier cannot be previewed.

For local-only preview, disable the classifier first:

```text
/bifrost classifier off
/bifrost preview your prompt
```

Regex rules, configured default, and the local classification cache remain available. Clear the local cache if you need to test rules/default without an earlier cached tier:

```text
/bifrost cache clear
```

## Report an issue

Include content-free evidence where possible:

1. Pi and Pi-Bifrost versions;
2. `/bifrost debug` output with secrets removed;
3. `/bifrost classifier status` when relevant;
4. probe status counts, not credentials or raw private prompts;
5. minimal redacted configuration that reproduces the problem.

[Open a GitHub issue](https://github.com/iamaamir/pi-bifrost/issues).
