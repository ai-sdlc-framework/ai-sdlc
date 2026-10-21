import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STALL_GRACE_MS,
  DEFAULT_STALL_STALE_MS,
  findOpenPrNumber,
  endsWithQuestion,
  stallResumeNote,
  stallThresholdsFromEnv,
} from './stall.js';
import type { CommandRunner } from './types.js';

describe('stallThresholdsFromEnv', () => {
  it('defaults to 30 and 10 minutes', () => {
    expect(stallThresholdsFromEnv({})).toEqual({
      staleMs: DEFAULT_STALL_STALE_MS,
      graceMs: DEFAULT_STALL_GRACE_MS,
    });
    expect(DEFAULT_STALL_STALE_MS).toBe(30 * 60_000);
    expect(DEFAULT_STALL_GRACE_MS).toBe(10 * 60_000);
  });
  it('uses the supplied defaults when the environment is empty', () => {
    expect(stallThresholdsFromEnv({}, { staleMs: 7, graceMs: 3 })).toEqual({
      staleMs: 7,
      graceMs: 3,
    });
  });
  it('reads positive numbers and ignores junk', () => {
    expect(
      stallThresholdsFromEnv({
        AI_SDLC_DISPATCH_STALE_MS: '1000',
        AI_SDLC_DISPATCH_STALL_GRACE_MS: 'abc',
      }),
    ).toEqual({ staleMs: 1000, graceMs: DEFAULT_STALL_GRACE_MS });
  });
});

describe('stallResumeNote', () => {
  it('names the step and the pull request', () => {
    expect(stallResumeNote('ship', 9)).toContain('step ship');
    expect(stallResumeNote('ship', 9)).toContain('#9');
    expect(stallResumeNote('ship')).toContain('No pull request');
  });
});

describe('findOpenPrNumber', () => {
  const run =
    (status: number, stdout: string): CommandRunner =>
    () => ({
      status,
      stdout,
      stderr: '',
    });
  const list = JSON.stringify([
    { number: 1, headRefName: 'ai-sdlc/aisdlc-9-other' },
    { number: 2, headRefName: 'ai-sdlc/aisdlc-8-slug' },
  ]);
  it('finds the task branch', () => {
    expect(findOpenPrNumber(run(0, list), '/r', 'AISDLC-8')).toBe(2);
    expect(findOpenPrNumber(run(0, list), '/r', 'AISDLC-7')).toBeUndefined();
  });
  it('is undefined when gh fails or prints junk', () => {
    expect(findOpenPrNumber(run(1, ''), '/r', 'AISDLC-8')).toBeUndefined();
    expect(findOpenPrNumber(run(0, 'nope'), '/r', 'AISDLC-8')).toBeUndefined();
  });
});

describe('endsWithQuestion', () => {
  it('is true when the last real line is a question, ignoring chrome', () => {
    expect(endsWithQuestion('done\nShall I push or release?\n╭────╮\n│ > │\n╰────╯\n')).toBe(true);
  });
  it('is false for a statement or empty output', () => {
    expect(endsWithQuestion('Pushed the branch.\n❯ \n')).toBe(false);
    expect(endsWithQuestion('')).toBe(false);
  });
});
