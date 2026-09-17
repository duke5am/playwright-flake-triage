# playwright-flake-triage

Turn **"this test is flaky"** into **"it fails because of X, here is the fix."**

Point it at Playwright JSON reports collected across several runs and it tells you
which tests are flaky, why, and what to fix first. No dependencies beyond Node.

```bash
python3 -m playwright test --reporter=json > run-01.json     # repeat N times
node detect/report.mjs runs/
```

```
PLAYWRIGHT FLAKY TEST TRIAGE
10 run(s) · 16 test(s) observed · 14 flaky · 2 stable
CI time burned by failed attempts and retries: 2m 12s

WHAT TO FIX FIRST
  1. [strict-mode-violation · high] opens the first product  [chromium]
     priority 80/100 · 60% flaky (6 failed, 4 clean) · strict-mode.spec.mjs
     evidence [error message]: locator('.product-tile') matched 2 elements where
                               exactly one was required
     fix: The locator matches more than one element. Narrow it (getByRole with an
          accessible name) — the multi-match is usually an app bug.
```

A bundled demo (`samples/`) has ten real runs so you can see it work immediately:

```bash
node detect/report.mjs samples
```

## It classifies into causes, not just "flaky"

| Category | The signal |
|---|---|
| `strict-mode-violation` | the locator matched more than one element |
| `missing-await-race` | failure at a locator immediately after an action |
| `timeout` | the test hit its timeout rather than failing an assertion |
| `test-order-dependency` | passes alone, fails in the suite |
| `resource-contention` | only fails with workers > 1 |
| `animation-transition` | element not stable |
| `network-timing` | failure mentions a request or response |
| `nondeterministic-data` | depends on ordering or generated data |
| `unknown` | **no usable evidence — and it says so** |

`unknown` is a legitimate outcome and is ranked last so it never displaces a
diagnosis you can act on. The report also lists the signals it *rejected* and why.

## The distinction that matters

Every classification is derived from evidence in the run history, and the report
shows that evidence:

```
evidence [rule]: R1 matched: error message matches /strict mode violation/
evidence [run history]: 6 failed run(s), 0 run(s) that only passed on retry
```

It also tells you when your collection method cannot detect flakes — for instance
if every run had `retries=0`, a **single-run** pipeline will never see them, and
the report says so rather than implying the suite is clean.

## Requirements

Node 20+. No dependencies, no install. You need Playwright reports in JSON
(`--reporter=json`), collected across several runs — one run cannot show a flake.

## The full pack

The paid kit adds the **prove-it project** that reproduces each failure mode on
purpose so you can watch the classifier work; nine `fixes/` guides with
wrong-and-right code and why the common fix (a hard sleep, or `retries: 3` to hide
it) is harmful; the CI setup and quarantine-policy guides; and 104 tests.

→ **Playwright Flaky Test Triage Kit**: <!-- GUMROAD-LINK -->
