#!/usr/bin/env node
/**
 * parse-results.mjs — read Playwright JSON reporter output and work out which
 * tests passed in some runs and failed in others.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Playwright's JSON reporter describes ONE run. Flakiness is a property of MANY
 * runs, so the first job is to turn N report files into a per-test history.
 * Everything else in this kit (classification, triage report) is built on the
 * structures this file returns.
 *
 * NO DEPENDENCIES. Node >= 18. Nothing here touches the network.
 *
 * THE REAL REPORTER SHAPE (verified against @playwright/test 1.63.0)
 * ------------------------------------------------------------------
 *   {
 *     "config":  { "rootDir", "workers", "projects": [...], "version", ... },
 *     "suites":  [ { "title", "file", "specs": [...], "suites": [ ...nested... ] } ],
 *     "errors":  [ ...global errors, e.g. webServer failed to start... ],
 *     "stats":   { "startTime", "duration", ... }
 *   }
 *
 * A suite is a FILE at the top level, and a `describe()` block when nested.
 * `suites` nests arbitrarily deep. A spec is one `test()` declaration:
 *
 *   spec = { "title", "ok", "tags", "id", "file", "line", "column", "tests": [...] }
 *
 * `spec.tests` holds one entry per project (and per repeat, under --repeat-each):
 *
 *   test = { "timeout", "annotations", "expectedStatus", "projectName",
 *            "projectId", "status", "results": [...] }
 *
 *   test.status         : "expected" | "unexpected" | "flaky" | "skipped"
 *   test.expectedStatus : "passed"   | "failed"     | "skipped"   (test.fail/skip)
 *
 * `test.results` holds one entry per ATTEMPT (retries included):
 *
 *   result = { "status", "duration", "retry", "workerIndex", "parallelIndex",
 *              "startTime", "errors": [ { "message", "location" } ], "stdout", ... }
 *
 *   result.status : "passed" | "failed" | "timedOut" | "skipped" | "interrupted"
 *
 * THREE THINGS THAT BITE EVERYONE
 * -------------------------------
 * 1. `test.status === "flaky"` is Playwright's own name for "failed, then passed
 *    on retry". One JSON file can therefore contain flakiness WITHOUT running
 *    the suite N times — but only if you enabled retries. See docs/CI-SETUP.md.
 * 2. Error messages keep their ANSI colour escapes (`\u001b[31m...`). Every
 *    pattern match in this kit runs on stripAnsi()'d text, otherwise a rule that
 *    works locally fails in a colourful terminal.
 * 3. A `timedOut` result usually carries TWO errors: the generic
 *    "Test timeout of Nms exceeded." and the real underlying one. Both are kept.
 * 4. `result.status === "interrupted"` means CI was cancelled or the worker was
 *    killed. It is NOT a failure and must never be counted as one, or every
 *    cancelled build looks like a flaky build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * CLI helpers
 * ------------------------------------------------------------------ */

/**
 * Was this module run as the entry script (`node detect/report.mjs ...`) rather
 * than imported as a library?
 *
 * Comparing raw paths is not enough: if the kit (or the project) is reached
 * through a symlink — pnpm stores, a plain `ln -s`, some container mounts — then
 * process.argv[1] holds the symlinked path while import.meta.url holds the real
 * one, the comparison fails, and the CLI exits silently having done nothing.
 * Resolve both sides before comparing.
 */
export function isDirectInvocation(importMetaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(importMetaUrl));
  }
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

// Matches CSI colour/style sequences, e.g. ESC[2m ESC[31m ESC[39m ESC[22m.
const ANSI_PATTERN = /[\u001b\u009b]\[[0-9;]*[A-Za-z]/g;

/** Remove ANSI colour escapes from a string. */
export function stripAnsi(text) {
  return typeof text === 'string' ? text.replace(ANSI_PATTERN, '') : '';
}

/**
 * Collapse a failure message into a stable fingerprint so that the same bug
 * seen in five runs groups into one entry. Volatile parts (numbers, durations,
 * quoted VALUES, hex ids, absolute paths, code-frame line numbers) are removed.
 *
 * Deliberate exception: SHORT quoted strings are kept. `locator("#a")` and
 * `locator("#b")` are different failures with different fixes, and collapsing
 * every quoted string to <STR> would merge them. Only long payloads (JSON
 * bodies, snapshot blobs) are collapsed.
 */
export function normalizeMessage(message) {
  return stripAnsi(message)
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !/^\s*\d+\s*\|/.test(line) && !/^\s*(>|\^|\|)/.test(line)) // drop code frames
    .join('\n')
    .replace(/0x[0-9a-f]+/gi, '<HEX>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
    .replace(/\b\d+(\.\d+)?\s?m?s\b/g, '<DURATION>')
    .replace(/\b\d+\b/g, '<N>')
    .replace(/"(?:[^"\\]|\\.){60,}"/g, '"<STR>"')
    .replace(/'(?:[^'\\]|\\.){60,}'/g, "'<STR>'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/* ------------------------------------------------------------------ *
 * Outcomes
 * ------------------------------------------------------------------ */

