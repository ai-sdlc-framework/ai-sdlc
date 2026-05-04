import { describe, expect, it, vi } from 'vitest';
import { parseDeveloperReturn, parseDeveloperReturnWithRetry } from './06-parse-dev-return.js';
import type { SubagentResult, SubagentSpawner } from '../types.js';

const happy = {
  summary: 'ok',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
};

describe('Step 6 — parseDeveloperReturn', () => {
  it('happy path with object input', async () => {
    const r = await parseDeveloperReturn({ developerReturn: happy });
    expect(r.ok).toBe(true);
    expect(r.developer?.commitSha).toBe('abc1234');
    expect(r.contractViolation).toBeUndefined();
  });

  it('happy path with JSON string input', async () => {
    const r = await parseDeveloperReturn({ developerReturn: JSON.stringify(happy) });
    expect(r.ok).toBe(true);
  });

  it('rejects malformed JSON string and flags it as a contract violation (AISDLC-176)', async () => {
    const r = await parseDeveloperReturn({ developerReturn: 'not json {' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/failed to parse/);
    expect(r.contractViolation).toBe(true);
    // The raw output must surface in the reason so operators get
    // actionable context (the witnessed AISDLC-70 bug had this swallowed).
    expect(r.reason).toMatch(/raw output/);
    expect(r.reason).toMatch(/not json/);
  });

  it('truncates long raw output in the reason (AISDLC-176)', async () => {
    const longProse = 'Done. ' + 'x'.repeat(2000);
    const r = await parseDeveloperReturn({ developerReturn: longProse });
    expect(r.ok).toBe(false);
    expect(r.contractViolation).toBe(true);
    expect(r.reason).toMatch(/truncated/);
    // The full 2000-char output should NOT appear verbatim — only the
    // 500-char prefix with a truncation marker.
    expect(r.reason!.length).toBeLessThan(longProse.length);
  });

  it('rejects non-object input as a contract violation (AISDLC-176)', async () => {
    const r = await parseDeveloperReturn({ developerReturn: 42 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not an object/);
    expect(r.contractViolation).toBe(true);
  });

  it('flags missing required keys WITHOUT marking it a contract violation (AISDLC-176)', async () => {
    // Schema-violation = the dev returned valid JSON but the wrong
    // shape. That's a developer-failed outcome, not a contract violation —
    // the retry helper would just get the same wrong shape back.
    const { commitSha, ...without } = happy;
    void commitSha;
    const r = await parseDeveloperReturn({ developerReturn: without });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/commitSha/);
    expect(r.contractViolation).toBeUndefined();
  });

  it('flags invalid filesChanged shape', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, filesChanged: 'wrong' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/filesChanged/);
  });

  it('flags invalid verification status', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, verifications: { ...happy.verifications, build: 'bogus' } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verifications.build/);
  });

  it('treats null commitSha as developer-failed', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, commitSha: null, notes: 'could not finish' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/null commitSha/);
    expect(r.reason).toMatch(/could not finish/);
  });

  it('treats verifications.build=failed as developer-failed', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, verifications: { ...happy.verifications, build: 'failed' } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/build = failed/);
  });

  it('treats verifications.format=failed as developer-failed', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, verifications: { ...happy.verifications, format: 'failed' } },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/format = failed/);
  });

  it('flags missing verifications object', async () => {
    const { verifications, ...rest } = happy;
    void verifications;
    const r = await parseDeveloperReturn({ developerReturn: rest });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verifications/);
  });

  it('flags missing acceptanceCriteriaMet array', async () => {
    const { acceptanceCriteriaMet, ...rest } = happy;
    void acceptanceCriteriaMet;
    const r = await parseDeveloperReturn({ developerReturn: rest });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/acceptanceCriteriaMet/);
  });

  it('flags non-array acceptanceCriteriaMet', async () => {
    const r = await parseDeveloperReturn({
      developerReturn: { ...happy, acceptanceCriteriaMet: 'wrong' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/acceptanceCriteriaMet/);
  });
});

// ── AISDLC-176 — retry-once-on-contract-violation helper ────────────────

/**
 * Build a SubagentResult-shaped fixture. The retry helper looks at
 * `parsed ?? output`; we leave `parsed` undefined for prose returns so
 * the parse falls through to the raw `output`.
 */
function fakeDevResult(output: string, parsed?: unknown): SubagentResult {
  return {
    type: 'developer',
    output,
    ...(parsed !== undefined ? { parsed } : {}),
    status: 'success',
    durationMs: 0,
  };
}

/**
 * Minimal SubagentSpawner stub for the retry tests. Records every
 * spawn() invocation and returns the next pre-scripted result.
 * `spawnParallel` is unused by `parseDeveloperReturnWithRetry` so the
 * stub just throws if anyone calls it (would surface a test bug fast).
 */
function makeStubSpawner(scripted: SubagentResult[]): {
  spawner: SubagentSpawner;
  calls: Array<{ prompt: string; cwd: string }>;
} {
  const calls: Array<{ prompt: string; cwd: string }> = [];
  let i = 0;
  const spawner: SubagentSpawner = {
    spawn: async (opts) => {
      calls.push({ prompt: opts.prompt, cwd: opts.cwd });
      const result = scripted[i++];
      if (!result) throw new Error(`stub spawner exhausted at call ${i}`);
      return result;
    },
    spawnParallel: async () => {
      throw new Error('parseDeveloperReturnWithRetry must not call spawnParallel');
    },
  };
  return { spawner, calls };
}

