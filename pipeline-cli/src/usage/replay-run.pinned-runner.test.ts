import { describe, expect, it } from 'vitest';
import { pinnedRunner } from './replay-run.js';
import type { Runner } from '../runtime/exec.js';

describe('pinnedRunner', () => {
  const seen: string[][] = [];
  const inner: Runner = async (_c, args) => {
    seen.push(args);
    return { stdout: '', stderr: '', code: 0 };
  };

  it('keeps leading -c settings (quotePath) and --text, pins the base, adds the hardening flags', async () => {
    seen.length = 0;
    await pinnedRunner(inner, 'abc123')('git', [
      '-c',
      'core.quotePath=false',
      'diff',
      '--text',
      'origin/main...HEAD',
    ]);
    expect(seen[0]).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--text',
      'abc123...HEAD',
    ]);
  });

  it('pins a plain diff and passes other commands through unchanged', async () => {
    seen.length = 0;
    await pinnedRunner(inner, 'abc123')('git', ['diff', 'origin/main...HEAD']);
    await pinnedRunner(inner, 'abc123')('git', ['log', '-1']);
    expect(seen[0]).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      'abc123...HEAD',
    ]);
    expect(seen[1]).toEqual(['log', '-1']);
  });
});
