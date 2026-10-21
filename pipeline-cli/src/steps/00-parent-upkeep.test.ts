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
