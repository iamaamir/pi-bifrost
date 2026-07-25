# Dual classifier: LLM-first with regex fallback

pi-bifrost uses two classification systems: an LLM classifier (tried first) and regex rules (fallback). The LLM reads the prompt and returns a tier name; regex rules are simple pattern→tier mappings.

**Why not LLM-only?** The classifier model can be unavailable (local server down, API outage, rate limit). A silent model router that breaks when a sidecar is down is worse than no router at all. The regex fallback ensures routing always works.

**Why not regex-only?** Regex rules are rigid. "Help me design a rate limiter" and "what's a rate limiter?" both contain "rate limiter" but need different tiers. An LLM can distinguish intent — regex cannot.

**Why LLM first, not regex first?** The LLM is more accurate. If it's available, use it. Regex is the safety net, not the primary path. Running regex first and only falling back to LLM would mean paying for LLM tokens only when regex fails — but regex never truly "fails," it just matches or doesn't. The current order means: try the accurate thing, fall back to the reliable thing.

**Consequences:**
- Every cache miss costs LLM tokens (mitigated by using cheap classifier models and a fuzzy cache)
- The classifier model must understand the tier names — custom tiers need a custom system prompt
- Two classification paths to test and maintain
