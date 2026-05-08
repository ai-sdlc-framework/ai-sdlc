/**
 * Tests for the `_tui/events.jsonl` self-observability writer
 * (RFC-0023 §12 / AISDLC-178.7).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { selfEventsPath, writeSelfEvent, writeTuiCrashed, writeTuiStarted } from './self-events.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'tui-self-events-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function readLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('selfEventsPath', () => {
  it('joins artifactsDir with _tui/events.jsonl', () => {
    expect(selfEventsPath('/abs/artifacts')).toBe('/abs/artifacts/_tui/events.jsonl');
  });
});

describe('writeSelfEvent', () => {
  it('appends one stamped record per call when telemetry is enabled', () => {
    const path = selfEventsPath(tmp);
    expect(
      writeSelfEvent({ type: 'TuiStarted' }, { artifactsDir: tmp, isEnabled: () => true }),
    ).toBe(true);
    expect(
      writeSelfEvent({ type: 'TuiCrashed' }, { artifactsDir: tmp, isEnabled: () => true }),
    ).toBe(true);
    const lines = readLines(path);
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe('TuiStarted');
    expect(lines[1].type).toBe('TuiCrashed');
    expect(typeof lines[0].ts).toBe('string');
    expect((lines[0].ts as string).length).toBeGreaterThan(0);
  });

  it('honours caller-supplied ts (no double-stamp)', () => {
    const ts = '2026-05-07T16:42:00.000Z';
    writeSelfEvent({ type: 'TuiStarted', ts }, { artifactsDir: tmp, isEnabled: () => true });
    const lines = readLines(selfEventsPath(tmp));
    expect(lines[0].ts).toBe(ts);
  });

  it('returns false + writes nothing when telemetry is disabled', () => {
    const ok = writeSelfEvent(
      { type: 'TuiStarted' },
      { artifactsDir: tmp, isEnabled: () => false },
    );
    expect(ok).toBe(false);
    expect(existsSync(selfEventsPath(tmp))).toBe(false);
  });

  it('preserves additional payload fields verbatim', () => {
    writeSelfEvent(
      { type: 'TuiDataSourceFailed', source: 'gh-pr-cache', errorKind: 'source-unavailable' },
      { artifactsDir: tmp, isEnabled: () => true },
    );
    const lines = readLines(selfEventsPath(tmp));
    expect(lines[0]).toMatchObject({
      type: 'TuiDataSourceFailed',
      source: 'gh-pr-cache',
      errorKind: 'source-unavailable',
    });
  });
});

describe('writeTuiStarted', () => {
  it('records version + terminal dimensions', () => {
    writeTuiStarted(
      { version: '0.1.0', termCols: 120, termRows: 40 },
      { artifactsDir: tmp, isEnabled: () => true },
    );
    const lines = readLines(selfEventsPath(tmp));
    expect(lines[0]).toMatchObject({
      type: 'TuiStarted',
      version: '0.1.0',
      termCols: 120,
      termRows: 40,
    });
  });

  it('falls back to process.stdout dims when caller omits them', () => {
    writeTuiStarted({ version: '0.1.0' }, { artifactsDir: tmp, isEnabled: () => true });
    const lines = readLines(selfEventsPath(tmp));
    expect(lines[0].type).toBe('TuiStarted');
    // termCols/termRows may be undefined (non-tty); we just assert the
    // record landed without throwing.
  });
});

describe('writeTuiCrashed', () => {
  it('normalises an Error into errorMessage + stack', () => {
    const err = new Error('boom');
    writeTuiCrashed(err, { artifactsDir: tmp, isEnabled: () => true });
    const lines = readLines(selfEventsPath(tmp));
    expect(lines[0]).toMatchObject({ type: 'TuiCrashed', errorMessage: 'boom' });
    expect(typeof lines[0].stack).toBe('string');
  });

  it('normalises a non-Error throw into errorMessage', () => {
    writeTuiCrashed('arbitrary string crash', { artifactsDir: tmp, isEnabled: () => true });
    const lines = readLines(selfEventsPath(tmp));
    expect(lines[0]).toMatchObject({
      type: 'TuiCrashed',
      errorMessage: 'arbitrary string crash',
    });
    expect(lines[0].stack).toBeUndefined();
  });

  it('respects the telemetry kill switch', () => {
    expect(writeTuiCrashed(new Error('x'), { artifactsDir: tmp, isEnabled: () => false })).toBe(
      false,
    );
    expect(existsSync(selfEventsPath(tmp))).toBe(false);
  });
});
