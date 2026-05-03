/**
 * Tests for the RFC-0014 Phase 5 operator override log.
 *
 * Hermetic — every test runs against a tmpdir-scoped override file. The
 * library is pure I/O over a JSONL line at `$ARTIFACTS_DIR/_deps/overrides.jsonl`,
 * so coverage focuses on:
 *   - append + read round-trip
 *   - the `isValidOverrideEntry` shape gate (forward-compat, malformed
 *     skip)
 *   - resolveOverrideLogPath fallbacks
 *   - the 10-entry ranking cap
 *   - tolerance for missing files / unreadable files
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendOverrideEntry,
  isValidOverrideEntry,
  loadOverrides,
  resolveOverrideLogPath,
  type OverrideEntry,
} from './override-log.js';

let tmp: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'deps-override-log-'));
  savedEnv = { ...process.env };
});

afterEach(() => {
  process.env = savedEnv;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('resolveOverrideLogPath', () => {
  it('honours filePath > artifactsDir > $ARTIFACTS_DIR > cwd', () => {
    expect(resolveOverrideLogPath({ filePath: '/abs/x.jsonl' })).toBe('/abs/x.jsonl');
    expect(resolveOverrideLogPath({ artifactsDir: '/a' })).toBe('/a/_deps/overrides.jsonl');
    process.env.ARTIFACTS_DIR = '/env';
    expect(resolveOverrideLogPath({})).toBe('/env/_deps/overrides.jsonl');
  });
});

describe('appendOverrideEntry + loadOverrides round-trip', () => {
  it('writes one JSONL line per entry; loadOverrides reads them back', () => {
    const filePath = join(tmp, 'overrides.jsonl');
    appendOverrideEntry(
      {
        snapshotPath: '/snap/1.jsonl',
        dispatcherTopId: 'AISDLC-A',
        operatorPickedId: 'AISDLC-B',
        ranking: [
          { id: 'AISDLC-A', position: 1 },
          { id: 'AISDLC-B', position: 2 },
        ],
        reason: 'B unblocks more',
      },
      { filePath, now: () => new Date('2026-05-02T10:00:00.000Z') },
    );
    appendOverrideEntry(
      {
        snapshotPath: '/snap/2.jsonl',
        dispatcherTopId: 'AISDLC-C',
        operatorPickedId: 'AISDLC-D',
        ranking: [{ id: 'AISDLC-C', position: 1 }],
      },
      { filePath, now: () => new Date('2026-05-02T11:00:00.000Z') },
    );

    const result = loadOverrides({ filePath });
    expect(result.skipped).toBe(0);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      schemaVersion: 1,
      ts: '2026-05-02T10:00:00.000Z',
      snapshotPath: '/snap/1.jsonl',
      dispatcherTopId: 'AISDLC-A',
      operatorPickedId: 'AISDLC-B',
      reason: 'B unblocks more',
    });
    expect(result.entries[0].ranking).toEqual([
      { id: 'AISDLC-A', position: 1 },
      { id: 'AISDLC-B', position: 2 },
    ]);
  });

  it('caps the ranking at 10 entries on write', () => {
    const filePath = join(tmp, 'overrides.jsonl');
    const longRanking = Array.from({ length: 25 }, (_, i) => ({
      id: `AISDLC-${i}`,
      position: i + 1,
    }));
    const written = appendOverrideEntry(
      {
        snapshotPath: '',
        dispatcherTopId: 'AISDLC-0',
        operatorPickedId: 'AISDLC-5',
        ranking: longRanking,
      },
      { filePath },
    );
    expect(written.ranking).toHaveLength(10);
    expect(written.ranking[0]?.id).toBe('AISDLC-0');
    expect(written.ranking[9]?.id).toBe('AISDLC-9');

    const result = loadOverrides({ filePath });
    expect(result.entries[0]?.ranking).toHaveLength(10);
  });

  it('appends to an existing file rather than overwriting', () => {
    const filePath = join(tmp, 'overrides.jsonl');
    for (let i = 0; i < 5; i++) {
      appendOverrideEntry(
        {
          snapshotPath: '',
          dispatcherTopId: 'AISDLC-X',
          operatorPickedId: `AISDLC-Y${i}`,
          ranking: [{ id: 'AISDLC-X', position: 1 }],
        },
        { filePath, now: () => new Date(`2026-05-02T10:0${i}:00.000Z`) },
      );
    }
    const raw = readFileSync(filePath, 'utf8');
    expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(5);
    expect(loadOverrides({ filePath }).entries).toHaveLength(5);
  });

  it('creates the parent directory on first write', () => {
    const filePath = join(tmp, 'nested', '_deps', 'overrides.jsonl');
    appendOverrideEntry(
      {
        snapshotPath: '',
        dispatcherTopId: '',
        operatorPickedId: 'AISDLC-Z',
        ranking: [{ id: 'AISDLC-Z', position: 1 }],
      },
      { filePath },
    );
    expect(loadOverrides({ filePath }).entries).toHaveLength(1);
  });

  it('preserves optional `reason` and `mode` only when present', () => {
    const filePath = join(tmp, 'overrides.jsonl');
    const noOpts = appendOverrideEntry(
      {
        snapshotPath: '',
        dispatcherTopId: 'AISDLC-A',
        operatorPickedId: 'AISDLC-B',
        ranking: [{ id: 'AISDLC-A', position: 1 }],
      },
      { filePath },
    );
    expect(noOpts.reason).toBeUndefined();
    expect(noOpts.mode).toBeUndefined();

    const withOpts = appendOverrideEntry(
      {
        snapshotPath: '',
        dispatcherTopId: 'AISDLC-A',
        operatorPickedId: 'AISDLC-B',
        ranking: [{ id: 'AISDLC-A', position: 1 }],
        reason: 'why not',
        mode: 'baseline',
      },
      { filePath },
    );
    expect(withOpts.reason).toBe('why not');
    expect(withOpts.mode).toBe('baseline');
  });
});

describe('loadOverrides — tolerance', () => {
  it('returns empty when the file is missing', () => {
    const r = loadOverrides({ filePath: join(tmp, 'never-existed.jsonl') });
    expect(r.entries).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('skips malformed JSON lines and counts them', () => {
    const filePath = join(tmp, 'overrides.jsonl');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          schemaVersion: 1,
          ts: '2026-05-02T10:00:00.000Z',
          snapshotPath: '',
          dispatcherTopId: 'AISDLC-A',
          operatorPickedId: 'AISDLC-B',
          ranking: [{ id: 'AISDLC-A', position: 1 }],
        }),
        '{ not json',
        '',
        JSON.stringify({ schemaVersion: 99, garbage: true }),
        JSON.stringify({
          schemaVersion: 1,
          ts: '2026-05-02T11:00:00.000Z',
          snapshotPath: '',
          dispatcherTopId: 'AISDLC-X',
          operatorPickedId: 'AISDLC-Y',
          ranking: [{ id: 'AISDLC-X', position: 1 }],
        }),
      ].join('\n'),
      'utf8',
    );
    const r = loadOverrides({ filePath });
    expect(r.entries).toHaveLength(2);
    expect(r.skipped).toBe(2); // bad JSON + bad schema; empty line is filtered before parse
  });
});

describe('isValidOverrideEntry', () => {
  it('accepts a well-formed entry', () => {
    const entry: OverrideEntry = {
      schemaVersion: 1,
      ts: '2026-05-02T10:00:00.000Z',
      snapshotPath: '/snap.jsonl',
      dispatcherTopId: 'AISDLC-A',
      operatorPickedId: 'AISDLC-B',
      ranking: [{ id: 'AISDLC-A', position: 1 }],
    };
    expect(isValidOverrideEntry(entry)).toBe(true);
  });

  it('rejects missing required fields', () => {
    expect(isValidOverrideEntry(null)).toBe(false);
    expect(isValidOverrideEntry({})).toBe(false);
    expect(isValidOverrideEntry({ schemaVersion: 1 })).toBe(false);
    expect(
      isValidOverrideEntry({
        schemaVersion: 1,
        ts: '...',
        snapshotPath: '',
        dispatcherTopId: '',
        operatorPickedId: '', // empty picked = invalid
        ranking: [],
      }),
    ).toBe(false);
  });

  it('rejects malformed ranking entries', () => {
    expect(
      isValidOverrideEntry({
        schemaVersion: 1,
        ts: '2026-05-02T10:00:00.000Z',
        snapshotPath: '',
        dispatcherTopId: '',
        operatorPickedId: 'AISDLC-A',
        ranking: [{ id: 'AISDLC-A' }],
      }),
    ).toBe(false);
    expect(
      isValidOverrideEntry({
        schemaVersion: 1,
        ts: '2026-05-02T10:00:00.000Z',
        snapshotPath: '',
        dispatcherTopId: '',
        operatorPickedId: 'AISDLC-A',
        ranking: 'nope',
      }),
    ).toBe(false);
  });

  it('rejects future schema versions (forward-incompatible)', () => {
    expect(
      isValidOverrideEntry({
        schemaVersion: 2,
        ts: '2026-05-02T10:00:00.000Z',
        snapshotPath: '',
        dispatcherTopId: '',
        operatorPickedId: 'AISDLC-A',
        ranking: [{ id: 'AISDLC-A', position: 1 }],
      }),
    ).toBe(false);
  });

  it('tolerates extra unknown fields', () => {
    expect(
      isValidOverrideEntry({
        schemaVersion: 1,
        ts: '2026-05-02T10:00:00.000Z',
        snapshotPath: '',
        dispatcherTopId: '',
        operatorPickedId: 'AISDLC-A',
        ranking: [{ id: 'AISDLC-A', position: 1 }],
        someFutureField: { nested: 'data' },
      }),
    ).toBe(true);
  });
});
