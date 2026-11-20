# Duplication denominator audit

`check:duplication` measures one number: duplicated lines as a share of all
measured lines, against the budget in [`.jscpd.json`](../../.jscpd.json). That
number alone cannot say **where** the duplication is, or how much of it is a
property of the measurement settings rather than of the code.

This audit answers both questions read-only. It runs jscpd over a grid of
`minTokens` x `minLines` values and groups every clone by directory pair.

A clone credits its directory in full when both sides sit in the same directory,
and half to each side when it crosses directories.

## How to reproduce

```bash
node scripts/duplication-audit.mjs          # this table
node scripts/duplication-audit.mjs --json   # same data for a script
```

Output captured on 2026-11-20 at `321c9e0` (Node 24, jscpd 5.4.3), verbatim:

```text
### Totals

| minTokens | minLines | Clones | Duplicated lines | Percentage |
| --- | --- | --- | --- | --- |
| 30 | 6 | 517 | 4648 | 7.13% |
| 30 | 10 | 110 | 1427 | 2.19% |
| 30 | 20 | 5 | 114 | 0.18% |
| 30 | 40 | 0 | 0 | 0.00% |
| 50 | 6 | 331 | 3248 | 4.99% |
| 50 | 10 | 110 | 1437 | 2.21% |
| 50 | 20 | 6 | 139 | 0.21% |
| 50 | 40 | 0 | 0 | 0.00% |
| 80 | 6 | 114 | 1308 | 2.01% |
| 80 | 10 | 55 | 786 | 1.21% |
| 80 | 20 | 5 | 114 | 0.18% |
| 80 | 40 | 0 | 0 | 0.00% |
| 120 | 6 | 35 | 478 | 0.73% |
| 120 | 10 | 26 | 405 | 0.62% |
| 120 | 20 | 4 | 91 | 0.14% |
| 120 | 40 | 0 | 0 | 0.00% |
| 200 | 6 | 1 | 14 | 0.02% |
| 200 | 10 | 1 | 14 | 0.02% |
| 200 | 20 | 0 | 0 | 0.00% |
| 200 | 40 | 0 | 0 | 0.00% |

### minTokens 30, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 427 | 3828 |
| `(root)` | 83 | 753 |
| `(root) -> tests` | 6 | 56 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 433 | 3856 |
| `(root)` | 90 | 786.5 |
| `scripts` | 1 | 5.5 |

### minTokens 30, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 89 | 1134 |
| `(root)` | 19 | 271 |
| `(root) -> scripts` | 1 | 11 |
| `(root) -> tests` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 90 | 1139.5 |
| `(root)` | 21 | 282 |
| `scripts` | 1 | 5.5 |

### minTokens 30, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 3 | 69 |
| `(root)` | 2 | 45 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 3 | 69 |
| `(root)` | 2 | 45 |

### minTokens 30, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |

### minTokens 50, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 290 | 2819 |
| `(root)` | 40 | 418 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 290 | 2819 |
| `(root)` | 41 | 423.5 |
| `scripts` | 1 | 5.5 |

### minTokens 50, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 92 | 1183 |
| `(root)` | 17 | 243 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 92 | 1183 |
| `(root)` | 18 | 248.5 |
| `scripts` | 1 | 5.5 |

### minTokens 50, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 4 | 94 |
| `(root)` | 2 | 45 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 4 | 94 |
| `(root)` | 2 | 45 |

### minTokens 50, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |

### minTokens 80, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 97 | 1089 |
| `(root)` | 16 | 208 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 97 | 1089 |
| `(root)` | 17 | 213.5 |
| `scripts` | 1 | 5.5 |

### minTokens 80, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 43 | 605 |
| `(root)` | 11 | 170 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 43 | 605 |
| `(root)` | 12 | 175.5 |
| `scripts` | 1 | 5.5 |

### minTokens 80, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 3 | 69 |
| `(root)` | 2 | 45 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 3 | 69 |
| `(root)` | 2 | 45 |

### minTokens 80, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |

### minTokens 120, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 32 | 428 |
| `(root)` | 3 | 50 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 32 | 428 |
| `(root)` | 3 | 50 |

### minTokens 120, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 23 | 355 |
| `(root)` | 3 | 50 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 23 | 355 |
| `(root)` | 3 | 50 |

### minTokens 120, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 3 | 69 |
| `(root)` | 1 | 22 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 3 | 69 |
| `(root)` | 1 | 22 |

### minTokens 120, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |

### minTokens 200, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 1 | 14 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 1 | 14 |

### minTokens 200, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 1 | 14 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 1 | 14 |

### minTokens 200, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |

### minTokens 200, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
```

## What the numbers say

- **Tests carry most of the measured duplication.** At the configured
  `minTokens 50, minLines 6`, 290 of 331 clones and 2819 of 3248 duplicated
  lines are inside `tests/` (87%). Root-level modules contribute 418 lines
  (13%), and a single cross-directory clone contributes 11.
- **`minLines` is the binding knob.** Going from 6 to 10 lines removes `1811`
  duplicated lines (56% of the total) while `minTokens` 30 versus 50 at the same
  `minLines` changes the total by 10 lines (0.7%). The duplication that the
  removed band represents is short test scaffolding, not shared product code.
- **Product-code duplication is small.** With `minLines 10`, root-level modules
  carry `248.5` credited lines of `1437`, about 0.38% of the 65,130 measured
  lines.

## Decision

[`D-13`](../../docs/adr/0027-quality-gates.md) asked whether the audit justifies
moving the settings. It does:

| Setting | Before | After | Why |
| --- | --- | --- | --- |
| `minTokens` | 50 | 50 | Not the binding knob; lowering it adds token-light clones without product signal |
| `minLines` | 6 | 10 | Removes the 6-9 line test-boilerplate band (56% of the old total) |
| `threshold` | 5.5 | 2.5 | Measured 2.21% plus ~13% headroom, so the budget stays a ratchet |

Everything stays measured: `tests/**` is not excluded. A copy-pasted test is
still a maintenance liability, and excluding it would hide the one number this
audit exists to expose.

Reference threshold: 2.5% of 65,130 lines is about 1,628 duplicated lines, so the
current tree keeps roughly 190 lines of headroom before the gate trips.
