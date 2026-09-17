#!/usr/bin/env node
/**
 * classify.mjs — turn "this test is flaky" into "this test fails because of X".
 *
 * HOW THIS WORKS, AND WHAT IT WILL NOT DO
 * ---------------------------------------
 * This is a HEURISTIC classifier. It reads the evidence a Playwright JSON report
 * actually contains — result status, error message text, the actionability call
 * log, the code frame around the failing line, the test timeout, the worker
 * count, retry indexes, and (if you supply them) solo/serial reproduction runs —
 * and picks the cause category whose required signals match.
 *
 * It does not read your source code, your server logs, or your database. When
 * the evidence is not there, it returns `unknown`. That is a real answer, not a
 * failure: `unknown` means "this report does not contain the signal; go and
 * collect the missing evidence", and fixes/09-unknown.md is the checklist for
 * doing exactly that.
 *
 * WHAT MAKES A CLASSIFICATION TRUSTWORTHY
 * ---------------------------------------
 * Every result carries an evidence list. Each entry names the SIGNAL (where in
 * the report it came from) and the DETAIL (what it said). If you disagree with a
 * classification, you read the evidence and see which signal you disagree with.
 * There is no opaque scoring model here and no model weights: by design, you can
 * audit every decision by eye.
 *
 * The exact signal that drives each rule is documented in docs/CLASSIFICATION.md
 * and reproduced in the RULES table below.
 */

import { OUTCOME, VERDICT, looksSerial, isDirectInvocation } from './parse-results.mjs';

/* ------------------------------------------------------------------ *
 * Categories
 * ------------------------------------------------------------------ */

export const CATEGORY = {
  TIMEOUT: 'timeout',
  MISSING_AWAIT_RACE: 'missing-await-race',
  STRICT_MODE_VIOLATION: 'strict-mode-violation',
  ANIMATION_TRANSITION: 'animation-transition',
  NETWORK_TIMING: 'network-timing',
  TEST_ORDER_DEPENDENCY: 'test-order-dependency',
  RESOURCE_CONTENTION: 'resource-contention',
  NONDETERMINISTIC_DATA: 'nondeterministic-data',
  UNKNOWN: 'unknown',
};

/** One markdown fix guide per category, shipped in fixes/. */
export const FIX_FILE = {
  [CATEGORY.TIMEOUT]: 'fixes/01-timeout.md',
  [CATEGORY.MISSING_AWAIT_RACE]: 'fixes/02-missing-await-race.md',
  [CATEGORY.STRICT_MODE_VIOLATION]: 'fixes/03-strict-mode-violation.md',
  [CATEGORY.ANIMATION_TRANSITION]: 'fixes/04-animation-transition.md',
  [CATEGORY.NETWORK_TIMING]: 'fixes/05-network-timing.md',
  [CATEGORY.TEST_ORDER_DEPENDENCY]: 'fixes/06-test-order-dependency.md',
  [CATEGORY.RESOURCE_CONTENTION]: 'fixes/07-resource-contention.md',
  [CATEGORY.NONDETERMINISTIC_DATA]: 'fixes/08-nondeterministic-data.md',
  [CATEGORY.UNKNOWN]: 'fixes/09-unknown.md',
};

/** One-line fix summary used in the triage report. */
export const FIX_SUMMARY = {
  [CATEGORY.TIMEOUT]:
    'Find out what the test was still waiting for in the call log. If it was waiting on a locator, this is a race — fix the wait, do not raise the budget.',
  [CATEGORY.MISSING_AWAIT_RACE]:
    'Add the missing await or replace the non-retrying assertion with a web-first assertion (expect(locator).toHaveText(...)) that retries until the UI settles.',
  [CATEGORY.STRICT_MODE_VIOLATION]:
    'The locator matches more than one element. Narrow it (getByRole with an accessible name, .first() only if the order is genuinely guaranteed) — the multi-match is usually an app bug.',
  [CATEGORY.ANIMATION_TRANSITION]:
    'Wait for the element to be stable or for the animation to finish before acting (expect(el).toHaveCSS or wait for the transition class to drop); do not click a moving target.',
  [CATEGORY.NETWORK_TIMING]:
    'The failure is about a request or response. Await the response you depend on, assert on it, and fail loudly — do not sleep and hope.',
  [CATEGORY.TEST_ORDER_DEPENDENCY]:
    'It passes alone and fails in the suite: it is reading state another test wrote. Give the test its own fixture/data and reset shared state per test.',
  [CATEGORY.RESOURCE_CONTENTION]:
    'It only fails with parallel workers. Reduce shared resources per test (own user/session/record), or isolate the resource-hungry file with test.describe.configure({ mode: "serial" }).',
  [CATEGORY.NONDETERMINISTIC_DATA]:
    'The comparison involves data that legitimately varies (order, timestamps, ids, floats). Assert on the invariant, not the literal value.',
  [CATEGORY.UNKNOWN]:
    'Not enough signal in the report. Collect the missing evidence listed in fixes/09-unknown.md, then re-run the classifier.',
};

/* ------------------------------------------------------------------ *
 * Low-level message readers
 * ------------------------------------------------------------------ */

/** The `>` -marked source line from the code frame Playwright embeds in messages. */
export function extractFailingSourceLine(message) {
  const lines = String(message ?? '').split('\n');
  const idx = lines.findIndex((l) => /^\s*>/.test(l));
  if (idx === -1) return null;
  const m = lines[idx].match(/^\s*>\s*\d*\s*\|\s?(.*)$/);
  if (m) return { line: m[1].trim(), index: idx, previous: lines.slice(Math.max(0, idx - 3), idx) };
  return { line: lines[idx].replace(/^[\s>|]+/, '').trim(), index: idx, previous: lines.slice(Math.max(0, idx - 3), idx) };
}

