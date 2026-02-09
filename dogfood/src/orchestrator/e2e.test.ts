/**
 * E2E integration tests — uses real .ai-sdlc/ config with mocked adapters + runner.
 *
 * Validates full orchestrator wiring including post-agent guardrail enforcement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { executePipeline } from './execute.js';
import type { AgentRunner, AgentResult } from '../runner/types.js';
import type { IssueTracker, SourceControl, Issue, PullRequest, AuditLog } from '@ai-sdlc/reference';
import type { Logger } from './logger.js';

// Mock child_process.execFile used by executePipeline for git checkout/push
// and by validateAgentOutput for git diff --stat
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
    }
    return { stdout: '', stderr: '' };
  }),
}));

const CONFIG_DIR = resolve(import.meta.dirname, '../../../.ai-sdlc');

/** Silent logger to avoid noise in test output. */
function makeSilentLogger(): Logger {
  return {
    stage: vi.fn(),
    stageEnd: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    summary: vi.fn(),
  };
}

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

function makeMockAuditLog(): AuditLog {
  return {
    record: vi.fn().mockImplementation((entry) => ({
      id: 'test-id',
      timestamp: new Date().toISOString(),
      ...entry,
    })),
    entries: vi.fn().mockReturnValue([]),
    query: vi.fn().mockReturnValue([]),
    verifyIntegrity: vi.fn().mockReturnValue({ valid: true }),
  };
}

describe('E2E: executePipeline()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = '';
  });

  it('full success path — well-formed issue, clean agent output → PR created', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    await executePipeline(42, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      tracker,
      sourceControl: sc,
      runner,
      logger: makeSilentLogger(),
      auditLog,
    });

    expect(tracker.getIssue).toHaveBeenCalledWith('42');
    expect(runner.run).toHaveBeenCalled();
    expect(sc.createPR).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'ai-sdlc/issue-42',
        targetBranch: 'main',
      }),
    );
  });

  it('pre-agent rejection — issue with complexity 5 is rejected before agent runs', async () => {
    const issue = makeIssue({
      description: '## Description\ntest\n\n## Acceptance Criteria\n- ok\n\n### Complexity\n5',
    });
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
        logger: makeSilentLogger(),
        auditLog,
      }),
    ).rejects.toThrow();

    // Agent should never have been invoked
    expect(runner.run).not.toHaveBeenCalled();
    // No PR should have been created
    expect(sc.createPR).not.toHaveBeenCalled();
  });

  it('post-agent blocked path rejection — agent modifies .ai-sdlc/ files', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner({
      filesChanged: ['.ai-sdlc/pipeline.yaml', 'src/fix.test.ts'],
    });
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
        logger: makeSilentLogger(),
        auditLog,
      }),
    ).rejects.toThrow('guardrail validation');

    // Agent ran, but push/PR should NOT have happened
    expect(runner.run).toHaveBeenCalled();
    expect(sc.createPR).not.toHaveBeenCalled();
  });

  it('post-agent file count rejection — agent changes 20 files', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const files = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    files.push('src/file.test.ts');
    const runner = makeMockRunner({ filesChanged: files });
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
        logger: makeSilentLogger(),
        auditLog,
      }),
    ).rejects.toThrow('guardrail validation');

    expect(runner.run).toHaveBeenCalled();
    expect(sc.createPR).not.toHaveBeenCalled();
  });

  it('post-agent missing tests rejection — agent returns only .ts files', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner({ filesChanged: ['src/fix.ts'] });
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
        logger: makeSilentLogger(),
        auditLog,
      }),
    ).rejects.toThrow('guardrail validation');

    expect(runner.run).toHaveBeenCalled();
    expect(sc.createPR).not.toHaveBeenCalled();
  });
});
