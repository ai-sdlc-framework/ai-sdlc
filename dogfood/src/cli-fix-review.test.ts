import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('cli-fix-review', () => {
  const cliPath = resolve(import.meta.dirname, 'cli-fix-review.ts');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exits with error on missing PR arg', () => {
    try {
      execFileSync('npx', ['tsx', cliPath], {
        encoding: 'utf-8',
        timeout: 10_000,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      // Should not reach here
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const error = err as { status: number; stderr: string };
      expect(error.status).not.toBe(0);
      expect(error.stderr).toContain('Usage');
    }
  });

  it('exits with error on invalid PR number', () => {
    try {
      execFileSync('npx', ['tsx', cliPath, '--pr', 'invalid'], {
        encoding: 'utf-8',
        timeout: 10_000,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      expect.unreachable('Should have thrown');
    } catch (err: unknown) {
      const error = err as { status: number; stderr: string };
      expect(error.status).not.toBe(0);
      expect(error.stderr).toContain('Invalid PR number');
    }
  });
});
