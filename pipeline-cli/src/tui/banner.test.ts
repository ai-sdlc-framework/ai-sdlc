/**
 * Tests for the TUI startup banner (AISDLC-178.6 AC#4).
 *
 * Per OQ-8, the banner MUST disclose the telemetry path + the opt-out
 * env var. We assert on both the enabled and disabled phrasing so the
 * disclosure can't silently regress.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildBanner, printBanner } from './banner.js';
import { TUI_TELEMETRY_FLAG } from './analytics/feature-flag.js';

describe('buildBanner', () => {
  it('discloses the telemetry path when enabled (default)', () => {
    const banner = buildBanner({ artifactsDir: '/var/data', isEnabled: () => true });
    expect(banner).toContain('/var/data/_operator/interactions.jsonl');
    expect(banner).toContain('Self-observability events writing');
    expect(banner).toContain(TUI_TELEMETRY_FLAG);
    expect(banner).toContain('off');
  });

  it('confirms disablement when the operator opted OUT', () => {
    const banner = buildBanner({ artifactsDir: '/var/data', isEnabled: () => false });
    expect(banner).toContain('Self-observability disabled');
    expect(banner).toContain('No events written');
    expect(banner).toContain(TUI_TELEMETRY_FLAG);
  });
});

describe('printBanner', () => {
  it('writes the banner via the injected writer', () => {
    const writer = vi.fn();
    printBanner({ artifactsDir: '/tmp/x', isEnabled: () => true, writer });
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0][0]).toContain('/tmp/x/_operator/interactions.jsonl');
  });
});
