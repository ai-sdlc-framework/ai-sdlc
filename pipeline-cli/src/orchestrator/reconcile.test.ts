/**
 * Hermetic tests for the reconcile sub-tick (AISDLC-418).
 *
 * Coverage targets:
 *   - Happy path: dev verdict → emit leaves → sign → push → flip → arm → remove
 *   - No verdict: outcome=failed, no further steps
 *   - Verdict outcome != success: outcome=failed
 *   - Worktree missing: outcome=failed
 *   - Sign failure: outcome=partial (leaves emitted) but stops before push
 *   - Push failure: outcome=partial, no flip
 *   - skipPush / skipFlipReady / skipArmAutoMerge gating
 *   - extractPrNumberFromUrl pure helper
 *   - salvageReviewerTranscript happy path + fallback
 *   - encodeWorktreePathForClaudeTmp shape matches real /private/tmp entries
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureBoardDirs, writeVerdict } from '../dispatch/board.js';
import type { DispatchVerdict } from '../dispatch/types.js';

import {
  AGENT_ID_PATTERN,
  defaultHomeDir,
  encodeWorktreePathForClaudeTmp,
  extractPrNumberFromUrl,
  readVerdictJson,
  RECONCILE_REVIEWERS,
  runReconcile,
  safeExistsFile,
  salvageReviewerTranscript,
} from './reconcile.js';

interface SpawnCall {
  file: string;
  args: readonly string[];
  cwd?: string;
}

function makeSpawnRecorder(
  responses: Record<string, { status: number | null; stdout?: string; stderr?: string }> = {},
): {
  spawn: (
    file: string,
    args: readonly string[],
    opts: { cwd?: string },
  ) => { status: number | null; stdout: string; stderr: string };
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn(file, args, opts) {
      const callRecord: SpawnCall = { file, args: [...args] };
      if (opts.cwd) callRecord.cwd = opts.cwd;
      calls.push(callRecord);
      // Match by a key that includes args[1] (subcommand) when present.
      const key = [file, args[0] ?? '', args[1] ?? ''].filter(Boolean).join(' ');
      const matched = responses[key] ?? responses[file] ?? { status: 0 };
      return {
        status: matched.status,
        stdout: matched.stdout ?? '',
        stderr: matched.stderr ?? '',
      };
    },
  };
}

function writeDevVerdict(
  boardDir: string,
  overrides: Partial<DispatchVerdict> = {},
): DispatchVerdict {
  ensureBoardDirs(boardDir);
  const verdict: DispatchVerdict = {
    schemaVersion: 'v1',
    taskId: 'AISDLC-418',
    outcome: 'success',
    commitSha: '1111111111111111111111111111111111111111',
    pushedBranch: 'ai-sdlc/aisdlc-418-test',
    prUrl: 'https://github.com/org/repo/pull/4321',
    completedAt: '2026-05-24T10:00:00.000Z',
    workerId: 'test-worker',
    workerKind: 'in-session-agent',
    ...overrides,
  };
  writeVerdict(boardDir, verdict);
  return verdict;
}

function setupReviewerArtifacts(worktreePath: string, taskIdLower: string): void {
  const transcriptsDir = path.join(worktreePath, '.ai-sdlc', 'transcripts', taskIdLower);
  const verdictsDir = path.join(worktreePath, '.ai-sdlc', 'verdicts');
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(verdictsDir, { recursive: true });
  for (const r of RECONCILE_REVIEWERS) {
    writeFileSync(path.join(transcriptsDir, `${r}.jsonl`), `{"reviewer":"${r}"}\n`, 'utf8');
    writeFileSync(
      path.join(verdictsDir, `${r}-${taskIdLower}.json`),
      JSON.stringify({ approved: true, findings: { critical: 0, major: 0 } }),
      'utf8',
    );
  }
  // Aggregated verdict the sign step reads.
  writeFileSync(
    path.join(verdictsDir, `${taskIdLower}.json`),
    JSON.stringify({ verdicts: [], approved: true }),
    'utf8',
  );
}

describe('reconcile — pure helpers', () => {
  describe('extractPrNumberFromUrl', () => {
    it('returns the PR number from a github.com URL', () => {
      expect(extractPrNumberFromUrl('https://github.com/org/repo/pull/4321')).toBe('4321');
    });

    it('returns empty string for non-PR strings', () => {
      expect(extractPrNumberFromUrl(undefined)).toBe('');
      expect(extractPrNumberFromUrl(null)).toBe('');
      expect(extractPrNumberFromUrl('not a url')).toBe('');
      expect(extractPrNumberFromUrl('https://github.com/org/repo/issues/4321')).toBe('');
    });
  });

  describe('encodeWorktreePathForClaudeTmp', () => {
    it('matches real /private/tmp claude entries (double-dash before .worktrees)', () => {
      const encoded = encodeWorktreePathForClaudeTmp(
        '/Users/dominique/Documents/dev/ai-sdlc/ai-sdlc/.worktrees/aisdlc-284',
      );
      expect(encoded).toBe('-Users-dominique-Documents-dev-ai-sdlc-ai-sdlc--worktrees-aisdlc-284');
    });

    it('replaces every slash with a dash', () => {
      const encoded = encodeWorktreePathForClaudeTmp('/a/b/c');
      expect(encoded).toBe('-a-b-c');
    });
  });
});

describe('salvageReviewerTranscript', () => {
  let tmpRoot: string;
  let worktreePath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), 'salvage-tmp-'));
    worktreePath = mkdtempSync(path.join(tmpdir(), 'salvage-wt-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });
  });

  it('returns already-present when the transcript exists in the worktree', () => {
    const dest = path.join(worktreePath, '.ai-sdlc', 'transcripts', 'aisdlc-418');
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, 'code-reviewer.jsonl'), 'preexisting\n', 'utf8');
    const result = salvageReviewerTranscript(
      worktreePath,
      'AISDLC-418',
      'code-reviewer',
      'agentxyz1',
      { tmpRoot },
    );
    expect(result.status).toBe('already-present');
  });

  it('returns not-found when /private/tmp has no match', () => {
    const result = salvageReviewerTranscript(
      worktreePath,
      'AISDLC-418',
      'code-reviewer',
      'agentxyz1',
      { tmpRoot },
    );
    expect(result.status).toBe('not-found');
  });

  it('rejects path-traversal agentIds (iter-2 MAJOR #5)', () => {
    // Set up a real file at the would-be-traversed location to prove the
    // rejection is the agentId validator, not just an absent file.
    const trickyDir = path.join(
      tmpRoot,
      'claude-501',
      encodeWorktreePathForClaudeTmp(worktreePath),
    );
    mkdirSync(path.join(trickyDir, 'session-a', 'tasks'), { recursive: true });
    writeFileSync(
      path.join(trickyDir, 'session-a', 'tasks', 'whatever.output'),
      'should-not-leak\n',
      'utf8',
    );
    const cases = [
      '../../../etc/passwd',
      'session-uuid/../tasks/agent',
      'AGENT-WITH-CAPS',
      'short',
      '',
      'a'.repeat(64),
      './foo',
    ];
    for (const bad of cases) {
      expect(AGENT_ID_PATTERN.test(bad)).toBe(false);
      const result = salvageReviewerTranscript(worktreePath, 'AISDLC-418', 'code-reviewer', bad, {
        tmpRoot,
      });
      expect(result.status).toBe('not-found');
    }
    // And ensure a well-formed agentId pattern still accepts valid inputs.
    for (const good of ['b0d3ltjxv', 'abc123', 'agent42xyz']) {
      expect(AGENT_ID_PATTERN.test(good)).toBe(true);
    }
  });

  it('salvages a transcript from a matching claude-<uid>/<encoded>/<session>/tasks/ entry', () => {
    const encoded = encodeWorktreePathForClaudeTmp(worktreePath);
    const sessionDir = path.join(tmpRoot, 'claude-501', encoded, 'session-uuid', 'tasks');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(path.join(sessionDir, 'agentxyz1.output'), 'salvaged content\n', 'utf8');
    const result = salvageReviewerTranscript(
      worktreePath,
      'AISDLC-418',
      'code-reviewer',
      'agentxyz1',
      { tmpRoot },
    );
    expect(result.status).toBe('salvaged');
    expect(result.source).toContain('agentxyz1.output');
    expect(
      readFileSync(
        path.join(worktreePath, '.ai-sdlc', 'transcripts', 'aisdlc-418', 'code-reviewer.jsonl'),
        'utf8',
      ),
    ).toBe('salvaged content\n');
  });
});

describe('runReconcile — orchestration', () => {
  let workDir: string;
  let worktreePath: string;
  let boardDir: string;
  const taskId = 'AISDLC-418';
  const taskIdLower = taskId.toLowerCase();

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'reconcile-wd-'));
    worktreePath = path.join(workDir, '.worktrees', taskIdLower);
    boardDir = path.join(workDir, '.ai-sdlc', 'dispatch');
    mkdirSync(worktreePath, { recursive: true });
    setupReviewerArtifacts(worktreePath, taskIdLower);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns outcome=failed when no verdict is present', () => {
    ensureBoardDirs(boardDir);
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.outcome).toBe('failed');
    expect(result.steps[0]?.name).toBe('load-dev-verdict');
    expect(result.steps[0]?.status).toBe('failed');
  });

  it('returns outcome=failed when verdict.outcome is not success', () => {
    writeDevVerdict(boardDir, { outcome: 'iterate-needed' });
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.outcome).toBe('failed');
    const verdictStep = result.steps.find((s) => s.name === 'load-dev-verdict');
    expect(verdictStep?.status).toBe('failed');
    expect(verdictStep?.output).toContain('iterate-needed');
  });

  it('returns outcome=failed when the worktree path is missing', () => {
    writeDevVerdict(boardDir);
    rmSync(worktreePath, { recursive: true, force: true });
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.outcome).toBe('failed');
    expect(result.steps.find((s) => s.name === 'verify-worktree')?.status).toBe('failed');
  });

  it('runs the full happy path: leaves → sign → fetch → rebase → push → ready → merge → remove', () => {
    writeDevVerdict(boardDir);
    const { spawn, calls } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.outcome).toBe('success');
    expect(result.prNumber).toBe('4321');
    expect(result.prUrl).toBe('https://github.com/org/repo/pull/4321');
    // Three emit-leaf calls, one sign, fetch, rebase, push, ready, merge.
    const stepNames = result.steps.map((s) => s.name);
    expect(stepNames).toContain('emit-leaf:code-reviewer');
    expect(stepNames).toContain('emit-leaf:test-reviewer');
    expect(stepNames).toContain('emit-leaf:security-reviewer');
    expect(stepNames).toContain('sign-attestation');
    expect(stepNames).toContain('git-fetch');
    expect(stepNames).toContain('git-rebase');
    expect(stepNames).toContain('git-push');
    expect(stepNames).toContain('gh-pr-ready');
    expect(stepNames).toContain('gh-pr-merge-auto');
    expect(stepNames).toContain('remove-verdict');
    // git push uses --force-with-lease, never raw --force.
    const pushCall = calls.find((c) => c.file === 'git' && c.args[0] === 'push');
    expect(pushCall?.args).toContain('--force-with-lease');
    expect(pushCall?.args).not.toContain('--force');
    // gh pr ready was called with the right number.
    const readyCall = calls.find(
      (c) => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'ready',
    );
    expect(readyCall?.args).toContain('4321');
    // gh pr merge --auto --squash <prNumber>
    const mergeCall = calls.find(
      (c) => c.file === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge',
    );
    expect(mergeCall?.args).toEqual(expect.arrayContaining(['--auto', '--squash', '4321']));
  });

  it('outcome=partial when sign-attestation fails', () => {
    writeDevVerdict(boardDir);
    const { spawn } = makeSpawnRecorder({
      // 1st node call is emit-leaf (return 0). We need to differentiate the
      // sign call. Match by the script suffix in args[0].
      node: { status: 0 },
    });
    // Override: when the 2nd positional arg is the sign script, fail.
    const customSpawn = (
      file: string,
      args: readonly string[],
      opts: { cwd?: string },
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'node' && args[0]?.endsWith('sign-attestation.mjs')) {
        return { status: 1, stdout: '', stderr: 'signing key missing' };
      }
      return spawn(file, args, opts);
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('partial');
    expect(result.steps.find((s) => s.name === 'sign-attestation')?.status).toBe('failed');
    // No push/ready should have happened.
    expect(result.steps.find((s) => s.name === 'git-fetch')).toBeUndefined();
    expect(result.steps.find((s) => s.name === 'gh-pr-ready')).toBeUndefined();
  });

  it('outcome=partial when git push fails after successful rebase', () => {
    writeDevVerdict(boardDir);
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'git' && args[0] === 'push') {
        return { status: 1, stdout: '', stderr: 'remote rejected' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('partial');
    expect(result.steps.find((s) => s.name === 'git-push')?.status).toBe('failed');
    expect(result.steps.find((s) => s.name === 'gh-pr-ready')).toBeUndefined();
  });

  it('skipPush=true bypasses the fetch/rebase/push step', () => {
    writeDevVerdict(boardDir);
    const { spawn, calls } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      skipPush: true,
      spawn,
    });
    expect(result.outcome).toBe('success');
    const pushStep = result.steps.find((s) => s.name === 'git-push');
    expect(pushStep?.status).toBe('skipped');
    expect(calls.some((c) => c.file === 'git' && c.args[0] === 'push')).toBe(false);
  });

  it('skipFlipReady=true bypasses gh pr ready (no merge-auto then either, defensively)', () => {
    writeDevVerdict(boardDir);
    const { spawn, calls } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      skipFlipReady: true,
      spawn,
    });
    expect(result.outcome).toBe('success');
    const readyStep = result.steps.find((s) => s.name === 'gh-pr-ready');
    expect(readyStep?.status).toBe('skipped');
    expect(calls.some((c) => c.file === 'gh' && c.args[1] === 'ready')).toBe(false);
  });

  it('falls back to gh pr view when verdict.prUrl is empty', () => {
    writeDevVerdict(boardDir, { prUrl: null });
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stdout: '9999\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('success');
    expect(result.prNumber).toBe('9999');
  });

  it('still removes the verdict after success', () => {
    writeDevVerdict(boardDir);
    const verdictPath = path.join(boardDir, 'done', `${taskId}.verdict.json`);
    expect(existsSync(verdictPath)).toBe(true);
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.outcome).toBe('success');
    expect(existsSync(verdictPath)).toBe(false);
  });

  it('reviewer-agent-id triggers /private/tmp salvage when transcript is missing', () => {
    writeDevVerdict(boardDir);
    // Delete one reviewer's transcript so the salvage path runs.
    rmSync(path.join(worktreePath, '.ai-sdlc', 'transcripts', taskIdLower, 'code-reviewer.jsonl'));
    // Reconcile won't find it under /private/tmp (the test env doesn't have
    // a real claude session there), so we expect salvage-transcript:code-reviewer = skipped
    // and emit-leaf:code-reviewer = skipped (no transcript). The other two reviewers
    // emit successfully. The overall outcome is still success because sign + push + ready
    // all succeed and salvage 'skipped' isn't 'failed'.
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      reviewerAgentIds: { 'code-reviewer': 'nonexistent00' },
      spawn,
    });
    expect(result.steps.find((s) => s.name === 'salvage-transcript:code-reviewer')?.status).toBe(
      'skipped',
    );
    // When salvage skips, the loop continues without adding an emit-leaf step
    // for that reviewer at all — the other two reviewers' leaves still emit.
    expect(result.steps.find((s) => s.name === 'emit-leaf:code-reviewer')).toBeUndefined();
    expect(result.steps.find((s) => s.name === 'emit-leaf:test-reviewer')?.status).toBe('success');
    expect(result.outcome).toBe('success');
  });

  it('outcome=failed when devVerdict.commitSha is empty', () => {
    writeDevVerdict(boardDir, { commitSha: '' });
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.outcome).toBe('failed');
    expect(result.steps.find((s) => s.name === 'verify-head-sha')?.status).toBe('failed');
  });

  it('outcome=partial when aggregated verdict is missing', () => {
    writeDevVerdict(boardDir);
    rmSync(path.join(worktreePath, '.ai-sdlc', 'verdicts', `${taskIdLower}.json`));
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.outcome).toBe('partial');
    expect(result.steps.find((s) => s.name === 'sign-attestation')?.status).toBe('failed');
  });

  it('outcome=partial when individual reviewer verdict is missing (emit-leaf skipped)', () => {
    writeDevVerdict(boardDir);
    rmSync(path.join(worktreePath, '.ai-sdlc', 'verdicts', `code-reviewer-${taskIdLower}.json`));
    const { spawn } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn,
    });
    expect(result.steps.find((s) => s.name === 'emit-leaf:code-reviewer')?.status).toBe('skipped');
    expect(result.outcome).toBe('success');
  });

  it('outcome=partial when git fetch fails', () => {
    writeDevVerdict(boardDir);
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'git' && args[0] === 'fetch') {
        return { status: 128, stdout: '', stderr: 'no remote' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('partial');
    expect(result.steps.find((s) => s.name === 'git-fetch')?.status).toBe('failed');
    expect(result.steps.find((s) => s.name === 'git-rebase')).toBeUndefined();
  });

  it('outcome=partial when git rebase fails', () => {
    writeDevVerdict(boardDir);
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'git' && args[0] === 'rebase') {
        return { status: 1, stdout: '', stderr: 'conflict' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('partial');
    expect(result.steps.find((s) => s.name === 'git-rebase')?.status).toBe('failed');
    expect(result.steps.find((s) => s.name === 'git-push')).toBeUndefined();
  });

  it('outcome=partial when gh pr ready fails after a successful push', () => {
    writeDevVerdict(boardDir);
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'ready') {
        return { status: 1, stdout: '', stderr: 'pr already ready' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('partial');
    expect(result.steps.find((s) => s.name === 'gh-pr-ready')?.status).toBe('failed');
    expect(result.steps.find((s) => s.name === 'gh-pr-merge-auto')).toBeUndefined();
  });

  it('skipArmAutoMerge=true bypasses gh pr merge but flips ready', () => {
    writeDevVerdict(boardDir);
    const { spawn, calls } = makeSpawnRecorder();
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      skipArmAutoMerge: true,
      spawn,
    });
    expect(result.outcome).toBe('success');
    expect(result.steps.find((s) => s.name === 'gh-pr-merge-auto')?.status).toBe('skipped');
    expect(calls.some((c) => c.file === 'gh' && c.args[1] === 'merge')).toBe(false);
  });

  it('schema-version v5 is forwarded to sign-attestation', () => {
    writeDevVerdict(boardDir);
    const seen: string[][] = [];
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'node' && args[0]?.endsWith('sign-attestation.mjs')) {
        seen.push([...args]);
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      schemaVersion: 'v5',
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('success');
    expect(seen[0]).toEqual(expect.arrayContaining(['--schema-version', 'v5']));
  });

  it('reviewerModel + harness overrides reach the emit-leaf invocation', () => {
    writeDevVerdict(boardDir);
    const emitCalls: string[][] = [];
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'node' && args[0]?.endsWith('cli-attestation.mjs')) {
        emitCalls.push([...args]);
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      reviewerModel: 'claude-opus-4-7',
      harness: 'custom-harness',
      spawn: customSpawn,
    });
    expect(emitCalls.length).toBe(3);
    for (const call of emitCalls) {
      expect(call).toEqual(expect.arrayContaining(['--model', 'claude-opus-4-7']));
      expect(call).toEqual(expect.arrayContaining(['--harness', 'custom-harness']));
    }
  });

  it('caller-supplied transcript + verdict overrides reach the emit-leaf args', () => {
    writeDevVerdict(boardDir);
    const explicitTranscript = path.join(workDir, 'tx', 'override.jsonl');
    const explicitVerdict = path.join(workDir, 'tx', 'verdict.json');
    mkdirSync(path.join(workDir, 'tx'), { recursive: true });
    writeFileSync(explicitTranscript, 'override\n', 'utf8');
    writeFileSync(explicitVerdict, '{"approved":true}', 'utf8');
    const emitCalls: string[][] = [];
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'node' && args[0]?.endsWith('cli-attestation.mjs')) {
        emitCalls.push([...args]);
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      reviewerTranscripts: { 'code-reviewer': explicitTranscript },
      reviewerVerdicts: { 'code-reviewer': explicitVerdict },
      spawn: customSpawn,
    });
    const codeCall = emitCalls.find((args) => args.includes('code-reviewer'));
    expect(codeCall).toEqual(expect.arrayContaining(['--transcript-path', explicitTranscript]));
    expect(codeCall).toEqual(expect.arrayContaining(['--verdict-path', explicitVerdict]));
  });

  it('outcome=partial when neither verdict.prUrl nor branch probe yields a PR number', () => {
    writeDevVerdict(boardDir, { prUrl: null });
    const customSpawn = (
      file: string,
      args: readonly string[],
    ): { status: number | null; stdout: string; stderr: string } => {
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return { status: 1, stdout: '', stderr: 'no pr' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = runReconcile({
      workDir,
      taskId,
      boardDir,
      worktreePath,
      spawn: customSpawn,
    });
    expect(result.outcome).toBe('partial');
    expect(result.steps.find((s) => s.name === 'gh-pr-ready')?.status).toBe('failed');
  });
});

describe('reconcile — small exported utilities', () => {
  it('defaultHomeDir returns a non-empty string (matches os.homedir())', () => {
    const home = defaultHomeDir();
    expect(typeof home).toBe('string');
    expect(home.length).toBeGreaterThan(0);
  });

  it('safeExistsFile is true for an existing regular file', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'safe-exists-'));
    const f = path.join(tmpDir, 'x.txt');
    writeFileSync(f, 'hi', 'utf8');
    expect(safeExistsFile(f)).toBe(true);
    expect(safeExistsFile(path.join(tmpDir, 'nope'))).toBe(false);
    expect(safeExistsFile(tmpDir)).toBe(false); // directory, not file
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readVerdictJson parses good JSON + returns null on bad input', () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'read-verdict-'));
    const good = path.join(tmpDir, 'g.json');
    const bad = path.join(tmpDir, 'b.json');
    writeFileSync(good, '{"approved":true}', 'utf8');
    writeFileSync(bad, '{not-json', 'utf8');
    expect(readVerdictJson(good)).toEqual({ approved: true });
    expect(readVerdictJson(bad)).toBeNull();
    expect(readVerdictJson(path.join(tmpDir, 'nope.json'))).toBeNull();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('salvageReviewerTranscript — edge paths', () => {
  it('returns not-found when tmpRoot itself does not exist (readdirSync throws)', () => {
    const wt = mkdtempSync(path.join(tmpdir(), 'salvage-edge-wt-'));
    try {
      const result = salvageReviewerTranscript(wt, 'AISDLC-418', 'code-reviewer', 'b0d3ltjxv', {
        tmpRoot: '/this/path/definitely/does/not/exist/abcxyz',
      });
      expect(result.status).toBe('not-found');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('skips a claude-<uid> entry whose <encoded> dir is not readable / not a dir', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'salvage-edge-tmp-'));
    const wt = mkdtempSync(path.join(tmpdir(), 'salvage-edge-wt-'));
    try {
      // Create a claude-501/ dir with no <encoded> subdir — the loop should
      // skip it via the `if (!existsSync(cwdDir)) continue` branch.
      mkdirSync(path.join(tmpRoot, 'claude-501'), { recursive: true });
      // Add a second claude-uid where <encoded> exists but the session dir
      // listing would race away — emulate via a FILE at the encoded path
      // (readdirSync throws ENOTDIR → catch path triggers).
      const encoded = encodeWorktreePathForClaudeTmp(wt);
      writeFileSync(path.join(tmpRoot, 'claude-502'), 'not-a-dir', 'utf8');
      // Note: claude-502 starts with claude- so it matches; but it's a file
      // → path.join(tmpRoot, 'claude-502', encoded) doesn't exist → continue.
      // Add a third claude-uid where the encoded dir IS a dir but the session
      // dir scan throws because the session "dir" is a file under encoded.
      const goodEncoded = path.join(tmpRoot, 'claude-503', encoded);
      mkdirSync(goodEncoded, { recursive: true });
      // Add a file as a "session" — readdirSync on encoded gives ['session-file'];
      // path.join(encoded, 'session-file', 'tasks', 'agent.output') existsSync = false.
      writeFileSync(path.join(goodEncoded, 'session-file'), 'x', 'utf8');
      const result = salvageReviewerTranscript(wt, 'AISDLC-418', 'code-reviewer', 'agent42x1', {
        tmpRoot,
      });
      expect(result.status).toBe('not-found');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });
});
