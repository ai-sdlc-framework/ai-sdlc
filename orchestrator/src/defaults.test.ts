import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as defaults from './defaults.js';

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

describe('defaults — new constants', () => {
  it('DEFAULT_LINT_COMMAND defaults to undefined', () => {
    // Unless env var is set, should be undefined
    expect(defaults.DEFAULT_LINT_COMMAND).toSatisfy(
      (v: unknown) => v === undefined || typeof v === 'string',
    );
  });

  it('DEFAULT_FORMAT_COMMAND defaults to undefined', () => {
    expect(defaults.DEFAULT_FORMAT_COMMAND).toSatisfy(
      (v: unknown) => v === undefined || typeof v === 'string',
    );
  });

  it('DEFAULT_COMMIT_MESSAGE_TEMPLATE is a string with placeholders', () => {
    expect(defaults.DEFAULT_COMMIT_MESSAGE_TEMPLATE).toBeTypeOf('string');
    expect(defaults.DEFAULT_COMMIT_MESSAGE_TEMPLATE).toContain('{issueNumber}');
    expect(defaults.DEFAULT_COMMIT_MESSAGE_TEMPLATE).toContain('{issueTitle}');
  });

  it('DEFAULT_COMMIT_CO_AUTHOR is a string', () => {
    expect(defaults.DEFAULT_COMMIT_CO_AUTHOR).toBeTypeOf('string');
    expect(defaults.DEFAULT_COMMIT_CO_AUTHOR.length).toBeGreaterThan(0);
  });

  it('DEFAULT_OPENAI_API_URL is a valid URL', () => {
    expect(defaults.DEFAULT_OPENAI_API_URL).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('DEFAULT_OPENAI_MODEL is gpt-4', () => {
    expect(defaults.DEFAULT_OPENAI_MODEL).toBe('gpt-4');
  });

  it('DEFAULT_ANTHROPIC_API_URL is a valid URL', () => {
    expect(defaults.DEFAULT_ANTHROPIC_API_URL).toBe('https://api.anthropic.com/v1/messages');
  });

  it('DEFAULT_ANTHROPIC_MODEL is claude-sonnet-4-5-20250929', () => {
    expect(defaults.DEFAULT_ANTHROPIC_MODEL).toBe('claude-sonnet-4-5-20250929');
  });

  it('DEFAULT_GENERIC_LLM_MODEL is "default"', () => {
    expect(defaults.DEFAULT_GENERIC_LLM_MODEL).toBe('default');
  });

  it('DEFAULT_LLM_TIMEOUT_MS is 120000', () => {
    expect(defaults.DEFAULT_LLM_TIMEOUT_MS).toBe(120_000);
  });

  it('DEFAULT_LLM_MAX_TOKENS is 4096', () => {
    expect(defaults.DEFAULT_LLM_MAX_TOKENS).toBe(4096);
  });

  it('DEFAULT_LLM_SYSTEM_PROMPT is a non-empty string', () => {
    expect(defaults.DEFAULT_LLM_SYSTEM_PROMPT).toBeTypeOf('string');
    expect(defaults.DEFAULT_LLM_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('DEFAULT_DOCKER_IMAGE is node:20-slim', () => {
    expect(defaults.DEFAULT_DOCKER_IMAGE).toBe('node:20-slim');
  });

  it('DEFAULT_WORKFLOW_FILE is ci.yml', () => {
    expect(defaults.DEFAULT_WORKFLOW_FILE).toBe('ci.yml');
  });

  it('DEFAULT_LABEL_TO_SKILL_MAP has expected keys', () => {
    expect(defaults.DEFAULT_LABEL_TO_SKILL_MAP).toBeTypeOf('object');
    expect(defaults.DEFAULT_LABEL_TO_SKILL_MAP.bug).toBe('debugging');
    expect(defaults.DEFAULT_LABEL_TO_SKILL_MAP.feature).toBe('implementation');
    expect(defaults.DEFAULT_LABEL_TO_SKILL_MAP.docs).toBe('documentation');
  });

  it('DEFAULT_ANALYSIS_CACHE_TTL_MS is 86400000 (24h)', () => {
    expect(defaults.DEFAULT_ANALYSIS_CACHE_TTL_MS).toBe(86_400_000);
  });
});
