# Model Probe

The Model Probe is a diagnostic tool used to verify the real-world availability and health of configured models.

## How it Works

The probe sends a minimal prompt (`1+1=`) to every available model in the registry and records the outcome.

### Execution Flow

1. **Initialization**: `runProbe` retrieves all available models from the `modelRegistry`.
2. **Concurrent Execution**: Up to 50 concurrent workers are spawned to process the model list (configurable via `probe.concurrency`, see [Configuration](#configuration)).
3. **Probing Process (`probeOne`)**:
   - **Authentication**: Retrieves provider and authentication details for the model.
   - **Primary Attempt**: Uses `provider.streamSimple()` for a lightweight check.
     - Constraints: Max 5 tokens, 10s timeout, temperature 0.
   - **Fallback Attempt**: If the stream fails or returns an empty response, it attempts a `promptWithMinimalSession()` call (full session transport).
4. **Result Recording**: For each model, the following metrics are captured:
   - `status`: `ok`, `error`, `timeout`, or `skipped`.
   - `duration_ms`: Time taken for the response.
   - `transport`: Whether `streamSimple` or `session` was used.
   - `tokens`: Total tokens used (if successful).
   - `error`: Error message if the probe failed.
5. **Persistence**: The final results are written to `.pi/bifrost-probe.json`.

## Scalability Analysis (Large Model Lists)

When handling a large number of models (e.g., 500+), the current implementation faces several bottlenecks:

### Performance
- **Concurrency Limit**: 50 concurrent workers process the list concurrently (configurable via `probe.concurrency`).
- **Worst-Case Duration**: If all models hit the timeout, a full sweep is bounded by roughly `ceil(models / 50) × timeout`. For 500 models at the default 10s timeout that is ~100s; with the short 50ms timeout used by diagnostics it is ~166ms.
- **Realistic Duration**: With healthy providers and the 50ms diagnostic timeout, 500 models typically complete in well under a second (~166ms measured).

### Resource Usage
- **Memory**: Low. Each result is small, and the total JSON output for 500 models is roughly 50KB.
- **Network**: High potential for provider rate-limiting if concurrency is increased without adaptive controls.
- **Disk I/O**: A single synchronous write at the end of the process.

### Limitations & Risks
- **No Checkpointing**: If the process is interrupted, the entire probe must restart from the beginning.
- **Fixed Timeouts**: The per-model timeout (default 10s, configurable via `probe.timeoutMs`) does not adapt to provider-specific latency.
- **Rate Limiting**: Probing many models from the same provider simultaneously may trigger API rate limits; the default 50-way concurrency (configurable via `probe.concurrency`, see [Configuration](#configuration)) assumes per-provider model counts stay modest or providers tolerate burst traffic.

## Configuration

Both worker count and timeout are configurable in `bifrost.json`:

```json
{
  "probe": {
    "concurrency": 8,
    "timeoutMs": 10000
  }
}
```

- `probe.concurrency` (integer ≥ 1, default 50) — maximum models probed simultaneously. Lower this (e.g. 4–8) if a provider returns 429s during probing.
- `probe.timeoutMs` (integer ≥ 1, default 10000) — per-model timeout in milliseconds.

Both `runProbe` options apply to `/bifrost probe` and `/bifrost init`.

## Recommendations for Scaling
- **Configurable Concurrency**: Available via `probe.concurrency` (see above).
- **Progress Persistence**: Implement incremental writes to the results file to allow resuming.
- **Adaptive Concurrency**: Dynamically reduce worker count if a spike in `timeout` or `error` statuses is detected.
- **Provider-Aware Batching**: Group probes by provider to better manage rate limits.