/**
 * `Expected:` / `Received:` blocks from an assertion failure. Multiline arrays
 * and objects are captured by taking the indented continuation lines.
 */
export function extractExpectDiff(message) {
  const lines = String(message ?? '').split('\n');
  const grab = (label) => {
    const start = lines.findIndex((l) => l.trim().startsWith(`${label}:`));
    if (start === -1) return null;
    const first = lines[start].trim().slice(label.length + 1).trim();
    const rest = [];
    for (let i = start + 1; i < lines.length; i += 1) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (/^\S/.test(l)) break;
      rest.push(l);
    }
    return [first, ...rest].join('\n').trim();
  };
  const expected = grab('Expected');
  const received = grab('Received');

  // `toEqual` / `toMatchObject` print a unified diff instead of labelled
  // blocks. Only the CHANGED lines survive there, which is enough for the
  // order-nondeterminism signal: a value that is removed on one side and added
  // on the other with identical text has moved, not changed.
  const expectedOnly = [];
  const receivedOnly = [];
  for (const raw of lines) {
    if (/^-\s*Expected\s+-/.test(raw.trim())) continue;
    if (/^\+\s*Received\s+\+/.test(raw.trim())) continue;
    // Trailing commas are diff punctuation, not part of the value: compare the
    // values, so a moved "Filter", matches a moved "Filter".
    if (/^-\s+\S/.test(raw)) expectedOnly.push(raw.replace(/^-\s+/, '').replace(/,\s*$/, '').trim());
    else if (/^\+\s+\S/.test(raw)) receivedOnly.push(raw.replace(/^\+\s+/, '').replace(/,\s*$/, '').trim());
  }

  if (expected === null && received === null && expectedOnly.length === 0 && receivedOnly.length === 0) return null;
  return { expected, received, expectedOnly, receivedOnly };
}

function parseMaybeArray(text) {
  if (text === null || text === undefined) return null;
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.map((v) => JSON.stringify(v)) : null;
  } catch {
    /* not JSON — fall through to token scraping */
  }
  const tokens = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return tokens.length >= 2 ? tokens : null;
}

const TIME_LIKE = [
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, // ISO timestamp
  /\b\d{1,2}:\d{2}(:\d{2})?\s?(am|pm)?\b/i, // clock time
  /\b(just now|a moment ago|\d+\s?(second|minute|hour|day)s?\sago)\b/i, // relative time
  /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b/i, // weekday name
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i, // date
];
const ID_LIKE = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // uuid
  /\b[0-9a-f]{16,}\b/i, // long hex id
  /\b[A-Z]{2,}-\d{3,}\b/, // ORDER-1042 style
];
const HTTP_STATUS = /\b(200|201|202|204|301|302|304|400|401|403|404|405|409|410|422|429|500|502|503|504)\b/;

const looksLike = (patterns, text) => patterns.some((re) => re.test(text ?? ''));

/* ------------------------------------------------------------------ *
 * Context passed to every rule
 * ------------------------------------------------------------------ */

/**
 * Work out which solo / serial runs count as evidence for this test.
 *
 * Evidence runs are supplied explicitly (see buildEvidenceRuns in report.mjs)
 * as { label, config, testCount, passedTestIds } — evidence is matched by test
 * IDENTITY, never by run index, because the main history and the solo/serial
 * reports come from separate parses whose indexes overlap.
 */
function findEvidenceRuns(test, runs, evidenceRuns) {
  const solo = [];
  const serial = [];
  for (const run of evidenceRuns ?? []) {
    if (!(run.passedTestIds instanceof Set) || !run.passedTestIds.has(test.testId)) continue;
    classifyRunKind(run, solo, serial);
  }

  const byFile = new Map((runs ?? []).map((r) => [r.sourceFile, r]));
  const failingRunMeta = test.failures.map((f) => byFile.get(f.sourceFile)).filter(Boolean);
  const failingWorkers = new Set(
    test.failures.flatMap((f) => f.badAttempts.map((a) => a.workerIndex)).filter((w) => w !== null),
  );
  return {
    solo,
    serial,
    failingRunMeta,
    wasSeenPassing: test.counts.cleanPass + test.counts.passedOnRetry > 0,
    workerCounts: {
      observed: [...failingWorkers].sort((a, b) => a - b),
      configured: [
        ...new Set(
          failingRunMeta.map((r) => r.config?.actualWorkers ?? r.config?.workers).filter((w) => typeof w === 'number'),
        ),
      ],
    },
  };
}

function classifyRunKind(run, solo, serial) {
  const label = String(run.label ?? '');
  const workers = run.config?.actualWorkers ?? run.config?.workers;
  const testCount = run.testCount ?? 0;
  // Explicit naming wins: files/labels containing "serial"/"workers1" are the
  // whole suite on one worker; "solo"/"alone"/"repro" is a single-test
  // reproduction. See prove-it/run.sh for the convention. Serial is tested
  // first because "serial-workers1" must never be read as solo evidence.
  if (looksSerial(label)) serial.push(run);
  else if (/solo|alone|isolated|repro/i.test(label)) solo.push(run);
  else if (typeof workers === 'number' && workers === 1 && testCount <= 3) solo.push(run);
  else if (typeof workers === 'number' && workers === 1) serial.push(run);
}

