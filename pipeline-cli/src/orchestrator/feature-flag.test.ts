/**
 * Feature-flag tests for the autonomous orchestrator (RFC-0015 Phase 1).
 */

import { describe, expect, it } from 'vitest';
import {
  isOrchestratorEnabled,
  ORCHESTRATOR_FLAG,
  orchestratorDisabledMessage,
} from './feature-flag.js';

describe('orchestrator feature flag', () => {
  it('is OFF when the flag is unset', () => {
    expect(isOrchestratorEnabled({})).toBe(false);
  });

  it('is OFF when the flag is empty string', () => {
    expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: '' })).toBe(false);
  });

  it('is ON when the flag is `experimental` (canonical Phase 1 opt-in)', () => {
    expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: 'experimental' })).toBe(true);
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE', 'ON', 'Experimental'])(
    'accepts truthy value %s case-insensitively',
    (value) => {
      expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: value })).toBe(true);
    },
  );

  it.each(['0', 'false', 'no', 'off', 'maybe', 'enabled'])(
    'rejects non-canonical value %s',
    (value) => {
      expect(isOrchestratorEnabled({ [ORCHESTRATOR_FLAG]: value })).toBe(false);
    },
  );

  it('disabled message names the flag + the experimental opt-in value', () => {
    const msg = orchestratorDisabledMessage();
    expect(msg).toContain(ORCHESTRATOR_FLAG);
    expect(msg).toContain('experimental');
  });
});
