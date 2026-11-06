import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Poll until a file exists or `timeoutMs` elapses (test sync helper). */
async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`waitForFile timed out after ${timeoutMs}ms: ${path}`);
}
import { withMergeGate, isBranchUpToDate, MergeGateLockTimeoutError } from './merge-gate.js';
import { decideRequeue, appendTriageHistory } from './requeue.js';

describe('withMergeGate', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'merge-gate-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('serializes concurrent gate acquisitions', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const tasks = Array.from({ length: 5 }, () =>
      withMergeGate(tmpRoot, async () => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
      }),
    );
    await Promise.all(tasks);
    expect(maxObserved).toBe(1);
  });

  it('releases the lock on success', async () => {
    await withMergeGate(tmpRoot, async () => 'ok');
    // Second acquisition succeeds quickly.
    const start = Date.now();
    await withMergeGate(tmpRoot, async () => 'ok');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('releases the lock on failure', async () => {
    await expect(
      withMergeGate(tmpRoot, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Second acquisition succeeds.
    await withMergeGate(tmpRoot, async () => 'ok');
  });

  it('times out when lock is held longer than timeoutMs', async () => {
    let releaseFirst!: () => void;
    const first = withMergeGate(tmpRoot, async () => {
      await new Promise<void>((r) => {
        releaseFirst = r;
      });
    });
    // Wait until `first` has actually acquired the lock before launching the
    // contender; without this, the second call can win the exclusive-create
    // race and the test asserts on the wrong arm. (The 5s default is a
    // CI-load-friendly upper bound — the lock should appear in <50ms.)
    await waitForFile(join(tmpRoot, '.merge-gate.lock'));

    // Bumped from 200ms to 1500ms so the test isn't pinned to the merge-gate
    // poll cadence (POLL_INTERVAL_MS=100); under CI load 200ms gave only ~2
    // poll cycles before the timeout fired, racing other I/O.
    await expect(withMergeGate(tmpRoot, async () => 'never', { timeoutMs: 1500 })).rejects.toThrow(
      MergeGateLockTimeoutError,
    );
    releaseFirst();
    await first;
  });
});

describe('isBranchUpToDate', () => {
  it('true when branch base SHA matches remote head', async () => {
    const result = await isBranchUpToDate('abc', 'main', async () => 'abc');
    expect(result).toBe(true);
  });

  it('false when SHAs differ', async () => {
    const result = await isBranchUpToDate('abc', 'main', async () => 'xyz');
    expect(result).toBe(false);
  });
});

describe('decideRequeue', () => {
  const baseInput = {
    lastTriage: { timestamp: '2026-04-26T12:00:00Z', trigger: 'original' as const, composite: 0.7 },
    failureHistory: [],
    triggeringFailure: 'CIFailure' as const,
    trigger: 'automatic' as const,
  };

  it('operator-triggered requeue always re-scores', () => {
    const d = decideRequeue({ ...baseInput, trigger: 'operator' });
    expect(d.reScore).toBe(true);
    expect(d.reason).toBe('operator-requeue');
  });

  it('time threshold > 24h triggers re-score', () => {
    const d = decideRequeue({
      ...baseInput,
      now: () => new Date('2026-04-28T13:00:00Z'), // ~49h later
    });
    expect(d.reScore).toBe(true);
    expect(d.reason).toBe('time-threshold');
  });

  it('always-transient failures (MergeConflict) trust the score', () => {
    const d = decideRequeue({
      ...baseInput,
      triggeringFailure: 'MergeConflict',
      now: () => new Date('2026-04-26T13:00:00Z'),
    });
    expect(d.reScore).toBe(false);
    expect(d.reason).toBe('trust-score');
  });

  it('always-re-score failures (MigrationConflict) re-score on first occurrence', () => {
    const d = decideRequeue({
      ...baseInput,
      triggeringFailure: 'MigrationConflict',
      now: () => new Date('2026-04-26T13:00:00Z'),
    });
    expect(d.reScore).toBe(true);
    expect(d.reason).toBe('failure-type');
  });

  it('CIFailure re-scores after 3rd occurrence', () => {
    const history = [
      { at: '2026-04-26T10:00:00Z', event: 'CIFailure' as const },
      { at: '2026-04-26T11:00:00Z', event: 'CIFailure' as const },
    ];
    const d = decideRequeue({
      ...baseInput,
      triggeringFailure: 'CIFailure',
      failureHistory: history,
      now: () => new Date('2026-04-26T12:30:00Z'),
    });
    expect(d.reScore).toBe(true);
    expect(d.detail).toMatch(/3×/);
  });

  it('AgentTimeout re-scores after 2nd occurrence', () => {
    const d = decideRequeue({
      ...baseInput,
      triggeringFailure: 'AgentTimeout',
      failureHistory: [{ at: '2026-04-26T11:00:00Z', event: 'AgentTimeout' }],
      now: () => new Date('2026-04-26T12:30:00Z'),
    });
    expect(d.reScore).toBe(true);
  });

  it('AgentTimeout first occurrence trusts score', () => {
    const d = decideRequeue({
      ...baseInput,
      triggeringFailure: 'AgentTimeout',
      now: () => new Date('2026-04-26T12:30:00Z'),
    });
    expect(d.reScore).toBe(false);
  });
});

describe('appendTriageHistory + RetriageStorm detection', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'triage-history-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('appends a JSONL line per triage event', async () => {
    const r = await appendTriageHistory(tmpRoot, 'AISDLC-247', {
      timestamp: '2026-04-26T12:00:00Z',
      trigger: 'original',
      composite: 0.7,
    });
    expect(r.eventsInWindow).toBe(0); // 'original' doesn't count
    const content = await readFile(join(tmpRoot, 'AISDLC-247', 'triage-history.jsonl'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(1);
  });

  it('detects RetriageStorm when re-score events exceed 10 in 24h', async () => {
    for (let i = 0; i < 11; i++) {
      await appendTriageHistory(tmpRoot, 'AISDLC-247', {
        timestamp: new Date().toISOString(),
        trigger: 'failure-type',
        composite: 0.7,
      });
    }
    const r = await appendTriageHistory(tmpRoot, 'AISDLC-247', {
      timestamp: new Date().toISOString(),
      trigger: 'failure-type',
      composite: 0.7,
    });
    expect(r.stormDetected).toBe(true);
    expect(r.eventsInWindow).toBeGreaterThan(10);
  });
});
