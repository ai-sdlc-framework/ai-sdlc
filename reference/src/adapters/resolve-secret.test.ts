import { describe, it, expect, afterEach } from 'vitest';
import { resolveSecret } from './resolve-secret.js';

describe('resolveSecret', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('converts kebab-case to UPPER_SNAKE_CASE and reads env var', () => {
    process.env.GITHUB_TOKEN = 'ghp_test123';
    expect(resolveSecret('github-token')).toBe('ghp_test123');
  });

  it('handles single-word secret names', () => {
    process.env.TOKEN = 'abc';
    expect(resolveSecret('token')).toBe('abc');
  });

  it('handles multi-segment names', () => {
    process.env.LINEAR_API_KEY = 'lin_xyz';
    expect(resolveSecret('linear-api-key')).toBe('lin_xyz');
  });

  it('throws when environment variable is not set', () => {
    delete process.env.MISSING_SECRET;
    expect(() => resolveSecret('missing-secret')).toThrow(
      'Secret "missing-secret" not found: environment variable MISSING_SECRET is not set',
    );
  });

  it('throws when environment variable is empty string', () => {
    process.env.EMPTY_VAR = '';
    expect(() => resolveSecret('empty-var')).toThrow('environment variable EMPTY_VAR is not set');
  });
});
