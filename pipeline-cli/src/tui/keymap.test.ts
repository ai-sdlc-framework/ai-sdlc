/**
 * Keymap unit tests — RFC-0023 §7.6 / AISDLC-178.5 AC#3.
 *
 * The keymap is the single source of truth for footer + help. These tests
 * lock down (a) the exact 9 keys that ship with Phase 5, (b) the mapping
 * from key → mode, (c) the mode-key predicate.
 */

import { describe, expect, it } from 'vitest';

import { KEYMAP, isModeKey, modeForKey } from './keymap.js';

describe('KEYMAP', () => {
  it('contains exactly 9 entries (b/p/d/c/a/// r/?/q)', () => {
    expect(KEYMAP.map((b) => b.key)).toEqual(['b', 'p', 'd', 'c', 'a', '/', 'r', '?', 'q']);
  });

  it('every binding has a non-empty footerLabel and description', () => {
    for (const b of KEYMAP) {
      expect(b.footerLabel.length).toBeGreaterThan(0);
      expect(b.description.length).toBeGreaterThan(0);
    }
  });

  it('mode-switch keys (b/p/d/c/a/?) carry a mode; others do not', () => {
    const modeKeys = KEYMAP.filter((b) => b.mode !== null).map((b) => b.key);
    expect(modeKeys.sort()).toEqual(['?', 'a', 'b', 'c', 'd', 'p'].sort());
  });
});

describe('modeForKey', () => {
  it('returns the matching mode for known mode keys', () => {
    expect(modeForKey('b')).toBe('blockers');
    expect(modeForKey('p')).toBe('prs');
    expect(modeForKey('d')).toBe('deps');
    expect(modeForKey('c')).toBe('config');
    expect(modeForKey('a')).toBe('analytics');
    expect(modeForKey('?')).toBe('help');
  });

  it('returns null for non-mode keys', () => {
    expect(modeForKey('/')).toBeNull();
    expect(modeForKey('r')).toBeNull();
    expect(modeForKey('q')).toBeNull();
    expect(modeForKey('z')).toBeNull();
    expect(modeForKey('')).toBeNull();
  });
});

describe('isModeKey', () => {
  it('recognises every binding with a mode', () => {
    for (const k of ['b', 'p', 'd', 'c', 'a', '?']) {
      expect(isModeKey(k)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const k of ['/', 'r', 'q', 'x', '', 'B']) {
      expect(isModeKey(k)).toBe(false);
    }
  });
});
