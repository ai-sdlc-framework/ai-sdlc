/**
 * YAML syntax highlight tests — RFC-0023 §9 / AISDLC-178.5 AC#5.
 */

import { describe, expect, it } from 'vitest';

import { highlightYaml, tokenizeYamlLine } from './highlight.js';

describe('tokenizeYamlLine', () => {
  it('tags `key: value` correctly', () => {
    const tokens = tokenizeYamlLine('foo: bar');
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toContain('key');
    expect(kinds).toContain('punct');
    expect(kinds).toContain('value');
  });

  it('recognises strings (double-quoted) as a string token', () => {
    const tokens = tokenizeYamlLine('foo: "hello world"');
    const string = tokens.find((t) => t.kind === 'string');
    expect(string?.text).toBe('"hello world"');
  });

  it('recognises numbers', () => {
    const tokens = tokenizeYamlLine('foo: 42');
    const num = tokens.find((t) => t.kind === 'number');
    expect(num?.text).toBe('42');
  });

  it('recognises trailing comments', () => {
    const tokens = tokenizeYamlLine('foo: bar  # an explanation');
    const comment = tokens.find((t) => t.kind === 'comment');
    expect(comment?.text).toContain('an explanation');
  });

  it('does not split a `#` inside a quoted string', () => {
    const tokens = tokenizeYamlLine('foo: "not # a comment"');
    expect(tokens.find((t) => t.kind === 'comment')).toBeUndefined();
  });

  it('handles full-line comments', () => {
    const tokens = tokenizeYamlLine('# whole-line comment');
    expect(tokens[tokens.length - 1].kind).toBe('comment');
  });

  it('handles list items (`- foo: bar`)', () => {
    const tokens = tokenizeYamlLine('  - name: example');
    const keys = tokens.filter((t) => t.kind === 'key');
    expect(keys.map((k) => k.text)).toContain('name');
  });

  it('recognises booleans/null as values', () => {
    const tokens = tokenizeYamlLine('foo: true');
    expect(tokens.find((t) => t.text === 'true')?.kind).toBe('value');
  });
});

describe('highlightYaml', () => {
  it('returns one HighlightedLine per input line', () => {
    const lines = highlightYaml('a: 1\nb: 2\nc: 3\n');
    expect(lines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4]);
  });

  it('preserves blank lines as empty token lists', () => {
    const lines = highlightYaml('a: 1\n\nb: 2\n');
    expect(lines[1].tokens).toHaveLength(0);
  });
});
