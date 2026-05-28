/**
 * Tests for the signal-ingestion governance event logger (AISDLC-348 / RFC-0030 §11).
 *
 * Covers:
 *  - `computeConfigDiff()`: deterministic, sorted, scalar + nested + array drift
 *  - `writeSignalIngestionConfigChangedEvent()`: appends to the date-rotated
 *    events file matching pipeline-cli's `eventsFilePath()` shape so the
 *    two writers stream into one observable file
 *  - `loadSignalIngestionConfigWithGovernance()`: end-to-end load + diff +
 *    emit; verifies `comparedAgainst` discrimination + `skipEventEmission`
 *    short-circuit + no-event-on-no-diff
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SIGNAL_INGESTION_CONFIG, type SignalIngestionConfig } from './config.js';
import {
  computeConfigDiff,
  eventsFilePath,
  loadSignalIngestionConfigWithGovernance,
  writeSignalIngestionConfigChangedEvent,
} from './governance-events.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(label: string): string {
  const dir = join(tmpdir(), `signal-gov-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readEventLines(artifactsDir: string, date: Date): string[] {
  const path = eventsFilePath(artifactsDir, date);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

// ── computeConfigDiff ───────────────────────────────────────────────────

describe('computeConfigDiff', () => {
  it('returns no changes when configs are identical', () => {
    const diff = computeConfigDiff(
      DEFAULT_SIGNAL_INGESTION_CONFIG,
      DEFAULT_SIGNAL_INGESTION_CONFIG,
    );
    expect(diff.changed).toBe(false);
    expect(diff.changes).toEqual([]);
  });

  it('detects scalar drift at top level (enabled flip)', () => {
    const current: SignalIngestionConfig = { ...DEFAULT_SIGNAL_INGESTION_CONFIG, enabled: true };
    const diff = computeConfigDiff(DEFAULT_SIGNAL_INGESTION_CONFIG, current);
    expect(diff.changed).toBe(true);
    expect(diff.changes).toEqual([{ path: 'enabled', previous: false, current: true }]);
  });

  it('detects nested scalar drift (tierMultipliers.churned tune)', () => {
    const current: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      tierMultipliers: { ...DEFAULT_SIGNAL_INGESTION_CONFIG.tierMultipliers, churned: 3.5 },
    };
    const diff = computeConfigDiff(DEFAULT_SIGNAL_INGESTION_CONFIG, current);
    expect(diff.changed).toBe(true);
    expect(diff.changes).toEqual([
      { path: 'tierMultipliers.churned', previous: 2.0, current: 3.5 },
    ]);
  });

  it('detects array drift (adapters list change)', () => {
    const current: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      adapters: ['signal-source-support-ticket', 'signal-source-manual'],
    };
    const diff = computeConfigDiff(DEFAULT_SIGNAL_INGESTION_CONFIG, current);
    expect(diff.changed).toBe(true);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0].path).toBe('adapters');
    expect(diff.changes[0].previous).toEqual([
      'signal-source-support-ticket',
      'signal-source-community-thread',
      'signal-source-in-app-feedback',
    ]);
    expect(diff.changes[0].current).toEqual([
      'signal-source-support-ticket',
      'signal-source-manual',
    ]);
  });

  it('orders multiple changes lexicographically (stable audit output)', () => {
    const current: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      enabled: true,
      recencyHalfLifeDays: 14,
      clustering: { algorithm: 'embedding', similarityThreshold: 0.75 },
    };
    const diff = computeConfigDiff(DEFAULT_SIGNAL_INGESTION_CONFIG, current);
    expect(diff.changed).toBe(true);
    const paths = diff.changes.map((c) => c.path);
    // Lexicographic order: clustering.algorithm < clustering.similarityThreshold
    //                     < enabled < recencyHalfLifeDays
    expect(paths).toEqual([
      'clustering.algorithm',
      'clustering.similarityThreshold',
      'enabled',
      'recencyHalfLifeDays',
    ]);
  });
});

// ── writeSignalIngestionConfigChangedEvent ─────────────────────────────

describe('writeSignalIngestionConfigChangedEvent', () => {
  let artifactsDir: string;

  beforeEach(() => {
    artifactsDir = makeTmpDir('write-event');
  });

  afterEach(() => {
    if (existsSync(artifactsDir)) rmSync(artifactsDir, { recursive: true, force: true });
  });

  it('appends a single JSONL line to the date-rotated events file', () => {
    const frozen = new Date('2026-05-24T12:00:00.000Z');
    const ok = writeSignalIngestionConfigChangedEvent(
      {
        ts: '',
        type: 'SignalIngestionConfigChanged',
        configPath: '/repo/.ai-sdlc/signal-ingestion.yaml',
        changes: [{ path: 'enabled', previous: false, current: true }],
        comparedAgainst: 'defaults',
      },
      { artifactsDir, now: () => frozen },
    );
    expect(ok).toBe(true);

    const lines = readEventLines(artifactsDir, frozen);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      type: 'SignalIngestionConfigChanged',
      configPath: '/repo/.ai-sdlc/signal-ingestion.yaml',
      comparedAgainst: 'defaults',
      ts: '2026-05-24T12:00:00.000Z',
    });
    expect(parsed.changes).toEqual([{ path: 'enabled', previous: false, current: true }]);
  });

  it('appends to the same file across multiple events (one JSONL line per call)', () => {
    const frozen = new Date('2026-05-24T08:00:00.000Z');
    writeSignalIngestionConfigChangedEvent(
      {
        ts: '',
        type: 'SignalIngestionConfigChanged',
        configPath: 'a',
        changes: [{ path: 'enabled', previous: false, current: true }],
        comparedAgainst: 'defaults',
      },
      { artifactsDir, now: () => frozen },
    );
    writeSignalIngestionConfigChangedEvent(
      {
        ts: '',
        type: 'SignalIngestionConfigChanged',
        configPath: 'b',
        changes: [{ path: 'recencyHalfLifeDays', previous: 30, current: 14 }],
        comparedAgainst: 'previous-load',
      },
      { artifactsDir, now: () => frozen },
    );

    const lines = readEventLines(artifactsDir, frozen);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).configPath).toBe('a');
    expect(JSON.parse(lines[1]).configPath).toBe('b');
  });

  it('writes to the shared _orchestrator/events-YYYY-MM-DD.jsonl path', () => {
    const frozen = new Date('2026-05-24T00:00:00.000Z');
    const expected = join(artifactsDir, '_orchestrator', 'events-2026-05-24.jsonl');
    writeSignalIngestionConfigChangedEvent(
      {
        ts: '',
        type: 'SignalIngestionConfigChanged',
        configPath: 'p',
        changes: [{ path: 'enabled', previous: false, current: true }],
        comparedAgainst: 'defaults',
      },
      { artifactsDir, now: () => frozen },
    );
    expect(existsSync(expected)).toBe(true);
  });

  it('returns false + invokes warn on write failure (best-effort)', () => {
    // Point at a non-creatable path: a file used as a directory.
    const stub = join(artifactsDir, 'as-file');
    writeFileSync(stub, 'block');
    const captured: string[] = [];
    const ok = writeSignalIngestionConfigChangedEvent(
      {
        ts: '',
        type: 'SignalIngestionConfigChanged',
        configPath: 'p',
        changes: [{ path: 'enabled', previous: false, current: true }],
        comparedAgainst: 'defaults',
      },
      { artifactsDir: stub, warn: (m) => captured.push(m) },
    );
    expect(ok).toBe(false);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toContain('[signal-ingestion-governance]');
  });
});

// ── loadSignalIngestionConfigWithGovernance ────────────────────────────

describe('loadSignalIngestionConfigWithGovernance', () => {
  let projectRoot: string;
  let artifactsDir: string;

  beforeEach(() => {
    projectRoot = makeTmpDir('proj');
    artifactsDir = makeTmpDir('artifacts');
  });

  afterEach(() => {
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true });
    if (existsSync(artifactsDir)) rmSync(artifactsDir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): string {
    const aiSdlcDir = join(projectRoot, '.ai-sdlc');
    mkdirSync(aiSdlcDir, { recursive: true });
    const path = join(aiSdlcDir, 'signal-ingestion.yaml');
    writeFileSync(path, yaml, 'utf8');
    return path;
  }

  it('emits no event when loaded config matches defaults (no file present)', () => {
    const frozen = new Date('2026-05-24T01:00:00.000Z');
    const result = loadSignalIngestionConfigWithGovernance({
      projectRoot,
      artifactsDir,
      now: () => frozen,
    });
    expect(result.diff.changed).toBe(false);
    expect(result.eventWritten).toBe(false);
    expect(readEventLines(artifactsDir, frozen)).toHaveLength(0);
  });

  it('emits an event with comparedAgainst="defaults" on first non-default load', () => {
    writeConfig('enabled: true\n');
    const frozen = new Date('2026-05-24T02:00:00.000Z');
    const result = loadSignalIngestionConfigWithGovernance({
      projectRoot,
      artifactsDir,
      now: () => frozen,
    });
    expect(result.diff.changed).toBe(true);
    expect(result.eventWritten).toBe(true);

    const lines = readEventLines(artifactsDir, frozen);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.comparedAgainst).toBe('defaults');
    expect(parsed.changes).toEqual([{ path: 'enabled', previous: false, current: true }]);
  });

  it('emits an event with comparedAgainst="previous-load" when previousConfigSnapshot supplied', () => {
    writeConfig('enabled: true\nrecencyHalfLifeDays: 14\n');
    const frozen = new Date('2026-05-24T03:00:00.000Z');
    // Previous snapshot: matches the file's `enabled: true` but has old half-life
    const previous: SignalIngestionConfig = {
      ...DEFAULT_SIGNAL_INGESTION_CONFIG,
      enabled: true,
      recencyHalfLifeDays: 30,
    };
    const result = loadSignalIngestionConfigWithGovernance({
      projectRoot,
      artifactsDir,
      previousConfigSnapshot: previous,
      now: () => frozen,
    });
    expect(result.diff.changed).toBe(true);
    expect(result.eventWritten).toBe(true);

    const lines = readEventLines(artifactsDir, frozen);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.comparedAgainst).toBe('previous-load');
    // Only the half-life diffs vs the previous snapshot — `enabled` is unchanged.
    expect(parsed.changes).toEqual([{ path: 'recencyHalfLifeDays', previous: 30, current: 14 }]);
  });

  it('suppresses event emission when skipEventEmission=true (diff still computed)', () => {
    writeConfig('enabled: true\n');
    const frozen = new Date('2026-05-24T04:00:00.000Z');
    const result = loadSignalIngestionConfigWithGovernance({
      projectRoot,
      artifactsDir,
      now: () => frozen,
      skipEventEmission: true,
    });
    expect(result.diff.changed).toBe(true);
    expect(result.eventWritten).toBe(false);
    expect(readEventLines(artifactsDir, frozen)).toHaveLength(0);
  });

  it('echoes the resolved configPath on the result + the event', () => {
    writeConfig('enabled: true\n');
    const frozen = new Date('2026-05-24T05:00:00.000Z');
    const result = loadSignalIngestionConfigWithGovernance({
      projectRoot,
      artifactsDir,
      now: () => frozen,
    });
    expect(result.configPath).toBe(join(projectRoot, '.ai-sdlc', 'signal-ingestion.yaml'));
    const lines = readEventLines(artifactsDir, frozen);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.configPath).toBe(result.configPath);
  });
});
