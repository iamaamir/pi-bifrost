/** Internal decision boundary: no host API, context edits, IO or retry scheduling. */
export type RetryLineageFact =
  | { readonly kind: "failure"; readonly id: string; readonly model: string; readonly matchesLatest: boolean }
  | { readonly kind: "omission"; readonly target: string }
  | { readonly kind: "other" };

/** Require a single empty, omitted failure per admitted model, in dispatch order.
 *  The adapter supplies facts only for an exact persisted user boundary.
 *  Success, partial content, tools, compaction and unrelated entries are "other".
 */
export function provesNativeRetryLineage(facts: readonly RetryLineageFact[], attempted: readonly string[]): boolean {
  if (!attempted.length || new Set(attempted).size !== attempted.length || facts.length !== attempted.length * 2) return false;
  const ids = new Set<string>();
  for (let i = 0; i < attempted.length; i++) {
    const failure = facts[2 * i], omission = facts[2 * i + 1];
    if (failure?.kind !== "failure" || omission?.kind !== "omission") return false;
    if (failure.model !== attempted[i] || !failure.id || ids.has(failure.id) || omission.target !== failure.id) return false;
    if (failure.matchesLatest !== (i === attempted.length - 1)) return false;
    ids.add(failure.id);
  }
  return true;
}
