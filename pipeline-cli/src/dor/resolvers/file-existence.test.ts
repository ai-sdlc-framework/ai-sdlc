import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileExistenceResolver } from './file-existence.js';
import { cleanupTmpProject, makeTmpProject } from '../../__test-helpers/make-task.js';
import type { Reference } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
  mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
  writeFileSync(join(tmp, 'spec', 'rfcs', 'RFC-0011-foo.md'), 'rfc body');
  mkdirSync(join(tmp, 'pipeline-cli', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'pipeline-cli', 'src', 'index.ts'), 'export {};');
  writeFileSync(join(tmp, 'backlog', 'tasks', 'aisdlc-115.2 - foo.md'), 'task');
  writeFileSync(join(tmp, 'backlog', 'completed', 'aisdlc-100 - bar.md'), 'task');
});
afterEach(() => cleanupTmpProject(tmp));

describe('fileExistenceResolver.supports', () => {
  it('matches RFC-NNNN', () => {
    expect(fileExistenceResolver.supports({ raw: 'RFC-0011', kind: 'unknown' })).toBe(true);
  });
  it('matches AISDLC-NN', () => {
    expect(fileExistenceResolver.supports({ raw: 'AISDLC-115.2', kind: 'unknown' })).toBe(true);
  });
  it('matches relative repo paths', () => {
    expect(
      fileExistenceResolver.supports({
        raw: 'pipeline-cli/src/index.ts',
        kind: 'unknown',
      }),
    ).toBe(true);
  });
  it('rejects URLs and absolute paths', () => {
    expect(fileExistenceResolver.supports({ raw: 'https://x.com', kind: 'url' })).toBe(false);
    expect(fileExistenceResolver.supports({ raw: '/etc/passwd', kind: 'unknown' })).toBe(false);
    expect(fileExistenceResolver.supports({ raw: 'file://foo', kind: 'unknown' })).toBe(false);
  });
  it('rejects github-issue and url kinds explicitly', () => {
    expect(fileExistenceResolver.supports({ raw: 'foo', kind: 'github-issue' })).toBe(false);
    expect(fileExistenceResolver.supports({ raw: 'foo', kind: 'url' })).toBe(false);
  });
});

describe('fileExistenceResolver.resolve', () => {
  it('resolves RFC-0011 against spec/rfcs', async () => {
    const res = await fileExistenceResolver.resolve(
      { raw: 'RFC-0011', kind: 'file-existence' },
      { workDir: tmp },
    );
    expect(res.resolved).toBe(true);
  });
  it('reports missing RFC', async () => {
    const res = await fileExistenceResolver.resolve(
      { raw: 'RFC-9999', kind: 'file-existence' },
      { workDir: tmp },
    );
    expect(res.resolved).toBe(false);
    expect(res.reason).toMatch(/RFC-9999/);
  });
  it('reports missing spec/rfcs dir', async () => {
    const otherTmp = makeTmpProject();
    try {
      const res = await fileExistenceResolver.resolve(
        { raw: 'RFC-0011', kind: 'file-existence' },
        { workDir: otherTmp },
      );
      expect(res.resolved).toBe(false);
      expect(res.reason).toMatch(/no spec\/rfcs/);
    } finally {
      cleanupTmpProject(otherTmp);
    }
  });
  it('resolves AISDLC ID in tasks/', async () => {
    const res = await fileExistenceResolver.resolve(
      { raw: 'AISDLC-115.2', kind: 'file-existence' },
      { workDir: tmp },
    );
    expect(res.resolved).toBe(true);
  });
  it('resolves AISDLC ID in completed/', async () => {
    const res = await fileExistenceResolver.resolve(
      { raw: 'AISDLC-100', kind: 'file-existence' },
      { workDir: tmp },
    );
    expect(res.resolved).toBe(true);
  });
  it('reports missing AISDLC ID', async () => {
    const res = await fileExistenceResolver.resolve(
      { raw: 'AISDLC-9999', kind: 'file-existence' },
      { workDir: tmp },
    );
    expect(res.resolved).toBe(false);
  });
  it('resolves bare repo path', async () => {
    const res = await fileExistenceResolver.resolve(
      { raw: 'pipeline-cli/src/index.ts', kind: 'file-existence' },
      { workDir: tmp },
    );
    expect(res.resolved).toBe(true);
  });
  it('reports missing bare path', async () => {
    const res = await fileExistenceResolver.resolve(
      { raw: 'pipeline-cli/src/missing.ts', kind: 'file-existence' },
      { workDir: tmp },
    );
    expect(res.resolved).toBe(false);
  });
});

describe('fileExistenceResolver.supports — bare-path heuristic', () => {
  it('matches words with slashes only when extension-shaped', () => {
    const ref: Reference = { raw: 'foo/bar/baz.ts', kind: 'unknown' };
    expect(fileExistenceResolver.supports(ref)).toBe(true);
  });
  it('does not match hashtag-only strings', () => {
    expect(fileExistenceResolver.supports({ raw: '#42', kind: 'unknown' })).toBe(false);
  });
});
