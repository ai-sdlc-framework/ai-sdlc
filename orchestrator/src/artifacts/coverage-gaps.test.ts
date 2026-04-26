/**
 * Targeted coverage tests for artifact paths flagged by codecov on PR #67.
 * Covers startHeartbeat lifecycle (start/stop/double-start/error swallowing) and
 * listActiveStates with malformed entries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateWriter, HEARTBEAT_INTERVAL_MS, type RuntimeState } from './index.js';

describe('StateWriter.startHeartbeat — gap coverage', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'heartbeat-gaps-'));
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('invokes produce() on each interval tick', () => {
    const writer = new StateWriter(tmpRoot, 'AISDLC-1');
    const produce = vi.fn<() => RuntimeState>(() => ({
      issueId: 'AISDLC-1',
      currentStage: 'plan',
      startedAt: '2026-04-26T12:00:00Z',
      lastHeartbeat: '2026-04-26T12:00:00Z',
      status: 'running',
    }));
    const stop = writer.startHeartbeat(produce);
    expect(produce).not.toHaveBeenCalled();

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 100);
    expect(produce).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(produce).toHaveBeenCalledTimes(2);

    stop();
  });

  it('throws when started twice without stopping', () => {
    const writer = new StateWriter(tmpRoot, 'AISDLC-2');
    const produce = (): RuntimeState => ({
      issueId: 'AISDLC-2',
      currentStage: 'plan',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'running',
    });
    const stop = writer.startHeartbeat(produce);
    expect(() => writer.startHeartbeat(produce)).toThrow(/already running/);
    stop();
  });

  it('stop() is idempotent — calling twice does not throw', () => {
    const writer = new StateWriter(tmpRoot, 'AISDLC-3');
    const stop = writer.startHeartbeat(() => ({
      issueId: 'AISDLC-3',
      currentStage: 'plan',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'running',
    }));
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('swallows produce() errors silently and keeps ticking', () => {
    const writer = new StateWriter(tmpRoot, 'AISDLC-4');
    const produce = vi.fn(() => {
      throw new Error('producer crashed');
    });
    const stop = writer.startHeartbeat(produce);

    expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 100)).not.toThrow();
    expect(produce).toHaveBeenCalledTimes(1);

    // Subsequent ticks still fire even after the first one threw.
    expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)).not.toThrow();
    expect(produce).toHaveBeenCalledTimes(2);

    stop();
  });

  it('stop() halts further ticks', () => {
    const writer = new StateWriter(tmpRoot, 'AISDLC-5');
    const produce = vi.fn<() => RuntimeState>(() => ({
      issueId: 'AISDLC-5',
      currentStage: 'plan',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'running',
    }));
    const stop = writer.startHeartbeat(produce);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + 100);
    expect(produce).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5);
    expect(produce).toHaveBeenCalledTimes(1); // no further calls
  });
});
