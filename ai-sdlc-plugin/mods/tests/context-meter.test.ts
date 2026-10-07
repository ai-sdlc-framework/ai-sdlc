import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLDS,
  EMPTY_TOTALS,
  LEVEL_COLOR,
  addUsage,
  bar,
  costWeight,
  formatTokens,
  levelFor,
  percentOfWindow,
  resolveThresholds,
} from '../context-meter/hooks/meter.ts';

test('defaults are 10/13/15', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, { amber: 10, hot: 13, red: 15 });
});

test('threshold to level and colour mapping', () => {
  const cases: [number, string, string][] = [
    [0, 'ok', 'green'],
    [9.99, 'ok', 'green'],
    [10, 'amber', 'yellow'],
    [12.9, 'amber', 'yellow'],
    [13, 'hot', 'yellow'],
    [14.99, 'hot', 'yellow'],
    [15, 'red', 'red'],
    [40, 'red', 'red'],
  ];
  for (const [pct, level, color] of cases) {
    assert.equal(levelFor(pct), level, `level at ${pct}`);
    assert.equal(LEVEL_COLOR[levelFor(pct)], color, `colour at ${pct}`);
  }
});

test('custom thresholds apply; unordered or invalid ones fall back to defaults', () => {
  assert.deepEqual(resolveThresholds({ amberAtPercent: 5, hotAtPercent: 6, redAtPercent: 8 }), {
    amber: 5,
    hot: 6,
    red: 8,
  });
  assert.deepEqual(resolveThresholds({ amberAtPercent: 20 }), DEFAULT_THRESHOLDS);
  assert.deepEqual(
    resolveThresholds({ redAtPercent: 'x', amberAtPercent: -1 }),
    DEFAULT_THRESHOLDS,
  );
  assert.deepEqual(resolveThresholds(undefined), DEFAULT_THRESHOLDS);
  assert.equal(
    levelFor(6, resolveThresholds({ amberAtPercent: 5, hotAtPercent: 6, redAtPercent: 8 })),
    'hot',
  );
});

test('percentOfWindow degrades to null without metrics', () => {
  assert.equal(percentOfWindow(150_000, 1_000_000), 15);
  assert.equal(percentOfWindow(undefined, 1_000_000), null);
  assert.equal(percentOfWindow(10, 0), null);
});

test('token totals arithmetic', () => {
  let t = addUsage(EMPTY_TOTALS, {
    input_tokens: 10,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    output_tokens: 5,
  });
  t = addUsage(t, { input_tokens: 2, output_tokens: 3 });
  assert.deepEqual(t, { input: 12, cacheWrite: 100, cacheRead: 1000, output: 8 });
  assert.deepEqual(EMPTY_TOTALS, { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
});

test('cost weight uses 1 / 1.25 / 0.1 / 5 ratios', () => {
  assert.equal(
    costWeight({ input: 100, cacheWrite: 100, cacheRead: 1000, output: 10 }),
    100 + 125 + 100 + 50,
  );
  assert.equal(costWeight(EMPTY_TOTALS), 0);
});

test('formatting and bar', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12_345), '12.3k');
  assert.equal(formatTokens(150_000), '150k');
  assert.equal(formatTokens(1_250_000), '1.25M');
  assert.equal(bar(0), '░'.repeat(20));
  assert.equal(bar(15), '█'.repeat(20));
  assert.equal(bar(99), '█'.repeat(20));
  assert.equal(bar(7.5), '█'.repeat(10) + '░'.repeat(10));
});
