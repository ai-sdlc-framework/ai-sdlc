import { describe, expect, it } from 'vitest';
import { defaultRunner } from './exec.js';

describe('defaultRunner', () => {
  it('returns stdout/stderr/code for a successful command', async () => {
    const r = await defaultRunner('node', ['-e', 'process.stdout.write("hi"); process.exit(0)']);
    expect(r.stdout).toBe('hi');
    expect(r.code).toBe(0);
  });

  it('returns code + stderr when allowFailure=true', async () => {
    const r = await defaultRunner('node', ['-e', 'process.stderr.write("oops"); process.exit(2)'], {
      allowFailure: true,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toBe('oops');
  });

  it('throws when command fails and allowFailure is false', async () => {
    await expect(defaultRunner('node', ['-e', 'process.exit(7)'])).rejects.toThrow();
  });

  it('passes env overrides to child process', async () => {
    const r = await defaultRunner(
      'node',
      ['-e', 'process.stdout.write(process.env.PIPELINE_TEST_VAR ?? "")'],
      { env: { PIPELINE_TEST_VAR: 'abc' } },
    );
    expect(r.stdout).toBe('abc');
  });
});
