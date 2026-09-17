#!/usr/bin/env node
/**
 * report.mjs — prioritised triage report.
 *
 * Answers the only question that matters on a Monday morning: of the flaky
 * tests I have, which one do I fix first, and what is wrong with it?
 *
 * USAGE
 *   node detect/report.mjs <reports-dir> [options]
 *
 *   --json                     machine-readable report on stdout (schemaVersion 1)
 *   --md                       markdown report (paste into a PR or an issue)
 *   --top <n>                  show only the n highest-priority tests
 *   --include-stable           also list tests that passed every run
 *   --fail-on-flaky            exit 1 when a non-quarantined flaky test exists
 *   --fail-on-category a,b     exit 1 when a flaky test in one of these categories exists
 *   --min-flake-rate <0..1>    ignore tests below this flakiness rate (default 0)
 *   --solo <file|dir>          reports from single-test reproduction runs (--grep)
 *   --serial <file|dir>        reports from a single-worker run of the whole suite
 *   --out <file>               write the report to a file instead of stdout
 *
 * PRIORITISATION (see docs/CLASSIFICATION.md for the long version)
 *   priority = categorySeverity × confidenceWeight × (0.5 + 0.5 × flakeRate) × 20
 *   rounded to 1 decimal, tie-broken by CI time burned, then by title.
 *   Everything in that formula is visible in this file and tunable.
 */

import fs from 'node:fs';
import path from 'node:path';

import { aggregate, analyze, VERDICT, flakyTests, looksSerial, isDirectInvocation } from './parse-results.mjs';
import { classifyAll, CATEGORY, FIX_FILE, RULES } from './classify.mjs';

export const SCHEMA_VERSION = 1;

/**
 * How bad is this category if it is real? Higher = fix sooner.
 * These weights encode a judgement, and the judgement is spelled out:
 *  - 5: almost always a genuine product or accessibility defect (strict mode)
 *  - 4: hides real bugs and corrupts other tests (races, network, order)
 *  - 3: real but narrower (contention, non-deterministic data)
 *  - 2: usually test-side mechanics (timeout, animation)
 *  - 1: we do not know yet, so rank it last and go collect evidence
 */
export const CATEGORY_SEVERITY = {
  [CATEGORY.STRICT_MODE_VIOLATION]: 5,
  [CATEGORY.MISSING_AWAIT_RACE]: 4,
  [CATEGORY.NETWORK_TIMING]: 4,
  [CATEGORY.TEST_ORDER_DEPENDENCY]: 4,
  [CATEGORY.RESOURCE_CONTENTION]: 3,
  [CATEGORY.NONDETERMINISTIC_DATA]: 3,
  [CATEGORY.ANIMATION_TRANSITION]: 2,
  [CATEGORY.TIMEOUT]: 2,
  [CATEGORY.UNKNOWN]: 1,
};

export const CONFIDENCE_WEIGHT = { high: 1, medium: 0.8, low: 0.6 };

const CATEGORY_ORDER = Object.keys(CATEGORY_SEVERITY).sort(
  (a, b) => CATEGORY_SEVERITY[b] - CATEGORY_SEVERITY[a],
);

/** 0-100 priority score. Same inputs, same number, every time. */
export function priorityScore({ category, confidence, flakeRate }) {
  const severity = CATEGORY_SEVERITY[category] ?? 1;
  const weight = CONFIDENCE_WEIGHT[confidence] ?? 0.6;
  return Math.round(severity * weight * (0.5 + 0.5 * flakeRate) * 20 * 10) / 10;
}

function humanDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function wrap(text, width = 96, indent = '      ') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width - indent.length) line += ` ${word}`;
    else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Budget / diagnostic warnings
 * ------------------------------------------------------------------ */

