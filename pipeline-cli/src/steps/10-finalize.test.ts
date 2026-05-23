import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFinalSummary, finalizeTask, moveTaskToCompleted } from './10-finalize.js';
import { cleanupTmpProject, makeTmpProject, writeTaskFile } from '../__test-helpers/make-task.js';
import { FakeRunner, ok } from '../__test-helpers/fake-runner.js';
import type { AggregatedVerdict, DeveloperReturn, TaskSpec } from '../types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
});
afterEach(() => {
  cleanupTmpProject(tmp);
});

const task: TaskSpec = {
  id: 'AISDLC-1',
  title: 'demo',
  status: 'In Progress',
  acceptanceCriteria: ['a', 'b', 'c'],
  acceptanceCriteriaChecked: [false, false, false],
  description: 'desc',
  rawBody: '',
  filePath: '',
};

const dev: DeveloperReturn = {
  summary: 'shipped X',
  filesChanged: ['a.ts', 'b.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2, 3],
  notes: 'no follow-up needed',
};

function approved(): AggregatedVerdict {
  return {
    approved: true,
    decision: 'APPROVED',
    counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    verdicts: [],
    harnessNote: '',
    summary: 'APPROVED',
  };
}

function blocked(): AggregatedVerdict {
  return {
    approved: false,
    decision: 'CHANGES_REQUESTED',
    counts: { critical: 1, major: 0, minor: 0, suggestion: 0 },
    verdicts: [],
    harnessNote: '',
    summary: 'CHANGES_REQUESTED',
  };
}

describe('Step 10 — buildFinalSummary', () => {
  it('renders the canonical CLAUDE.md template', () => {
    const r = buildFinalSummary({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
    });
    expect(r.acceptanceCriteriaCheck).toEqual([1, 2, 3]);
    expect(r.finalSummary).toContain('## Summary');
    expect(r.finalSummary).toContain('shipped X');
    expect(r.finalSummary).toContain('- a.ts');
    expect(r.finalSummary).toContain('passed');
    expect(r.finalSummary).toContain('## Follow-up');
  });

  it('defaults acceptanceCriteriaCheck to all ACs when developer reports none', () => {
    const r = buildFinalSummary({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: { ...dev, acceptanceCriteriaMet: [] },
      verdict: approved(),
      iterations: 1,
    });
    expect(r.acceptanceCriteriaCheck).toEqual([1, 2, 3]);
  });

  it('appends harness note when present', () => {
    const r = buildFinalSummary({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: { ...approved(), harnessNote: '⚠ test note' },
      iterations: 1,
    });
    expect(r.finalSummary).toContain('⚠ test note');
  });
});

describe('Step 10 — moveTaskToCompleted', () => {
  it('moves the file from tasks/ to completed/', () => {
    const path = writeTaskFile(tmp, { id: 'AISDLC-2', title: 'm', status: 'In Progress' });
    const dest = moveTaskToCompleted(path);
    expect(dest).toBe(join(tmp, 'backlog', 'completed', 'aisdlc-2 - m.md'));
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});

describe('Step 10 — finalizeTask', () => {
  it('skips entirely when verdict is not APPROVED', async () => {
    const r = await finalizeTask({
      taskId: 'AISDLC-1',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: blocked(),
      iterations: 2,
      skipCommit: true,
    });
    expect(r.skipped).toBe(true);
    expect(r.choreCommitSha).toBeNull();
  });

  it('flips status to Done + moves file when APPROVED', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-3', title: 'three', status: 'In Progress' });
    const fake = new FakeRunner();
    const r = await finalizeTask({
      taskId: 'AISDLC-3',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
      skipCommit: true,
    });
    expect(r.skipped).toBe(false);
    const completedPath = join(tmp, 'backlog', 'completed', 'aisdlc-3 - three.md');
    expect(existsSync(completedPath)).toBe(true);
    expect(readFileSync(completedPath, 'utf8')).toContain('status: Done');
  });

  it('runs git add + commit when skipCommit is false', async () => {
    writeTaskFile(tmp, { id: 'AISDLC-4', title: 'four', status: 'In Progress' });
    const fake = new FakeRunner()
      .on(/^git add/, ok())
      .on(/^git commit/, ok())
      .on(/^git rev-parse --short HEAD/, ok('1234567\n'));
    const r = await finalizeTask({
      taskId: 'AISDLC-4',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
    });
    expect(r.choreCommitSha).toBe('1234567');
  });

  it('throws when task file is absent', async () => {
    await expect(
      finalizeTask({
        taskId: 'AISDLC-NOPE',
        workDir: tmp,
        worktreePath: tmp,
        task,
        developerReturn: dev,
        verdict: approved(),
        iterations: 1,
        skipCommit: true,
      }),
    ).rejects.toThrow(/cannot locate task file/);
  });

  // ── AISDLC-202.3 AC #3 + #4: Codex path uses atomic completion ──────

  it('AC #3: useAtomicCompletion uses completeTaskAtomically (task in exactly one backlog location)', async () => {
    // Regression guard for the AISDLC-201 / AISDLC-203 duplicate-record bug:
    // before AISDLC-203, the Codex workflow copied the completed file without
    // deleting the original, leaving the task in BOTH tasks/ and completed/.
    // This test asserts that useAtomicCompletion guarantees single-location.
    writeTaskFile(tmp, { id: 'AISDLC-5', title: 'five', status: 'In Progress' });
    const fake = new FakeRunner();
    const r = await finalizeTask({
      taskId: 'AISDLC-5',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
      skipCommit: true,
      useAtomicCompletion: true,
    });
    expect(r.skipped).toBe(false);
    const completedPath = join(tmp, 'backlog', 'completed', 'aisdlc-5 - five.md');
    const tasksPath = join(tmp, 'backlog', 'tasks', 'aisdlc-5 - five.md');
    // AC #4: task exists in EXACTLY ONE backlog location — completed/.
    expect(existsSync(completedPath)).toBe(true);
    expect(existsSync(tasksPath)).toBe(false);
    expect(readFileSync(completedPath, 'utf8')).toContain('status: Done');
  });

  it('AISDLC-409: extracts v6 envelope path (.v6.dsse.json) from sign-attestation stdout', async () => {
    // The regex at 10-finalize.ts:178 must match BOTH the v5 form
    // (<sha>.dsse.json) and the v6 form (<sha>.v6.dsse.json). Post-AISDLC-409,
    // v6 is the default signing schema, so this test guards against a regression
    // where the chore commit message would say "Signed at null" because the
    // pre-cutover regex required `\.dsse\.json` to follow the hex SHA directly.
    writeTaskFile(tmp, { id: 'AISDLC-7', title: 'seven', status: 'In Progress' });
    // Fake helper script: just needs to exist so the existsSync guard passes.
    const fakeHelper = join(tmp, 'fake-sign-attestation.mjs');
    writeFileSync(fakeHelper, '// noop\n');
    const v6PathInStdout =
      '.ai-sdlc/attestations/a0b1c2d3e4f5061728394a5b6c7d8e9f00112233.v6.dsse.json';
    const fake = new FakeRunner()
      // The signer invocation prints the envelope path to stdout.
      .on(/^node .*fake-sign-attestation\.mjs/, ok(`${v6PathInStdout}\n`))
      .on(/^git add/, ok())
      .on(/^git commit/, ok())
      .on(/^git rev-parse --short HEAD/, ok('abc1234\n'));
    const r = await finalizeTask({
      taskId: 'AISDLC-7',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
      signAttestationScript: fakeHelper,
    });
    expect(r.skipped).toBe(false);
    // The commit message must reference the v6 envelope path verbatim,
    // proving the regex matched and `attestationPath` was extracted (not null).
    const commitCall = fake.calls.find((c) => c.command === 'git' && c.args[0] === 'commit');
    expect(commitCall, 'expected a git commit call').toBeDefined();
    expect(commitCall!.args.join(' ')).toContain(v6PathInStdout);
    // Sanity: the regex must NOT have matched a v5 (.dsse.json) form that
    // accidentally captured only the hex prefix without the .v6 infix.
    expect(commitCall!.args.join(' ')).not.toContain(
      '.ai-sdlc/attestations/a0b1c2d3e4f5061728394a5b6c7d8e9f00112233.dsse.json',
    );
  });

  it('AISDLC-409: still extracts v5 envelope path (.dsse.json) — backward-compat', async () => {
    // Same regex must continue matching the v5 (legacy) form so opt-out flows
    // (AI_SDLC_V5_LEGACY=1) keep working.
    writeTaskFile(tmp, { id: 'AISDLC-8', title: 'eight', status: 'In Progress' });
    const fakeHelper = join(tmp, 'fake-sign-attestation-v5.mjs');
    writeFileSync(fakeHelper, '// noop\n');
    const v5PathInStdout =
      '.ai-sdlc/attestations/aabbccddeeff00112233445566778899aabbccdd.dsse.json';
    const fake = new FakeRunner()
      .on(/^node .*fake-sign-attestation-v5\.mjs/, ok(`${v5PathInStdout}\n`))
      .on(/^git add/, ok())
      .on(/^git commit/, ok())
      .on(/^git rev-parse --short HEAD/, ok('def5678\n'));
    const r = await finalizeTask({
      taskId: 'AISDLC-8',
      workDir: tmp,
      worktreePath: tmp,
      task,
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
      signAttestationScript: fakeHelper,
    });
    expect(r.skipped).toBe(false);
    const commitCall = fake.calls.find((c) => c.command === 'git' && c.args[0] === 'commit');
    expect(commitCall!.args.join(' ')).toContain(v5PathInStdout);
  });

  // ── AISDLC-393 — gh-issue source skips backlog file move/patch ──────

  it('AISDLC-393: gh-issue source skips tasks/→completed/ move (no file exists)', async () => {
    // No backlog file is staged — the issue is the source of truth and
    // there's nothing to move. The previous (file-required) path would
    // throw "cannot locate task file"; the gh-issue branch must NOT.
    const fake = new FakeRunner();
    const r = await finalizeTask({
      taskId: 'gh-issue-612',
      workDir: tmp,
      worktreePath: tmp,
      // Use an inline spec mirroring what fetchGhIssueAsTaskSpec produces.
      task: {
        id: 'gh-issue-612',
        title: 'demo issue',
        status: 'To Do',
        acceptanceCriteria: ['a'],
        acceptanceCriteriaChecked: [false],
        description: 'body',
        rawBody: 'body',
        filePath: '<gh-issue:612>',
      },
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
      skipCommit: true,
      sourceKind: 'gh-issue',
    });

    expect(r.skipped).toBe(false);
    // No backlog file should have been created or moved.
    expect(existsSync(join(tmp, 'backlog', 'tasks', 'gh-issue-612 - demo-issue.md'))).toBe(false);
    expect(existsSync(join(tmp, 'backlog', 'completed', 'gh-issue-612 - demo-issue.md'))).toBe(
      false,
    );
    // finalSummary is still rendered (orchestrator needs it for PR body).
    expect(r.finalSummary).toContain('## Summary');
    expect(r.finalSummary).toContain('shipped X');
  });

  it('AISDLC-393: gh-issue source skips chore commit when no attestation was signed', async () => {
    // Without an attestation envelope to stage AND no backlog file to add,
    // there's nothing to commit on the gh-issue path. The runner should
    // never be invoked with `git add` / `git commit` in that case.
    const fake = new FakeRunner();
    const r = await finalizeTask({
      taskId: 'gh-issue-7',
      workDir: tmp,
      worktreePath: tmp,
      task: {
        id: 'gh-issue-7',
        title: 't',
        status: 'To Do',
        acceptanceCriteria: ['a'],
        acceptanceCriteriaChecked: [false],
        description: '',
        rawBody: '',
        filePath: '<gh-issue:7>',
      },
      developerReturn: dev,
      verdict: approved(),
      iterations: 1,
      runner: fake.toRunner(),
      // skipCommit: false (default-ish) — to verify the no-op decision lives
      // inside the gh-issue branch, not in skipCommit.
      sourceKind: 'gh-issue',
    });

    expect(r.choreCommitSha).toBeNull();
    const gitCalls = fake.calls.filter((c) => c.command === 'git');
    expect(gitCalls.find((c) => c.args[0] === 'add')).toBeUndefined();
    expect(gitCalls.find((c) => c.args[0] === 'commit')).toBeUndefined();
  });

  it('AC #4: regression — Codex workflow does not create duplicate backlog entries', async () => {
    // AISDLC-201 root cause: the Codex workflow copied the file to
    // backlog/completed/ WITHOUT removing it from backlog/tasks/. This left
    // the task visible in both locations. completeTaskAtomically throws a
    // DuplicateTaskFileError when a duplicate already exists, ensuring the
    // invariant is detectable before push.
    writeTaskFile(tmp, { id: 'AISDLC-6', title: 'six', status: 'In Progress' });
    // Manually create a stale completed/ copy (simulating the AISDLC-201 bug).
    const completedDir = join(tmp, 'backlog', 'completed');
    mkdirSync(completedDir, { recursive: true });
    writeFileSync(
      join(completedDir, 'aisdlc-6 - six.md'),
      '---\nid: AISDLC-6\ntitle: six\nstatus: Done\n---\n',
    );
    // When both copies exist, completeTaskAtomically should throw — finalizeTask
    // surfaces this as a rejected promise so the pipeline can abort cleanly.
    await expect(
      finalizeTask({
        taskId: 'AISDLC-6',
        workDir: tmp,
        worktreePath: tmp,
        task,
        developerReturn: dev,
        verdict: approved(),
        iterations: 1,
        skipCommit: true,
        useAtomicCompletion: true,
      }),
    ).rejects.toThrow(/DUPLICATE DETECTED|cli-task-complete/);
  });
});
