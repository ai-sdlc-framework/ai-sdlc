/**
 * Tests for the clock-discipline gate (AISDLC-769).
 * Run with: node --test scripts/check-clock-discipline.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countClockReads,
  isScanned,
  scanClockReads,
  diffClockReads,
  baselineGrowth,
  loadBaseline,
  run,
} from './check-clock-discipline.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture(files, baseline) {
  const dir = mkdtempSync(join(tmpdir(), 'clock-gate-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  if (baseline) {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/clock-baseline.json'), JSON.stringify({ files: baseline }));
  }
  return dir;
}

function quiet(fn) {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('countClockReads', () => {
  it('counts Date.now() and zero-arg new Date()', () => {
    assert.equal(countClockReads('const a = Date.now(); const b = new Date();'), 2);
  });
  it('ignores new Date(arg), Date.parse and comments', () => {
    assert.equal(
      countClockReads("new Date(x); new Date('2026-01-01'); Date.parse(s); // Date.now()"),
      0,
    );
  });
});

describe('isScanned', () => {
  it('skips tests, the clock seam, helpers and fixtures', () => {
    assert.equal(isScanned('p/src/a.ts'), true);
    assert.equal(isScanned('p/src/a.test.ts'), false);
    assert.equal(isScanned('p/src/clock.ts'), false);
    assert.equal(isScanned('p/src/__test-helpers/x.ts'), false);
    assert.equal(isScanned('p/src/__fixtures__/x.ts'), false);
  });
});

describe('gate', () => {
  it('passes when the scan equals the baseline', () => {
    const dir = fixture({ 'pkg/src/a.ts': 'export const t = Date.now();' }, { 'pkg/src/a.ts': 1 });
    try {
      assert.equal(
        quiet(() => run([], dir)),
        0,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on a new direct Date.now() in a file outside the baseline (AC-1)', () => {
    const dir = fixture(
      {
        'pkg/src/a.ts': 'export const t = Date.now();',
        'pkg/src/b.ts': 'export const u = Date.now();',
      },
      { 'pkg/src/a.ts': 1 },
    );
    try {
      assert.equal(
        quiet(() => run([], dir)),
        1,
      );
      assert.deepEqual(
        diffClockReads(scanClockReads(dir), loadBaseline(dir)).grown.map((g) => g.path),
        ['pkg/src/b.ts'],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when a baselined file gains a call site', () => {
    const dir = fixture({ 'pkg/src/a.ts': 'Date.now(); new Date();' }, { 'pkg/src/a.ts': 1 });
    try {
      assert.equal(
        quiet(() => run([], dir)),
        1,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows reads inside a clock.ts seam', () => {
    const dir = fixture({ 'pkg/src/clock.ts': 'export const now = () => new Date();' }, {});
    try {
      assert.equal(
        quiet(() => run([], dir)),
        0,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on stale slack so the baseline must be shrunk', () => {
    const dir = fixture({ 'pkg/src/a.ts': 'export const x = 1;' }, { 'pkg/src/a.ts': 1 });
    try {
      assert.equal(
        quiet(() => run([], dir)),
        1,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('baseline is shrink-only (AC-2)', () => {
  it('--update-baseline refuses to grow an existing baseline', () => {
    const dir = fixture({ 'pkg/src/a.ts': 'Date.now(); Date.now();' }, { 'pkg/src/a.ts': 1 });
    try {
      assert.equal(
        quiet(() => run(['--update-baseline'], dir)),
        1,
      );
      assert.deepEqual(loadBaseline(dir), { 'pkg/src/a.ts': 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--update-baseline records a shrink', () => {
    const dir = fixture(
      { 'pkg/src/a.ts': 'Date.now();' },
      { 'pkg/src/a.ts': 3, 'pkg/src/gone.ts': 2 },
    );
    try {
      assert.equal(
        quiet(() => run(['--update-baseline'], dir)),
        0,
      );
      assert.deepEqual(loadBaseline(dir), { 'pkg/src/a.ts': 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('baselineGrowth flags new files and increases only', () => {
    assert.deepEqual(baselineGrowth({ a: 2 }, { a: 1 }), []);
    assert.equal(baselineGrowth({ a: 1 }, { a: 2, b: 1 }).length, 2);
  });

  it('the committed baseline matches the live repo exactly (cannot grow, cannot hold slack)', () => {
    const diff = diffClockReads(scanClockReads(REPO), loadBaseline(REPO));
    assert.deepEqual(diff, { grown: [], stale: [] });
  });
});