function buildWarnings({ runs, tests, globalErrors }) {
  const warnings = [];
  if (runs.length === 0) {
    warnings.push('No report files were parsed. Point the tool at a directory of JSON reporter outputs (one file per run).');
    return warnings;
  }
  if (runs.length < 3) {
    warnings.push(
      `Only ${runs.length} run(s) collected. Rates from fewer than ~10 runs are noisy: a test that is 20% flaky can pass 3 runs in a row and look clean. See docs/CI-SETUP.md for the collection loop.`,
    );
  }
  const retrySettings = [...new Set(runs.map((r) => r.config?.retries).filter((v) => typeof v === 'number'))];
  if (retrySettings.length === 1 && retrySettings[0] === 0) {
    warnings.push(
      'Every collected run had retries=0. Flakes are therefore only visible ACROSS runs. That is the cleaner signal, but it means a single-run pipeline can never see them — see docs/CI-SETUP.md.',
    );
  }
  if (retrySettings.some((v) => v > 0)) {
    warnings.push(
      `Some runs used retries (${retrySettings.join(', ')}). Any test whose result was "passed after a failed attempt" is counted as flaky, not as a pass. If your pipeline only stores the final exit code or a summary that hides retries, those flakes are invisible to you.`,
    );
  }
  if (globalErrors.length > 0) {
    warnings.push(
      `${globalErrors.length} run(s) contain reporter-level errors (for example a webServer that failed to start). Failures in those runs are usually infrastructure, not test flakiness — check docs/CI-SETUP.md before quarantining anything.`,
    );
  }
  const workerSets = [...new Set(runs.map((r) => r.config?.workers).filter((v) => typeof v === 'number'))];
  if (workerSets.length > 1) {
    warnings.push(
      `Collected runs used different worker counts (${workerSets.join(', ')}). If that was deliberate (a parallel run and a serial run), the serial run is used as evidence for resource-contention; if it was accidental, the comparison still works but read the evidence carefully.`,
    );
  }
  const versions = [...new Set(runs.map((r) => r.config?.version).filter(Boolean))];
  if (versions.length > 1) {
    warnings.push(`Collected runs came from different Playwright versions (${versions.join(', ')}). Error texts differ between versions; re-run the classifier after upgrading.`);
  }
  const shards = runs.filter((r) => r.config?.shard).length;
  if (shards > 0 && shards !== runs.length) {
    warnings.push(
      `${shards} of ${runs.length} run(s) came from a sharded run. A shard only contains part of the suite: treat each shard as a partial run, or merge shards before triaging, otherwise the run history for a test is uneven.`,
    );
  }
  const observed = tests.length;
  if (observed === 0) warnings.push('Reports were parsed but contained no test specs. Was --reporter=json actually used?');
  return warnings;
}

/* ------------------------------------------------------------------ *
 * Report construction
 * ------------------------------------------------------------------ */

/**
 * @param {object} input {tests, runs, globalErrors} from parse-results analyze()
 * @param {{verdicts?: Map, minFlakeRate?: number, generatedAt?: string, sourceInputs?: string[]}} [options]
 */
