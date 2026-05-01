/**
 * `defaultSpawner()` — unit tests.
 *
 * Tests the resolution order:
 *   1. `claude` CLI on PATH → ShellClaudePSpawner
 *   2. `ANTHROPIC_API_KEY` in env → ClaudeCodeSDKSpawner
 *   3. neither → throw
 *
 * Both detection mechanisms (`which` + env read) are injected so the suite
 * doesn't shell out to the real `which`/`where` and doesn't mutate the real
 * `process.env`.
 */

import { describe, expect, it, vi } from 'vitest';
import { defaultSpawner, defaultWhich } from './default-spawner.js';
import { ShellClaudePSpawner } from './shell-claude-p-spawner.js';
import { ClaudeCodeSDKSpawner } from './claude-code-sdk-spawner.js';

describe('defaultSpawner', () => {
  it('returns ShellClaudePSpawner when `claude` is on PATH (regardless of API key)', async () => {
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(true),
      env: () => 'unused-key', // shouldn't matter — CLI wins
    });
    expect(spawner).toBeInstanceOf(ShellClaudePSpawner);
  });

  it('returns ClaudeCodeSDKSpawner when `claude` is missing but ANTHROPIC_API_KEY is set', async () => {
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(false),
      env: () => 'sk-ant-test-key',
    });
    expect(spawner).toBeInstanceOf(ClaudeCodeSDKSpawner);
  });

  it('throws a clear instructional error when neither CLI nor API key is available', async () => {
    await expect(
      defaultSpawner({
        which: vi.fn().mockResolvedValue(false),
        env: () => undefined,
      }),
    ).rejects.toThrow(/install the `claude` CLI|set ANTHROPIC_API_KEY/);
  });

  it('passes shell-spawner options through when CLI detection wins', async () => {
    const which = vi.fn().mockResolvedValue(true);
    const spawner = await defaultSpawner({
      which,
      env: () => undefined,
      shell: { binary: '/opt/bin/claude', defaultTimeoutMs: 1000 },
    });
    // The which probe should target the overridden binary name.
    expect(which).toHaveBeenCalledWith('/opt/bin/claude');
    expect(spawner).toBeInstanceOf(ShellClaudePSpawner);
  });

  it('passes sdk-spawner options through when env detection wins', async () => {
    const spawner = await defaultSpawner({
      which: vi.fn().mockResolvedValue(false),
      env: () => 'env-key',
      sdk: { model: 'opus' },
    });
    expect(spawner).toBeInstanceOf(ClaudeCodeSDKSpawner);
    // The constructed spawner used the env-supplied API key, not undefined.
    // We can't introspect private fields directly, so cross-check via a spawn
    // call: with no invoker, the default invoker tries to import the SDK and
    // fails with a clear error — proving the spawner was wired with our key.
    const r = await spawner.spawn({
      type: 'developer',
      prompt: 'p',
      cwd: '/tmp',
    });
    expect(r.status).toBe('error');
    expect(r.error).not.toMatch(/no API key/); // env key was honoured
  });

  it('prefers the explicit env-callback override over reading process.env directly', async () => {
    const env = vi.fn().mockReturnValue('callback-key');
    await defaultSpawner({
      which: vi.fn().mockResolvedValue(false),
      env,
    });
    expect(env).toHaveBeenCalledTimes(1);
  });
});

describe('defaultWhich', () => {
  it('returns true for a binary that always exists on the test system (node)', async () => {
    // `node` is guaranteed to be on PATH wherever vitest runs.
    expect(await defaultWhich('node')).toBe(true);
  });

  it('returns false for a binary that does not exist', async () => {
    expect(await defaultWhich('definitely-not-a-real-binary-xyzzy-12345')).toBe(false);
  });
});
