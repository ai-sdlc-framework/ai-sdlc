/**
 * Feature-flag tests for the autonomous orchestrator (RFC-0015).
 *
 * AISDLC-411 (2026-05-23): polarity flipped via operator override-path
 * promotion. Default is now ON; opt-out via the FALSY set (off/0/false/no).
 */

import { describe, expect, it } from 'vitest';
import {
  isOrchestratorEnabled,
  ORCHESTRATOR_FLAG,
  orchestratorDisabledMessage,
} from './feature-flag.js';

describe('orchestrator feature flag (post-AISDLC-411 default-ON)', () => {
  it('is ON when the flag is unset (default-ON post-promotion)', () => {
    expect(isOrchestratorEnabled({})).toBe(true);
  });

  it('is ON when the flag is empty string (treated as unset)', () => {
    expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: '' })).toBe(true);
  });

  it('is ON when the flag is `experimental` (canonical Phase 1 opt-in still honored)', () => {
    expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: 'experimental' })).toBe(true);
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE', 'ON', 'Experimental'])(
    'accepts truthy value %s case-insensitively (backward-compat)',
    (value) => {
      expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: value })).toBe(true);
    },
  );

  it.each(['0', 'false', 'no', 'off', 'OFF', 'FALSE', 'NO'])(
    'opts OUT to OFF when set to falsy value %s (case-insensitive)',
    (value) => {
      expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: value })).toBe(false);
    },
  );

  it.each(['maybe', 'enabled', '2', 'whatever'])(
    'treats unknown / random value %s as ON (fail-safe; only the FALSY set opts out)',
    (value) => {
      expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: value })).toBe(true);
    },
  );

  it('disabled message names the flag + the default-ON semantic', () => {
    const msg = orchestratorDisabledMessage();
    expect(msg).toContain(ORCHESTRATOR_FLAG);
    expect(msg).toContain('default-ON');
  });
});
