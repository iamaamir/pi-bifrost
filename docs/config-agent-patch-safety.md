# Config-agent patch safety

`bifrost_config` writes a user's configuration, so its patch path, rejection
rules, and report are contracts rather than implementation details. This page
records why each rule has its current shape. Change a rule only with the reason
below in hand.

## Composition

- **Plain objects merge; everything else replaces.** A patch names the field it
  wants to change, so a partial edit must keep unspecified siblings at any depth
  (#237). Arrays, scalars, and `null` replace the whole value.
- **`null` is a value, not a delete marker.** Deleting a key is expressed by
  top-level `remove` or a full `candidate`. A deep merge cannot tell an omitted
  key from a key the user did not mention, so omission preserves.
- **Neither argument is mutated.** Merged objects are new; untouched subtrees are
  shared because nothing downstream writes into them.

## Rejection

- **Only `__proto__` is rejected.** It is the one key that rewrites an object's
  prototype when written by index, and a host JSON patch can carry it even though
  the schema never declares it. `constructor` and `prototype` are ordinary
  own-property writes, and tier, criteria, and scope maps may legitimately use
  those names — rejecting them would break valid configuration.
- **The walk covers arrays and every nested value.** A container that the merge
  replaces wholesale must not be able to hide the key. The scan runs before the
  merge, so a rejected patch changes nothing.
- **Depth is bounded before recursion.** A very deep patch must fail as input,
  not as a stack overflow.

## Reported paths

- **The path value uses only JSON Pointer escapes** (`~0` for `~`, `~1` for `/`).
  Control characters stay in the value. Encoding them into the path would map a
  real newline and a literal `\u000a` key onto the same text, so two changes would
  be reported as one.
- **Escaping for display is a presentation concern.** Display sites escape
  backslashes and control characters, which keeps each change on one line without
  touching path identity. The approval dialog renders the path through JSON, so
  the same path shows a different (also unambiguous) spelling there.
- **Arrays stay one entry at their own path.** Element-by-element entries would
  imply a merge that does not happen.
- **`nestedChanges` is additive.** The top-level `changes` list keeps its field
  contract because approval summaries and rule/pool summaries read it.

## Report budget

- **The report is at most 120 lines, marker included.** The marker counts as one
  of those lines; it is not a 121st line.
- **The tail is protected.** Write eligibility and the apply digests are what the
  agent copies out of the report, so truncation may shorten only the optional
  detail above them.
- **Tail detail has its own caps** (`MAX_CHANGE_LINES`, `MAX_WARNING_LINES`,
  `MAX_PROBE_FAILURE_LINES`). Without them a candidate that warns on every model
  grows the tail without limit, which is how the marker/budget bug appeared.
- **Every truncation is visible.** Each capped list prints how many entries were
  omitted and points at the complete structured result (`details.issues`,
  `details.liveProbe`). Do not add a detail list that can grow unbounded.
