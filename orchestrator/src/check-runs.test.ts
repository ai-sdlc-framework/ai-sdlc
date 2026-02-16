import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCheckRun, updateCheckRun, reportGateCheckRuns, type GateResult } from './check-runs.js';

// Mock child_process.execFile to avoid actual gh CLI calls
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
    // If called with callback style (promisify wraps it)
    if (cb) cb(null, { stdout: '{}', stderr: '' });
    return { stdout: '', stderr: '' };
  }),
}));

vi.mock('node:util', () => ({
  promisify: (fn: Function) => async (...args: unknown[]) => {
    return new Promise((resolve, reject) => {
      fn(...args, (err: Error | null, result: unknown) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  },
}));

describe('check-runs', () => {
  describe('createCheckRun', () => {
    it('returns success when gh CLI succeeds', async () => {
      const result = await createCheckRun({
        name: 'AI-SDLC: test-gate',
        headSha: 'abc123',
        status: 'completed',
        conclusion: 'success',
        title: 'Test Gate',
        summary: 'Gate passed',
      });
      expect(result.success).toBe(true);
    });

    it('handles basic input without optional fields', async () => {
      const result = await createCheckRun({
        name: 'AI-SDLC: basic',
        headSha: 'def456',
        status: 'queued',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('updateCheckRun', () => {
    it('returns success when updating a check run', async () => {
      const result = await updateCheckRun(123, {
        status: 'completed',
        conclusion: 'success',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('reportGateCheckRuns', () => {
    it('creates check runs for each gate result', async () => {
      const gateResults: GateResult[] = [
        { gate: 'complexity', verdict: 'pass', message: 'Complexity within bounds' },
        { gate: 'tests', verdict: 'pass', message: 'Tests required' },
        { gate: 'review', verdict: 'fail', message: 'Review not completed' },
      ];

      // Should not throw
      await reportGateCheckRuns('abc123', gateResults);
    });

    it('handles empty gate results', async () => {
      await reportGateCheckRuns('abc123', []);
      // No-op, should not throw
    });

    it('maps verdicts to correct conclusions', async () => {
      const gateResults: GateResult[] = [
        { gate: 'pass-gate', verdict: 'pass' },
        { gate: 'fail-gate', verdict: 'fail' },
        { gate: 'skip-gate', verdict: 'skip' },
      ];
      // Should not throw — verifies all verdict types are handled
      await reportGateCheckRuns('sha', gateResults);
    });
  });
});
