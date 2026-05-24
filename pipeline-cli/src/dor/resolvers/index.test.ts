import { describe, expect, it } from 'vitest';
import { DEFAULT_RESOLVERS, extractReferences, resolveReference } from './index.js';
import type { Resolver } from '../types.js';

describe('extractReferences', () => {
  it('extracts markdown links and tags github URLs as github-issue', () => {
    const body =
      'See [issue 42](https://github.com/owner/repo/issues/42) and ' +
      '[docs](https://example.com/docs).';
    const refs = extractReferences(body);
    const map = new Map(refs.map((r) => [r.raw, r.kind]));
    expect(map.get('https://github.com/owner/repo/issues/42')).toBe('github-issue');
    expect(map.get('https://example.com/docs')).toBe('url');
  });

  it('extracts bare URLs', () => {
    const body = 'visit https://example.com/api/x for the API.';
    const refs = extractReferences(body);
    expect(refs.some((r) => r.raw === 'https://example.com/api/x' && r.kind === 'url')).toBe(true);
  });

  it('strips trailing punctuation from bare URLs', () => {
    const refs = extractReferences('See https://example.com/a, then https://example.com/b.');
    const raws = refs.map((r) => r.raw);
    expect(raws).toContain('https://example.com/a');
    expect(raws).toContain('https://example.com/b');
  });

  it('extracts gh issue refs (#NN, gh#NN, owner/repo#NN)', () => {
    const body = 'fixes #42 and gh#43 and ai-sdlc-framework/ai-sdlc#44';
    const refs = extractReferences(body);
    const raws = refs.map((r) => r.raw);
    expect(raws).toContain('#42');
    expect(raws).toContain('gh#43');
    expect(raws).toContain('ai-sdlc-framework/ai-sdlc#44');
  });

  it('extracts RFC and AISDLC IDs', () => {
    const refs = extractReferences('depends on RFC-0011 and AISDLC-115.1');
    const raws = refs.map((r) => r.raw);
    expect(raws).toContain('RFC-0011');
    expect(raws).toContain('AISDLC-115.1');
  });

  it('does NOT extract backtick-quoted file paths from body prose (narrowed 2026-05-23)', () => {
    // Body-prose backtick paths often appear as hypothetical examples in AC
    // descriptions (e.g. "a changed file at `pkg/bin/cli-foo.mjs`"). The old
    // extractor flagged these as references that must resolve, dumbing down
    // task wording. Narrowed: file references go in frontmatter `references:`
    // or markdown links. See header comment on extractReferences.
    const refs = extractReferences(
      'change `pipeline-cli/src/foo.ts` and `spec/schemas/x.json` and a hypothetical `pkg/bin/cli-foo.mjs`',
    );
    const raws = refs.map((r) => r.raw);
    expect(raws).not.toContain('pipeline-cli/src/foo.ts');
    expect(raws).not.toContain('spec/schemas/x.json');
    expect(raws).not.toContain('pkg/bin/cli-foo.mjs');
  });

  it('still extracts file refs from markdown links (intentional reference shape)', () => {
    const refs = extractReferences(
      'see [the helper](pipeline-cli/src/foo.ts) and [the schema](spec/schemas/x.json)',
    );
    const raws = refs.map((r) => r.raw);
    expect(raws).toContain('pipeline-cli/src/foo.ts');
    expect(raws).toContain('spec/schemas/x.json');
  });

  it('dedupes', () => {
    const refs = extractReferences('see #42 and again #42');
    expect(refs.filter((r) => r.raw === '#42').length).toBe(1);
  });

  it('returns empty array for plain text', () => {
    expect(extractReferences('the sky is blue.')).toEqual([]);
  });
});

describe('resolveReference', () => {
  const fakeOk: Resolver = {
    name: 'file-existence',
    supports: () => true,
    resolve: async (ref) => ({ ref, resolved: true }),
  };
  const fakeFail: Resolver = {
    name: 'file-existence',
    supports: () => true,
    resolve: async (ref) => ({ ref, resolved: false, reason: 'nope' }),
  };

  it('dispatches to first matching resolver', async () => {
    const res = await resolveReference(
      { raw: 'foo', kind: 'file-existence' },
      { workDir: '/tmp' },
      [fakeOk],
    );
    expect(res.resolved).toBe(true);
  });

  it('returns no-resolver result when nothing matches', async () => {
    const noMatch: Resolver = {
      name: 'file-existence',
      supports: () => false,
      resolve: async (ref) => ({ ref, resolved: true }),
    };
    const res = await resolveReference({ raw: 'foo', kind: 'unknown' }, { workDir: '/tmp' }, [
      noMatch,
    ]);
    expect(res.resolved).toBe(false);
    expect(res.reason).toMatch(/no resolver/);
  });

  it('catches resolver throws and returns failure', async () => {
    const thrower: Resolver = {
      name: 'file-existence',
      supports: () => true,
      resolve: async () => {
        throw new Error('boom');
      },
    };
    const res = await resolveReference(
      { raw: 'foo', kind: 'file-existence' },
      { workDir: '/tmp' },
      [thrower],
    );
    expect(res.resolved).toBe(false);
    expect(res.reason).toMatch(/threw: boom/);
  });

  it('passes through fail reason from resolver', async () => {
    const res = await resolveReference(
      { raw: 'foo', kind: 'file-existence' },
      { workDir: '/tmp' },
      [fakeFail],
    );
    expect(res.resolved).toBe(false);
    expect(res.reason).toBe('nope');
  });

  it('default registry has 3 resolvers', () => {
    expect(DEFAULT_RESOLVERS.map((r) => r.name)).toEqual(['github-issue', 'file-existence', 'url']);
  });
});
