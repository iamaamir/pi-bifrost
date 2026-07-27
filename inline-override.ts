// ── Inline tier override parsing ──────────────────────────────
// Type a tier name as the first word to force that tier.
// "frontier debug this" → tier "frontier", prompt "debug this".

export interface InlineOverrideResult {
  /** Forced tier name if first word matches a configured tier. */
  readonly forcedTier: string | undefined;
  /** Prompt text with tier name stripped. */
  readonly promptText: string;
}

/**
 * Parse a user prompt for inline tier override.
 *
 * If the first word (case-insensitive) matches a key in `models`,
 * it's stripped from the prompt and returned as `forcedTier`.
 *
 * @param text   Raw user input.
 * @param models Tiers config map (e.g. { frontier: [...], economical: [...] }).
 * @returns Parsed override result.
 */
export function parseInlineOverride(
  text: string,
  models: Record<string, string | string[]> | undefined,
): InlineOverrideResult {
  if (!models) return { forcedTier: undefined, promptText: text };

  const firstWord = text.match(/^([a-zA-Z]+)\s+/);
  if (!firstWord) return { forcedTier: undefined, promptText: text };

  const candidate = firstWord[1].toLowerCase();
  if (models[candidate]) {
    return {
      forcedTier: candidate,
      promptText: text.slice(firstWord[0].length),
    };
  }

  return { forcedTier: undefined, promptText: text };
}