export function buildReport(input, options = {}) {
  const { tests, runs, globalErrors } = input;
  const minFlakeRate = options.minFlakeRate ?? 0;
  const verdicts = options.verdicts ?? classifyAll(tests, { runs, evidenceRuns: options.evidenceRuns });

  const flaky = flakyTests(tests).filter((t) => t.flakeRate >= minFlakeRate);
  const consistentFailures = tests.filter((t) => t.verdict === VERDICT.CONSISTENTLY_FAILING);
  const stable = tests.filter((t) => t.verdict === VERDICT.STABLE_PASS);
  const skipped = tests.filter((t) => t.verdict === VERDICT.ALWAYS_SKIPPED);
  const expectedFailures = tests.filter((t) => t.verdict === VERDICT.EXPECTED_FAILURE);
  const quarantined = tests.filter((t) => t.quarantined);

  const entries = flaky.map((test) => {
    const verdict = verdicts.get(test.testId);
    const priority = priorityScore({ category: verdict.category, confidence: verdict.confidence, flakeRate: test.flakeRate });
    return {
      testId: test.testId,
      title: test.fullTitle,
      file: test.file,
      projectName: test.projectName,
      location: test.location,
      category: verdict.category,
      confidence: verdict.confidence,
      priority,
      flakeRate: test.flakeRate,
      failRate: test.failRate,
      retryRate: test.retryRate,
      counts: test.counts,
      runsObserved: test.counts.runsObserved,
      evidence: verdict.evidence,
      hints: verdict.hints,
      rejected: verdict.rejected ?? [],
      fixSummary: verdict.fixSummary,
      fixFile: verdict.fixFile,
      quarantined: test.quarantined,
      quarantineMarker: test.quarantineMarker,
      trend: test.trend,
      firstFailureRun: test.failureRuns.length ? test.failureRuns[0] : null,
      lastFailureRun: test.failureRuns.length ? test.failureRuns[test.failureRuns.length - 1] : null,
      failureRuns: test.failureRuns,
      wastedMs: test.wastedDurationMs,
      distinctErrors: test.distinctErrors.map((e) => ({ count: e.count, sample: e.sample, normalized: e.normalized })),
    };
  });

  entries.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.wastedMs - a.wastedMs ||
      b.counts.failedOutright - a.counts.failedOutright ||
      a.title.localeCompare(b.title),
  );
  entries.forEach((e, i) => {
    e.rank = i + 1;
  });

  const byCategory = CATEGORY_ORDER.map((category) => {
    const inCategory = entries.filter((e) => e.category === category);
    return {
      category,
      count: inCategory.length,
      severity: CATEGORY_SEVERITY[category],
      fixFile: FIX_FILE[category],
      tests: inCategory.map((t) => ({ title: t.title, file: t.file, flakeRate: t.flakeRate, priority: t.priority })),
    };
  }).filter((c) => c.count > 0);

  const wastedMs = tests.reduce((sum, t) => sum + (t.wastedDurationMs || 0), 0);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    generator: 'playwright-flaky-test-triage-kit/detect/report.mjs',
    inputs: options.sourceInputs ?? runs.map((r) => r.sourceFile),
    runs: runs.map((r) => ({
      index: r.runIndex,
      sourceFile: r.sourceFile,
      label: r.label,
      tests: r.testCount,
      config: r.config,
      reporterErrors: r.errors,
    })),
    totals: {
      runs: runs.length,
      testsObserved: tests.length,
      flaky: flaky.length,
      quarantined: quarantined.length,
      consistentlyFailing: consistentFailures.length,
      stablePassing: stable.length,
      alwaysSkipped: skipped.length,
      markedExpectedFailures: expectedFailures.length,
      wastedMs,
      wastedHuman: humanDuration(wastedMs),
    },
    categories: byCategory,
    warnings: buildWarnings({ runs, tests, globalErrors }),
    globalErrors,
    triage: entries,
    quarantined: quarantined.map((t) => ({
      testId: t.testId,
      title: t.fullTitle,
      file: t.file,
      marker: t.quarantineMarker,
      flakeRate: t.flakeRate,
      category: verdicts.get(t.testId)?.category ?? null,
    })),
    consistentFailures: consistentFailures.map((t) => ({
      testId: t.testId,
      title: t.fullTitle,
      file: t.file,
      failures: t.counts.failedOutright,
      category: verdicts.get(t.testId)?.category ?? null,
      firstError: t.distinctErrors[0]?.sample ?? null,
    })),
    stableTests: stable.map((t) => ({ testId: t.testId, title: t.fullTitle, cleanPasses: t.counts.cleanPass })),
    markedExpectedFailures: expectedFailures.map((t) => ({ testId: t.testId, title: t.fullTitle, runs: t.counts.expectedFail })),
    methodology: {
      priorityFormula: 'categorySeverity × confidenceWeight × (0.5 + 0.5 × flakeRate) × 20',
      categorySeverity: CATEGORY_SEVERITY,
      confidenceWeight: CONFIDENCE_WEIGHT,
      rules: RULES.map((r) => ({ id: r.id, category: r.category, signals: r.signals })),
      notes: [
        'Classification is heuristic and evidence-based. "unknown" is a legitimate outcome meaning the report did not contain the deciding signal.',
        'A test that failed in every run is reported as consistently-failing, not flaky.',
        'A test that only passed after a retry is counted as flaky, never as a pass.',
      ],
    },
  };
}

/* ------------------------------------------------------------------ *
 * Renderers
 * ------------------------------------------------------------------ */

