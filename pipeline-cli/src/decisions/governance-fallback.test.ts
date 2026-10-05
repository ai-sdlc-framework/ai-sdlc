import { describe, expect, it } from 'vitest';
import {
  checkGovernanceFallback,
  deriveGovernanceChange,
  detectGovernanceSurfaces,
  fallbackWeakensControl,
} from './governance-fallback.js';

const OPTS = ['loosen', 'keep'];
const weak = { kind: 'weakening' as const, weakeningOptionIds: ['loosen'] };

describe('checkGovernanceFallback', () => {
  it('refuses a weakening decision with a weakening fallback, naming both ways forward', () => {
    const msg = checkGovernanceFallback(weak, OPTS, 'loosen');
    expect(msg).toMatch(/governance-fallback rule/);
    expect(msg).toMatch(/non-weakening option as the fallback/);
    expect(msg).toMatch(/no fallback so it stays open/);
  });

  it('accepts a weakening decision with a non-weakening fallback or no fallback', () => {
    expect(checkGovernanceFallback(weak, OPTS, 'keep')).toBeNull();
    expect(checkGovernanceFallback(weak, OPTS, undefined)).toBeNull();
  });

  it('leaves tightening and untagged decisions alone', () => {
    expect(checkGovernanceFallback(undefined, OPTS, 'loosen')).toBeNull();
    expect(
      checkGovernanceFallback({ kind: 'tightening', weakeningOptionIds: [] }, OPTS, 'loosen'),
    ).toBeNull();
  });

  it('rejects inconsistent tags', () => {
    expect(
      checkGovernanceFallback({ kind: 'weakening', weakeningOptionIds: [] }, OPTS, 'keep'),
    ).toMatch(/needs at least one --weakens/);
    expect(
      checkGovernanceFallback({ kind: 'tightening', weakeningOptionIds: ['loosen'] }, OPTS, 'keep'),
    ).toMatch(/only valid with/);
    expect(
      checkGovernanceFallback({ kind: 'weakening', weakeningOptionIds: ['nope'] }, OPTS, 'keep'),
    ).toMatch(/unknown: nope/);
  });
});

describe('fallbackWeakensControl', () => {
  it('is true only for a weakening option of a weakening decision', () => {
    expect(fallbackWeakensControl(weak, 'loosen')).toBe(true);
    expect(fallbackWeakensControl(weak, 'keep')).toBe(false);
    expect(fallbackWeakensControl(undefined, 'loosen')).toBe(false);
  });
});

describe('detectGovernanceSurfaces / deriveGovernanceChange', () => {
  it.each([
    ['ai-sdlc-plugin/hooks/x.js', 'plugin hooks'],
    ['governance resolver defaults', 'governance resolver and schema defaults'],
    ['.ai-sdlc/agent-role.yaml', 'agent-role config and templates'],
    ['the required checks list', 'required checks and rulesets'],
    ['.github/workflows/ci.yml', 'workflow gates'],
    ['CLAUDE.md', 'CLAUDE.md rule sections'],
    ['allowForcePush', 'merge and role restrictions'],
  ])('%s names %s', (text, surface) => {
    expect(detectGovernanceSurfaces(text)).toContain(surface);
  });

  it('finds nothing in ordinary text', () => {
    expect(detectGovernanceSurfaces('helper naming', undefined, 'pick a name')).toEqual([]);
  });

  it('returns the authored tag unchanged when nothing matches, and a derived tag otherwise', () => {
    expect(deriveGovernanceChange(undefined, [])).toBeUndefined();
    expect(deriveGovernanceChange(weak, [])).toBe(weak);
    expect(deriveGovernanceChange(undefined, ['workflow gates'])).toEqual({
      kind: 'weakening',
      weakeningOptionIds: [],
      derived: true,
      surfaces: ['workflow gates'],
    });
  });

  it('a derived tag with no declared option refuses a fallback and auto-expire never applies one', () => {
    const d = deriveGovernanceChange(undefined, ['workflow gates']);
    expect(checkGovernanceFallback(d, OPTS, 'keep')).toMatch(/tagged automatically/);
    expect(checkGovernanceFallback(d, OPTS, undefined)).toBeNull();
    expect(fallbackWeakensControl(d, 'keep')).toBe(true);
  });
});
