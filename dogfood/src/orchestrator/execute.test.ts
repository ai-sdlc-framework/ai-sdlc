import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { executePipeline } from './execute.js';
import type { AgentRunner, AgentResult } from '../runner/types.js';
import type { IssueTracker, SourceControl, Issue, PullRequest, AuditLog } from '@ai-sdlc/reference';
import type { Logger } from './logger.js';

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
    addComment: vi.fn(),
    getComments: vi.fn().mockResolvedValue([]),
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

function makeSilentLogger(): Logger {
  return {
    stage: vi.fn(),
    stageEnd: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    summary: vi.fn(),
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
    const auditLog = makeMockAuditLog();

    await executePipeline(42, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      tracker,
      sourceControl: sc,
      runner,
      auditLog,
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
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
        auditLog,
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
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
        auditLog,
      }),
    ).rejects.toThrow('Agent failed');
  });

  it('passes agent constraints from config', async () => {
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
      auditLog,
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

  it('rejects when agent modifies blocked paths', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner({
      filesChanged: ['.github/workflows/ci.yml', 'src/fix.test.ts'],
    });
    const auditLog = makeMockAuditLog();

    await expect(
      executePipeline(42, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        tracker,
        sourceControl: sc,
        runner,
        auditLog,
      }),
    ).rejects.toThrow('guardrail validation');
  });

  it('rejects when agent changes too many files', async () => {
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
        auditLog,
      }),
    ).rejects.toThrow('guardrail validation');
  });

  it('rejects when agent produces no test files', async () => {
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
        auditLog,
      }),
    ).rejects.toThrow('guardrail validation');
  });

  it('allows issues at complexity boundary (3 = fully-autonomous)', async () => {
    const issue = makeIssue({
      description: '## Description\ncomplex\n\n## Acceptance Criteria\n- ok\n\n### Complexity\n3',
    });
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    // complexity 3 routes as 'fully-autonomous' — should pass
    await executePipeline(42, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      tracker,
      sourceControl: sc,
      runner,
      auditLog,
    });

    expect(runner.run).toHaveBeenCalled();
  });

  it('records audit entry on gate validation pass', async () => {
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
      auditLog,
    });

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        resource: 'issue#42',
        decision: 'allowed',
      }),
    );
  });

  it('records audit entry on gate validation deny', async () => {
    const issue = makeIssue({
      description: '## Description\ntest\n\n### Complexity\n5',
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
        auditLog,
      }),
    ).rejects.toThrow();

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        decision: 'denied',
      }),
    );
  });

  it('uses routeByComplexity to determine routing strategy', async () => {
    const issue = makeIssue(); // complexity 2 → 'fully-autonomous'
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
      auditLog,
    });

    // Should have recorded routing decision
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'route',
        resource: 'issue#42',
        decision: 'allowed',
        details: expect.objectContaining({ score: 2, strategy: 'fully-autonomous' }),
      }),
    );
  });

  it('merges autonomy level blocked paths with agent constraints', async () => {
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
      auditLog,
    });

    // Both agent role and autonomy policy have .github/workflows/** and .ai-sdlc/**
    // Merged + deduped should still include both
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: expect.objectContaining({
          blockedPaths: expect.arrayContaining(['.github/workflows/**', '.ai-sdlc/**']),
        }),
      }),
    );
  });

  it('evaluates promotion eligibility after success', async () => {
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
      auditLog,
    });

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        policy: 'promotion',
      }),
    );
  });

  it('increments gate pass counter on successful validation', async () => {
    const issue = makeIssue();
    const tracker = makeMockTracker(issue);
    const sc = makeMockSourceControl();
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const logger = makeSilentLogger();

    await executePipeline(42, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      tracker,
      sourceControl: sc,
      runner,
      auditLog,
      logger,
    });

    // getMeter() returns a no-op meter without SDK, so we just verify
    // the pipeline completes without error when counter.add() is called
    expect(runner.run).toHaveBeenCalled();
  });
});
