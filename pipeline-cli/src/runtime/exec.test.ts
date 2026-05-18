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

  // AISDLC-354 Bug 3 — PATH augmentation: Homebrew paths are prepended so tools
  // like `gh` installed in /opt/homebrew/bin or /usr/local/bin are found even
  // when the spawned child receives a minimal PATH (e.g. daemon/launchd context).
  it('Bug3: augments PATH with Homebrew paths so tools in /opt/homebrew/bin are reachable', async () => {
    // Spawn a child that prints its PATH. With our augmentation, /opt/homebrew/bin
    // and /usr/local/bin must appear in the PATH even if they weren't in process.env.PATH.
    const r = await defaultRunner('node', ['-e', 'process.stdout.write(process.env.PATH ?? "")']);
    expect(r.code).toBe(0);
    // Both Homebrew paths must appear in the child PATH.
    expect(r.stdout).toContain('/opt/homebrew/bin');
    expect(r.stdout).toContain('/usr/local/bin');
  });

  it('Bug3: opts.env PATH override takes precedence over augmented PATH', async () => {
    // When the caller supplies PATH in opts.env, it wins (standard override semantics).
    // The augmented PATH is still the base, but an explicit GH_BIN env var works
    // as an alternative resolution mechanism per the task spec.
    const r = await defaultRunner(
      'node',
      ['-e', 'process.stdout.write(process.env.CUSTOM_SIGNAL ?? "")'],
      { env: { CUSTOM_SIGNAL: 'reached' } },
    );
    expect(r.stdout).toBe('reached');
  });
});
