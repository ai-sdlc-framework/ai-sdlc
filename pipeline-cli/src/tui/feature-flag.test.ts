/**
 * Feature-flag tests for the operator TUI (RFC-0023 Phase 1 / AISDLC-178.1).
 *
 * Mirrors the conventions of `pipeline-cli/src/orchestrator/feature-flag.test.ts`
 * (RFC-0015) — same truthy set, same case-insensitive handling.
 */

import { describe, expect, it } from 'vitest';
import { isTuiEnabled, TUI_FLAG, tuiDisabledMessage } from './feature-flag.js';

describe('TUI feature flag', () => {
  it('is OFF when the flag is unset', () => {
    expect(isTuiEnabled({})).toBe(false);
  });

  it('is OFF when the flag is empty string', () => {
    expect(isTuiEnabled({ [TUI_FLAG]: '' })).toBe(false);
  });

  it('is ON when the flag is `experimental` (canonical Phase 1 opt-in)', () => {
    expect(isTuiEnabled({ [TUI_FLAG]: 'experimental' })).toBe(true);
  });

  it.each(['experimental', '1', 'true', 'yes', 'on'])(
    'accepts canonical truthy value %s',
    (value) => {
      expect(isTuiEnabled({ [TUI_FLAG]: value })).toBe(true);
    },
  );

  it.each(['EXPERIMENTAL', 'TRUE', 'Yes', 'ON', 'Experimental'])(
    'accepts truthy value %s case-insensitively',
    (value) => {
      expect(isTuiEnabled({ [TUI_FLAG]: value })).toBe(true);
    },
  );

  it.each(['off', 'false', '0', 'no', 'maybe', 'enabled', 'disabled', 'random'])(
    'rejects non-canonical value %s',
    (value) => {
      expect(isTuiEnabled({ [TUI_FLAG]: value })).toBe(false);
    },
  );

  it('trims surrounding whitespace before comparing', () => {
    expect(isTuiEnabled({ [TUI_FLAG]: '  experimental  ' })).toBe(true);
    expect(isTuiEnabled({ [TUI_FLAG]: '\ttrue\n' })).toBe(true);
  });

  it('disabled message names the flag + the experimental opt-in value', () => {
    const msg = tuiDisabledMessage();
    expect(msg).toContain(TUI_FLAG);
    expect(msg).toContain('experimental');
  });
});
