import { describe, it, expect } from 'vitest';
import { createEnvSecretStore } from './env-secret-store.js';

describe('EnvSecretStore', () => {
  it('resolves a secret from env vars', () => {
    const store = createEnvSecretStore({ GITHUB_TOKEN: 'abc123' });
    expect(store.get('github-token')).toBe('abc123');
  });

  it('returns undefined for missing secrets', () => {
    const store = createEnvSecretStore({});
    expect(store.get('github-token')).toBeUndefined();
  });

  it('converts kebab-case to UPPER_SNAKE_CASE', () => {
    const store = createEnvSecretStore({ LINEAR_API_KEY: 'key-val' });
    expect(store.get('linear-api-key')).toBe('key-val');
  });

  it('getRequired returns value when present', () => {
    const store = createEnvSecretStore({ MY_SECRET: 'value' });
    expect(store.getRequired('my-secret')).toBe('value');
  });

  it('getRequired throws when missing', () => {
    const store = createEnvSecretStore({});
    expect(() => store.getRequired('missing-secret')).toThrow('not found');
    expect(() => store.getRequired('missing-secret')).toThrow('MISSING_SECRET');
  });

  it('handles simple names without hyphens', () => {
    const store = createEnvSecretStore({ TOKEN: 'tok123' });
    expect(store.get('token')).toBe('tok123');
  });

  it('does not have set or delete (read-only)', () => {
    const store = createEnvSecretStore({});
    expect(store.set).toBeUndefined();
    expect(store.delete).toBeUndefined();
  });

  it('defaults to process.env when no env provided', () => {
    const originalValue = process.env.AI_SDLC_TEST_SECRET;
    process.env.AI_SDLC_TEST_SECRET = 'test-val';
    try {
      const store = createEnvSecretStore();
      expect(store.get('ai-sdlc-test-secret')).toBe('test-val');
    } finally {
      if (originalValue === undefined) {
        delete process.env.AI_SDLC_TEST_SECRET;
      } else {
        process.env.AI_SDLC_TEST_SECRET = originalValue;
      }
    }
  });
});
