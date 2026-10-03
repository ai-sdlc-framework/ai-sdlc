/**
 * AISDLC-682 — byte-identical classification snapshot + ReDoS regression.
 *
 * The snapshot in `__fixtures__/quality-classifier-corpus.snapshot.txt` was
 * captured from the pre-change (regex-only) classifier; the test proves the
 * linearised heuristics produce identical output. Regenerate deliberately
 * with `UPDATE_CLASSIFIER_SNAPSHOT=1`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildCorpus, EXIT_CODES } from './quality-classifier-corpus.js';
import {
  _BridgedPattern,
  _HEURISTIC_PATTERNS,
  _scoreSignal,
  classifyFailure,
  MAX_CLASSIFIED_TEXT_LENGTH,
  type FailureSignal,
} from './quality-classifier.js';

const SNAPSHOT_PATH = fileURLToPath(
  new URL('./__fixtures__/quality-classifier-corpus.snapshot.txt', import.meta.url),
);
const TS = new Date('2026-01-01T00:00:00.000Z');

function capture(): string {
  const rows: unknown[] = [];
  for (const stderr of buildCorpus()) {
    for (const exitCode of EXIT_CODES) {
      const sig = { stderr, exitCode, source: 'snapshot' } as FailureSignal;
      const result = classifyFailure(sig, { ts: TS });
      const full = JSON.stringify({
        stderr,
        exitCode,
        breakdown: _scoreSignal(stderr, exitCode),
        result,
      });
      // Readable summary + a digest of the complete output (keeps the fixture small).
      rows.push(
        `${result.class}|${result.bucket}|${result.confidence}|${createHash('sha256').update(full).digest('hex').slice(0, 16)}`,
      );
    }
  }
  return rows.join('\n') + '\n';
}

describe('classifier snapshot (AISDLC-682)', () => {
  it('matches the pre-change snapshot byte-for-byte', () => {
    const actual = capture();
    if (process.env['UPDATE_CLASSIFIER_SNAPSHOT'] === '1') {
      writeFileSync(SNAPSHOT_PATH, actual);
    }
    expect(existsSync(SNAPSHOT_PATH), `missing fixture ${SNAPSHOT_PATH}`).toBe(true);
    const expected = readFileSync(SNAPSHOT_PATH, 'utf8').split('\n');
    const rows = actual.split('\n');
    const corpus = buildCorpus();
    const firstDiff = rows.findIndex((row, i) => row !== expected[i]);
    if (firstDiff !== -1) {
      const text = corpus[Math.floor(firstDiff / EXIT_CODES.length)];
      expect.fail(
        `row ${firstDiff} differs for ${JSON.stringify(text)} (exit ${EXIT_CODES[firstDiff % EXIT_CODES.length]}): ` +
          `expected ${expected[firstDiff]} got ${rows[firstDiff]}`,
      );
    }
    expect(rows.length).toBe(expected.length);
  });
});

describe('classifier input bound + pathological input (AISDLC-682)', () => {
  const classify = (stderr: string) =>
    classifyFailure({ stderr, exitCode: 1, source: 'redos' } as FailureSignal, { ts: TS });

  it('exposes a 16 KiB bound', () => {
    expect(MAX_CLASSIFIED_TEXT_LENGTH).toBe(16 * 1024);
  });

  it('classifies a 1 MiB near-match input in under 100 ms, same class as the truncated input', () => {
    const unit = 'developer returned timeout worktree left sentinel filter open question ';
    const big = unit.repeat(Math.ceil((1024 * 1024) / unit.length)).slice(0, 1024 * 1024);
    // Best of three so a loaded CI machine does not turn a scheduling hiccup into a failure.
    let elapsed = Infinity;
    let result = classify(big);
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      result = classify(big);
      elapsed = Math.min(elapsed, performance.now() - start);
    }
    expect(elapsed).toBeLessThan(100);
    expect(result.class).toBe(classify(big.slice(0, MAX_CLASSIFIED_TEXT_LENGTH)).class);
  });

  it('sees a signal that ends exactly at the bound and misses one that starts at or past it', () => {
    const sig = 'ECONNRESET';
    const external = (text: string) => _scoreSignal(text, 1).externalDependency;
    const cap = MAX_CLASSIFIED_TEXT_LENGTH;
    // Last character of the signal is the last character inside the cap.
    expect(external('x'.repeat(cap - sig.length) + sig)).toBeGreaterThan(0);
    // One character later: the signal is cut off at the cap.
    expect(external('x'.repeat(cap - sig.length + 1) + sig)).toBe(0);
    // Starts exactly at the cap.
    expect(external('x'.repeat(cap) + sig)).toBe(0);
    expect(external(sig + 'x'.repeat(cap))).toBeGreaterThan(0);
  });

  it('applies the same cap through classifyFailure', () => {
    const inside = 'x'.repeat(MAX_CLASSIFIED_TEXT_LENGTH - 10) + 'ECONNRESET';
    expect(classify(inside).class).toBe('external-dependency-failed');
    expect(classify(inside + ' ').class).toBe('external-dependency-failed');
    expect(classify('x'.repeat(MAX_CLASSIFIED_TEXT_LENGTH) + 'ECONNRESET').class).toBe('ambiguous');
  });
});

describe('BridgedPattern line-spanning segments (AISDLC-682 review)', () => {
  const openQuestion = () => new _BridgedPattern(/open\s+question/, /unanswered/);
  const oracle = /open\s+question.*unanswered/i;

  it.each([
    ['LF', 'open question open\nquestion unanswered'],
    ['CRLF', 'open question open\r\nquestion unanswered'],
    ['U+2028', 'open question open\u2028question unanswered'],
    ['U+2029', 'open question open\u2029question unanswered'],
    ['several candidates', 'open question\nopen question\nopen\nquestion unanswered'],
    ['candidate chain', 'open\nquestion open\nquestion open\nquestion unanswered'],
    ['no candidate on the line', 'open question\nunanswered'],
    ['first candidate only', 'open question unanswered\nopen\nquestion'],
  ])('%s agrees with the original regex', (_name, text) => {
    expect(openQuestion().test(text)).toBe(oracle.test(text));
  });

  it('matches the reported case', () => {
    expect(openQuestion().test('open question open\nquestion unanswered')).toBe(true);
  });

  it('keeps a trailing `after\\s+fail` that spans a line break', () => {
    const p = new _BridgedPattern(/worktree/, /left/, /after\s+fail/);
    expect(p.test('worktree left after\nfail')).toBe(true);
    expect(p.test('worktree\nleft after fail')).toBe(false);
  });
});

describe('production heuristics vs the original regexes (AISDLC-682)', () => {
  /** Original (pre-AISDLC-682) heuristic regexes, in `_HEURISTIC_PATTERNS` order: the oracle. */
  const ORIGINAL: RegExp[] = [
    /github\s+api\s+(error|outage|unavailable)/i,
    /anthropic\s+(api|claude)\s+(error|rate.?limit|overloaded)/i,
    /rate.?limit(ed)?/i,
    /npm\s+(registry|ERR)/i,
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i,
    /network\s+(error|partition|timeout)/i,
    /503\s+service\s+unavailable/i,
    /502\s+bad\s+gateway/i,
    /developer.*returned.*prose/i,
    /JSON\s+envelope\s+required/i,
    /parse.*developer.*return/i,
    /invalid.*json.*response/i,
    /SyntaxError.*JSON/i,
    /worktree.*left.*after\s+fail/i,
    /sentinel.*not.*removed/i,
    /cleanup.*fail/i,
    /active.task.*stale/i,
    /filter.*throw/i,
    /pre.dispatch.*fail/i,
    /swallowed.*error/i,
    /silently.*dispatch/i,
    /3x\s+baseline/i,
    /took\s+dramatically\s+longer/i,
    /performance\s+regression/i,
    /timeout.*baseline/i,
    /AC\s+list\s+missing/i,
    /open\s+question.*unanswered/i,
    /needs.clarification/i,
    /missing\s+acceptance\s+criteria/i,
    /DoR.*failed/i,
    /definition.of.ready.*fail/i,
  ];
  const SEPARATORS = [' ', '  ', '\t', '\n', '\r\n', '\r', '\u2028', '\u2029', '-', '_', ',', ''];

  it('covers every production heuristic', () => {
    expect(_HEURISTIC_PATTERNS.length).toBe(ORIGINAL.length);
  });

  it('agrees with the original regex on seeded random multi-candidate inputs', () => {
    let seed = 20260682;
    const rand = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    ORIGINAL.forEach((re, idx) => {
      const words = re.source.match(/[A-Za-z0-9]+/g) ?? [];
      const tokens = [...new Set(words.flatMap((w) => [w, w.slice(0, Math.ceil(w.length / 2))]))];
      const sep = (): string => SEPARATORS[rand(SEPARATORS.length)]!;
      let positives = 0;
      for (let k = 0; k < 6000; k++) {
        let text = '';
        if (rand(2) === 0) {
          // Planted: the pattern's words in order with noise between, some dropped.
          for (const w of words) {
            if (rand(6) === 0) continue;
            text += w + sep();
            for (let n = rand(3); n > 0; n--) text += tokens[rand(tokens.length)] + sep();
          }
        } else {
          for (let i = 1 + rand(14); i > 0; i--) text += tokens[rand(tokens.length)] + sep();
        }
        if (rand(4) === 0) text = text.toUpperCase();
        const expected = re.test(text);
        if (expected) positives++;
        if (_HEURISTIC_PATTERNS[idx]!.test(text) !== expected) {
          expect.fail(`${re} diverges on ${JSON.stringify(text)} (oracle ${expected})`);
        }
      }
      // Guard against a vacuous fuzz (all-negative corpus proves little).
      expect(positives, `${re} positives`).toBeGreaterThan(10);
    });
  }, 30000);
});
