import { describe, it, expect } from 'vitest';
import { redactSecrets, SECRET_PATTERNS } from './secret-redact.js';
import * as barrel from '../index.js';

describe('secret-redact (reference location)', () => {
  it('redacts a known token and passes empty input through', () => {
    expect(redactSecrets(`token ${'sk-' + 'a'.repeat(30)} end`)).toBe(
      'token [REDACTED:OPENAI] end',
    );
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets(undefined)).toBe('');
  });

  it('is exported from the package barrel', () => {
    expect(barrel.redactSecrets).toBe(redactSecrets);
    expect(barrel.SECRET_PATTERNS).toBe(SECRET_PATTERNS);
  });
});
