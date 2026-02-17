import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveIssue, type IssueResolution } from './issue-linker.js';
import { execFile } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

function mockExec(stdout: string) {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb?: unknown) => {
    // promisify wraps execFile — the callback is the last arg
    const callback = (typeof _opts === 'function' ? _opts : cb) as
      (err: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(null, { stdout, stderr: '' });
    return undefined as never;
  });
}

function mockExecSequence(outputs: string[]) {
  let callIndex = 0;
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb?: unknown) => {
    const callback = (typeof _opts === 'function' ? _opts : cb) as
      (err: Error | null, result: { stdout: string; stderr: string }) => void;
    const stdout = outputs[callIndex] ?? '';
    callIndex++;
    callback(null, { stdout, stderr: '' });
    return undefined as never;
  });
}

function mockExecFail() {
  mockExecFile.mockImplementation((_cmd, _args, _opts, cb?: unknown) => {
    const callback = (typeof _opts === 'function' ? _opts : cb) as
      (err: Error | null, result: { stdout: string; stderr: string }) => void;
    callback(new Error('git not available'), { stdout: '', stderr: '' });
    return undefined as never;
  });
}

describe('resolveIssue', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves from strict branch pattern (ai-sdlc/issue-42)', async () => {
    mockExec('ai-sdlc/issue-42\n');
    const result = await resolveIssue('/repo');
    expect(result).toEqual({ issueNumber: 42, method: 'branch', confidence: 1.0 });
  });

  it('resolves from loose branch pattern (issue-123)', async () => {
    mockExec('feature/issue-123\n');
    const result = await resolveIssue('/repo');
    expect(result).toEqual({ issueNumber: 123, method: 'branch', confidence: 0.8 });
  });

  it('resolves from loose branch pattern (issue_7)', async () => {
    mockExec('issue_7\n');
    const result = await resolveIssue('/repo');
    expect(result).toEqual({ issueNumber: 7, method: 'branch', confidence: 0.8 });
  });

  it('falls back to explicit issue when branch has no match', async () => {
    mockExec('main\n');
    const result = await resolveIssue('/repo', 99);
    expect(result).toEqual({ issueNumber: 99, method: 'explicit', confidence: 1.0 });
  });

  it('falls back to git context when no branch or explicit', async () => {
    mockExecSequence([
      'main\n',                              // rev-parse --abbrev-ref HEAD
      'abc1234 fixes #55\ndef5678 update\n', // git log --oneline -20
    ]);
    const result = await resolveIssue('/repo');
    expect(result).toEqual({ issueNumber: 55, method: 'git-context', confidence: 0.6 });
  });

  it('picks most-referenced issue from git log', async () => {
    mockExecSequence([
      'main\n',
      'a fix #10\nb fix #20\nc ref #20\nd fix #10\ne fix #10\n',
    ]);
    const result = await resolveIssue('/repo');
    expect(result.issueNumber).toBe(10);
    expect(result.method).toBe('git-context');
  });

  it('returns unattributed when nothing matches', async () => {
    mockExecSequence(['main\n', 'abc1234 no refs here\n']);
    const result = await resolveIssue('/repo');
    expect(result).toEqual({ issueNumber: null, method: 'unattributed', confidence: 0 });
  });

  it('returns unattributed when git fails', async () => {
    mockExecFail();
    const result = await resolveIssue('/repo');
    expect(result).toEqual({ issueNumber: null, method: 'unattributed', confidence: 0 });
  });

  it('branch takes priority over explicit', async () => {
    mockExec('ai-sdlc/issue-77\n');
    const result = await resolveIssue('/repo', 99);
    expect(result.issueNumber).toBe(77);
    expect(result.method).toBe('branch');
  });
});
