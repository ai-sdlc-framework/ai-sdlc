import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateGate3 } from './gate-3-references.js';
import { fileExistenceResolver } from '../resolvers/file-existence.js';
import { cleanupTmpProject, makeTmpProject } from '../../__test-helpers/make-task.js';
import type { IssueInput, Resolver } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
  mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
  writeFileSync(join(tmp, 'spec', 'rfcs', 'RFC-0011-foo.md'), '');
});
afterEach(() => cleanupTmpProject(tmp));

function input(body: string, references?: string[]): IssueInput {
  return { source: 'backlog', id: 'AISDLC-1', title: 't', body, workDir: tmp, references };
}

describe('evaluateGate3 pending refs (AISDLC-879)', () => {
  it('passes with a pending note when the id is in another open filing PR', async () => {
    const v = await evaluateGate3(input('plain', ['AISDLC-777']), {
      resolvers: [fileExistenceResolver],
      pendingRefs: { 'aisdlc-777': 'open filing PR #42' },
    });
    expect(v.verdict).toBe('pass');
    expect(v.pending).toEqual([{ ref: 'AISDLC-777', where: 'open filing PR #42' }]);
    expect(v.finding).toMatch(/#42/);
  });

  it('still fails an id that matches nothing', async () => {
    const v = await evaluateGate3(input('plain', ['AISDLC-778']), {
      resolvers: [fileExistenceResolver],
      pendingRefs: { 'AISDLC-777': 'open filing PR #42' },
    });
    expect(v.verdict).toBe('fail');
  });
});

describe('evaluateGate3', () => {
  it('passes vacuously when no refs', async () => {
    const v = await evaluateGate3(input('plain text'));
    expect(v.verdict).toBe('pass');
    expect(v.confidence).toBe('medium');
  });

  it('passes when all refs resolve', async () => {
    const v = await evaluateGate3(input('See RFC-0011 for details.'), {
      resolvers: [fileExistenceResolver],
    });
    expect(v.verdict).toBe('pass');
    expect(v.confidence).toBe('high');
  });

  it('fails when an RFC ref does not resolve', async () => {
    const v = await evaluateGate3(input('See RFC-9999 for details.'), {
      resolvers: [fileExistenceResolver],
    });
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/RFC-9999/);
  });

  it('uses the explicit references list as well', async () => {
    const v = await evaluateGate3(input('plain', ['RFC-0011']), {
      resolvers: [fileExistenceResolver],
    });
    expect(v.verdict).toBe('pass');
  });

  it('aggregates multiple failures with sample cap at 5', async () => {
    const refs = Array.from({ length: 8 }, (_, i) => `RFC-99${i.toString().padStart(2, '0')}`);
    const v = await evaluateGate3(input(refs.join(' '), []), {
      resolvers: [fileExistenceResolver],
    });
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/8 reference\(s\)/);
  });

  it('catches resolver failures via injected resolver', async () => {
    const failer: Resolver = {
      name: 'file-existence',
      supports: () => true,
      resolve: async (ref) => ({ ref, resolved: false, reason: 'forced' }),
    };
    // Use a markdown link — body-prose backtick paths are no longer
    // extracted post-2026-05-23 narrowing (see extractReferences header).
    const v = await evaluateGate3(input('See [the helper](pipeline-cli/src/x.ts).'), {
      resolvers: [failer],
    });
    expect(v.verdict).toBe('fail');
    expect(v.finding).toMatch(/forced/);
  });
});

describe('evaluateGate3 deliverables (AISDLC-1148)', () => {
  it('passes a declared deliverable that does not exist, still fails other missing paths', async () => {
    const opts = { resolvers: [fileExistenceResolver] };
    const ok = await evaluateGate3(
      { ...input('plain', ['src/new-file.ts']), creates: ['./src/new-file.ts'] },
      opts,
    );
    expect(ok.verdict).toBe('pass');
    const bad = await evaluateGate3(
      { ...input('plain', ['src/new-file.ts', 'src/gone.ts']), creates: ['src/new-file.ts'] },
      opts,
    );
    expect(bad.verdict).toBe('fail');
    expect(bad.finding).toMatch(/gone\.ts/);
    expect(bad.finding).not.toMatch(/new-file/);
  });
});
