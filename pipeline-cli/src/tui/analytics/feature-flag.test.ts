/**
 * Tests for the AI_SDLC_TUI_TELEMETRY opt-OUT predicate
 * (RFC-0023 §10 / OQ-8 / AC#3 / AISDLC-178.6).
 */

import { describe, expect, it } from 'vitest';

import { isTelemetryEnabled, TUI_TELEMETRY_FLAG } from './feature-flag.js';

describe('isTelemetryEnabled', () => {
  it('defaults ON when env var is unset', () => {
    expect(isTelemetryEnabled({})).toBe(true);
  });

  it('disables on canonical opt-out values', () => {
    for (const v of ['off', 'OFF', 'Off', '0', 'false', 'no']) {
      expect(isTelemetryEnabled({ [TUI_TELEMETRY_FLAG]: v })).toBe(false);
    }
  });

  it('stays ON for unrelated values', () => {
    for (const v of ['on', '1', 'true', 'yes', 'whatever']) {
      expect(isTelemetryEnabled({ [TUI_TELEMETRY_FLAG]: v })).toBe(true);
    }
  });

  it('treats whitespace + mixed case as the canonical value', () => {
    expect(isTelemetryEnabled({ [TUI_TELEMETRY_FLAG]: '  Off  ' })).toBe(false);
  });
});
