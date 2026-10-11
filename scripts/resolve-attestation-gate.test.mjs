import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAttestationGate, isRunTargetedStatus } from './resolve-attestation-gate.mjs';

const run = (databaseId, status, conclusion, createdAt) => ({
  databaseId,
  status,
  conclusion,
  createdAt,
});
const RUN_URL = 'https://github.com/o/r/actions/runs/123';

describe('resolveAttestationGate (AISDLC-803)', () => {
  it('passes when the newest run succeeded, even if an older run failed', () => {
    const r = resolveAttestationGate({
      runs: [
        run(1, 'completed', 'failure', '2026-10-10T20:00:00Z'),
        run(2, 'completed', 'success', '2026-10-10T20:27:00Z'),
      ],
      // a stale foreign failure status must not matter
      statuses: [
        {
          context: 'ai-sdlc/attestation',
          state: 'failure',
          target_url: 'https://github.com/o/r/pull/1',
        },
      ],
    });
    assert.equal(r.verdict, 'pass');
  });

  it('fails when the newest run failed', () => {
    const r = resolveAttestationGate({
      runs: [
        run(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
        run(2, 'completed', 'failure', '2026-10-10T20:30:00Z'),
      ],
    });
    assert.equal(r.verdict, 'fail');
  });

  it('waits while the newest run is in progress', () => {
    const r = resolveAttestationGate({
      runs: [
        run(2, 'in_progress', null, '2026-10-10T20:30:00Z'),
        run(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
      ],
    });
    assert.equal(r.verdict, 'wait');
  });

  it('ignores cancelled runs and uses the next newest', () => {
    const r = resolveAttestationGate({
      runs: [
        run(2, 'completed', 'cancelled', '2026-10-10T20:30:00Z'),
        run(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
      ],
    });
    assert.equal(r.verdict, 'pass');
  });

  it('treats a non-run-targeted status as unknown (wait), not failure', () => {
    const r = resolveAttestationGate({
      runs: [],
      statuses: [
        {
          context: 'ai-sdlc/attestation',
          state: 'failure',
          target_url: 'https://github.com/o/r/pull/1',
        },
      ],
    });
    assert.equal(r.verdict, 'wait');
    assert.match(r.reason, /unknown/);
  });

  it('waits when there is no run and no status', () => {
    assert.equal(resolveAttestationGate().verdict, 'wait');
  });

  it('waits (does not trust the status) when there is no run even for a run-targeted status', () => {
    const r = resolveAttestationGate({
      runs: [],
      statuses: [{ context: 'ai-sdlc/attestation', state: 'success', target_url: RUN_URL }],
    });
    assert.equal(r.verdict, 'wait');
  });

  it('isRunTargetedStatus recognises run URLs only', () => {
    assert.equal(isRunTargetedStatus({ target_url: RUN_URL }), true);
    assert.equal(isRunTargetedStatus({ target_url: 'https://github.com/o/r/pull/1' }), false);
    assert.equal(isRunTargetedStatus({}), false);
    assert.equal(isRunTargetedStatus(undefined), false);
  });
});
