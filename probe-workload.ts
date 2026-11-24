/** Requested output budget for the canonical lightweight probe, not a provider-enforced cap. */
export const PROBE_MAX_TOKENS = 5;

export const PROBE_RESOURCE_DISCLOSURE =
  `Requests ${PROBE_MAX_TOKENS} output tokens per model; the host may raise or omit this limit. Native transport may send additional requests. Charges may apply.`;
