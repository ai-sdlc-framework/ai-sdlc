import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAttestationGate,
  isRunTargetedStatus,
  runGate,
  PROTECTED_FILES,
} from './resolve-attestation-gate.mjs';

const HEAD = 'abc123';
const REF = 'ai-sdlc/aisdlc-1';
const runUrl = (id) => `https://github.com/o/r/actions/runs/${id}`;
const RUN_URL = runUrl(123);

const pr = (databaseId, status, conclusion, createdAt, headSha = HEAD) => ({
  databaseId,
  status,
  conclusion,
  createdAt,
  event: 'pull_request',
  headSha,
  headBranch: REF,
});
const prt = (databaseId, status, conclusion, createdAt) => ({
  databaseId,
  status,
  conclusion,
  createdAt,
  event: 'pull_request_target',
  headSha: 'base-tip',
  headBranch: REF,
});
const posted = (id) => ({
  context: 'ai-sdlc/attestation',
  state: 'success',
  target_url: runUrl(id),
});
const gate = (input) => resolveAttestationGate({ headSha: HEAD, headRef: REF, ...input });

describe('resolveAttestationGate (AISDLC-803)', () => {
  it('passes when the newest run succeeded, even if an older run failed', () => {
    const r = gate({
      runs: [
        pr(1, 'completed', 'failure', '2026-10-10T20:00:00Z'),
        pr(2, 'completed', 'success', '2026-10-10T20:27:00Z'),
      ],
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
    const r = gate({
      runs: [
        pr(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
        pr(2, 'completed', 'failure', '2026-10-10T20:30:00Z'),
      ],
    });
    assert.equal(r.verdict, 'fail');
  });

  it('waits while the newest run is in progress or queued', () => {
    for (const status of ['in_progress', 'queued']) {
      const r = gate({
        runs: [
          pr(2, status, null, '2026-10-10T20:30:00Z'),
          pr(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
        ],
      });
      assert.equal(r.verdict, 'wait', status);
    }
  });

  it('ignores cancelled runs and uses the next newest', () => {
    const r = gate({
      runs: [
        pr(2, 'completed', 'cancelled', '2026-10-10T20:30:00Z'),
        pr(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
      ],
    });
    assert.equal(r.verdict, 'pass');
  });

  it('waits when only cancelled runs exist', () => {
    const r = gate({ runs: [pr(2, 'completed', 'cancelled', '2026-10-10T20:30:00Z')] });
    assert.equal(r.verdict, 'wait');
  });

  it('fails on skipped, timed_out, action_required and other non-success conclusions', () => {
    for (const c of ['skipped', 'timed_out', 'action_required', 'neutral', 'failure']) {
      const r = gate({ runs: [pr(1, 'completed', c, '2026-10-10T20:00:00Z')] });
      assert.equal(r.verdict, 'fail', c);
    }
  });

  it('treats a non-run-targeted status as unknown (wait), not failure', () => {
    const r = gate({
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
    const r = gate({
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

  describe('trust model', () => {
    it('ignores runs of an unexpected event', () => {
      const r = gate({
        runs: [
          { ...pr(1, 'completed', 'success', '2026-10-10T20:00:00Z'), event: 'workflow_dispatch' },
        ],
      });
      assert.equal(r.verdict, 'wait');
    });

    it('ignores pull_request runs whose headSha does not equal the head', () => {
      const r = gate({
        runs: [pr(1, 'completed', 'success', '2026-10-10T20:00:00Z', 'other-sha')],
      });
      assert.equal(r.verdict, 'wait');
    });

    it('does not trust a pull_request run when the PR edits the verifier workflow', () => {
      for (const f of PROTECTED_FILES) {
        const r = gate({
          runs: [pr(1, 'completed', 'success', '2026-10-10T20:00:00Z')],
          changedFiles: ['README.md', f],
        });
        assert.equal(r.verdict, 'wait', f);
      }
    });

    it('trusts a linked pull_request_target run even when the PR edits the verifier workflow', () => {
      const r = gate({
        runs: [
          pr(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
          prt(5, 'completed', 'success', '2026-10-10T20:01:00Z'),
        ],
        statuses: [posted(5)],
        changedFiles: [PROTECTED_FILES[0]],
      });
      assert.equal(r.verdict, 'pass');
      assert.match(r.reason, /pull_request_target run 5/);
    });

    it('does not trust a pull_request_target run with no status linking it to the head', () => {
      const r = gate({
        runs: [prt(5, 'completed', 'success', '2026-10-10T20:01:00Z')],
        statuses: [],
      });
      assert.equal(r.verdict, 'wait');
    });

    it('does not trust a pull_request_target run from a different head branch', () => {
      const run = {
        ...prt(5, 'completed', 'success', '2026-10-10T20:01:00Z'),
        headBranch: 'other',
      };
      assert.equal(gate({ runs: [run], statuses: [posted(5)] }).verdict, 'wait');
    });

    it('a trusted pull_request_target run is authoritative over a failed fork pull_request run', () => {
      const r = gate({
        runs: [
          pr(9, 'completed', 'failure', '2026-10-10T20:05:00Z'),
          prt(5, 'completed', 'success', '2026-10-10T20:01:00Z'),
        ],
        statuses: [posted(5)],
      });
      assert.equal(r.verdict, 'pass');
    });

    it('fails when the trusted pull_request_target run failed', () => {
      const r = gate({
        runs: [prt(5, 'completed', 'failure', '2026-10-10T20:01:00Z')],
        statuses: [posted(5)],
      });
      assert.equal(r.verdict, 'fail');
    });
  });

  describe('tie-break', () => {
    it('breaks equal createdAt by the higher databaseId', () => {
      const r = gate({
        runs: [
          pr(2, 'completed', 'failure', '2026-10-10T20:00:00Z'),
          pr(3, 'completed', 'success', '2026-10-10T20:00:00Z'),
        ],
      });
      assert.equal(r.verdict, 'pass');
      const r2 = gate({
        runs: [
          pr(3, 'completed', 'success', '2026-10-10T20:00:00Z'),
          pr(4, 'completed', 'failure', '2026-10-10T20:00:00Z'),
        ],
      });
      assert.equal(r2.verdict, 'fail');
    });

    it('sorts an unparseable createdAt as oldest', () => {
      const r = gate({
        runs: [
          pr(99, 'completed', 'failure', 'not-a-date'),
          pr(1, 'completed', 'success', '2026-10-10T20:00:00Z'),
        ],
      });
      assert.equal(r.verdict, 'pass');
    });
  });
});

describe('runGate polling (AISDLC-803)', () => {
  const env = {
    REPO: 'o/r',
    HEAD_SHA: HEAD,
    HEAD_REF: REF,
    PR_NUMBER: '1',
    GATE_TIMEOUT_SECONDS: '60',
  };
  const harness = (fetchImpl) => {
    let t = 0;
    const logs = [];
    return {
      logs,
      opts: {
        env,
        fetch: fetchImpl,
        sleep: async (ms) => {
          t += ms;
        },
        now: () => t,
        log: (m) => logs.push(m),
      },
    };
  };
  const okInput = (runs) => ({ runs, statuses: [], headSha: HEAD, headRef: REF, changedFiles: [] });

  it('exits 2 when required env is missing', async () => {
    assert.equal(await runGate({ env: {}, log: () => {} }), 2);
  });

  it('times out into failure when no trusted run ever appears', async () => {
    const h = harness(() => okInput([]));
    assert.equal(await runGate(h.opts), 1);
    assert.match(h.logs.at(-1), /timed out/);
  });

  it('passes once a run succeeds after waiting', async () => {
    let n = 0;
    const h = harness(() =>
      okInput(
        ++n < 3
          ? [pr(1, 'in_progress', null, '2026-10-10T20:00:00Z')]
          : [pr(1, 'completed', 'success', '2026-10-10T20:00:00Z')],
      ),
    );
    assert.equal(await runGate(h.opts), 0);
  });

  it('fails immediately on a failed run', async () => {
    const h = harness(() => okInput([pr(1, 'completed', 'failure', '2026-10-10T20:00:00Z')]));
    assert.equal(await runGate(h.opts), 1);
  });

  it('retries a transient gh failure inside the window, then passes', async () => {
    let n = 0;
    const h = harness(() => {
      if (++n === 1) throw new Error('boom');
      return okInput([pr(1, 'completed', 'success', '2026-10-10T20:00:00Z')]);
    });
    assert.equal(await runGate(h.opts), 0);
    assert.ok(h.logs.some((l) => /gh lookup failed: boom/.test(l)));
  });

  it('fails closed on timeout when gh keeps failing', async () => {
    const h = harness(() => {
      throw new Error('down');
    });
    assert.equal(await runGate(h.opts), 1);
  });
});