/** Per-attempt outcome. `pass-on-retry` is not a pass — it is a flake. */
export const OUTCOME = {
  PASS: 'pass',
  PASS_ON_RETRY: 'pass-on-retry',
  FAIL: 'fail',
  SKIPPED: 'skipped',
  INTERRUPTED: 'interrupted',
  EXPECTED_FAIL: 'expected-fail',
  UNEXPECTED_PASS: 'unexpected-pass',
  NOT_OBSERVED: 'not-observed',
};

/** Per-test verdict across all report files. */
export const VERDICT = {
  FLAKY: 'flaky',
  FLAKY_RETRY_ONLY: 'flaky-retry-only',
  STABLE_PASS: 'stable-pass',
  CONSISTENTLY_FAILING: 'consistently-failing',
  ALWAYS_SKIPPED: 'always-skipped',
  EXPECTED_FAILURE: 'expected-failure',
  NOT_OBSERVED: 'not-observed',
};

const FAILING_RESULT_STATUSES = new Set(['failed', 'timedOut']);

/**
 * Reduce one attempt (a `result` object) to an outcome, honouring
 * `expectedStatus` so that `test.fail()` and `test.skip()` are not miscounted.
 */
export function outcomeForAttempt(result, expectedStatus = 'passed') {
  const status = result?.status ?? 'failed';
  if (expectedStatus === 'skipped' || status === 'skipped') return OUTCOME.SKIPPED;
  if (status === 'interrupted') return OUTCOME.INTERRUPTED;
  if (expectedStatus === 'failed') {
    return FAILING_RESULT_STATUSES.has(status) ? OUTCOME.EXPECTED_FAIL : OUTCOME.UNEXPECTED_PASS;
  }
  if (status === 'passed') return OUTCOME.PASS;
  return OUTCOME.FAIL;
}

/**
 * Reduce one test's attempts within ONE run to a single outcome.
 * A run where attempt 0 failed and attempt 1 passed is `pass-on-retry`.
 */
export function runOutcomeForAttempts(attempts) {
  if (attempts.length === 0) return OUTCOME.NOT_OBSERVED;
  const outcomes = attempts.map((a) => a.outcome);
  const real = outcomes.filter(
    (o) => o !== OUTCOME.SKIPPED && o !== OUTCOME.INTERRUPTED && o !== OUTCOME.EXPECTED_FAIL,
  );
  if (real.length === 0) {
    if (outcomes.includes(OUTCOME.INTERRUPTED)) return OUTCOME.INTERRUPTED;
    if (outcomes.includes(OUTCOME.EXPECTED_FAIL)) return OUTCOME.EXPECTED_FAIL;
    return OUTCOME.SKIPPED;
  }
  const hasPass = real.includes(OUTCOME.PASS) || real.includes(OUTCOME.UNEXPECTED_PASS);
  const hasFail = real.includes(OUTCOME.FAIL);
  if (hasPass && hasFail) return OUTCOME.PASS_ON_RETRY;
  if (hasPass) return OUTCOME.PASS;
  return OUTCOME.FAIL;
}

/* ------------------------------------------------------------------ *
 * Flattening one report file
 * ------------------------------------------------------------------ */

/**
 * Is this JSON a Playwright report at all?
 *
 * The check exists because a directory of reports is a directory you will also
 * write other JSON into — most obviously `--out reports/triage.json`, which is
 * exactly what docs/CI-SETUP.md tells you to do. Without this, the triage report
 * becomes an extra "run" on the next invocation, and the run count silently
 * changes from 10 to 11 (which is how this was found).
 */
