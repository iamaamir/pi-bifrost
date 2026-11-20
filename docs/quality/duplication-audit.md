# Duplication denominator audit

Maintainer document. It is not part of the user guide.

`check:duplication` reports one number: duplicated lines as a share of all
measured lines, against the budget in [`.jscpd.json`](../../.jscpd.json). That
number does not say where the lines are, or how the settings move it. This audit
answers both, read-only.

## Reproduce

```bash
node scripts/duplication-audit.mjs          # this table
node scripts/duplication-audit.mjs --json   # same data for a script
```

Output captured on 2026-11-21 at `e137d7f` with a clean working tree, verbatim:

```text
### Totals

| minTokens | minLines | Clones | Duplicated lines | Percentage |
| --- | --- | --- | --- | --- |
| 30 | 6 | 914 | 8893 | 8.07% |
| 30 | 10 | 223 | 3442 | 3.12% |
| 30 | 20 | 30 | 955 | 0.87% |
| 30 | 40 | 7 | 375 | 0.34% |
| 50 | 6 | 616 | 6619 | 6.01% |
| 50 | 10 | 212 | 3332 | 3.02% |
| 50 | 20 | 32 | 1002 | 0.91% |
| 50 | 40 | 7 | 376 | 0.34% |
| 80 | 6 | 255 | 3509 | 3.19% |
| 80 | 10 | 146 | 2560 | 2.33% |
| 80 | 20 | 31 | 977 | 0.89% |
| 80 | 40 | 7 | 376 | 0.34% |
| 120 | 6 | 83 | 1658 | 1.51% |
| 120 | 10 | 73 | 1576 | 1.43% |
| 120 | 20 | 29 | 927 | 0.84% |
| 120 | 40 | 7 | 376 | 0.34% |
| 200 | 6 | 17 | 628 | 0.57% |
| 200 | 10 | 17 | 628 | 0.57% |
| 200 | 20 | 16 | 616 | 0.56% |
| 200 | 40 | 6 | 330 | 0.30% |

### minTokens 30, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 803 | 7875 |
| `(root)` | 83 | 753 |
| `scripts` | 11 | 92 |
| `docs` | 7 | 84 |
| `(root) -> tests` | 6 | 56 |
| `scripts -> tests` | 2 | 14 |
| `(root) -> scripts` | 1 | 11 |
| `mutation` | 1 | 8 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 811 | 7910 |
| `(root)` | 90 | 786.5 |
| `scripts` | 14 | 104.5 |
| `docs` | 7 | 84 |
| `mutation` | 1 | 8 |

### minTokens 30, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 198 | 3077 |
| `(root)` | 19 | 271 |
| `docs` | 3 | 54 |
| `scripts` | 1 | 18 |
| `(root) -> scripts` | 1 | 11 |
| `(root) -> tests` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 199 | 3082.5 |
| `(root)` | 21 | 282 |
| `docs` | 3 | 54 |
| `scripts` | 2 | 23.5 |

### minTokens 30, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 27 | 888 |
| `(root)` | 2 | 45 |
| `docs` | 1 | 22 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 27 | 888 |
| `(root)` | 2 | 45 |
| `docs` | 1 | 22 |

### minTokens 30, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 375 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 375 |

### minTokens 50, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 568 | 6102 |
| `(root)` | 40 | 418 |
| `docs` | 2 | 40 |
| `scripts` | 3 | 34 |
| `scripts -> tests` | 2 | 14 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 570 | 6109 |
| `(root)` | 41 | 423.5 |
| `scripts` | 6 | 46.5 |
| `docs` | 2 | 40 |

### minTokens 50, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 191 | 3020 |
| `(root)` | 17 | 243 |
| `docs` | 2 | 40 |
| `scripts` | 1 | 18 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 191 | 3020 |
| `(root)` | 18 | 248.5 |
| `docs` | 2 | 40 |
| `scripts` | 2 | 23.5 |

### minTokens 50, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 29 | 935 |
| `(root)` | 2 | 45 |
| `docs` | 1 | 22 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 29 | 935 |
| `(root)` | 2 | 45 |
| `docs` | 1 | 22 |

### minTokens 50, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 376 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 376 |

### minTokens 80, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 235 | 3232 |
| `(root)` | 16 | 208 |
| `docs` | 2 | 40 |
| `scripts` | 1 | 18 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 235 | 3232 |
| `(root)` | 17 | 213.5 |
| `docs` | 2 | 40 |
| `scripts` | 2 | 23.5 |

### minTokens 80, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 131 | 2321 |
| `(root)` | 11 | 170 |
| `docs` | 2 | 40 |
| `scripts` | 1 | 18 |
| `(root) -> scripts` | 1 | 11 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 131 | 2321 |
| `(root)` | 12 | 175.5 |
| `docs` | 2 | 40 |
| `scripts` | 2 | 23.5 |

### minTokens 80, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 28 | 910 |
| `(root)` | 2 | 45 |
| `docs` | 1 | 22 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 28 | 910 |
| `(root)` | 2 | 45 |
| `docs` | 1 | 22 |

### minTokens 80, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 376 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 376 |

### minTokens 120, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 78 | 1568 |
| `(root)` | 3 | 50 |
| `docs` | 1 | 22 |
| `scripts` | 1 | 18 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 78 | 1568 |
| `(root)` | 3 | 50 |
| `docs` | 1 | 22 |
| `scripts` | 1 | 18 |

### minTokens 120, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 68 | 1486 |
| `(root)` | 3 | 50 |
| `docs` | 1 | 22 |
| `scripts` | 1 | 18 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 68 | 1486 |
| `(root)` | 3 | 50 |
| `docs` | 1 | 22 |
| `scripts` | 1 | 18 |

### minTokens 120, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 27 | 883 |
| `(root)` | 1 | 22 |
| `docs` | 1 | 22 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 27 | 883 |
| `(root)` | 1 | 22 |
| `docs` | 1 | 22 |

### minTokens 120, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 376 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 7 | 376 |

### minTokens 200, minLines 6

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 17 | 628 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 17 | 628 |

### minTokens 200, minLines 10

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 17 | 628 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 17 | 628 |

### minTokens 200, minLines 20

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 16 | 616 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 16 | 616 |

### minTokens 200, minLines 40

| Directory pair | Clones | Duplicated lines |
| --- | --- | --- |
| `tests` | 6 | 330 |

| Directory | Clones touching | Credited duplicated lines |
| --- | --- | --- |
| `tests` | 6 | 330 |
```

