/**
 * Feature-flag tests — RFC-0016 Phase 1 (AISDLC-279).
 *
 * Mirrors the orchestrator feature-flag test shape so the two
 * subsystems stay in lock-step on their opt-in semantics. Verifies:
 *  - off by default (unset, empty)
 *  - canonical `experimental` value enables
 *  - other truthy values accepted case-insensitively (graceful for
 *    operators who reach for `1` / `true` etc.)
 *  - non-canonical values rejected (a typo can't accidentally enable)
 *  - disabled message surfaces both the flag name AND the opt-in
 *    value so a fresh operator can copy-paste the fix.
 */

import { describe, expect, it } from 'vitest';
import { ESTIMATION_FLAG, estimationDisabledMessage, isEstimationEnabled } from './feature-flag.js';

describe('estimation feature flag', () => {
  it('is OFF when the flag is unset', () => {
    expect(isEstimationEnabled({})).toBe(false);
  });

  it('is OFF when the flag is empty string', () => {
    expect(isEstimationEnabled({ [ESTIMATION_FLAG]: '' })).toBe(false);
  });

  it('is ON when the flag is `experimental` (canonical Phase 1 opt-in)', () => {
    expect(isEstimationEnabled({ [ESTIMATION_FLAG]: 'experimental' })).toBe(true);
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE', 'ON', 'Experimental', '  experimental  '])(
    'accepts truthy value %s case-insensitively (and trims whitespace)',
    (value) => {
      expect(isEstimationEnabled({ [ESTIMATION_FLAG]: value })).toBe(true);
    },
  );

  it.each(['0', 'false', 'no', 'off', 'maybe', 'enabled', 'experimntal'])(
    'rejects non-canonical value %s',
    (value) => {
      expect(isEstimationEnabled({ [ESTIMATION_FLAG]: value })).toBe(false);
    },
  );

  it('disabled message names the flag + the experimental opt-in value', () => {
    const msg = estimationDisabledMessage();
    expect(msg).toContain(ESTIMATION_FLAG);
    expect(msg).toContain('experimental');
  });
});