export function looksLikePlaywrightReport(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  if (Array.isArray(doc.suites)) return true;
  if (doc.config && typeof doc.config === 'object') return true;
  if (Array.isArray(doc.errors)) return true;
  return false;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}). Use --reporter=json, not --reporter=line.`);
  }
}

/**
 * `retries`, `repeatEach` and `timeout` are per-project in the JSON reporter.
 * Fall back to the top level for other reporter shapes, then take the maximum
 * across projects so a mixed-config run is treated as its loosest setting.
 */
function pickProjectValue(config, key) {
  if (typeof config?.[key] === 'number') return config[key];
  const values = (Array.isArray(config?.projects) ? config.projects : [])
    .map((p) => p?.[key])
    .filter((v) => typeof v === 'number');
  return values.length ? Math.max(...values) : null;
}

function annotationsOf(test) {
  const list = Array.isArray(test?.annotations) ? test.annotations : [];
  return list
    .filter(Boolean)
    .map((a) => ({ type: String(a.type ?? ''), description: a.description ? String(a.description) : '' }));
}

const QUARANTINE_MARKERS = ['quarantine', 'quarantined', 'flaky', 'known-flaky', 'skip-flaky'];

/**
 * A test is treated as quarantined when it is annotated or tagged with a
 * recognised marker, or when `@quarantine` / `@flaky` appears in its title.
 * See docs/QUARANTINE-POLICY.md for the convention this kit recommends.
 */
function detectQuarantine(test, spec, fullTitlePath) {
  const haystack = [
    ...annotationsOf(test).map((a) => `${a.type} ${a.description}`),
    ...(Array.isArray(spec?.tags) ? spec.tags : []),
    ...fullTitlePath,
  ]
    .join(' ')
    .toLowerCase();
  const marker = QUARANTINE_MARKERS.find((m) => haystack.includes(m));
  return marker ? { quarantined: true, marker } : { quarantined: false, marker: null };
}

function walkSuites(suites, ancestors, visit, depth = 0) {
  for (const suite of suites ?? []) {
    const title = suite?.title ?? '';
    // Only the OUTERMOST suite title is the spec file path; every deeper level
    // is a describe() block. Depth is tracked explicitly because "ancestors is
    // empty" is also true for the first describe() inside a file suite.
    const nextAncestors = depth === 0 ? ancestors : [...ancestors, title];
    for (const spec of suite?.specs ?? []) visit(spec, nextAncestors, suite);
    walkSuites(suite?.suites, nextAncestors, visit, depth + 1);
  }
}

/**
 * Flatten one parsed report into an array of "observed test" records.
 * Multi-project runs produce one record per project — they are different tests
 * in every useful sense (different browser, different timeout).
 *
 * @param {object} report parsed JSON reporter output
 * @param {{sourceFile?: string, runIndex?: number, label?: string}} [meta]
 */
export function flattenReport(report, meta = {}) {
  const { sourceFile = '<memory>', runIndex = 0, label = null } = meta;
  const observations = [];
  const config = report?.config ?? {};
  const projectByName = new Map(
    (Array.isArray(config.projects) ? config.projects : [])
      .filter(Boolean)
      .map((p) => [p.name ?? '', p]),
  );

  const runConfig = {
    sourceFile,
    runIndex,
    label,
    version: config.version ?? null,
    rootDir: config.rootDir ?? null,
    workers: typeof config.workers === 'number' ? config.workers : null,
    // config.metadata.actualWorkers is what really ran; config.workers is the
    // requested maximum. Resource contention depends on the former.
    actualWorkers: typeof config.metadata?.actualWorkers === 'number' ? config.metadata.actualWorkers : null,
    fullyParallel: config.fullyParallel === true,
    // retries/timeout live under config.projects[] in the JSON reporter, not at
    // the top level. Take the most permissive project value.
    retries: pickProjectValue(config, 'retries'),
    repeatEach: pickProjectValue(config, 'repeatEach'),
    timeout: pickProjectValue(config, 'timeout'),
    shard: config.shard ?? null,
    grep: config.grep ?? null,
    startTime: report?.stats?.startTime ?? null,
    duration: typeof report?.stats?.duration === 'number' ? report.stats.duration : null,
    stats: report?.stats
      ? {
          expected: report.stats.expected ?? null,
          unexpected: report.stats.unexpected ?? null,
          flaky: report.stats.flaky ?? null,
          skipped: report.stats.skipped ?? null,
        }
      : null,
    errors: (Array.isArray(report?.errors) ? report.errors : []).map((e) =>
      typeof e === 'string' ? stripAnsi(e) : stripAnsi(e?.message ?? JSON.stringify(e)),
    ),
  };

  walkSuites(report?.suites, [], (spec, describePath) => {
    const file = spec?.file ?? describePath[0] ?? '<unknown>';
    const specTitle = spec?.title ?? '<untitled>';
    // Group `tests` by project so --repeat-each collapses into one history line.
    const byProject = new Map();
    for (const test of spec?.tests ?? []) {
      const projectName = test?.projectName ?? '';
      if (!byProject.has(projectName)) byProject.set(projectName, []);
      byProject.get(projectName).push(test);
    }

    for (const [projectName, tests] of byProject) {
      const first = tests[0] ?? {};
      const attempts = [];
      for (const test of tests) {
        const expectedStatus = test?.expectedStatus ?? 'passed';
        const results = Array.isArray(test?.results) ? test.results : [];
        for (const result of results) {
          const errors = (Array.isArray(result?.errors) ? result.errors : [])
            .filter(Boolean)
            .map((e) => ({
              message: stripAnsi(e?.message ?? ''),
              normalized: normalizeMessage(e?.message ?? ''),
              location: e?.location ?? null,
            }));
          attempts.push({
            retry: typeof result?.retry === 'number' ? result.retry : attempts.length,
            status: result?.status ?? 'failed',
            outcome: outcomeForAttempt(result, expectedStatus),
            duration: typeof result?.duration === 'number' ? result.duration : 0,
            workerIndex: result?.workerIndex ?? null,
            parallelIndex: result?.parallelIndex ?? null,
            startTime: result?.startTime ?? null,
            expectedStatus,
            testStatus: test?.status ?? null,
            errors,
          });
        }
      }
      attempts.sort((a, b) => a.retry - b.retry);

      const titlePath = [...describePath, specTitle];
      const project = projectByName.get(projectName);
      const quarantine = detectQuarantine(first, spec, titlePath);
      observations.push({
        testId: makeTestId({ file, titlePath, projectName }),
        file,
        title: specTitle,
        titlePath,
        fullTitle: titlePath.join(' › '),
        projectName: projectName || (project?.name ?? ''),
        projectTimeout: project?.timeout ?? null,
        projectRetries: project?.retries ?? null,
        specOk: spec?.ok === true,
        specId: spec?.id ?? null,
        tags: Array.isArray(spec?.tags) ? spec.tags.map(String) : [],
        annotations: annotationsOf(first),
        quarantined: quarantine.quarantined,
        quarantineMarker: quarantine.marker,
        location: { file: spec?.file ?? file, line: spec?.line ?? null, column: spec?.column ?? null },
        attempts,
        runOutcome: runOutcomeForAttempts(attempts),
        testStatus: first?.status ?? null,
        expectedStatus: first?.expectedStatus ?? 'passed',
        timeout: typeof first?.timeout === 'number' ? first.timeout : (project?.timeout ?? null),
        run: runConfig,
      });
    }
  });

  return observations;
}

/** Stable identity across runs: same file + same describe chain + same project. */
export function makeTestId({ file, titlePath, projectName }) {
  const normFile = String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  const project = projectName ? ` [${projectName}]` : '';
  return `${normFile} :: ${titlePath.join(' > ')}${project}`;
}

/* ------------------------------------------------------------------ *
 * Loading many runs from disk
 * ------------------------------------------------------------------ */

/** Report files in a directory, in natural (run-2 before run-10) order. */
export function listReportFiles(dir) {
  const stat = fs.statSync(dir);
  if (stat.isFile()) return [dir];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }))
    .map((name) => path.join(dir, name));
}

/**
 * Parse a directory of report files (one per run) or an explicit list of files.
 *
 * @returns {{runs: object[], observations: object[], globalErrors: object[]}}
 */
export function parseRuns(input, options = {}) {
  const { label = null, onWarning = null } = options;
  const inputs = Array.isArray(input) ? input : [input];
  const files = inputs.flatMap((entry) => listReportFiles(entry));
  const runs = [];
  const observations = [];
  const globalErrors = [];

  files.forEach((file, index) => {
    let report;
    try {
      report = readJson(file);
    } catch (err) {
      const warning = `skipped ${path.basename(file)}: ${err.message}`;
      if (onWarning) onWarning(warning);
      return;
    }
    if (!looksLikePlaywrightReport(report)) {
      const keys = Object.keys(report ?? {}).slice(0, 5).join(', ');
      const warning = `skipped ${path.basename(file)}: not a Playwright JSON report (top-level keys: ${keys || 'none'}). Use --reporter=json; do not point the tool at other JSON files.`;
      if (onWarning) onWarning(warning);
      return;
    }
    const meta = { sourceFile: file, runIndex: index, label: labelFromFile(file, label) };
    const flat = flattenReport(report, meta);
    // Correlate each observation with its run without duplicating runConfig.
    for (const obs of flat) {
      const { run, ...rest } = obs;
      observations.push({ ...rest, sourceFile: file, runIndex: index });
    }
    const run = flat[0]?.run ?? null;
    const summary = {
      sourceFile: file,
      runIndex: index,
      label: meta.label,
      config: run
        ? {
            version: run.version,
            workers: run.workers,
            retries: run.retries,
            repeatEach: run.repeatEach,
            timeout: run.timeout,
            fullyParallel: run.fullyParallel,
            shard: run.shard,
            rootDir: run.rootDir,
            startTime: run.startTime,
            duration: run.duration,
          }
        : null,
      testCount: flat.length,
      errors: run?.errors ?? [],
    };
    if (summary.errors.length > 0) {
      globalErrors.push({ sourceFile: file, errors: summary.errors });
    }
    runs.push(summary);
  });

  return { runs, observations, globalErrors };
}

function labelFromFile(file, label) {
  if (label) return label;
  // The label is the file's basename, nothing else. Do NOT decorate it: the
  // classifier pattern-matches labels to decide whether a run is a solo
  // reproduction or a serial one, and an innocent suffix like " (solo/serial)"
  // would make every serial run look like a solo run.
  return path.basename(file).replace(/\.json$/i, '');
}

/**
 * True when a run appears to be a single-worker reproduction run.
 * Filename/label convention is the reliable signal: name a solo run
 * `solo-<test>.json` and a single-worker full-suite run `serial-workers1.json`.
 * The label is only matched as a serial run if it does not also look like a
 * single-test reproduction, because "serial-workers1" is not a solo run.
 */
export function isSoloRun(runSummary) {
  if (!runSummary) return false;
  const label = String(runSummary.label ?? '');
  if (looksSerial(label)) return false;
  if (/solo|alone|isolated|repro/i.test(label)) return true;
  // actualWorkers is what really ran; workers is only the configured maximum.
  const workers = runSummary.config?.actualWorkers ?? runSummary.config?.workers;
  const testCount = runSummary.testCount ?? 0;
  return typeof workers === 'number' && workers === 1 && testCount <= 3;
}

/** True when a run looks like the whole suite restricted to one worker. */
export function looksSerial(label) {
  return /serial|workers?[-_ ]?1|single[-_ ]?worker/i.test(String(label ?? ''));
}

/* ------------------------------------------------------------------ *
 * Aggregation across runs
 * ------------------------------------------------------------------ */

function trendOf(runOutcomes) {
  const half = Math.floor(runOutcomes.length / 2);
  if (half === 0) return 'unknown';
  const bad = (list) => list.filter((o) => o === OUTCOME.FAIL || o === OUTCOME.PASS_ON_RETRY).length;
  const early = bad(runOutcomes.slice(0, half));
  const late = bad(runOutcomes.slice(half));
  if (early === late) return 'steady';
  return late > early ? 'worsening' : 'improving';
}

function verdictOf(counts) {
  const { cleanPass, passedOnRetry, failedOutright, expectedFail, unexpectedPass, skipped, interrupted } = counts;
  const observed = cleanPass + passedOnRetry + failedOutright + unexpectedPass;
  if (observed === 0) {
    if (skipped > 0) return VERDICT.ALWAYS_SKIPPED;
    // test.fail() tests: failing is the configured behaviour. They are neither
    // stable passes nor flakes, and must never be counted as either.
    if (expectedFail > 0) return VERDICT.EXPECTED_FAILURE;
    return VERDICT.NOT_OBSERVED;
  }
  if (failedOutright > 0 && cleanPass + passedOnRetry > 0) return VERDICT.FLAKY;
  if (failedOutright > 0) return VERDICT.CONSISTENTLY_FAILING;
  if (passedOnRetry > 0) return VERDICT.FLAKY_RETRY_ONLY;
  if (unexpectedPass > 0) return VERDICT.FLAKY;
  return VERDICT.STABLE_PASS;
}

/**
 * Collapse per-run observations into one history record per test.
 *
 * @param {object[]} observations output of parseRuns().observations
 * @param {{runs?: object[]}} [context]
 */
export function aggregate(observations, context = {}) {
  const runs = context.runs ?? [];
  const byTest = new Map();

  for (const obs of observations) {
    if (!byTest.has(obs.testId)) {
      byTest.set(obs.testId, {
        testId: obs.testId,
        file: obs.file,
        title: obs.title,
        titlePath: obs.titlePath,
        fullTitle: obs.fullTitle,
        projectName: obs.projectName,
        location: obs.location,
        tags: obs.tags,
        annotations: obs.annotations,
        quarantined: obs.quarantined,
        quarantineMarker: obs.quarantineMarker,
        timeout: obs.timeout,
        expectedStatus: obs.expectedStatus,
        runs: [],
        counts: {
          runsObserved: 0,
          cleanPass: 0,
          passedOnRetry: 0,
          failedOutright: 0,
          expectedFail: 0,
          unexpectedPass: 0,
          skipped: 0,
          interrupted: 0,
        },
        failures: [],
        totalDurationMs: 0,
        wastedDurationMs: 0,
        workerIndexes: [],
        projects: new Set(),
      });
    }
    const entry = byTest.get(obs.testId);
    entry.projects.add(obs.projectName);
    entry.runs.push({
      runIndex: obs.runIndex,
      sourceFile: obs.sourceFile,
      outcome: obs.runOutcome,
      testStatus: obs.testStatus,
      attempts: obs.attempts,
    });
    entry.counts.runsObserved += 1;
    entry.totalDurationMs += obs.attempts.reduce((sum, a) => sum + (a.duration || 0), 0);

    switch (obs.runOutcome) {
      case OUTCOME.PASS:
        entry.counts.cleanPass += 1;
        break;
      case OUTCOME.PASS_ON_RETRY:
        entry.counts.passedOnRetry += 1;
        break;
      case OUTCOME.FAIL:
        entry.counts.failedOutright += 1;
        break;
      case OUTCOME.EXPECTED_FAIL:
        entry.counts.expectedFail += 1;
        break;
      case OUTCOME.UNEXPECTED_PASS:
        entry.counts.unexpectedPass += 1;
        break;
      case OUTCOME.SKIPPED:
        entry.counts.skipped += 1;
        break;
      case OUTCOME.INTERRUPTED:
        entry.counts.interrupted += 1;
        break;
      default:
        break;
    }

    // Every attempt that did not pass is evidence, retries included. A retry
    // that eventually passed still tells us the first attempt misbehaved.
    const badAttempts = obs.attempts.filter(
      (a) => a.outcome === OUTCOME.FAIL || a.outcome === OUTCOME.UNEXPECTED_PASS,
    );
    // CI time burned: failed attempts, plus every extra attempt a retry caused.
    for (const a of obs.attempts) {
      if (a.retry > 0 || a.outcome === OUTCOME.FAIL) entry.wastedDurationMs += a.duration || 0;
      if (a.outcome === OUTCOME.FAIL && a.workerIndex !== null && !entry.workerIndexes.includes(a.workerIndex)) {
        entry.workerIndexes.push(a.workerIndex);
      }
    }
    if (badAttempts.length > 0) {
      entry.failures.push({
        runIndex: obs.runIndex,
        sourceFile: obs.sourceFile,
        runOutcome: obs.runOutcome,
        attemptCount: obs.attempts.length,
        badAttempts,
        errors: badAttempts.flatMap((a) => a.errors),
      });
    }
  }

  const ordered = [...byTest.values()].map((entry) => {
    const c = entry.counts;
    const denominator = c.cleanPass + c.passedOnRetry + c.failedOutright + c.unexpectedPass;
    const distinct = new Map();
    for (const failure of entry.failures) {
      for (const err of failure.errors) {
        if (!err.normalized) continue;
        if (!distinct.has(err.normalized)) {
          distinct.set(err.normalized, { normalized: err.normalized, count: 0, sample: err.message, locations: [] });
        }
        const rec = distinct.get(err.normalized);
        rec.count += 1;
        if (err.location && rec.locations.length < 3) rec.locations.push(err.location);
      }
    }
    return {
      ...entry,
      projects: [...entry.projects].filter(Boolean),
      runs: entry.runs.sort((a, b) => a.runIndex - b.runIndex),
      flakeRate: denominator === 0 ? 0 : (c.passedOnRetry + c.failedOutright + c.unexpectedPass) / denominator,
      failRate: denominator === 0 ? 0 : c.failedOutright / denominator,
      retryRate: denominator === 0 ? 0 : c.passedOnRetry / denominator,
      verdict: verdictOf(c),
      trend: trendOf(entry.runs.map((r) => r.outcome)),
      failureRuns: entry.failures.map((f) => f.runIndex),
      firstFailure: entry.failures.length ? entry.failures[0] : null,
      lastFailure: entry.failures.length ? entry.failures[entry.failures.length - 1] : null,
      distinctErrors: [...distinct.values()].sort((a, b) => b.count - a.count),
      runCount: runs.length || entry.counts.runsObserved,
    };
  });

  // Worst first: outright failures, then retry-masked flakes, then the rest.
  const rank = {
    [VERDICT.CONSISTENTLY_FAILING]: 0,
    [VERDICT.FLAKY]: 1,
    [VERDICT.FLAKY_RETRY_ONLY]: 2,
    [VERDICT.NOT_OBSERVED]: 3,
    [VERDICT.EXPECTED_FAILURE]: 4,
    [VERDICT.ALWAYS_SKIPPED]: 5,
    [VERDICT.STABLE_PASS]: 6,
  };
  ordered.sort(
    (a, b) =>
      (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9) ||
      b.flakeRate - a.flakeRate ||
      b.counts.failedOutright - a.counts.failedOutright ||
      a.fullTitle.localeCompare(b.fullTitle),
  );
  return ordered;
}

/**
 * One-call convenience: directory (or list of files) of report JSON in,
 * run history out.
 */
export function analyze(input, options = {}) {
  const parsed = parseRuns(input, options);
  const tests = aggregate(parsed.observations, parsed);
  return { ...parsed, tests };
}

/** Tests that failed in at least one run and passed in at least one other. */
export function flakyTests(tests) {
  return tests.filter((t) => t.verdict === VERDICT.FLAKY || t.verdict === VERDICT.FLAKY_RETRY_ONLY);
}

/* ------------------------------------------------------------------ *
 * CLI: node detect/parse-results.mjs <reports-dir> [--json]
 * ------------------------------------------------------------------ */

function renderSummary(tests, runs) {
  const lines = [];
  lines.push(`${runs.length} run(s) parsed, ${tests.length} test(s) observed.`);
  const groups = new Map();
  for (const t of tests) {
    if (!groups.has(t.verdict)) groups.set(t.verdict, []);
    groups.get(t.verdict).push(t);
  }
  for (const [verdict, list] of groups) {
    lines.push(`  ${verdict}: ${list.length}`);
  }
  lines.push('');
  const flaky = flakyTests(tests);
  if (flaky.length === 0) {
    lines.push('No test failed in one run and passed in another.');
  } else {
    lines.push('Flaky tests (failed at least one run, passed at least one):');
    for (const t of flaky) {
      lines.push(
        `  ${(t.flakeRate * 100).toFixed(0).padStart(3)}%  ` +
          `${t.counts.failedOutright} failed / ${t.counts.passedOnRetry} passed-on-retry / ` +
          `${t.counts.cleanPass} clean  ${t.fullTitle}${t.projectName ? ` [${t.projectName}]` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const targets = args.filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    process.stderr.write(
      'usage: node detect/parse-results.mjs <reports-dir|report.json> [more...] [--json]\n',
    );
    return 2;
  }
  const warnings = [];
  const result = analyze(targets, { onWarning: (w) => warnings.push(w) });
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          runs: result.runs,
          globalErrors: result.globalErrors,
          tests: result.tests.map((t) => ({
            testId: t.testId,
            file: t.file,
            fullTitle: t.fullTitle,
            projectName: t.projectName,
            verdict: t.verdict,
            trend: t.trend,
            counts: t.counts,
            flakeRate: t.flakeRate,
            quarantined: t.quarantined,
            failures: t.failures.map((f) => ({
              runIndex: f.runIndex,
              sourceFile: f.sourceFile,
              errors: f.errors.map((e) => e.message),
            })),
          })),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(renderSummary(result.tests, result.runs) + '\n');
  }
  return 0;
}

if (isDirectInvocation(import.meta.url)) {
  process.exitCode = main(process.argv);
}
