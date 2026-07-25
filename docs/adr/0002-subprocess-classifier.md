# Subprocess classifier invocation alongside direct HTTP

The LLM classifier supports two invocation methods: `direct` (OpenAI-compatible HTTP POST to the model's base URL) and `subprocess` (spawns a fresh `pi --no-extensions` process).

**Why two methods?** Direct HTTP is fast but only works for OpenAI-compatible APIs. Many pi providers use non-OpenAI protocols (Anthropic Messages, Codex Responses) or require custom auth flows that pi handles internally. The subprocess method delegates to pi itself — any model pi can use, the classifier can use.

**Why not subprocess-only?** Subprocess spawn is slow — cold start, config loading, model resolution. Direct HTTP is a single fetch. For local LM Studio/Ollama servers (the common classifier case), direct HTTP is near-instant.

**Why not direct-only?** Would lock the classifier out of many providers. A user whose only cheap model is an Anthropic Haiku key couldn't use the classifier.

**Consequences:**
- Two code paths to maintain in `classifier.ts` (direct HTTP ~50 lines, subprocess ~50 lines)
- Subprocess method is a recursive pi invocation — pi-bifrost loaded in the subprocess must not interfere (handled via `--no-extensions` in the subprocess)
- `auto` method tries direct first, then subprocess — doubles latency on failure but maximizes availability
- The `endpoint` config field forces `direct` mode since there's no pi process to delegate to for arbitrary endpoints