export function renderText(report, options = {}) {
  const top = options.top ?? Infinity;
  const includeStable = options.includeStable === true;
  const L = [];
  const rule = '─'.repeat(78);

  L.push('PLAYWRIGHT FLAKY TEST TRIAGE');
  L.push('='.repeat(78));
  const t = report.totals;
  L.push(
    `${t.runs} run(s) · ${t.testsObserved} test(s) observed · ${t.flaky} flaky · ` +
      `${t.consistentlyFailing} consistently failing · ${t.stablePassing} stable` +
      (t.alwaysSkipped ? ` · ${t.alwaysSkipped} skipped` : ''),
  );
  L.push(`CI time burned by failed attempts and retries: ${t.wastedHuman}`);
  const versions = [...new Set(report.runs.map((r) => r.config?.version).filter(Boolean))];
  const workers = [...new Set(report.runs.map((r) => r.config?.workers).filter((v) => typeof v === 'number'))];
  const retries = [...new Set(report.runs.map((r) => r.config?.retries).filter((v) => typeof v === 'number'))];
  if (versions.length || workers.length || retries.length) {
    L.push(
      `Playwright ${versions.join('/') || '?'} · workers ${workers.join('/') || '?'} · retries ${retries.join('/') || '?'}`,
    );
  }
  if (Array.isArray(report.evidenceRuns) && report.evidenceRuns.length > 0) {
    L.push(
      `Evidence-only runs (not counted in the rates): ${report.evidenceRuns
        .map((r) => `${r.label} [${r.kind}]`)
        .join(', ')}`,
    );
  }
  L.push('');

  if (report.warnings.length > 0) {
    L.push('READ THIS FIRST');
    L.push(rule);
    for (const w of report.warnings) L.push(wrap(`• ${w}`));
    L.push('');
  }

  if (report.triage.length === 0) {
    L.push('WHAT TO FIX FIRST');
    L.push(rule);
    L.push(
      wrap(
        report.totals.runs <= 1
          ? 'No flaky test found. With a single run, only a pass-on-retry (which needs --retries) can reveal a flake. Collect more runs — see docs/CI-SETUP.md.'
          : 'No test failed in one run and passed in another. That is not proof of stability: collect more runs and keep reading retries as failures, not passes.',
      ),
    );
    L.push('');
  } else {
    L.push('WHAT TO FIX FIRST');
    L.push(rule);
    const shown = report.triage.slice(0, top === Infinity ? report.triage.length : top);
    for (const e of shown) {
      L.push(
        ` ${String(e.rank).padStart(2)}. [${e.category} · ${e.confidence}] ${e.title}` +
          (e.projectName ? `  [${e.projectName}]` : ''),
      );
      L.push(
        `     priority ${e.priority}/100 · ${pct(e.flakeRate)} flaky ` +
          `(${e.counts.failedOutright} failed, ${e.counts.passedOnRetry} pass-on-retry, ${e.counts.cleanPass} clean) · ${e.file}`,
      );
      if (e.quarantined) L.push(`     QUARANTINED (marker: ${e.quarantineMarker}) — tracked, not fixed`);
      for (const ev of e.evidence) L.push(wrap(`evidence [${ev.signal}]: ${ev.detail}`, 96, '     '));
      for (const r of e.rejected) L.push(wrap(`ruled out: ${r}`, 96, '     '));
      for (const h of e.hints) L.push(wrap(`also plausible: ${h.category} (rule ${h.rule}) — ${h.detail}`, 96, '     '));
      L.push(wrap(`fix: ${e.fixSummary}`, 96, '     '));
      L.push(`     read: ${e.fixFile}`);
      L.push('');
    }
    if (shown.length < report.triage.length) {
      L.push(`(${report.triage.length - shown.length} more flaky test(s) not shown; raise --top)`);
      L.push('');
    }
  }

  L.push('BY CATEGORY');
  L.push(rule);
  if (report.categories.length === 0) L.push('  (nothing to classify)');
  for (const c of report.categories) {
    L.push(`  ${c.category.padEnd(24)} ${String(c.count).padStart(3)}  severity ${c.severity}/5  → ${c.fixFile}`);
  }
  L.push('');

  if (report.consistentFailures.length > 0) {
    L.push('CONSISTENTLY FAILING (not flaky — fix as normal bugs)');
    L.push(rule);
    for (const c of report.consistentFailures) {
      L.push(`  ${c.title}  [${c.failures} failures${c.category ? `, looks like ${c.category}` : ''}]`);
    }
    L.push('');
  }

  if (report.quarantined.length > 0) {
    L.push('QUARANTINED');
    L.push(rule);
    for (const q of report.quarantined) {
      L.push(`  ${q.title}  [marker: ${q.marker}, category ${q.category ?? 'n/a'}, ${pct(q.flakeRate)} flaky]`);
    }
    L.push('  A quarantined test must have an owner and an expiry date. See docs/QUARANTINE-POLICY.md.');
    L.push('');
  }

  if (report.globalErrors.length > 0) {
    L.push('REPORTER-LEVEL ERRORS');
    L.push(rule);
    for (const g of report.globalErrors) {
      for (const err of g.errors) L.push(wrap(`• ${path.basename(g.sourceFile)}: ${err}`, 96, '  '));
    }
    L.push('');
  }

  if (report.markedExpectedFailures.length > 0) {
    L.push('MARKED EXPECTED-TO-FAIL (test.fail(): behaving as configured, not flakes)');
    L.push(rule);
    for (const e of report.markedExpectedFailures) L.push(`  ${e.title}  [failed as expected in ${e.runs} run(s)]`);
    L.push('');
  }

  if (includeStable) {
    L.push('STABLE IN EVERY COLLECTED RUN');
    L.push(rule);
    for (const s of report.stableTests) L.push(`  ${s.title}  [${s.cleanPasses} clean passes]`);
    L.push('');
  }

  L.push(rule);
  L.push(`Priority = ${report.methodology.priorityFormula}`);
  L.push('Classification is heuristic. "unknown" means the report lacked the deciding signal, not that the test is fine.');
  L.push(`Generated ${report.generatedAt} by ${report.generator}`);
  return L.join('\n');
}

