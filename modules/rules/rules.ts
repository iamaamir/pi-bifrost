import { isPatternAccepted, verifyRulePatterns } from "./safety.ts";

export interface RouteRule {
  pattern: string;
  model: string;
}

/**
 * Match rules in order, constructing a RegExp per rule per call.
 * @deprecated Production uses `compileRules` + `classifyCompiled`.
 * Kept as the reference implementation for parity tests.
 */
export function classify(text: string, rules: readonly RouteRule[]): string | undefined {
  for (const rule of rules) {
    try {
      const re = new RegExp(rule.pattern, "i");
      verifyRulePatterns([rule.pattern]);
      if (!isPatternAccepted(rule.pattern)) continue;
      if (re.test(text)) return rule.model;
    } catch (err) {
      console.error(`[bifrost] invalid regex "${rule.pattern}": ${err}`);
    }
  }
  return undefined;
}

/** A route rule with its pattern compiled once. */
export interface CompiledRule {
  readonly re: RegExp;
  readonly model: string;
}

/** Compile rules ahead of time; invalid and unverifiable patterns are logged and dropped. */
export function compileRules(rules: readonly RouteRule[]): CompiledRule[] {
  const compiled: Array<CompiledRule & { pattern: string }> = [];
  for (const rule of rules) {
    try {
      compiled.push({ re: new RegExp(rule.pattern, "i"), model: rule.model, pattern: rule.pattern });
    } catch (err) {
      console.error(`[bifrost] invalid regex "${rule.pattern}": ${err}`);
    }
  }
  verifyRulePatterns(compiled.map((rule) => rule.pattern));
  return compiled.filter((rule) => isPatternAccepted(rule.pattern))
    .map(({ re, model }) => ({ re, model }));
}

/** Match against precompiled rules — no per-call regex construction. */
export function classifyCompiled(text: string, rules: readonly CompiledRule[]): string | undefined {
  for (const rule of rules) {
    if (rule.re.test(text)) return rule.model;
  }
  return undefined;
}
