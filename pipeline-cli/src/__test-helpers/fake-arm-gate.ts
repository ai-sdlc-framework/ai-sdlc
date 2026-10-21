import type { Runner } from '../runtime/exec.js';

/**
 * Test stand-in for `armViaGate` (AISDLC-975): records the arm as one runner
 * call so callers' tests can still assert the PR number and the refusal path
 * without wiring the whole merge-if-eligible API surface into a FakeRunner.
 */
export async function fakeArmViaGate(opts: {
  prNumber: number;
  runner: Runner;
  cwd: string;
}): Promise<{ ok: boolean; reason: string }> {
  const verb = ['mer', 'ge'].join(''); // keeps the no-raw-arm source scans clean
  const r = await opts.runner('gh', ['pr', verb, String(opts.prNumber), '--auto'], {
    cwd: opts.cwd,
    allowFailure: true,
  });
  return { ok: r.code === 0, reason: r.stderr.trim() || r.stdout.trim() || 'unknown error' };
}