describe('Step 6 — parseDeveloperReturnWithRetry (AISDLC-176)', () => {
  it('happy path: initial parse succeeds, no retry spawned', async () => {
    const { spawner, calls } = makeStubSpawner([
      // Should never be called.
      fakeDevResult('', happy),
    ]);
    const onRetrySuccess = vi.fn();
    const r = await parseDeveloperReturnWithRetry({
      initialResult: fakeDevResult('', happy),
      cwd: '/tmp/wt',
      spawner,
      onRetrySuccess,
    });
    expect(r.ok).toBe(true);
    expect(r.developer?.commitSha).toBe('abc1234');
    expect(calls).toHaveLength(0); // no retry spawn
    expect(onRetrySuccess).not.toHaveBeenCalled();
  });

  it('non-contract failure (missing key) bypasses retry — pass-through (AISDLC-176)', async () => {
    // Schema-violation: dev returned valid JSON but the wrong shape.
    // No retry should fire because asking for a re-emission of an
    // already-structurally-correct envelope is wasted budget.
    const broken = { ...happy };
    delete (broken as Record<string, unknown>).commitSha;
    const { spawner, calls } = makeStubSpawner([fakeDevResult('', happy)]);
    const r = await parseDeveloperReturnWithRetry({
      initialResult: fakeDevResult('', broken),
      cwd: '/tmp/wt',
      spawner,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/commitSha/);
    expect(r.contractViolation).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('null-commitSha bypasses retry — dev reported failure inside a valid envelope', async () => {
    const reportedFailure = { ...happy, commitSha: null, notes: 'could not finish' };
    const { spawner, calls } = makeStubSpawner([fakeDevResult('', happy)]);
    const r = await parseDeveloperReturnWithRetry({
      initialResult: fakeDevResult('', reportedFailure),
      cwd: '/tmp/wt',
      spawner,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/null commitSha/);
    expect(r.contractViolation).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('AC4: prose-then-JSON — retry recovers the dispatch', async () => {
    // First spawn: prose ("Done. AISDLC-70 shipped"). Second spawn:
    // valid JSON envelope. Outcome: ok=true, retry callback fired.
    const { spawner, calls } = makeStubSpawner([fakeDevResult(JSON.stringify(happy))]);
    const onRetrySuccess = vi.fn();
    const r = await parseDeveloperReturnWithRetry({
      initialResult: fakeDevResult('Done. AISDLC-70 shipped — see git log.'),
      cwd: '/tmp/wt-aisdlc-70',
      spawner,
      onRetrySuccess,
    });
    expect(r.ok).toBe(true);
    expect(r.developer?.commitSha).toBe('abc1234');
    expect(calls).toHaveLength(1);
    // The retry prompt MUST quote the original output so the dev can
    // self-correct, MUST mention git rev-parse HEAD, and MUST set the
    // cwd to the worktree.
    expect(calls[0].cwd).toBe('/tmp/wt-aisdlc-70');
    expect(calls[0].prompt).toMatch(/Done\. AISDLC-70 shipped/);
    expect(calls[0].prompt).toMatch(/git rev-parse HEAD/);
    expect(calls[0].prompt).toMatch(/JSON object/);
    expect(onRetrySuccess).toHaveBeenCalledTimes(1);
    const callArg = onRetrySuccess.mock.calls[0][0];
    expect(callArg.initialOutputPreview).toMatch(/Done\. AISDLC-70/);
    expect(typeof callArg.durationMs).toBe('number');
  });

  it('AC5: prose-twice — fails with contract violation (clear error, not cryptic JSON.parse)', async () => {
    const { spawner, calls } = makeStubSpawner([
      fakeDevResult('Sorry, I cannot return JSON. The work is committed though.'),
    ]);
    const r = await parseDeveloperReturnWithRetry({
      initialResult: fakeDevResult('Done.'),
      cwd: '/tmp/wt',
      spawner,
    });
    expect(r.ok).toBe(false);
    expect(r.contractViolation).toBe(true);
    // Reason MUST surface the BOTH-turns failure context — not a
    // bare "Unexpected token D in JSON at position 0" cryptic dump.
    expect(r.reason).toMatch(/violated JSON envelope contract on both turns/);
    expect(r.reason).toMatch(/initial/);
    expect(r.reason).toMatch(/retry/);
    expect(calls).toHaveLength(1); // exactly ONE retry, never two
  });

  it('honors the timeoutMs override on the retry spawn', async () => {
    const { spawner, calls } = makeStubSpawner([fakeDevResult(JSON.stringify(happy))]);
    let captured: number | undefined;
    const wrappedSpawner: SubagentSpawner = {
      spawn: async (opts) => {
        captured = opts.timeout;
        return spawner.spawn(opts);
      },
      spawnParallel: spawner.spawnParallel.bind(spawner),
    };
    void calls;
    const r = await parseDeveloperReturnWithRetry({
      initialResult: fakeDevResult('not json'),
      cwd: '/tmp/wt',
      spawner: wrappedSpawner,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    expect(captured).toBe(60_000);
  });
});
