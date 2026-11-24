/** Requested output budget for the canonical lightweight probe, not a provider-enforced cap. */
export const PROBE_MAX_TOKENS = 5;

/**
 * The resource facts a user must see before agreeing, stated as briefly as the
 * consent dialog can afford: this text is rendered above a list of every model
 * the probe will reach, so its height competes with that list on small terminals.
 */
export const PROBE_RESOURCE_DISCLOSURE =
  `${PROBE_MAX_TOKENS} output tokens each; host may raise/omit; retries may add; charges may apply.`;
