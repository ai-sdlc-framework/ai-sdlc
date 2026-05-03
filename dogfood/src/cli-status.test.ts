/**
 * Tests for the cli-status `--orchestrator` view (RFC-0015 Phase 4 /
 * AISDLC-169.4).
 *
 * Covers `renderOrchestratorEvents()` — the pure renderer that turns a
 * list of `OrchestratorEvent`s into the per-line output the operator
 * sees. The full main() is exercised end-to-end via shell-out by the
 * pipeline-cli test fixtures; these tests cover the formatting + color
 * coding contract documented in `pipeline-cli/docs/orchestrator.md`.
 */

import { describe, expect, it } from 'vitest';

import type { OrchestratorEvent } from '@ai-sdlc/pipeline-cli/orchestrator';

import { renderOrchestratorEvents } from './cli-status.js';

describe('renderOrchestratorEvents', () => {
  it('returns an empty-state line when the events list is empty', () => {
    const out = renderOrchestratorEvents([]);
    expect(out).toEqual(['No orchestrator events found.']);
  });

  it('renders one line per event with ts, type, taskId, runId', () => {
    const events: OrchestratorEvent[] = [
      {
        ts: '2026-05-02T00:00:00Z',
        type: 'OrchestratorTick',
        runId: 'abcdef1234567890',
        tick: 1,
        candidates: 1,
        dispatched: 0,
      },
      {
        ts: '2026-05-02T00:00:01Z',
        type: 'OrchestratorDispatched',
        taskId: 'AISDLC-169.4',
        runId: 'abcdef1234567890',
        tick: 1,
      },
      {
        ts: '2026-05-02T00:00:02Z',
        type: 'OrchestratorCompleted',
        taskId: 'AISDLC-169.4',
        runId: 'abcdef1234567890',
        tick: 1,
        outcome: 'approved',
        prUrl: 'https://github.com/x/y/pull/1',
      },
    ];
    const out = renderOrchestratorEvents(events);
    expect(out[0]).toBe('Recent orchestrator events (3):');
    expect(out[1]).toBe('');
    // Tick event has no taskId — placeholder stays as `taskId=-`.
    expect(out[2]).toContain('2026-05-02T00:00:00Z');
    expect(out[2]).toContain('OrchestratorTick');
    expect(out[2]).toContain('taskId=-');
    expect(out[2]).toContain('runId=abcdef12'); // shortened to 8 chars
    // Dispatched + Completed include the task id.
    expect(out[3]).toContain('OrchestratorDispatched');
    expect(out[3]).toContain('taskId=AISDLC-169.4');
    expect(out[4]).toContain('OrchestratorCompleted');
    expect(out[4]).toContain('taskId=AISDLC-169.4');
  });

  it('color-codes by type when useColor is true', () => {
    const events: OrchestratorEvent[] = [
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorCompleted', taskId: 'A', runId: 'r' },
      { ts: '2026-05-02T00:00:01Z', type: 'OrchestratorFailed', taskId: 'B', runId: 'r' },
      { ts: '2026-05-02T00:00:02Z', type: 'OrchestratorAwaitingExternal', taskId: 'C', runId: 'r' },
      { ts: '2026-05-02T00:00:03Z', type: 'OrchestratorTick', runId: 'r' },
    ];
    const out = renderOrchestratorEvents(events, { useColor: true });
    // Completed = green (32) — assert as substring (escape codes are
    // control characters; eslint's no-control-regex bans them in regexp
    // form, so use indexOf-style asserts via toContain).
    expect(out[2]).toContain('\x1b[32m');
    expect(out[2]).toContain('OrchestratorCompleted');
    expect(out[2]).toContain('\x1b[0m');
    // Failed = red (31)
    expect(out[3]).toContain('\x1b[31m');
    expect(out[3]).toContain('OrchestratorFailed');
    // AwaitingExternal = yellow (33)
    expect(out[4]).toContain('\x1b[33m');
    expect(out[4]).toContain('OrchestratorAwaitingExternal');
    // Tick = gray (90)
    expect(out[5]).toContain('\x1b[90m');
    expect(out[5]).toContain('OrchestratorTick');
  });

  it('omits color codes when useColor is false (default)', () => {
    const events: OrchestratorEvent[] = [
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorCompleted', taskId: 'A', runId: 'r' },
    ];
    const out = renderOrchestratorEvents(events, { useColor: false });
    expect(out[2]).not.toContain('\x1b[');
  });

  it('shortens runId to 8 chars (or leaves it alone when shorter)', () => {
    const events: OrchestratorEvent[] = [
      { ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick', runId: 'short' },
      {
        ts: '2026-05-02T00:00:01Z',
        type: 'OrchestratorTick',
        runId: 'd4e8c6a2-1234-5678-9abc-def012345678',
      },
    ];
    const out = renderOrchestratorEvents(events);
    expect(out[2]).toContain('runId=short');
    expect(out[3]).toContain('runId=d4e8c6a2');
    expect(out[3]).not.toContain('1234-5678');
  });

  it('shows runId=- when the event has no runId', () => {
    const events: OrchestratorEvent[] = [{ ts: '2026-05-02T00:00:00Z', type: 'OrchestratorTick' }];
    const out = renderOrchestratorEvents(events);
    expect(out[2]).toContain('runId=-');
  });
});
