/**
 * Events writer tests (RFC-0015 Phase 4 / AISDLC-169.4).
 *
 * Covers:
 *   - Feature-flag gating (no writes when off).
 *   - Date-rotated file path (`events-YYYY-MM-DD.jsonl`).
 *   - Append-only semantics (multiple writes accumulate, never replace).
 *   - JSON shape (one event per line, JSON.stringify form).
 *   - Parent-dir auto-creation.
 *   - Best-effort write (errors swallowed, not thrown).
 *   - readRecentEvents: limit, multi-file, malformed-line skipping.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  eventsDirPath,
  eventsFilePath,
  ORCHESTRATOR_FLAG,
  readRecentEvents,
  writeEvent,
  type OrchestratorEvent,
} from './index.js';

let workdir: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'orchestrator-events-'));
  savedEnv = { ...process.env };
  process.env[ORCHESTRATOR_FLAG] = 'experimental';
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
  process.env = savedEnv;
});

describe('eventsFilePath', () => {
  it('rotates by UTC date', () => {
    const path = eventsFilePath('/tmp/x', new Date('2026-05-02T13:30:00Z'));
    expect(path).toBe('/tmp/x/_orchestrator/events-2026-05-02.jsonl');
  });

  it('zero-pads single-digit months + days', () => {
    const path = eventsFilePath('/tmp/x', new Date('2026-01-09T00:00:00Z'));
    expect(path).toBe('/tmp/x/_orchestrator/events-2026-01-09.jsonl');
  });

  it('uses UTC, not local time, around the day boundary', () => {
    // 23:30 UTC on May 1 = 00:30 May 2 in CET — UTC suffix wins.
    const path = eventsFilePath('/tmp/x', new Date('2026-05-01T23:30:00Z'));
    expect(path).toBe('/tmp/x/_orchestrator/events-2026-05-01.jsonl');
  });
});

describe('writeEvent — feature-flag gating', () => {
  it('no-ops when the flag is unset', () => {
    delete process.env[ORCHESTRATOR_FLAG];
    const ok = writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir },
    );
    expect(ok).toBe(false);
    expect(existsSync(eventsDirPath(workdir))).toBe(false);
  });

  it('no-ops when the flag value is not in the truthy set', () => {
    process.env[ORCHESTRATOR_FLAG] = 'maybe';
    const ok = writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir },
    );
    expect(ok).toBe(false);
  });

  it('writes when the flag is truthy', () => {
    process.env[ORCHESTRATOR_FLAG] = 'on';
    const ok = writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir, now: () => new Date('2026-05-02T00:00:00Z') },
    );
    expect(ok).toBe(true);
  });

  it('honors the isEnabled override (tests bypass without env mutation)', () => {
    delete process.env[ORCHESTRATOR_FLAG];
    const ok = writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir, isEnabled: () => true },
    );
    expect(ok).toBe(true);
  });
});

describe('writeEvent — file format + append semantics', () => {
  it('writes exactly one JSON line per call', () => {
    const event: OrchestratorEvent = {
      ts: '2026-05-02T00:00:00Z',
      type: 'OrchestratorDispatched',
      taskId: 'AISDLC-169.4',
      runId: 'abc-123',
      tick: 1,
    };
    writeEvent(event, {
      artifactsDir: workdir,
      now: () => new Date('2026-05-02T00:00:00Z'),
    });
    const path = eventsFilePath(workdir, new Date('2026-05-02T00:00:00Z'));
    const raw = readFileSync(path, 'utf8');
    expect(raw).toBe(JSON.stringify(event) + '\n');
  });

  it('appends multiple events without overwriting', () => {
    const date = new Date('2026-05-02T00:00:00Z');
    const a: OrchestratorEvent = { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' };
    const b: OrchestratorEvent = {
      ts: '2026-05-02T00:00:01Z',
      type: 'OrchestratorDispatched',
      taskId: 'X',
    };
    writeEvent(a, { artifactsDir: workdir, now: () => date });
    writeEvent(b, { artifactsDir: workdir, now: () => date });
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    expect(raw).toContain('"OrchestratorTick"');
    expect(raw).toContain('"OrchestratorDispatched"');
  });

  it('rotates per UTC day — events on different dates land in different files', () => {
    const day1 = new Date('2026-05-02T00:00:00Z');
    const day2 = new Date('2026-05-03T00:00:00Z');
    writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir, now: () => day1 },
    );
    writeEvent(
      { ts: '2026-05-03T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir, now: () => day2 },
    );
    expect(existsSync(eventsFilePath(workdir, day1))).toBe(true);
    expect(existsSync(eventsFilePath(workdir, day2))).toBe(true);
  });

  it('creates parent directories when missing', () => {
    const deep = join(workdir, 'nested', 'artifacts');
    expect(existsSync(deep)).toBe(false);
    writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: deep, now: () => new Date('2026-05-02T00:00:00Z') },
    );
    expect(existsSync(eventsFilePath(deep, new Date('2026-05-02T00:00:00Z')))).toBe(true);
  });

  it('stamps ts when caller omits it', () => {
    const date = new Date('2026-05-02T12:34:56Z');
    writeEvent({ type: 'OrchestratorTick' } as OrchestratorEvent, {
      artifactsDir: workdir,
      now: () => date,
    });
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.ts).toBe('2026-05-02T12:34:56.000Z');
  });

  it('preserves caller-supplied ts when present', () => {
    const date = new Date('2026-05-02T12:34:56Z');
    writeEvent(
      { ts: '2099-01-01T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir, now: () => date },
    );
    const raw = readFileSync(eventsFilePath(workdir, date), 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.ts).toBe('2099-01-01T00:00:00Z');
  });
});

describe('writeEvent — best-effort failure', () => {
  it('returns false + does not throw when the path resolves to a directory', () => {
    // Force a write failure by passing an artifactsDir that's actually a
    // file-not-a-directory at the leaf level. mkdirSync({recursive}) is
    // tolerant of existing dirs; we trigger appendFileSync EISDIR by
    // pre-creating a directory at the events file path.
    const date = new Date('2026-05-02T00:00:00Z');
    const path = eventsFilePath(workdir, date);
    // Pre-create the events file PATH as a directory — appendFileSync will EISDIR.
    mkdirSync(path, { recursive: true });
    const ok = writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir, now: () => date },
    );
    expect(ok).toBe(false);
  });
});

describe('readRecentEvents', () => {
  it('returns [] when the directory is missing', () => {
    expect(readRecentEvents({ artifactsDir: workdir })).toEqual([]);
  });

  it('returns events oldest→newest within the requested slice', () => {
    const date = new Date('2026-05-02T00:00:00Z');
    for (let i = 0; i < 3; i += 1) {
      writeEvent(
        {
          ts: `2026-05-02T00:00:0${i}Z`,
          type: 'OrchestratorTick',
          tick: i,
        } as OrchestratorEvent,
        { artifactsDir: workdir, now: () => date },
      );
    }
    const events = readRecentEvents({ artifactsDir: workdir, limit: 10 });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.tick)).toEqual([0, 1, 2]);
  });

  it('caps at the requested limit (newest events kept)', () => {
    const date = new Date('2026-05-02T00:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      writeEvent(
        {
          ts: `2026-05-02T00:00:0${i}Z`,
          type: 'OrchestratorTick',
          tick: i,
        } as OrchestratorEvent,
        { artifactsDir: workdir, now: () => date },
      );
    }
    const events = readRecentEvents({ artifactsDir: workdir, limit: 2 });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.tick)).toEqual([3, 4]);
  });

  it('walks multiple date-rotated files and returns chronological order', () => {
    const day1 = new Date('2026-05-01T00:00:00Z');
    const day2 = new Date('2026-05-02T00:00:00Z');
    writeEvent(
      { ts: '2026-05-01T00:00:00Z', type: 'OrchestratorTick', tick: 1 },
      { artifactsDir: workdir, now: () => day1 },
    );
    writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick', tick: 2 },
      { artifactsDir: workdir, now: () => day2 },
    );
    const events = readRecentEvents({ artifactsDir: workdir, limit: 10 });
    expect(events.map((e) => e.tick)).toEqual([1, 2]);
  });

  it('skips malformed JSON lines silently', () => {
    const date = new Date('2026-05-02T00:00:00Z');
    const path = eventsFilePath(workdir, date);
    mkdirSync(eventsDirPath(workdir), { recursive: true });
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' }),
        'not-json-at-all',
        JSON.stringify({ ts: '2026-05-02T00:00:01Z', type: 'OrchestratorDispatched', taskId: 'X' }),
        '',
      ].join('\n'),
    );
    const events = readRecentEvents({ artifactsDir: workdir, limit: 10 });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(['OrchestratorTick', 'OrchestratorDispatched']);
  });

  it('returns [] when limit is 0', () => {
    writeEvent(
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' },
      { artifactsDir: workdir, now: () => new Date('2026-05-02T00:00:00Z') },
    );
    expect(readRecentEvents({ artifactsDir: workdir, limit: 0 })).toEqual([]);
  });
});
