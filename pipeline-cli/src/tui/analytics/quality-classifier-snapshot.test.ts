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
    if (process.env['UPDATE_CLASSIFIER_SNAPSHOT'] === '1' || !existsSync(SNAPSHOT_PATH)) {
      writeFileSync(SNAPSHOT_PATH, actual);
    }
    expect(actual === readFileSync(SNAPSHOT_PATH, 'utf8')).toBe(true);
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
    const start = performance.now();
    const result = classify(big);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(result.class).toBe(classify(big.slice(0, MAX_CLASSIFIED_TEXT_LENGTH)).class);
  });

  it('does not see a signal that sits beyond the bound', () => {
    const padded = 'x'.repeat(MAX_CLASSIFIED_TEXT_LENGTH) + ' ECONNRESET';
    expect(_scoreSignal(padded, 1).externalDependency).toBe(0);
    expect(
      _scoreSignal('ECONNRESET ' + 'x'.repeat(MAX_CLASSIFIED_TEXT_LENGTH), 1).externalDependency,
    ).toBeGreaterThan(0);
  });
});

describe('BridgedPattern equivalence with the `.*` regex (AISDLC-682)', () => {
  const TOKENS = ['a', 'b', 'c', 'A', 'B', 'x', 'y', ' ', '  ', '\n', '\r', '\u2028', '\u2029'];
  const CASES: [RegExp, RegExp[]][] = [
    [/a.*b/i, [/a/, /b/]],
    [/a.*b.*c/i, [/a/, /b/, /c/]],
    [/a.*x\s+y/i, [/a/, /x\s+y/]],
    [/a.b.*c/i, [/a.b/, /c/]],
  ];

  it('agrees with the regex on 20000 seeded random inputs', () => {
    let seed = 682;
    const rand = (n: number): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    for (let k = 0; k < 20000; k++) {
      let text = '';
      for (let i = rand(16); i > 0; i--) text += TOKENS[rand(TOKENS.length)];
      for (const [re, segs] of CASES) {
        expect(new _BridgedPattern(...segs).test(text), `${re} on ${JSON.stringify(text)}`).toBe(
          re.test(text),
        );
      }
    }
  });
});