export function renderMarkdown(report, options = {}) {
  const top = options.top ?? Infinity;
  const L = [];
  const t = report.totals;
  L.push('# Playwright flaky test triage');
  L.push('');
  L.push(`- Collected runs: **${t.runs}**`);
  L.push(`- Tests observed: **${t.testsObserved}**`);
  L.push(`- Flaky (failed one run, passed another, or passed only on retry): **${t.flaky}**`);
  L.push(`- Consistently failing: **${t.consistentlyFailing}**`);
  L.push(`- CI time burned by failed attempts and retries: **${t.wastedHuman}**`);
  L.push('');

  if (report.warnings.length > 0) {
    L.push('## Read this first');
    L.push('');
    for (const w of report.warnings) L.push(`- ${w}`);
    L.push('');
  }

  L.push('## What to fix first');
  L.push('');
  const shown = report.triage.slice(0, top === Infinity ? report.triage.length : top);
  if (shown.length === 0) L.push('No flaky test found in the collected runs.');
  for (const e of shown) {
    L.push(`### ${e.rank}. ${e.title}${e.projectName ? ` \`[${e.projectName}]\`` : ''}`);
    L.push('');
    L.push(`- **Category:** \`${e.category}\` (confidence: ${e.confidence}, priority ${e.priority}/100)`);
    L.push(
      `- **Flakiness:** ${pct(e.flakeRate)} — ${e.counts.failedOutright} outright failure(s), ` +
        `${e.counts.passedOnRetry} pass-on-retry, ${e.counts.cleanPass} clean pass(es) in ${e.counts.runsObserved} run(s)`,
    );
    L.push(`- **File:** \`${e.file}\``);
    L.push(`- **Fix:** ${e.fixSummary}`);
    L.push(`- **Guide:** \`${e.fixFile}\``);
    L.push('');
    L.push('Evidence:');
    L.push('');
    for (const ev of e.evidence) L.push(`- \`${ev.signal}\` — ${ev.detail}`);
    for (const r of e.rejected) L.push(`- (ruled out) ${r}`);
    for (const h of e.hints) L.push(`- (also plausible) \`${h.category}\` via ${h.rule} — ${h.detail}`);
    L.push('');
  }

  L.push('## By category');
  L.push('');
  L.push('| Category | Tests | Severity | Guide |');
  L.push('|---|---|---|---|');
  for (const c of report.categories) L.push(`| \`${c.category}\` | ${c.count} | ${c.severity}/5 | \`${c.fixFile}\` |`);
  L.push('');

  if (report.quarantined.length > 0) {
    L.push('## Quarantined');
    L.push('');
    for (const q of report.quarantined) L.push(`- ${q.title} (marker: \`${q.marker}\`)`);
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(`Priority formula: \`${report.methodology.priorityFormula}\`. Classification is heuristic and may return \`unknown\`.`);
  L.push('');
  L.push(`Generated ${report.generatedAt} by \`${report.generator}\` (schema ${report.schemaVersion}).`);
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

/**
 * Turn a solo/serial analysis into per-file evidence records. Evidence is
 * matched to tests by IDENTITY (testId), so a report only ever counts as
 * evidence for the exact tests that were in it and passed there.
 */
export function buildEvidenceRuns(analysis) {
  const out = [];
  for (const run of analysis.runs) {
    const observations = analysis.observations.filter((o) => o.sourceFile === run.sourceFile);
    if (observations.length === 0) continue;
    const aggregated = aggregate(observations);
    out.push({
      sourceFile: run.sourceFile,
      label: run.label,
      kind: looksSerial(run.label) || (/solo|alone|isolated|repro/i.test(String(run.label)) === false && run.config?.actualWorkers === 1 && run.testCount > 3) ? 'serial' : 'solo',
      testCount: run.testCount,
      config: run.config,
      passedTestIds: new Set(
        aggregated.filter((t) => t.counts.cleanPass + t.counts.passedOnRetry > 0).map((t) => t.testId),
      ),
    });
  }
  return out;
}

function parseArgs(argv) {
  const opts = {
    targets: [],
    json: false,
    markdown: false,
    top: Infinity,
    includeStable: false,
    failOnFlaky: false,
    failOnCategory: null,
    minFlakeRate: 0,
    solo: [],
    serial: [],
    out: null,
  };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--json') opts.json = true;
    else if (a === '--md' || a === '--markdown') opts.markdown = true;
    else if (a === '--include-stable') opts.includeStable = true;
    else if (a === '--fail-on-flaky') opts.failOnFlaky = true;
    else if (a === '--top') opts.top = Number(args[++i]);
    else if (a === '--min-flake-rate') opts.minFlakeRate = Number(args[++i]);
    else if (a === '--fail-on-category') opts.failOnCategory = String(args[++i]).split(',').map((s) => s.trim());
    else if (a === '--solo') opts.solo.push(args[++i]);
    else if (a === '--serial') opts.serial.push(args[++i]);
    else if (a === '--out') opts.out = args[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.targets.push(a);
  }
  return opts;
}

const HELP = `usage: Playwright flaky test triage report

  node detect/report.mjs <reports-dir|report.json ...> [options]

  --json                   machine-readable report (schemaVersion ${SCHEMA_VERSION})
  --md                     markdown report
  --top <n>                show only the n highest-priority tests
  --include-stable         also list tests that passed every run
  --fail-on-flaky          exit 1 if a non-quarantined flaky test exists
  --fail-on-category a,b   exit 1 if a flaky test in these categories exists
  --min-flake-rate <0..1>  ignore tests below this flakiness rate
  --solo <path>            single-test reproduction run(s) — evidence for test-order-dependency
  --serial <path>          single-worker full-suite run(s) — evidence for resource-contention
  --out <file>             write output to a file instead of stdout
`;

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help || (opts.targets.length === 0 && opts.solo.length === 0 && opts.serial.length === 0)) {
    process.stdout.write(HELP);
    return opts.help ? 0 : 2;
  }

  const warnings = [];
  const primary = analyze(opts.targets.length ? opts.targets : [], { onWarning: (w) => warnings.push(w) });
  // Solo and serial reports are evidence, not extra runs: keep them out of the
  // run history so they cannot dilute the flakiness rates.
  const solo = analyze(opts.solo, { onWarning: (w) => warnings.push(w), label: null });
  const serial = analyze(opts.serial, { onWarning: (w) => warnings.push(w), label: null });

  const tests = primary.tests;
  const allRuns = [...primary.runs, ...solo.runs, ...serial.runs];
  const evidenceRuns = [...buildEvidenceRuns(solo), ...buildEvidenceRuns(serial)];
  const verdicts = classifyAll(tests, { runs: primary.runs, evidenceRuns });

  const report = buildReport(
    { tests, runs: primary.runs, globalErrors: primary.globalErrors },
    { verdicts, minFlakeRate: opts.minFlakeRate, sourceInputs: [...opts.targets, ...opts.solo, ...opts.serial] },
  );
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  // Evidence runs are reported separately: they are not part of the run history
  // that the flakiness rates are computed from.
  report.evidenceRuns = evidenceRuns.map((r) => ({
    sourceFile: r.sourceFile,
    label: r.label,
    kind: r.kind,
    tests: r.testCount,
    passedTests: r.passedTestIds.size,
    config: r.config,
  }));

  const output = opts.json
    ? JSON.stringify(report, null, 2)
    : opts.markdown
      ? renderMarkdown(report, opts)
      : renderText(report, opts);

  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, `${output}\n`);
    process.stderr.write(`wrote ${opts.out}\n`);
  } else {
    process.stdout.write(`${output}\n`);
  }

  const actionable = report.triage.filter((e) => !e.quarantined);
  if (opts.failOnCategory) {
    const hit = actionable.find((e) => opts.failOnCategory.includes(e.category));
    if (hit) {
      process.stderr.write(`failing: ${hit.title} is ${hit.category}\n`);
      return 1;
    }
  }
  if (opts.failOnFlaky && actionable.length > 0) {
    process.stderr.write(`failing: ${actionable.length} flaky test(s) need triage\n`);
    return 1;
  }
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  try {
    process.exitCode = main(process.argv);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 2;
  }
}
