import { describe, expect, it } from 'vitest';
import {
  DECISION_CATALOG_FLAG,
  decisionCatalogDisabledMessage,
  isDecisionCatalogEnabled,
} from './feature-flag.js';

describe('isDecisionCatalogEnabled (default-ON since AISDLC-392)', () => {
  it('returns true when the flag is unset (default-on)', () => {
    expect(isDecisionCatalogEnabled({})).toBe(true);
  });

  it('returns true for canonical "experimental" value (backwards-compat)', () => {
    expect(isDecisionCatalogEnabled({ [DECISION_CATALOG_FLAG]: 'experimental' })).toBe(true);
  });

  it('accepts other truthy spellings (case-insensitive, backwards-compat)', () => {
    for (const v of ['1', 'true', 'YES', 'On', 'EXPERIMENTAL']) {
      expect(isDecisionCatalogEnabled({ [DECISION_CATALOG_FLAG]: v })).toBe(true);
    }
  });

  it('returns false for explicit opt-out values', () => {
    for (const v of ['0', 'false', 'no', 'off', 'disabled', 'OFF', 'False']) {
      expect(isDecisionCatalogEnabled({ [DECISION_CATALOG_FLAG]: v })).toBe(false);
    }
  });

  it('returns true for empty string (treated as unset → default-on)', () => {
    expect(isDecisionCatalogEnabled({ [DECISION_CATALOG_FLAG]: '' })).toBe(true);
  });

  it('decisionCatalogDisabledMessage names the flag + describes opt-out', () => {
    const msg = decisionCatalogDisabledMessage();
    expect(msg).toContain(DECISION_CATALOG_FLAG);
    expect(msg).toMatch(/opt-out|AISDLC-392|default since/i);
  });
});
