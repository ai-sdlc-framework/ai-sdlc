import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parentUpkeepMode } from './00-parent-upkeep.js';

describe('parentUpkeepMode (AISDLC-981)', () => {
  it('runs inline standalone, asserts under a hierarchy session', () => {
    expect(parentUpkeepMode({})).toBe('inline');
    expect(parentUpkeepMode({ AI_SDLC_HIERARCHY_SESSION: 'alpha' })).toBe('assert');
  });
  it('the flag overrides either way', () => {
    expect(
      parentUpkeepMode({ AI_SDLC_HIERARCHY_SESSION: 'a', AI_SDLC_PARENT_UPKEEP: 'inline' }),
    ).toBe('inline');
    expect(parentUpkeepMode({ AI_SDLC_PARENT_UPKEEP: 'assert' })).toBe('assert');
  });
});

describe('usage ledger is ignored (AISDLC-1166)', () => {
  it('developer-honesty.jsonl is git-ignored so Step 0.5 never sees it as untracked', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const out = execFileSync('git', ['check-ignore', '.ai-sdlc/usage/developer-honesty.jsonl'], {
      cwd: root,
      encoding: 'utf-8',
    });
    expect(out.trim()).toBe('.ai-sdlc/usage/developer-honesty.jsonl');
  });
});
