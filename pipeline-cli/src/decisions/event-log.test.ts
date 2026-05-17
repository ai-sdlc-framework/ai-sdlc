/**
 * Tests for the append-only Decision event log (RFC-0035 OQ-1 substrate).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  nextDecisionId,
  readDecisionEvents,
  resolveDecisionsDir,
  resolveEventLogPath,
} from './event-log.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'decisions-log-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('path resolution', () => {
  it('resolves the decisions dir relative to workDir', () => {
    expect(resolveDecisionsDir(workDir)).toBe(join(workDir, '.ai-sdlc', '_decisions'));
  });

  it('resolves the event log path', () => {
    expect(resolveEventLogPath(workDir)).toBe(
      join(workDir, '.ai-sdlc', '_decisions', 'events.jsonl'),
    );
  });
});

describe('appendDecisionEvent', () => {
  it('creates parent directories on first write', () => {
    const evt = makeDecisionOpenedEvent({
      decisionId: 'DEC-0001',
      source: 'ad-hoc',
      scope: 'workspace',
      summary: 'first',
      options: [{ id: 'opt-a', description: 'A' }],
    });
    const path = appendDecisionEvent(evt, { workDir });
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(resolveEventLogPath(workDir));
  });

  it('appends without rewriting earlier lines (append-only)', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'first',
        options: [{ id: 'opt-a', description: 'A' }],
      }),
      { workDir },
    );
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0002',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'second',
        options: [{ id: 'opt-a', description: 'A' }],
      }),
      { workDir },
    );
    const raw = readFileSync(resolveEventLogPath(workDir), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).decisionId).toBe('DEC-0001');
    expect(JSON.parse(lines[1]).decisionId).toBe('DEC-0002');
  });

  it('refuses to append a structurally-invalid event', () => {
    const bad = {
      eventVersion: 'v1',
      type: 'decision-opened',
      ts: '2026-05-15T12:00:00Z',
      decisionId: 'DEC-0001',
      source: 'ad-hoc',
      scope: 'workspace',
      summary: 'no options',
      options: [],
    } as unknown as Parameters<typeof appendDecisionEvent>[0];
    expect(() => appendDecisionEvent(bad, { workDir })).toThrow(/invalid event/);
    expect(existsSync(resolveEventLogPath(workDir))).toBe(false);
  });
});

describe('readDecisionEvents', () => {
  it('returns empty when the log file is missing', () => {
    const r = readDecisionEvents({ workDir });
    expect(r.events).toEqual([]);
    expect(r.skipped).toBe(0);
  });

  it('returns events in append order', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'first',
        options: [{ id: 'opt-a', description: 'A' }],
        now: new Date('2026-05-15T10:00:00Z'),
      }),
      { workDir },
    );
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0002',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0035',
        summary: 'second',
        options: [{ id: 'opt-a', description: 'A' }],
        now: new Date('2026-05-15T11:00:00Z'),
      }),
      { workDir },
    );
    const r = readDecisionEvents({ workDir });
    expect(r.events.map((e) => e.decisionId)).toEqual(['DEC-0001', 'DEC-0002']);
    expect(r.skipped).toBe(0);
  });

  it('skips malformed JSON and invalid events without aborting', () => {
    // Seed the log with one valid + two bad lines.
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'first',
        options: [{ id: 'opt-a', description: 'A' }],
      }),
      { workDir },
    );
    const path = resolveEventLogPath(workDir);
    const raw = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      raw + '{not json\n' + JSON.stringify({ eventVersion: 'v2', type: 'unknown-type' }) + '\n',
      'utf8',
    );
    const r = readDecisionEvents({ workDir });
    expect(r.events).toHaveLength(1);
    expect(r.skipped).toBe(2);
  });
});

describe('nextDecisionId', () => {
  it('returns DEC-0001 on an empty log', () => {
    expect(nextDecisionId({ workDir })).toBe('DEC-0001');
  });

  it('returns the next sequential id after the highest seen', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0007',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'seven',
        options: [{ id: 'opt-a', description: 'A' }],
      }),
      { workDir },
    );
    expect(nextDecisionId({ workDir })).toBe('DEC-0008');
  });

  it('ignores malformed decisionIds when scanning for the max', () => {
    // Direct write to bypass validation — simulate operator-edited log
    // containing a malformed line; reader should ignore it for id allocation.
    const path = resolveEventLogPath(workDir);
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0003',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'three',
        options: [{ id: 'opt-a', description: 'A' }],
      }),
      { workDir },
    );
    writeFileSync(path, readFileSync(path, 'utf8') + 'garbage line\n', 'utf8');
    expect(nextDecisionId({ workDir })).toBe('DEC-0004');
  });
});
