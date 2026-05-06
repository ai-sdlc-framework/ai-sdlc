/**
 * AISDLC-200 — `cleanupTask` throw path coverage.
 *
 * The shipped `cleanupTask` (`steps/13-cleanup.ts`) catches its own
 * `unlinkSync` failures and returns `{ sentinelRemoved: false }`, so
 * exercising the executePipeline `finally` block's surrounding
 * `try/catch` (lines 320-324: `cleanupWarnings.push('sentinel cleanup
 * failed: ...')`) requires module-level interception — the cleanup
 * helper is only directly throwable through a mocked import. We park
 * this test in its own file so the `vi.mock` hoist is scoped to a
 * single integration scenario; the rest of the integration suite uses
 * the real cleanupTask.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRunner, ok } from './__test-helpers/fake-runner.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from './__test-helpers/make-task.js';
import type { DeveloperReturn } from './types.js';

// vi.mock hoists above the imports — replace the steps barrel's
// `cleanupTask` with one that throws so the executePipeline finally
// hits its `catch (err)` path on lines 320-324. Every other step
// re-exports through the real module via the `importActual` spread so
// the rest of the pipeline behaves normally.
vi.mock('./steps/index.js', async () => {
  const actual = await vi.importActual<typeof import('./steps/index.js')>('./steps/index.js');
  return {
    ...actual,
    cleanupTask: vi.fn(async () => {
      throw new Error('simulated unlinkSync EPERM during sentinel removal');
    }),
  };
});

// Import AFTER the mock so executePipeline picks up the mocked
// cleanupTask via its `import { cleanupTask } from './steps/index.js'`.
const { executePipeline } = await import('./execute-pipeline.js');
const { MockSpawner } = await import('./runtime/subagent-spawner.js');

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
  vi.restoreAllMocks();
});

const goodDev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
  notes: 'no follow-up',
};

const approvedReviewer = (type: 'code-reviewer' | 'test-reviewer' | 'security-reviewer') => ({
  type,
  output: '',
  parsed: { approved: true, findings: [], summary: 'lgtm' },
  status: 'success' as const,
  durationMs: 0,
});

function makeApprovingSpawner(): InstanceType<typeof MockSpawner> {
  return new MockSpawner({
    developer: {
      type: 'developer',
      output: '',
      parsed: goodDev,
      status: 'success',
      durationMs: 0,
    },
    'code-reviewer': approvedReviewer('code-reviewer'),
    'test-reviewer': approvedReviewer('test-reviewer'),
    'security-reviewer': approvedReviewer('security-reviewer'),
  });
}

function makeHappyRunner(): FakeRunner {
  return new FakeRunner()
    .on(/^git fetch/, ok())
    .on(/^git worktree add/, ok())
    .on(/^git -C .+ rev-parse HEAD$/, ok('basecommit\n'))
    .on(/^git diff origin\/main\.\.\.HEAD$/, ok('--- diff content ---\n'))
    .on(/^git diff --name-only origin\/main\.\.\.HEAD$/, ok('a.ts\n'))
    .on(/^git push -u origin/, ok())
    .on(/^gh pr create/, ok('https://github.com/owner/repo/pull/42\n'));
}

describe('executePipeline cleanup-warning surface (AISDLC-200)', () => {
  it('AISDLC-200: cleanupTask throw is captured as cleanup warning + surfaced in notes', async () => {
    // Happy path through Step 12 — `outcome === 'approved'`, no abort
    // reason — but the mocked cleanupTask throws so the finally's
    // try/catch on lines 320-324 records a warning. Notes should reflect
    // ONLY the warning (no abort prefix), proving the conditional join
    // on lines 372-375 (`finalNotes ? ${finalNotes} | ${warnings} : warnings`)
    // takes the warnings-only branch when there's no abort reason.
    writeTaskFile(tmp, {
      id: 'AISDLC-200-CLEAN',
      title: 'cleanup throws',
      status: 'To Do',
      acceptanceCriteria: ['ship a thing'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-200-clean'), { recursive: true });

    const warnings: string[] = [];
    const result = await executePipeline({
      taskId: 'AISDLC-200-CLEAN',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
      logger: {
        info: () => {},
        warn: (msg) => warnings.push(msg),
        error: () => {},
        progress: () => {},
      },
    });

    // Pipeline still completes successfully — the cleanup throw is
    // non-fatal by design.
    expect(result.outcome).toBe('approved');
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');

    // Warning recorded on the logger AND surfaced in the envelope's
    // `notes` field.
    expect(warnings.some((w) => /Step 13 sentinel cleanup failed.*EPERM/i.test(w))).toBe(true);
    expect(result.notes).toMatch(/cleanup warnings:/i);
    expect(result.notes).toMatch(/sentinel cleanup failed:.*EPERM/i);
    // No abort prefix — happy path means `aborted` stays null, so notes
    // is the warnings-only string (covers the `: warnings` branch of
    // the ternary on line 374).
    expect(result.notes?.startsWith('cleanup warnings:')).toBe(true);
  });

  it('AISDLC-200: cleanupTask non-Error throw stringifies via String(err)', async () => {
    // Cover the `String(err)` fallback on line 321 — when the mocked
    // cleanupTask throws a non-Error value (e.g. `throw 'string'` or
    // `throw 42`), we still capture something meaningful in the
    // warnings array rather than dereferencing `.message` on undefined.
    writeTaskFile(tmp, {
      id: 'AISDLC-200-CLEAN-NONERR',
      title: 'cleanup throws non error',
      status: 'To Do',
      acceptanceCriteria: ['ship a thing'],
    });
    mkdirSync(join(tmp, '.worktrees', 'aisdlc-200-clean-nonerr'), { recursive: true });

    // Re-arm the mock for this test's invocation with a non-Error throw.
    const stepsModule = await import('./steps/index.js');
    vi.mocked(stepsModule.cleanupTask).mockImplementationOnce(async () => {
      throw 'plain-string-cleanup-error';
    });

    const result = await executePipeline({
      taskId: 'AISDLC-200-CLEAN-NONERR',
      workDir: tmp,
      spawner: makeApprovingSpawner(),
      runner: makeHappyRunner().toRunner(),
      skipFinalizeCommit: true,
      maxReviewIterations: 2,
    });

    expect(result.outcome).toBe('approved');
    expect(result.notes).toMatch(/sentinel cleanup failed: plain-string-cleanup-error/);
  });
});
