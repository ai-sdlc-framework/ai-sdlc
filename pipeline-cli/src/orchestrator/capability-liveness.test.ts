import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityStateRow } from '@ai-sdlc/reference';
import { listDecisions } from '../decisions/index.js';
import type { OrchestratorEvent } from './events.js';
import { runCapabilityLiveness } from './capability-liveness.js';

const row = (id: string, status: CapabilityStateRow['status']): CapabilityStateRow => ({
  id,
  status,
  counts: { live: 0, shadow: 0, degraded: 0 },
  unregistered: false,
});

describe('runCapabilityLiveness', () => {
  let dir: string;
  let events: Array<Omit<OrchestratorEvent, 'ts'>>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cap-live-'));
    events = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (
    required: string[],
    rows: CapabilityStateRow[],
    now: string,
    env: NodeJS.ProcessEnv = {},
  ) =>
    runCapabilityLiveness({
      workDir: dir,
      artifactsDir: dir,
      emit: (e) => void events.push(e),
      now: new Date(now),
      env,
      readRequired: () => required,
      readState: () => rows,
    });

  it('files nothing when no capability is required', () => {
    const r = run([], [row('dor.stage-b', 'degraded')], '2026-11-07T10:00:00Z');
    expect(r).toEqual({ degraded: [], filed: [] });
    expect(listDecisions({ workDir: dir }).decisions).toHaveLength(0);
  });

  it('files exactly one Decision for a degraded required capability and emits an event', () => {
    const rows = [row('dor.stage-b', 'degraded'), row('sa.layer3', 'degraded')];
    const r = run(['dor.stage-b'], rows, '2026-11-07T10:00:00Z');
    expect(r.filed).toHaveLength(1);
    const { decisions } = listDecisions({ workDir: dir });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.metadata.scope).toBe('capability:dor.stage-b');
    expect(events).toEqual([
      { type: 'CapabilityDegraded', capabilityId: 'dor.stage-b', capabilityStatus: 'degraded' },
    ]);
  });

  it('treats a required capability with no row as never-observed', () => {
    const r = run(['dor.stage-b'], [], '2026-11-07T10:00:00Z');
    expect(r.filed).toHaveLength(1);
    expect(events[0]).toMatchObject({ capabilityStatus: 'never-observed' });
  });

  it('files none on a second tick the same day, nor while the Decision is open', () => {
    run(['dor.stage-b'], [row('dor.stage-b', 'degraded')], '2026-11-07T10:00:00Z');
    const same = run(['dor.stage-b'], [row('dor.stage-b', 'degraded')], '2026-11-07T18:00:00Z');
    expect(same.filed).toHaveLength(0);
    const nextDay = run(['dor.stage-b'], [row('dor.stage-b', 'degraded')], '2026-11-08T10:00:00Z');
    expect(nextDay.filed).toHaveLength(0);
    expect(listDecisions({ workDir: dir }).decisions).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('does not file for live or shadow capabilities', () => {
    const r = run(
      ['a.one', 'b.two'],
      [row('a.one', 'live'), row('b.two', 'shadow')],
      '2026-11-07T10:00:00Z',
    );
    expect(r).toEqual({ degraded: [], filed: [] });
  });

  it('reports degraded but files nothing when the catalog is disabled', () => {
    const r = run(['dor.stage-b'], [row('dor.stage-b', 'degraded')], '2026-11-07T10:00:00Z', {
      AI_SDLC_DECISION_CATALOG: 'off',
    });
    expect(r.degraded).toEqual(['dor.stage-b']);
    expect(r.filed).toEqual([]);
  });

  it('never throws', () => {
    const r = runCapabilityLiveness({
      workDir: dir,
      artifactsDir: dir,
      emit: () => {},
      readRequired: () => {
        throw new Error('boom');
      },
    });
    expect(r).toEqual({ degraded: [], filed: [] });
  });

  it('survives a throwing emitter while filing', () => {
    const r = runCapabilityLiveness({
      workDir: dir,
      artifactsDir: dir,
      emit: () => {
        throw new Error('sink down');
      },
      now: new Date('2026-11-07T10:00:00Z'),
      readRequired: () => ['dor.stage-b'],
      readState: () => [row('dor.stage-b', 'degraded')],
    });
    expect(r.degraded).toEqual(['dor.stage-b']);
  });
});
