/**
 * tui-events-writer.ts unit tests — AISDLC-292 AC#5.
 *
 * Verifies that writeTuiCaptureFiled() appends a correctly-shaped
 * TuiCaptureFiled event and respects the telemetry feature flag.
 */

import { describe, expect, it, vi } from 'vitest';

import { writeTuiCaptureFiled } from './tui-events-writer.js';
import * as jsonlAppend from './jsonl-append.js';

describe('writeTuiCaptureFiled', () => {
  it('appends a TuiCaptureFiled record when telemetry is enabled', () => {
    const appendSpy = vi.spyOn(jsonlAppend, 'appendJsonlRecord').mockReturnValue(true);

    const now = new Date('2026-05-18T10:00:00Z');
    const result = writeTuiCaptureFiled('DEC-0042', {
      pane: 'decisions-pending',
      sessionId: 'sess-001',
      isEnabled: () => true,
      now: () => now,
      artifactsDir: '/tmp/test-artifacts',
    });

    expect(result).toBe(true);
    expect(appendSpy).toHaveBeenCalledOnce();

    const [, record] = appendSpy.mock.calls[0]!;
    expect(record.type).toBe('TuiCaptureFiled');
    expect(record.captureId).toBe('DEC-0042');
    expect(record.pane).toBe('decisions-pending');
    expect(record.sessionId).toBe('sess-001');
    expect(record.ts).toBe('2026-05-18T10:00:00.000Z');

    appendSpy.mockRestore();
  });

  it('omits optional fields when not supplied', () => {
    const appendSpy = vi.spyOn(jsonlAppend, 'appendJsonlRecord').mockReturnValue(true);

    writeTuiCaptureFiled('DEC-0001', { isEnabled: () => true });

    const [, record] = appendSpy.mock.calls[0]!;
    expect(record.sessionId).toBeUndefined();
    expect(record.pane).toBeUndefined();

    appendSpy.mockRestore();
  });

  it('returns false and does not call appendJsonlRecord when telemetry is off', () => {
    const appendSpy = vi.spyOn(jsonlAppend, 'appendJsonlRecord').mockReturnValue(true);

    const result = writeTuiCaptureFiled('DEC-0001', { isEnabled: () => false });

    expect(result).toBe(false);
    expect(appendSpy).not.toHaveBeenCalled();

    appendSpy.mockRestore();
  });

  it('returns false when appendJsonlRecord fails', () => {
    const appendSpy = vi.spyOn(jsonlAppend, 'appendJsonlRecord').mockReturnValue(false);

    const result = writeTuiCaptureFiled('DEC-0001', { isEnabled: () => true });

    expect(result).toBe(false);
    appendSpy.mockRestore();
  });
});
