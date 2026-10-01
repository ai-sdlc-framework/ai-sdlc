import { describe, expect, it } from 'vitest';
import { DEFAULT_LABEL_MAX, sanitizeLabel } from './sanitize-label.js';

describe('sanitizeLabel', () => {
  it('keeps ordinary labels unchanged', () => {
    expect(sanitizeLabel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
    expect(sanitizeLabel('ai-sdlc:developer')).toBe('ai-sdlc:developer');
  });

  it.each([
    ['gpt-5\u001b]52;c;QUJD\u0007', 'gpt-5?]52;c;QUJD?'],
    ['a\u001b[2Jb', 'a?[2Jb'],
    ['a\u001b]0;pwned\u0007b', 'a?]0;pwned?b'],
    ['a\nb\rc', 'a?b?c'],
    ['a\u009bb\u0085c\u007fd\u0000e', 'a?b?c?d?e'],
    ['a‮b‏c⁦d⁩e', 'a?b?c?d?e'],
    ['a\ud800b', 'a?b'],
    ['a\udc00b', 'a?b'],
  ])('replaces unsafe characters in %j', (input, expected) => {
    expect(sanitizeLabel(input)).toBe(expected);
  });

  it('keeps a valid surrogate pair', () => {
    expect(sanitizeLabel('a\u{1F600}b')).toBe('a\u{1F600}b');
  });

  it('caps the length with an ellipsis', () => {
    const out = sanitizeLabel('x'.repeat(200));
    expect(Array.from(out)).toHaveLength(DEFAULT_LABEL_MAX);
    expect(out.endsWith('…')).toBe(true);
    expect(sanitizeLabel('abcdef', 4)).toBe('abc…');
  });

  it('does not cap with an infinite limit and tolerates non-strings', () => {
    expect(sanitizeLabel('y'.repeat(300), Infinity)).toHaveLength(300);
    expect(sanitizeLabel(undefined)).toBe('');
    expect(sanitizeLabel(42)).toBe('42');
  });
});
