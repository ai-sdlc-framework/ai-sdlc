import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { attestationGrowth, formatAttestationGrowth } from './attestation-growth.js';
import type { CommandRunner } from './types.js';

function repo(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'growth-'));
  mkdirSync(path.join(d, '.ai-sdlc/attestations'), { recursive: true });
  mkdirSync(path.join(d, '.ai-sdlc/transcript-leaves/sub'), { recursive: true });
  writeFileSync(path.join(d, '.ai-sdlc/attestations/a.json'), 'abcd');
  writeFileSync(path.join(d, '.ai-sdlc/transcript-leaves/sub/b.jsonl'), 'xy');
  return d;
}

describe('attestationGrowth', () => {
  it('counts files and bytes and the weekly additions', () => {
    const run = (() => ({
      status: 0,
      stdout: 'a\nb\nb\n',
      stderr: '',
    })) as unknown as CommandRunner;
    const g = attestationGrowth(repo(), run);
    expect(g).toEqual({ files: 2, bytes: 6, addedLastWeek: 2 });
    expect(formatAttestationGrowth(g)).toContain('2 (0.0 MB), added last 7 days: 2');
  });

  it('omits the weekly figure when git fails or throws', () => {
    const bad = (() => ({ status: 1, stdout: '', stderr: '' })) as unknown as CommandRunner;
    expect(attestationGrowth(repo(), bad).addedLastWeek).toBeUndefined();
    const boom = (() => {
      throw new Error('no git');
    }) as unknown as CommandRunner;
    const g = attestationGrowth(repo(), boom);
    expect(g.addedLastWeek).toBeUndefined();
    expect(formatAttestationGrowth(g)).toContain('unknown');
  });

  it('tolerates missing directories', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'growth-'));
    const run = (() => undefined) as unknown as CommandRunner;
    expect(attestationGrowth(d, run)).toEqual({ files: 0, bytes: 0 });
  });
});
