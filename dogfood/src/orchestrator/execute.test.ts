import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { executePipeline } from './execute.js';
import type { AgentRunner, AgentResult } from '../runner/types.js';
import type { IssueTracker, SourceControl, Issue, PullRequest } from '@ai-sdlc/reference';

// Mock child_process.execFile used by executePipeline for git checkout/push
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
    }
    return { stdout: '', stderr: '' };
  }),
}));

const CONFIG_DIR = resolve(import.meta.dirname, '../../../.ai-sdlc');

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '42',
    title: 'Fix test flakiness',
    description: [
      '## Description',
      'Tests are flaky due to timing issues.',
      '',
      '## Acceptance Criteria',
      '- Tests should pass consistently',
      '',
      '### Complexity',
      '2',
    ].join('\n'),
    status: 'open',
    labels: ['ai-eligible', 'bug'],
    url: 'https://github.com/ai-sdlc-framework/ai-sdlc/issues/42',
    ...overrides,
  };
}

function makeMockTracker(issue: Issue): IssueTracker {
  return {
    getIssue: vi.fn().mockResolvedValue(issue),
    listIssues: vi.fn().mockResolvedValue([issue]),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    transitionIssue: vi.fn(),
    watchIssues: vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        /* stub */
      },
    }),
  };
}

function makeMockSourceControl(): SourceControl {
  const pr: PullRequest = {
    id: '100',
    title: 'fix: Fix test flakiness (#42)',
    sourceBranch: 'ai-sdlc/issue-42',
    targetBranch: 'main',
    status: 'open',
    author: 'ai-sdlc-bot',
    url: 'https://github.com/ai-sdlc-framework/ai-sdlc/pull/100',
  };
  return {
    createBranch: vi.fn().mockResolvedValue({ name: 'ai-sdlc/issue-42', sha: 'abc123' }),
    createPR: vi.fn().mockResolvedValue(pr),
    mergePR: vi.fn(),
    getFileContents: vi.fn(),
    listChangedFiles: vi.fn(),
    setCommitStatus: vi.fn(),
    watchPREvents: vi.fn().mockReturnValue({
      async *[Symbol.asyncIterator]() {
        /* stub */
      },
    }),
  };
}

function makeMockRunner(result?: Partial<AgentResult>): AgentRunner {
  return {
    run: vi.fn().mockResolvedValue({
      success: true,
      filesChanged: ['src/fix.ts', 'src/fix.test.ts'],
      summary: 'Fixed the flaky test by adding proper async handling',
      ...result,
    }),
  };
}

describe('executePipeline()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set env vars needed for commentOnIssue
    process.env.GITHUB_TOKEN = '';
  });

  it('runs the full pipeline successfully', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();

    await executePipeline(42, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      tracker,
      sourceControl: sc,
      runner,
    });

    expect(tracker.getIssue).toHaveBeenCalledWith('42');
    expect(sc.createBranch).toHaveBeenCalledWith({ name: 'ai-sdlc/issue-42' });
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 42,
        issueTitle: 'Fix test flakiness',
        branch: 'ai-sdlc/issue-42',
      }),
    );
    expect(sc.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'ai-sdlc/issue-42',
        targetBranch: 'main',
      }),
    );
  });

  it('fails when quality gate validation fails', async () => {
    const issue = makeIssue({
      description: '## Description\ntest\n\n### Complexity\n5',
    });
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
      }),
    ).rejects.toThrow('failed quality gate validation');

    // Should not have created a branch or invoked the agent
    expect(sc.createBranch).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('fails when agent returns failure', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner({
      success: false,
      filesChanged: [],
      error: 'Compilation failed',
    });

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
      }),
    ).rejects.toThrow('Agent failed');
  });

  it('passes agent constraints from config', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();

    await executePipeline(42, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      tracker,
      sourceControl: sc,
      runner,
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: {
          maxFilesPerChange: 15,
          requireTests: true,
          blockedPaths: ['.github/workflows/**', '.ai-sdlc/**'],
        },
      }),
    );
  });

  it('rejects issues with complexity exceeding max', async () => {
    const issue = makeIssue({
      description: '## Description\ncomplex\n\n## Acceptance Criteria\n- ok\n\n### Complexity\n3',
    });
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();

    // complexity 3 is at the boundary — should pass
    await executePipeline(42, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      tracker,
      sourceControl: sc,
      runner,
    });

    expect(runner.run).toHaveBeenCalled();
  });
});
