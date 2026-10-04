import { describe, expect, it } from 'vitest';

import { reviewPaths, scanReviewPaths } from './review-judgment-support.js';

const scan = (diff: string, changed: string[] = []) => scanReviewPaths(changed, diff);

describe('scanReviewPaths: diff --git headers', () => {
  it('reads both paths of a plain header and of a rename header with one " b/"', () => {
    expect(scan('diff --git a/src/a.ts b/src/a.ts\n+x\n')).toEqual({
      paths: ['src/a.ts'],
      unparseable: false,
    });
    const renamed = scan('diff --git a/.github/workflows/ci.yml b/docs/old-ci.md\n');
    expect(renamed.unparseable).toBe(false);
    expect(renamed.paths.sort()).toEqual(['.github/workflows/ci.yml', 'docs/old-ci.md']);
  });

  it('reads a same-name header whose path contains " b/", and no more than that', () => {
    const r = scan('diff --git a/dir b/x.ts b/dir b/x.ts\n');
    expect(r).toEqual({ paths: ['dir b/x.ts'], unparseable: false });
  });

  it('fails closed on a header with several " b/" whose sides differ', () => {
    for (const header of [
      'diff --git a/old b/x.ts b/new.ts',
      'diff --git a/a b/b b/c b/d',
      'diff --git a/x b/ b/y',
    ]) {
      expect(scan(`${header}\n`).unparseable).toBe(true);
    }
  });

  it('fails closed on headers that are not two plain paths', () => {
    for (const header of [
      'diff --git ',
      'diff --git x/a b/a',
      'diff --git a/only-one-side',
      'diff --git a/ b/x',
      'diff --git a/x b/',
      'diff --git "a/q.ts" "b/q.ts"',
      'diff --git a/q.ts "b/q.ts"',
      'diff --git "a/q.ts" b/q.ts',
    ]) {
      expect(scan(`${header}\n`).unparseable).toBe(true);
    }
  });

  it('still reads rename and copy lines, and vetoes an empty or quoted one', () => {
    const r = scan(
      [
        'diff --git a/old b/x.ts b/new b/y.ts',
        'rename from old b/x.ts',
        'rename to new b/y.ts',
        'diff --git a/s.ts b/c.ts',
        'copy from s.ts',
        'copy to c.ts',
      ].join('\n'),
    );
    expect(r.paths.sort()).toEqual(['c.ts', 'new b/y.ts', 'old b/x.ts', 's.ts']);
    // the first header is ambiguous, so the scan stays vetoed even though the rename lines named it
    expect(r.unparseable).toBe(true);
    expect(scan('diff --git a/x b/x\nrename to \n').unparseable).toBe(true);
    expect(scan('diff --git a/x b/x\nrename to "q\\303"\n').unparseable).toBe(true);
  });

  it('takes the changed-file list into account, and vetoes a quoted or empty entry', () => {
    expect(scan('', ['a.ts', 'b.ts'])).toEqual({ paths: ['a.ts', 'b.ts'], unparseable: false });
    expect(scan('', ['"q.ts"']).unparseable).toBe(true);
    expect(scan('', ['']).unparseable).toBe(true);
    expect(reviewPaths(['a.ts'], 'diff --git a/b.ts b/b.ts\n').sort()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('scanReviewPaths: hostile headers', () => {
  it('scans an adversarial header in linear time', () => {
    const time = (reps: number): number => {
      const d = `diff --git a/a b/${'a b/a'.repeat(reps)}\n`;
      const start = performance.now();
      for (let i = 0; i < 5; i++) scan(d);
      return performance.now() - start;
    };
    const small = Math.max(time(20_000), 5);
    const large = time(80_000);
    // 4x the input: a linear scan stays near 4x, a polynomial one is far above.
    expect(large / small).toBeLessThan(12);
    expect(large).toBeLessThan(5000);
    expect(scan(`diff --git a/a b/${'a b/a'.repeat(50_000)}\n`).unparseable).toBe(true);
  });

  it('survives a header made only of " b/" repeats, and a long same-name path', () => {
    const start = performance.now();
    expect(scan(`diff --git a/${' b/'.repeat(100_000)}\n`).unparseable).toBe(true);
    const path = 'p b/'.repeat(30_000);
    expect(scan(`diff --git a/${path} b/${path}\n`)).toEqual({
      paths: [path],
      unparseable: false,
    });
    expect(performance.now() - start).toBeLessThan(5000);
  });
});
