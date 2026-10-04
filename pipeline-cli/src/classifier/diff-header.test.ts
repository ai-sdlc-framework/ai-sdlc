import { describe, expect, it } from 'vitest';

import { diffHeaderPaths, sameNameHeaderPath } from './diff-header.js';

describe('sameNameHeaderPath', () => {
  it('reads a header whose two sides name the same file, whatever the path contains', () => {
    expect(sameNameHeaderPath('a/src/x.ts b/src/x.ts')).toBe('src/x.ts');
    expect(sameNameHeaderPath('a/dir b/x.ts b/dir b/x.ts')).toBe('dir b/x.ts');
    expect(sameNameHeaderPath('a/s p a c e b/s p a c e')).toBe('s p a c e');
  });

  it('is undefined for anything else', () => {
    for (const rest of [
      '',
      'a/',
      'x/a b/a',
      'a/x b/y',
      'a/x b/x ',
      'a/old b/x.ts b/new.ts',
      '"a/q" "b/q"',
      'a/x',
    ]) {
      expect(sameNameHeaderPath(rest)).toBeUndefined();
    }
  });
});

describe('diffHeaderPaths', () => {
  it('splits a plain or renamed header exactly', () => {
    expect(diffHeaderPaths('a/src/a.ts b/src/a.ts')).toEqual({
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      exact: true,
    });
    expect(diffHeaderPaths('a/.github/workflows/ci.yml b/docs/old-ci.md')).toEqual({
      oldPath: '.github/workflows/ci.yml',
      newPath: 'docs/old-ci.md',
      exact: true,
    });
  });

  it('reads a same-name header whose path contains " b/" exactly', () => {
    expect(diffHeaderPaths('a/dir b/x.ts b/dir b/x.ts')).toEqual({
      oldPath: 'dir b/x.ts',
      newPath: 'dir b/x.ts',
      exact: true,
    });
  });

  it('marks a differing header with several " b/" as a guess at the last split', () => {
    expect(diffHeaderPaths('a/old b/x.ts b/new.ts')).toEqual({
      oldPath: 'old b/x.ts',
      newPath: 'new.ts',
      exact: false,
    });
  });

  it('is undefined for a header that is not two non-empty paths', () => {
    for (const rest of ['', 'x/a b/a', 'a/only', 'a/ b/x', 'a/x b/', '"a/q" "b/q"', 'a/x "b/y"']) {
      expect(diffHeaderPaths(rest)).toBeUndefined();
    }
  });

  it('gives the same answer as the regex it replaces, except for same-name headers', () => {
    // Every string over a small alphabet, up to 8 characters after 'a/'.
    const alphabet = ['a', 'b', '/', ' '];
    const old = /^a\/(.+) b\/(.+)$/;
    let checked = 0;
    const walk = (body: string, depth: number): void => {
      const rest = `a/${body}`;
      const m = old.exec(rest);
      const got = diffHeaderPaths(rest);
      if (sameNameHeaderPath(rest) === undefined) {
        expect(got === undefined ? undefined : [got.oldPath, got.newPath]).toEqual(
          m ? [m[1], m[2]] : undefined,
        );
      }
      checked++;
      if (depth === 0) return;
      for (const c of alphabet) walk(body + c, depth - 1);
    };
    walk('', 8);
    expect(checked).toBeGreaterThan(80_000);
  });

  it('reads a hostile header in linear time (the bound is generous)', () => {
    const time = (reps: number): number => {
      const rest = `a/a b/${'a b/a'.repeat(reps)}`;
      const start = performance.now();
      for (let i = 0; i < 5; i++) diffHeaderPaths(rest);
      return performance.now() - start;
    };
    const small = Math.max(time(20_000), 5);
    const large = time(80_000);
    expect(large / small).toBeLessThan(12);
    expect(large).toBeLessThan(5000);

    const start = performance.now();
    expect(diffHeaderPaths(`a/${' b/'.repeat(100_000)}`)?.exact).toBe(false);
    expect(diffHeaderPaths(`a/${'p b/'.repeat(30_000)} b/${'p b/'.repeat(30_000)}`)?.exact).toBe(
      true,
    );
    expect(performance.now() - start).toBeLessThan(5000);
  }, 30000);
});