function buildContext(test, runs, evidenceRuns) {
  const allMessages = test.failures.flatMap((f) => f.errors.map((e) => e.message));

  // Classify on the DOMINANT failure, not on every message from every run.
  // One anomalous run (say a browser "Protocol error" during a timed-out
  // assertion) must not outvote the failure the test actually keeps producing.
  // The dominant group is the fingerprint seen most often; see
  // parse-results.normalizeMessage.
  const dominant = test.distinctErrors[0]?.normalized ?? null;
  const messages = dominant
    ? test.failures
        .flatMap((f) => f.errors)
        .filter((e) => e.normalized === dominant)
        .map((e) => e.message)
    : allMessages;
  const secondaryMessages = allMessages.filter((m) => !messages.includes(m));
  const joined = messages.join('\n');
  const sourceLines = messages.map(extractFailingSourceLine).filter(Boolean);
  const primarySource = sourceLines[0] ?? null;
  return {
    test,
    messages,
    allMessages,
    secondaryMessages,
    dominantFingerprint: dominant,
    joined,
    sourceLine: primarySource?.line ?? null,
    sourcePrevious: primarySource?.previous ?? [],
    diff: extractExpectDiff(messages[0] ?? ''),
    evidenceRuns: findEvidenceRuns(test, runs, evidenceRuns),
    // Rules may record why a signal they saw was NOT enough. Surfacing that is
    // the difference between "the tool said unknown" and "the tool told me what
    // it ruled out and why".
    rejectedSignals: [],
  };
}

/* ------------------------------------------------------------------ *
 * Detection helpers used by the rules
 * ------------------------------------------------------------------ */

/**
 * Playwright's WEB-FIRST assertions retry until the UI settles and therefore
 * must be awaited (`await expect(locator).toHaveText('x')`). A plain value
 * assertion (`expect(body.ok).toBe(true)`) is synchronous and must NOT be
 * awaited — flagging it as a missing await would be wrong.
 */
const WEB_FIRST_ASSERTIONS =
  /\b(toHaveText|toContainText|toBeVisible|toBeHidden|toBeAttached|toHaveCount|toHaveURL|toHaveTitle|toHaveValue|toHaveValues|toBeChecked|toBeEnabled|toBeDisabled|toBeEditable|toBeEmpty|toBeFocused|toBeInViewport|toHaveAttribute|toHaveClass|toHaveCSS|toHaveId|toHaveJSProperty|toHaveScreenshot|toMatchAriaSnapshot|toHaveAccessibleName|toHaveAccessibleDescription|toHaveRole|toPass)\b/;

/**
 * Signals that the failing line is an assertion that could not retry.
 *
 * Three distinct shapes, deliberately distinguished:
 *  1. `expect(await locator.textContent()).toBe('1')` — a value snapshot taken
 *     inside the assertion. Cannot retry, so timing decides the outcome.
 *  2. `const badge = await locator.textContent(); expect(badge).toBe('1')` —
 *     the same thing spread over two lines; the snapshot is in the variable.
 *  3. `expect(locator).toHaveText('1')` with no await — a web-first assertion
 *     that was never awaited, so the failure is reported but the test carries on.
 */
