/** Requested output budget for the canonical lightweight probe, not a provider-enforced cap. */
export const PROBE_MAX_TOKENS = 5;

export const PROBE_RESOURCE_DISCLOSURE =
  `Requests ${PROBE_MAX_TOKENS} output tokens per model; the host may raise or omit this limit, and transport may retry, so more than one request can be sent. Charges may apply.`;
