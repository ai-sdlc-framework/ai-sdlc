/**
 * Tests for the TUI interactions writer (AISDLC-178.6 AC#3).
 *
 * Particular focus on the OQ-8 opt-OUT contract: writers default ON,
 * `AI_SDLC_TUI_TELEMETRY=off` short-circuits the writer entirely.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeInteraction, type InteractionRecord } from './interactions-writer.js';
import { interactionsPath } from './paths.js';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'interactions-writer-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('writeInteraction', () => {
  it('writes when telemetry is enabled (default)', () => {
    const ok = writeInteraction(
      { kind: 'pane-opened', pane: 'analytics' },
      { artifactsDir: workdir, isEnabled: () => true, now: () => new Date('2026-05-04T08:00:00Z') },
    );
    expect(ok).toBe(true);
    const raw = readFileSync(interactionsPath(workdir), 'utf8');
    const record = JSON.parse(raw.trim()) as InteractionRecord;
    expect(record).toMatchObject({
      ts: '2026-05-04T08:00:00.000Z',
      kind: 'pane-opened',
      pane: 'analytics',
    });
  });

  it('opts OUT: no file written when isEnabled returns false', () => {
    const ok = writeInteraction(
      { kind: 'pane-opened', pane: 'blockers' },
      { artifactsDir: workdir, isEnabled: () => false },
    );
    expect(ok).toBe(false);
    expect(existsSync(interactionsPath(workdir))).toBe(false);
  });

  it('preserves a caller-stamped ts when provided', () => {
    writeInteraction(
      { kind: 'drill-down', pane: 'blockers', target: 'AISDLC-100', ts: '2024-01-01T00:00:00Z' },
      { artifactsDir: workdir, isEnabled: () => true },
    );
    const record = JSON.parse(
      readFileSync(interactionsPath(workdir), 'utf8').trim(),
    ) as InteractionRecord;
    expect(record.ts).toBe('2024-01-01T00:00:00Z');
    expect(record.target).toBe('AISDLC-100');
  });

  it('appends successive records', () => {
    writeInteraction(
      { kind: 'pane-opened', pane: 'overview' },
      { artifactsDir: workdir, isEnabled: () => true },
    );
    writeInteraction(
      { kind: 'pane-opened', pane: 'analytics' },
      { artifactsDir: workdir, isEnabled: () => true },
    );
    const lines = readFileSync(interactionsPath(workdir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as InteractionRecord).pane).toBe('overview');
    expect((JSON.parse(lines[1]) as InteractionRecord).pane).toBe('analytics');
  });
});
