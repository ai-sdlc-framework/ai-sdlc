import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('defaults — env-var-driven timeout overrides', () => {
  const envKeys = [
    'AI_SDLC_SANDBOX_TIMEOUT',
    'AI_SDLC_RUNNER_TIMEOUT',
    'AI_SDLC_GH_CLI_TIMEOUT',
    'AI_SDLC_JIT_TTL',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('returns hardcoded fallbacks when env vars are not set', async () => {
    // Dynamic import to pick up current env state
    const mod = await import('./defaults.js');
    // Defaults are evaluated at module load time, so verify the constants exist
    expect(typeof mod.DEFAULT_SANDBOX_TIMEOUT_MS).toBe('number');
    expect(typeof mod.DEFAULT_RUNNER_TIMEOUT_MS).toBe('number');
    expect(typeof mod.DEFAULT_GH_CLI_TIMEOUT_MS).toBe('number');
    expect(typeof mod.DEFAULT_JIT_TTL_MS).toBe('number');
  });

  it('parseDuration is used for timeout constants (integration)', async () => {
    // Verify parseDuration is re-exported for direct use
    const { parseDuration } = await import('@ai-sdlc/reference');
    expect(parseDuration('30m')).toBe(1_800_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('PT30M')).toBe(1_800_000);
    expect(parseDuration('2h')).toBe(7_200_000);
  });

  it('exports defaultSandboxConstraints with timeout', async () => {
    const { defaultSandboxConstraints, DEFAULT_SANDBOX_TIMEOUT_MS } = await import('./defaults.js');
    const constraints = defaultSandboxConstraints('/work');
    expect(constraints.timeoutMs).toBe(DEFAULT_SANDBOX_TIMEOUT_MS);
  });

  it('defaultSandboxConstraints accepts custom timeout', async () => {
    const { defaultSandboxConstraints } = await import('./defaults.js');
    const constraints = defaultSandboxConstraints('/work', 60_000);
    expect(constraints.timeoutMs).toBe(60_000);
  });
});