function missingAwaitSignal(ctx) {
  const line = ctx.sourceLine;
  if (!line) return null;
  if (!/\bexpect(\.\w+)?\s*\(/.test(line)) return null;

  const awaited = /\bawait\b/.test(line);
  const webFirst = WEB_FIRST_ASSERTIONS.test(line);

  if (/expect(\.\w+)?\s*\(\s*await\b/.test(line)) {
    return {
      kind: 'assertion-on-a-snapshot',
      detail: `failing line takes a value snapshot inside expect(...): \`${line}\` — a plain value assertion cannot retry, so it fails whenever the UI has not updated yet`,
    };
  }

  if (webFirst && !awaited) {
    return {
      kind: 'unawaited-web-first-assertion',
      detail: `failing line is a web-first assertion with no await: \`${line}\` — Playwright reports the failure but the test keeps going, so the result depends on timing`,
    };
  }

  if (!webFirst && !awaited) {
    // Look for the two-line snapshot form in the code frame above the failure.
    const previous = ctx.sourcePrevious.join('\n');
    const assignment = previous.match(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+[^;\n]*?(textContent|innerText|getAttribute|inputValue|allTextContents|count|allInnerTexts)\s*\(/,
    );
    if (assignment && new RegExp(`\\bexpect(\\.\\w+)?\\s*\\(\\s*${assignment[1]}\\b`).test(line)) {
      return {
        kind: 'assertion-on-a-snapshot',
        detail: `\`${assignment[1]}\` was captured with \`await ...${assignment[2]}()\` on the line above and then asserted on: \`${line}\` — the value was read once, before the app had finished updating it`,
      };
    }
    // A plain value assertion with no await is correct as written.
    return null;
  }

  return null;
}

function locatorTimeoutSignal(ctx) {
  // Evaluate each failure separately. Across ten runs, the same test can fail
  // both "locator never appeared" and "locator appeared but never became
  // actionable"; joining the texts first would let one of them hide the other.
  const hits = [];
  for (const message of ctx.messages) {
    const m = message.match(/locator\.[a-zA-Z]+: Timeout \d+ms exceeded|page\.[a-zA-Z]+: Timeout \d+ms exceeded/);
    if (!m) continue;
    hits.push({
      call: m[0],
      resolved: /locator resolved to/.test(message),
      clock: message.match(/Timeout (\d+)ms exceeded/)?.[1] ?? null,
    });
  }
  if (hits.length === 0) return null;
  const neverResolved = hits.filter((h) => !h.resolved);
  return {
    call: (neverResolved[0] ?? hits[0]).call,
    resolved: neverResolved.length === 0,
    neverResolvedCount: neverResolved.length,
    resolvedCount: hits.length - neverResolved.length,
    clock: hits[0].clock,
  };
}

function assertionValueSignal(ctx) {
  const diff = ctx.diff;
  if (!diff) return null;
  const unexpectedValue = /-\s*unexpected value/.test(ctx.joined);
  // "14 × locator resolved to <p>hello</p> — unexpected value" means the
  // assertion retried many times and the value never moved. A value that stays
  // wrong for the whole budget is a wrong expectation, not a race.
  const repetitions = [...ctx.joined.matchAll(/(\d+)\s*×\s*locator resolved to/g)].map((m) => Number(m[1]));
  const maxRepetitions = repetitions.length ? Math.max(...repetitions) : 0;
  return {
    expected: diff.expected,
    received: diff.received,
    unexpectedValue,
    maxRepetitions,
    stableWrongValue: unexpectedValue && maxRepetitions >= 5,
    receivedLooksEmpty: diff.received === null || /^(""|''|0|null|undefined|\[\]|\{\})$/.test((diff.received ?? '').trim()),
    receivedLooksLoading: /loading|pending|skeleton|please wait|…|\.\.\./i.test(diff.received ?? ''),
  };
}

/* ------------------------------------------------------------------ *
 * The rules. Order matters: the first rule whose signals match wins.
 * ------------------------------------------------------------------ */

export const RULES = [
  {
    id: 'R1',
    category: CATEGORY.STRICT_MODE_VIOLATION,
    // Signal: Playwright's own strict-mode error text, plus the "resolved to N
    // elements" count. Nothing else in a report looks like this.
    signals: 'error message matches /strict mode violation/',
    detect(ctx) {
      // The FULL phrase is required. A failing toHaveCount() also prints
      // "12 × locator resolved to 5 elements", which is a count assertion, not a
      // strict-mode violation — matching on the count alone misclassifies it.
      if (/strict mode violation:/i.test(ctx.joined)) {
        const count = ctx.joined.match(/resolved to (\d+) elements/)?.[1] ?? null;
        const locator = ctx.joined.match(/strict mode violation: (locator\([^)]*\)|getBy[A-Za-z]+\([^)]*\))/)?.[1] ?? null;
        return {
          confidence: 'high',
          evidence: [
            { signal: 'error message', detail: 'strict mode violation reported by Playwright' },
            {
              signal: 'error message',
              detail: locator
                ? `${locator} matched ${count ?? 'several'} elements where exactly one was required`
                : `locator resolved to ${count ?? 'several'} elements where exactly one was required`,
            },
          ],
        };
      }

      // Same root cause, quieter symptom: a count assertion that saw an exact
      // MULTIPLE of what it expected (2 → 4 following a page load). The DOM
      // rendered the same elements more than once. Deliberately narrow: an exact
      // multiple, on a test that is genuinely intermittent, with the competing
      // explanation (the data really did change) stated in the evidence.
      if (ctx.test.counts.cleanPass > 0 || ctx.test.counts.passedOnRetry > 0) {
        const diff = ctx.diff;
        const expected = Number(String(diff?.expected ?? '').trim());
        const received = Number(String(diff?.received ?? '').trim());
        if (
          ctx.diff &&
          /toHaveCount/.test(ctx.joined) &&
          Number.isInteger(expected) &&
          Number.isInteger(received) &&
          expected >= 1 &&
          received > expected &&
          received % expected === 0
        ) {
          return {
            confidence: 'medium',
            evidence: [
              { signal: 'Expected/Received diff', detail: `an element-count assertion wanted ${expected} and found ${received} — exactly ${received / expected}× as many` },
              {
                signal: 'reasoning',
                detail:
                  'the page rendered its elements more than once (duplicate render, an effect that ran twice, a list appended to instead of replaced). The same cause produces Playwright strict mode violations elsewhere. The alternative explanation — the underlying data really changed between runs — is worth ruling out first.',
              },
            ],
          };
        }
      }
      return null;
    },
  },
  {
    id: 'R2',
    category: CATEGORY.ANIMATION_TRANSITION,
    // Signal: Playwright's actionability log lines. "element is not stable"
    // means the bounding box changed between two animation frames;
    // "intercepts pointer events" names an element sitting on top of the target
    // (overlay, toast, sticky header) — usually mid-transition.
    signals: 'call log contains "element is not stable" or "intercepts pointer events"',
    detect(ctx) {
      if (/element is not stable/.test(ctx.joined)) {
        const mover = ctx.joined.match(/locator resolved to (<[^\n]*>)/)?.[1] ?? null;
        const attempts = (ctx.joined.match(/retrying click action|retrying [a-z]+ action/g) || []).length;
        return {
          confidence: 'high',
          evidence: [
            { signal: 'actionability call log', detail: 'element is not stable — its box moved between animation frames' },
            attempts > 0
              ? { signal: 'actionability call log', detail: `Playwright retried the action ${attempts} time(s) before timing out` }
              : null,
            mover ? { signal: 'actionability call log', detail: `target keeps moving: ${mover}` } : null,
          ].filter(Boolean),
        };
      }
      if (/intercepts pointer events/.test(ctx.joined)) {
        const overlay = ctx.joined.match(/(<[^\n]*>) intercepts pointer events/)?.[1] ?? 'another element';
        return {
          confidence: 'medium',
          evidence: [
            { signal: 'actionability call log', detail: `${overlay} intercepts pointer events for the target` },
            {
              signal: 'reasoning',
              detail:
                'the click never reached the target: an overlay, toast, sticky header or a still-fading element is on top of it (or the layout is wrong)',
            },
          ],
        };
      }
      return null;
    },
  },
  {
    id: 'R3',
    category: CATEGORY.NONDETERMINISTIC_DATA,
    // Signals: a snapshot assertion; or an expected/received pair that is the
    // SAME set of values in a different order; or time/id-like values; or a
    // float precision difference; or random/time sources on the failing line.
    signals:
      'snapshot assertion, or same-multiset-different-order diff, or timestamp/uuid/relative-time diff, or float precision diff, or Date/Math.random/uuid on the failing line',
    detect(ctx) {
      const diff = ctx.diff;

      if (/toMatchSnapshot|snapshot .*(does not match|mismatch)|Snapshot name:/i.test(ctx.joined)) {
        return {
          confidence: 'high',
          evidence: [{ signal: 'error message', detail: 'snapshot comparison failed — the recorded value no longer matches' }],
        };
      }

      if (diff && diff.expectedOnly.length > 0 && diff.expectedOnly.length === diff.receivedOnly.length) {
        const sortedExpected = [...diff.expectedOnly].sort().join('\u0000');
        const sortedReceived = [...diff.receivedOnly].sort().join('\u0000');
        if (sortedExpected === sortedReceived) {
          return {
            confidence: 'high',
            evidence: [
              {
                signal: 'Expected/Received diff',
                detail: `the diff removes and re-adds the exact same value(s) (${diff.expectedOnly.map(oneLine).join(', ')}) — the values did not change, their position did`,
              },
              {
                signal: 'reasoning',
                detail: 'an unordered source (Set, Object.keys, an unsorted query, a shuffled array) is being compared to a fixed order',
              },
            ],
          };
        }
      }

      if (diff && diff.expected && diff.received) {
        const e = parseMaybeArray(diff.expected);
        const r = parseMaybeArray(diff.received);
        if (e && r && e.length === r.length && e.join('\u0000') !== r.join('\u0000')) {
          const sortedE = [...e].sort().join('\u0000');
          const sortedR = [...r].sort().join('\u0000');
          if (sortedE === sortedR) {
            return {
              confidence: 'high',
              evidence: [
                { signal: 'Expected/Received diff', detail: 'both sides contain exactly the same values in a different order' },
                { signal: 'Expected/Received diff', detail: `expected ${diff.expected.replace(/\s+/g, ' ')}` },
                { signal: 'Expected/Received diff', detail: `received ${diff.received.replace(/\s+/g, ' ')}` },
                {
                  signal: 'reasoning',
                  detail: 'an unordered source (Set, Object.keys, an unsorted SQL query, a shuffled array) is being compared to a fixed order',
                },
              ],
            };
          }
        }

        const text = `${diff.expected} ${diff.received}`;
        if (looksLike(TIME_LIKE, text)) {
          return {
            confidence: 'medium',
            evidence: [
              { signal: 'Expected/Received diff', detail: `time-like values differ: expected "${oneLine(diff.expected)}" / received "${oneLine(diff.received)}"` },
              { signal: 'reasoning', detail: 'a clock, timezone, locale or relative-time label is part of the assertion' },
            ],
          };
        }
        if (looksLike(ID_LIKE, text)) {
          return {
            confidence: 'medium',
            evidence: [
              { signal: 'Expected/Received diff', detail: `identifier-like values differ: expected "${oneLine(diff.expected)}" / received "${oneLine(diff.received)}"` },
              { signal: 'reasoning', detail: 'a generated id (uuid, nanoid, sequence) is being compared to a fixed value' },
            ],
          };
        }
        // Floating point noise: BOTH sides must be plain decimal numbers, one of
        // them must carry long fraction digits, and the values must be nearly
        // equal but not equal. Anything looser matches two unrelated strings —
        // Number("") is 0, which is how a naive version of this rule reports a
        // "float difference" between "Hello" and "Welcome back, Ada".
        const asDecimal = (v) => {
          const t = String(v ?? '').trim().replace(/^["']|["']$/g, '');
          return /^-?\d+\.\d+$/.test(t) ? Number(t) : null;
        };
        const numExpected = asDecimal(diff.expected);
        const numReceived = asDecimal(diff.received);
        if (
          numExpected !== null &&
          numReceived !== null &&
          numExpected !== numReceived &&
          /\.\d{4,}/.test(diff.expected) &&
          Math.abs(numExpected - numReceived) <= Math.max(1e-9, Math.abs(numExpected) * 1e-9)
        ) {
          return {
            confidence: 'medium',
            evidence: [
              { signal: 'Expected/Received diff', detail: `floating point difference: ${oneLine(diff.expected)} vs ${oneLine(diff.received)}` },
              { signal: 'reasoning', detail: 'the same arithmetic produced a different least-significant digit' },
            ],
          };
        }
      }

      const line = ctx.sourceLine ?? '';
      const source = [line, ...ctx.sourcePrevious].join('\n');
      const sourceHit = source.match(/\b(new Date|Date\.now|Math\.random|crypto\.randomUUID|uuid|nanoid|toISOString|localeCompare|Intl\.)\b/);
      if (sourceHit) {
        return {
          confidence: 'medium',
          evidence: [
            { signal: 'code frame at the failing line', detail: `${sourceHit[1]} appears in the code around the failure` },
            { signal: 'reasoning', detail: 'a clock or random source feeds the value under assertion' },
          ],
        };
      }
      return null;
    },
  },
  {
    id: 'R4',
    category: CATEGORY.NETWORK_TIMING,
    // Signals: transport-level error strings, Playwright's response-waiting
    // APIs/log lines, or an HTTP status code appearing on both sides of an
    // assertion diff (200 vs 503 is an API failure, not a UI bug).
    signals:
      'net::ERR_/ECONNRESET/socket hang up/fetch failed/Request failed, or waitForResponse / "waiting for event \\"response\\"" / apiRequestContext, or an HTTP status code in the assertion diff',
    detect(ctx) {
      const transport = ctx.joined.match(
        /net::ERR_[A-Z_]+|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|Request failed|NetworkError|ERR_ABORTED|NS_ERROR/,
      );
      if (transport) {
        return {
          confidence: 'high',
          evidence: [
            { signal: 'error message', detail: `transport-level network failure: ${transport[0]}` },
            {
              signal: 'reasoning',
              detail: 'the request never produced a usable response — server down, port wrong, DNS, proxy, or the request was aborted',
            },
          ],
        };
      }
      if (/waitForResponse|waiting for event "response"|waiting for response /.test(ctx.joined)) {
        const url = ctx.joined.match(/waiting for response "([^"]+)"/)?.[1] ?? null;
        return {
          confidence: 'high',
          evidence: [
            { signal: 'call log', detail: `the test was waiting for a response${url ? ` matching ${url}` : ''} that never arrived` },
            {
              signal: 'reasoning',
              detail: 'the request either failed, was aborted, or the app never fired it because an earlier step did not complete',
            },
          ],
        };
      }
      // API-request failures prefix the error with the apiRequestContext method
      // and log the request line. Match those, NOT `request.get(` in the test's
      // own source: every API-driven test contains that, so matching source
      // would report a transport failure for any assertion a request test makes.
      const apiContext = ctx.joined.match(/apiRequestContext\.[a-z]+:|→\s*(GET|POST|PUT|PATCH|DELETE|HEAD)\s+https?:\/\//);
      if (apiContext) {
        return {
          confidence: 'medium',
          evidence: [
            { signal: 'call log', detail: `the failure came from an API request, not from the page (${oneLine(apiContext[0])})` },
          ],
        };
      }
      const diff = ctx.diff;
      if (diff) {
        const expectedIsStatus = HTTP_STATUS.test(diff.expected ?? '');
        const receivedIsStatus = HTTP_STATUS.test(diff.received ?? '');
        if (expectedIsStatus && receivedIsStatus) {
          return {
            confidence: 'medium',
            evidence: [
              { signal: 'Expected/Received diff', detail: `HTTP status mismatch: expected ${oneLine(diff.expected)} / received ${oneLine(diff.received)}` },
              { signal: 'reasoning', detail: 'the endpoint answered, but not with the status the test required' },
            ],
          };
        }
        const receivedEmpty = diff.received === null || /^(null|undefined|""|'')$/.test(diff.received.trim());
        if (expectedIsStatus && receivedEmpty) {
          return {
            confidence: 'medium',
            evidence: [
              { signal: 'Expected/Received diff', detail: `expected HTTP status ${oneLine(diff.expected)} but the received value was ${oneLine(diff.received)}` },
              {
                signal: 'reasoning',
                detail: 'the API call produced no response value at all (null/undefined) — the request failed or was never awaited',
              },
            ],
          };
        }
      }
      return null;
    },
  },
  {
    id: 'R5',
    category: CATEGORY.RESOURCE_CONTENTION,
    // Signal: worker/browser/OS-level failure text while more than one worker was
    // configured. This is a message-level claim (the browser or the machine
    // died), so it outranks the symptom rules below.
    signals:
      'browser/worker/process-level error text (Target closed, page crashed, Protocol error, ENOMEM, EADDRINUSE, …) with workers > 1',
    detect(ctx) {
      const er = ctx.evidenceRuns;
      const crash = ctx.joined.match(
        /Target page, context or browser has been closed|browser has been closed|Target closed|page crashed|Protocol error|worker process|ENOMEM|ENOSPC|EADDRINUSE|EMFILE|Too many open files|Resource temporarily unavailable|out of memory|SIGKILL|SIGTERM/,
      );
      const workers = er.workerCounts.configured;
      const parallel = workers.length === 0 || workers.some((w) => w > 1);
      if (crash && parallel) {
        return {
          confidence: 'medium',
          evidence: [
            { signal: 'error message', detail: `browser/worker-level failure: ${crash[0]}` },
            { signal: 'run config', detail: `the suite ran with workers=${workers.join('/') || 'unknown (assumed > 1)'}` },
            {
              signal: 'reasoning',
              detail: 'the machine ran out of a resource mid-run, so the test failed for a reason that has nothing to do with the code it exercises',
            },
          ],
        };
      }
      return null;
    },
  },
  {
    id: 'R6',
    category: CATEGORY.TEST_ORDER_DEPENDENCY,
    // Signals: the same test PASSED in a solo reproduction run (one test alone,
    // via --grep) and FAILED inside the full suite; or the failure happened in a
    // hook, which is where leaked state surfaces.
    signals:
      'passed in a solo/--grep run while failing in the suite, or failure located in a hook (beforeAll/beforeEach/afterAll/afterEach)',
    detect(ctx) {
      const er = ctx.evidenceRuns;
      if (er.solo.length > 0) {
        const run = er.solo[0];
        return {
          confidence: 'high',
          evidence: [
            { signal: `run "${run.label ?? run.sourceFile}"`, detail: 'the test passed when run on its own' },
            {
              signal: 'cross-run comparison',
              detail: `the same test failed in ${ctx.test.failureRuns.length} suite run(s): ${ctx.test.failureRuns.join(', ')}`,
            },
            {
              signal: 'reasoning',
              detail: 'something another test does (or leaves behind) decides the outcome — order, shared data, shared session, shared server state',
            },
          ],
        };
      }
      const hook = ctx.joined.match(/\b(beforeAll|beforeEach|afterAll|afterEach)\b/);
      if (hook) {
        return {
          confidence: 'low',
          evidence: [
            { signal: 'error message', detail: `the failure mentions the ${hook[1]} hook` },
            {
              signal: 'next step',
              detail: 'run this test alone (npx playwright test -g "<title>") and compare: if it passes alone, it is order-dependent',
            },
          ],
        };
      }
      return null;
    },
  },
  {
    id: 'R7',
    category: CATEGORY.TIMEOUT,
    // Signal: the test-level budget, not an assertion. Playwright reports it as
    // result.status "timedOut" and the message "Test timeout of Nms exceeded.".
    signals: 'result.status == "timedOut", or error message matches /Test timeout of \\d+ms exceeded/',
    detect(ctx) {
      const m = ctx.joined.match(/Test timeout of (\d+)ms exceeded/);
      const timedOutAttempt = ctx.test.failures.some((f) => f.badAttempts.some((a) => a.status === 'timedOut'));
      if (!m && !timedOutAttempt) return null;
      const budget = m?.[1] ?? String(ctx.test.timeout ?? 'unknown');
      const pending = ctx.joined.match(/^\s*-?\s*waiting for (.+)$/m)?.[1] ?? null;
      const configured = ctx.test.timeout;
      return {
        confidence: 'high',
        evidence: [
          { signal: 'result.status', detail: 'the attempt ended as timedOut, not as a failed assertion' },
          {
            signal: 'error message',
            detail: `the test used its whole ${budget}ms budget${configured ? ` (per-test timeout ${configured}ms)` : ''}`,
          },
          pending ? { signal: 'call log', detail: `still waiting for ${pending.trim()} when the budget ran out` } : null,
          {
            signal: 'reasoning',
            detail:
              'a timeout says "too slow", never "why". Read the call log above before changing any number: what it was waiting for names the real cause.',
          },
        ].filter(Boolean),
      };
    },
  },
  {
    id: 'R8',
    category: CATEGORY.MISSING_AWAIT_RACE,
    // Signals, strongest first: an unawaited or snapshotting assertion on the
    // failing line; an assertion whose call log shows the "unexpected value"
    // retry loop; a locator action timeout where the element was never found or
    // never became visible; a resolved-but-not-actionable element.
    signals:
      'failing source line has expect(...) without await or expect(await ...), or assertion call log shows "unexpected value", or locator timeout with element not found / not visible',
    detect(ctx) {
      const evidence = [];
      let confidence = null;

      const awaitSignal = missingAwaitSignal(ctx);
      if (awaitSignal) {
        confidence = 'high';
        evidence.push({ signal: 'code frame at the failing line', detail: awaitSignal.detail });
      }

      const value = assertionValueSignal(ctx);
      if (value && value.unexpectedValue && !value.stableWrongValue) {
        confidence = confidence ?? 'medium';
        evidence.push({
          signal: 'assertion call log',
          detail: `the assertion retried and saw an unexpected value${value.received !== null ? ` ("${oneLine(value.received)}")` : ''}`,
        });
      } else if (value && value.stableWrongValue) {
        // Deliberately NOT a race signal. Recorded so the report can say why
        // this rule was rejected rather than leaving the reader guessing.
        ctx.rejectedSignals.push(
          `the assertion retried ${value.maxRepetitions}× and always saw the same value ("${oneLine(value.received ?? '')}") — a value that never moves is a wrong expectation, not a race`,
        );
      }

      const loc = locatorTimeoutSignal(ctx);
      if (loc && !loc.resolved) {
        confidence = confidence ?? 'medium';
        evidence.push(
          {
            signal: 'call log',
            detail: `${loc.call} — the locator never resolved to an element in ${loc.neverResolvedCount} of ${loc.neverResolvedCount + loc.resolvedCount} failing attempt(s)`,
          },
          {
            signal: 'reasoning',
            detail: ctx.evidenceRuns.wasSeenPassing
              ? 'the element does appear in the runs where this test passed, so the action ran before the UI produced it'
              : 'this test did not pass in any collected run, so check first whether the element ever exists (selector typo, feature flag off, wrong page) before calling it a race',
          },
        );
      } else if (loc && loc.resolved) {
        confidence = confidence ?? 'low';
        evidence.push({
          signal: 'call log',
          detail: `${loc.call} — the element was found every time but never became actionable inside the budget (it was moving, covered, disabled or still loading)`,
        });
      }

      if (/element is not visible|element\(s\) not found/.test(ctx.joined) && !/element is not stable/.test(ctx.joined)) {
        confidence = confidence ?? 'medium';
        evidence.push({
          signal: 'call log',
          detail: 'Playwright kept waiting for the element to become visible and it never did inside the budget',
        });
      }

      if (/waiting for element to be visible, enabled and stable/.test(ctx.joined) && /element is not enabled/.test(ctx.joined)) {
        confidence = confidence ?? 'low';
        evidence.push({ signal: 'call log', detail: 'the element appeared but stayed disabled — the app was still in its own loading state' });
      }

      if (confidence === null) return null;

      if (value && value.receivedLooksLoading) {
        evidence.push({
          signal: 'Expected/Received diff',
          detail: `the received value still looks like a loading placeholder ("${oneLine(value.received)}")`,
        });
      } else if (value && value.receivedLooksEmpty) {
        evidence.push({
          signal: 'Expected/Received diff',
          detail: `the received value was empty/placeholder (${oneLine(value.received)}) while the expectation wanted a real value`,
        });
      }

      return { confidence, evidence };
    },
  },
  {
    id: 'R9',
    category: CATEGORY.RESOURCE_CONTENTION,
    // Signal: the ONLY evidence is that the test passed in a serial run of the
    // whole suite. Tried last on purpose: "it passes with one worker" is the
    // weakest causal claim about the test itself, and a message-level mechanism
    // (a race, a network wait, an unstable element) is a better explanation
    // whenever one is visible. When R9 is the winner, no rule above matched.
    signals: 'the test passed in a serial run (workers=1) of the whole suite, and no message-level rule matched',
    detect(ctx) {
      const er = ctx.evidenceRuns;
      if (er.serial.length === 0) return null;
      const run = er.serial[0];
      return {
        confidence: 'medium',
        evidence: [
          { signal: `run "${run.label ?? run.sourceFile}"`, detail: 'the test passed when the whole suite ran on a single worker' },
          { signal: 'run config', detail: `the failing runs used workers=${er.workerCounts.configured.join('/') || 'unknown'}` },
          {
            signal: 'reasoning',
            detail:
              'nothing in the error message explains the failure, and the test stops failing when it stops competing for machine resources (CPU, memory, ports, database connections, rate limits, temp files)',
          },
        ],
      };
    },
  },
];

/* ------------------------------------------------------------------ *
 * Classification entry points
 * ------------------------------------------------------------------ */

function oneLine(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Classify one aggregated test (a record from parse-results aggregate()).
 *
 * @param {object} test aggregated test history
 * @param {{runs?: object[]}} [options]
 * @returns {{testId, category, confidence, evidence, hints, fixFile, fixSummary, isFlaky}}
 */
export function classifyTest(test, options = {}) {
  const ctx = buildContext(test, options.runs ?? [], options.evidenceRuns ?? []);
  const isFlaky = test.verdict === VERDICT.FLAKY || test.verdict === VERDICT.FLAKY_RETRY_ONLY;

  if (test.failures.length === 0) {
    return {
      testId: test.testId,
      category: CATEGORY.UNKNOWN,
      confidence: 'low',
      evidence: [
        {
          signal: 'run history',
          detail:
            test.counts.unexpectedPass > 0
              ? 'the test is marked as expected-to-fail but passed: no error message exists to classify'
              : 'no failing attempt in any run — nothing to classify',
        },
      ],
      hints: [],
      rejected: [],
      fixFile: FIX_FILE[CATEGORY.UNKNOWN],
      fixSummary: FIX_SUMMARY[CATEGORY.UNKNOWN],
      isFlaky,
    };
  }

  const attempted = [];
  for (const rule of RULES) {
    const hit = rule.detect(ctx);
    if (hit) attempted.push({ rule, hit });
  }

  if (attempted.length === 0) {
    return {
      testId: test.testId,
      category: CATEGORY.UNKNOWN,
      confidence: 'low',
      evidence: [
        { signal: 'error message', detail: `no rule matched: "${oneLine(test.distinctErrors[0]?.sample ?? '')}"` },
        ...ctx.rejectedSignals.map((detail) => ({ signal: 'rule rejected', detail })),
        { signal: 'run history', detail: `${test.counts.failedOutright} failed run(s), ${test.counts.passedOnRetry} pass-on-retry run(s), ${test.counts.cleanPass} clean run(s)` },
        {
          signal: 'next step',
          detail: 'see fixes/09-unknown.md for the evidence to collect (trace, video, timings, solo run, serial run)',
        },
      ],
      hints: [],
      rejected: [],
      fixFile: FIX_FILE[CATEGORY.UNKNOWN],
      fixSummary: FIX_SUMMARY[CATEGORY.UNKNOWN],
      isFlaky,
    };
  }

  const [winner, ...rest] = attempted;
  const hints = rest.map(({ rule, hit }) => ({
    category: rule.category,
    rule: rule.id,
    detail: hit.evidence.map((e) => e.detail).join('; '),
  }));

  const neverPassed = test.counts.cleanPass + test.counts.passedOnRetry === 0;
  const historyNote = neverPassed
    ? {
        signal: 'run history',
        detail: `this test did not pass in any of the ${test.counts.runsObserved} collected run(s). It is a consistent failure, not a flake — the category below describes the symptom, and the fix is a normal bug fix.`,
      }
    : {
        signal: 'run history',
        detail: `${test.counts.failedOutright} failed run(s), ${test.counts.passedOnRetry} run(s) that only passed on retry, ${test.counts.cleanPass} clean pass(es)`,
      };

  return {
    testId: test.testId,
    category: winner.rule.category,
    confidence: winner.hit.confidence,
    evidence: [
      { signal: 'rule', detail: `${winner.rule.id} matched: ${winner.rule.signals}` },
      ...winner.hit.evidence,
      historyNote,
    ],
    hints,
    rejected: ctx.rejectedSignals,
    fixFile: FIX_FILE[winner.rule.category],
    fixSummary: FIX_SUMMARY[winner.rule.category],
    isFlaky,
  };
}

/** Classify a list of aggregated tests, keyed by testId. */
export function classifyAll(tests, options = {}) {
  const out = new Map();
  for (const test of tests) out.set(test.testId, classifyTest(test, options));
  return out;
}

/* ------------------------------------------------------------------ *
 * CLI: node detect/classify.mjs <reports-dir> [--json]
 * ------------------------------------------------------------------ */

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const targets = args.filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    process.stderr.write('usage: node detect/classify.mjs <reports-dir|report.json> [more...] [--json]\n');
    return 2;
  }
  return import('./parse-results.mjs').then(({ analyze }) => {
    const { tests, runs } = analyze(targets);
    const verdicts = classifyAll(tests, { runs });
    if (json) {
      process.stdout.write(
        JSON.stringify(
          [...verdicts.entries()].map(([testId, v]) => ({ testId, ...v })),
          null,
          2,
        ) + '\n',
      );
    } else {
      const lines = [];
      for (const t of tests) {
        const v = verdicts.get(t.testId);
        lines.push(`${v.category} (${v.confidence})  ${t.fullTitle}`);
        for (const e of v.evidence) lines.push(`    [${e.signal}] ${e.detail}`);
        for (const h of v.hints) lines.push(`    (also seen: ${h.category} via ${h.rule})`);
        lines.push('');
      }
      process.stdout.write(lines.join('\n'));
    }
    return 0;
  });
}

if (isDirectInvocation(import.meta.url)) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}
