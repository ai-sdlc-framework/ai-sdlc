#!/usr/bin/env node
/**
 * docs-sync.test.mjs — node:test coverage for the conversion primitives.
 *
 * Run with: `node --test scripts/docs-sync.test.mjs`
 *
 * Why node:test and not vitest: this script lives at the workspace root and
 * has no package.json of its own. node:test is zero-config, ships with the
 * Node version we already require (>=22), and matches the convention used
 * by ai-sdlc-plugin/hooks/*.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertMarkdownToMdx,
  parseFrontmatter,
  extractFirstH1,
  rewriteMdLinks,
} from './docs-sync.mjs';

test('extractFirstH1 — picks first heading', () => {
  assert.equal(extractFirstH1('# Hello\n\nbody'), 'Hello');
});

test('extractFirstH1 — ignores headings inside fenced code blocks', () => {
  const body = '```bash\n# this is a comment\n```\n\n# Real Title\n';
  assert.equal(extractFirstH1(body), 'Real Title');
});

test('extractFirstH1 — returns null when no H1 present', () => {
  assert.equal(extractFirstH1('## Subheading only\n\nbody'), null);
});

test('parseFrontmatter — returns empty when absent', () => {
  const { frontmatter, body } = parseFrontmatter('# Title\n\nbody\n');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, '# Title\n\nbody\n');
});

test('parseFrontmatter — extracts title key with quotes', () => {
  const src = '---\ntitle: "Hello World"\n---\n# H1\n';
  const { frontmatter, body } = parseFrontmatter(src);
  assert.equal(frontmatter.title, 'Hello World');
  assert.equal(body, '# H1\n');
});

test('rewriteMdLinks — rewrites .md to .mdx in markdown links', () => {
  const input = 'See [intro](./intro.md) and [api](../api/runners.md#section).';
  const expected = 'See [intro](./intro.mdx) and [api](../api/runners.mdx#section).';
  assert.equal(rewriteMdLinks(input), expected);
});

test('rewriteMdLinks — leaves http(s) URLs alone', () => {
  const input = '[external](https://example.com/foo.md)';
  assert.equal(rewriteMdLinks(input), input);
});

test('rewriteMdLinks — leaves .md inside fenced code blocks alone', () => {
  const input = [
    'Before [link](./a.md)',
    '```text',
    'foo.md',
    'bar.md',
    '```',
    'After [link](./b.md)',
  ].join('\n');
  const expected = [
    'Before [link](./a.mdx)',
    '```text',
    'foo.md',
    'bar.md',
    '```',
    'After [link](./b.mdx)',
  ].join('\n');
  assert.equal(rewriteMdLinks(input), expected);
});

test('convertMarkdownToMdx — adds title frontmatter from H1', () => {
  const out = convertMarkdownToMdx('# My Page\n\nbody\n');
  assert.match(out, /^---\ntitle: "My Page"\n---\n/);
  assert.match(out, /\n# My Page\n/);
});

test('convertMarkdownToMdx — falls back to filename when no H1', () => {
  const out = convertMarkdownToMdx('No heading here.\n', { fallbackTitle: 'fallback-name' });
  assert.match(out, /^---\ntitle: "fallback-name"\n---\n/);
});

test('convertMarkdownToMdx — escapes double quotes in title', () => {
  const out = convertMarkdownToMdx('# Say "hi"\n');
  assert.match(out, /title: "Say \\"hi\\""/);
});

test('convertMarkdownToMdx — rewrites links in body', () => {
  const out = convertMarkdownToMdx('# Title\n\nSee [more](./other.md).\n');
  assert.match(out, /\[more\]\(\.\/other\.mdx\)/);
});
