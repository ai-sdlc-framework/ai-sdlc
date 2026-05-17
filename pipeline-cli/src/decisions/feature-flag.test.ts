import { describe, expect, it } from 'vitest';
import {
  DECISION_CATALOG_FLAG,
  decisionCatalogDisabledMessage,
  isDecisionCatalogEnabled,
} from './feature-flag.js';

describe('isDecisionCatalogEnabled', () => {
  it('returns false when the flag is unset', () => {
    expect(isDecisionCatalogEnabled({})).toBe(false);
  });

  it('returns true for canonical "experimental" value', () => {
    expect(isDecisionCatalogEnabled({ [DECISION_CATALOG_FLAG]: 'experimental' })).toBe(true);
  });

  it('accepts other truthy spellings (case-insensitive)', () => {
    for (const v of ['1', 'true', 'YES', 'On', 'EXPERIMENTAL']) {
      expect(isDecisionCatalogEnabled({ [DECISION_CATALOG_FLAG]: v })).toBe(true);
    }
  });

  it('returns false for non-truthy values', () => {
    for (const v of ['0', 'false', 'no', 'off', '']) {
      expect(isDecisionCatalogEnabled({ [DECISION_CATALOG_FLAG]: v })).toBe(false);
    }
  });

  it('decisionCatalogDisabledMessage names the flag', () => {
    expect(decisionCatalogDisabledMessage()).toContain(DECISION_CATALOG_FLAG);
  });
});
