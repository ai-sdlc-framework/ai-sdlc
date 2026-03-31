import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('cli-fix-review', () => {
  const tsxBin = resolve(import.meta.dirname, '../../node_modules/.bin/tsx');
  const cliPath = resolve(import.meta.dirname, 'cli-fix-review.ts');

  it('exits with non-zero code on invalid PR number', () => {
    let exitCode = 0;
    try {
      execFileSync(tsxBin, [cliPath, '--pr', 'invalid'], {
        timeout: 15_000,
        stdio: 'pipe',
      });
    } catch (err: unknown) {
      exitCode = (err as { status: number }).status;
    }
    expect(exitCode).not.toBe(0);
  });
});