## What the numbers say

- At `minTokens 50, minLines 10` the tree measures 212 clones,
  3332 duplicated lines, 3.02% across
  294 sources.
- Tests carry the number: 191 clones and 3020 credited
  lines, 91% of all duplicated lines. Root modules carry
  248.5, about 0.23% of measured lines.
- `minLines` is the binding knob. At 6 it measures 6619
  lines (6.01%); at 10 it measures 3332,
  3287 lines fewer (50%). The removed band is short test
  scaffolding.
- `minTokens` is not binding. At 30 it measures 3442
  lines against 3332 at 50, a 3.3% difference.
- jscpd maps `.mjs` and `.cjs` to the `javascript` format. With only
  `typescript` listed, every `.mjs` script and tooling test was outside the
  gate. Both formats are measured now, which is why the denominator grew from
  154 to 294 sources.

## Decision

| Setting | Value | Why |
| --- | --- | --- |
| `format` | `typescript`, `javascript` | `.mjs` and `.cjs` are JavaScript to jscpd; a typescript-only filter silently excluded them |
| `minTokens` | 50 | Not the binding knob, so it keeps token-light clones out |
| `minLines` | 10 | Removes the 6-9 line test-boilerplate band (50% of the old total) |
| `threshold` | 3.3 | Measured 3.02% plus about 303 lines of headroom, so the budget stays a ratchet |

Everything stays measured: `tests/**` is not excluded. A copy-pasted test is a
maintenance liability, and excluding it would hide the number this audit exposes.
