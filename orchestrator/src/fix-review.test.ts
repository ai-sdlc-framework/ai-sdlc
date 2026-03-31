import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import {
  executeFixReview,
  countRetryAttempts,
  fetchReviewFindings,
  validatePrNumber,
  sanitizeBranchName,
  RETRY_MARKER,
  MAX_REVIEW_FIX_ATTEMPTS,
  type FixReviewOptions,
} from './fix-review.js';
import type { AgentRunner, AgentResult } from './runners/types.js';
import type { Logger } from './logger.js';
import type { AuditLog } from '@ai-sdlc/reference';

// Mock child_process — covers git and gh calls.
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      if (args?.[0] === 'branch' && args?.[1] === '--show-current') {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, 'ai-sdlc/issue-42\n', '');
      } else if (args?.[0] === 'pr' && args?.[1] === 'review') {
        // Mock gh pr review command
        const mockReviews = JSON.stringify([
          {
            state: 'CHANGES_REQUESTED',
            body: '### Testing Review\n\nPlease add tests for the new feature.',
            author: { login: 'ai-sdlc-testing-agent' },
          },
          {
            state: 'CHANGES_REQUESTED',
            body: '### Security Review\n\nFound SQL injection vulnerability.',
            author: { login: 'ai-sdlc-security-agent' },
          },
        ]);
        (cb as (err: null, stdout: string, stderr: string) => void)(null, mockReviews, '');
      } else {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      }
    }
    return { stdout: '', stderr: '' };
  }),
}));

const CONFIG_DIR = resolve(import.meta.dirname, '../../.ai-sdlc');

function makeSilentLogger(): Logger {
  return {
    stage: vi.fn(),
    stageEnd: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    summary: vi.fn(),
  };
}

function makeMockRunner(result?: Partial<AgentResult>): AgentRunner {
  return {
    run: vi.fn().mockResolvedValue({
      success: true,
      filesChanged: ['src/fix.ts', 'src/fix.test.ts'],
      summary: 'Fixed review findings',
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

describe('validatePrNumber()', () => {
  it('accepts positive integers', () => {
    expect(() => validatePrNumber(1)).not.toThrow();
    expect(() => validatePrNumber(42)).not.toThrow();
    expect(() => validatePrNumber(999999)).not.toThrow();
  });

  it('rejects zero', () => {
    expect(() => validatePrNumber(0)).toThrow(/Invalid PR number.*must be a positive integer/);
  });

  it('rejects negative numbers', () => {
    expect(() => validatePrNumber(-1)).toThrow(/Invalid PR number.*must be a positive integer/);
    expect(() => validatePrNumber(-42)).toThrow(/Invalid PR number.*must be a positive integer/);
  });

  it('rejects non-integers', () => {
    expect(() => validatePrNumber(3.14)).toThrow(/Invalid PR number.*must be a positive integer/);
    expect(() => validatePrNumber(NaN)).toThrow(/Invalid PR number.*must be a positive integer/);
  });
});

describe('sanitizeBranchName()', () => {
  it('accepts valid branch names', () => {
    expect(sanitizeBranchName('main')).toBe('main');
    expect(sanitizeBranchName('ai-sdlc/issue-42')).toBe('ai-sdlc/issue-42');
    expect(sanitizeBranchName('feature/FOO-123')).toBe('feature/FOO-123');
    expect(sanitizeBranchName('fix_bug.v2')).toBe('fix_bug.v2');
  });

  it('rejects branches with spaces', () => {
    expect(() => sanitizeBranchName('my branch')).toThrow(/Invalid branch name/);
  });

  it('rejects branches with special characters', () => {
    expect(() => sanitizeBranchName('branch;rm -rf /')).toThrow(/Invalid branch name/);
    expect(() => sanitizeBranchName('branch`whoami`')).toThrow(/Invalid branch name/);
    expect(() => sanitizeBranchName('branch$VAR')).toThrow(/Invalid branch name/);
    expect(() => sanitizeBranchName('branch&& echo hack')).toThrow(/Invalid branch name/);
  });

  it('rejects branches with newlines', () => {
    expect(() => sanitizeBranchName('branch\nmalicious')).toThrow(/Invalid branch name/);
  });
});

describe('countRetryAttempts()', () => {
  it('returns 0 with no markers', () => {
    const comments = ['This is a normal comment', 'Another comment'];
    expect(countRetryAttempts(comments)).toBe(0);
  });

  it('returns correct count with markers', () => {
    const comments = [
      `Some text\n${RETRY_MARKER}`,
      'No marker here',
      `Fix applied\n${RETRY_MARKER}`,
    ];
    expect(countRetryAttempts(comments)).toBe(2);
  });

  it('returns 0 with empty comments array', () => {
    expect(countRetryAttempts([])).toBe(0);
  });
});

describe('fetchReviewFindings()', () => {
  it('returns injected findings as-is', async () => {
    const findings = '### Review by test\n\nPlease fix X.';
    const result = await fetchReviewFindings(12345, findings);
    expect(result).toBe(findings);
  });

  it('fetches and formats review findings from gh CLI', async () => {
    const result = await fetchReviewFindings(12345);
    expect(result).toContain('### Review by ai-sdlc-testing-agent');
    expect(result).toContain('Please add tests for the new feature');
    expect(result).toContain('### Review by ai-sdlc-security-agent');
    expect(result).toContain('Found SQL injection vulnerability');
  });

  it('validates PR number before calling gh CLI', async () => {
    await expect(fetchReviewFindings(0)).rejects.toThrow(/Invalid PR number/);
    await expect(fetchReviewFindings(-5)).rejects.toThrow(/Invalid PR number/);
    await expect(fetchReviewFindings(3.14)).rejects.toThrow(/Invalid PR number/);
  });

  it('throws on invalid JSON from gh CLI', async () => {
    const { execFile: execFileMock } = await import('node:child_process');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mock = execFileMock as any;
    const originalImpl = mock.getMockImplementation();
    mock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
      if (typeof cb === 'function') {
        (cb as (err: null, stdout: string, stderr: string) => void)(
          null,
          'not valid json at all',
          '',
        );
      }
      return { stdout: '', stderr: '' };
    });

    await expect(fetchReviewFindings(42)).rejects.toThrow(/Failed to parse review data/);

    // Restore original mock
    if (originalImpl) mock.mockImplementation(originalImpl);
  });
});

describe('executeFixReview()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes fix-review pipeline successfully', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _prComments: [], // No previous attempts
      _reviewFindings: '### Review\n\nPlease add tests.',
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: '42',
        reviewFindings: '### Review\n\nPlease add tests.',
      }),
    );
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'execute',
        resource: expect.stringContaining('agent'),
        decision: 'allowed',
      }),
    );
  });

  it('stops when retry limit is reached', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    // Inject comments with markers to simulate max attempts reached
    const commentsWithMarkers = Array.from(
      { length: MAX_REVIEW_FIX_ATTEMPTS },
      () => `Attempt\n${RETRY_MARKER}`,
    );

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _prComments: commentsWithMarkers,
      _reviewFindings: '### Review\n\nPlease add tests.',
    });

    // Agent should NOT be invoked when limit is reached
    expect(runner.run).not.toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        decision: 'denied',
        details: expect.objectContaining({
          reason: 'retry-limit-reached',
        }),
      }),
    );
  });

  it('throws on agent failure', async () => {
    const runner = makeMockRunner({ success: false, error: 'Agent timeout' });
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    await expect(
      executeFixReview(42, {
        configDir: CONFIG_DIR,
        runner,
        logger,
        auditLog,
        _prComments: [],
        _reviewFindings: '### Review\n\nPlease add tests.',
      }),
    ).rejects.toThrow(/Fix-review agent failed/);
  });

  it('validates agent output against constraints', async () => {
    const runner = makeMockRunner({
      filesChanged: [
        ...Array.from({ length: 20 }, (_, i) => `file${i}.ts`), // Exceeds max files
      ],
    });
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    await expect(
      executeFixReview(42, {
        configDir: CONFIG_DIR,
        runner,
        logger,
        auditLog,
        _prComments: [],
        _reviewFindings: '### Review\n\nPlease add tests.',
      }),
    ).rejects.toThrow(); // Should throw due to max files violation
  });

  it('skips agent execution when no actionable review findings', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _prComments: [],
      _reviewFindings: 'No review findings (all reviews approved or pending)',
    });

    // Agent should NOT be invoked when there are no actionable findings
    expect(runner.run).not.toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        decision: 'allowed',
        details: expect.objectContaining({
          reason: 'no-actionable-findings',
        }),
      }),
    );
  });

  it('skips agent execution when review findings are empty', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _prComments: [],
      _reviewFindings: '',
    });

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('calls runner with review findings and correct branch', async () => {
    const runner = makeMockRunner({
      success: true,
      filesChanged: ['src/fix.ts', 'src/fix.test.ts'],
      summary: 'Fixed the issue',
    });
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _prComments: [],
      _reviewFindings: '### Review by critic\n\nPlease fix the naming.',
    });

    // Verify agent was called with review findings and correct branch
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewFindings: '### Review by critic\n\nPlease fix the naming.',
        branch: 'ai-sdlc/issue-42',
        issueId: '42',
      }),
    );

    // Verify audit log recorded agent execution + push
    const recordCalls = (auditLog.record as ReturnType<typeof vi.fn>).mock.calls;
    const executeCall = recordCalls.find(
      (c: unknown[]) => (c[0] as Record<string, unknown>).action === 'execute',
    );
    expect(executeCall).toBeTruthy();
    expect((executeCall![0] as Record<string, unknown>).decision).toBe('allowed');

    const pushCall = recordCalls.find(
      (c: unknown[]) =>
        (c[0] as Record<string, unknown>).action === 'create' &&
        String((c[0] as Record<string, unknown>).resource).includes('push/'),
    );
    expect(pushCall).toBeTruthy();
  });

  it('records episodic memory on success', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();
    const memory = {
      working: {
        set: vi.fn(),
        get: vi.fn(),
        clear: vi.fn(),
        delete: vi.fn(),
        keys: vi.fn().mockReturnValue([]),
      },
      episodic: {
        append: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        getRecent: vi.fn().mockReturnValue([]),
      },
      shortTerm: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
      longTerm: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
      shared: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
    };

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      memory: memory as unknown as FixReviewOptions['memory'],
      _prComments: [],
      _reviewFindings: '### Review\n\nFix it.',
    });

    expect(memory.episodic.append).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'fix-review-execution',
        value: expect.objectContaining({
          prNumber: 42,
          outcome: 'success',
        }),
      }),
    );
    expect(memory.working.clear).toHaveBeenCalled();
  });

  it('records failure episode when agent throws', async () => {
    const runner = makeMockRunner({ success: false, error: 'timeout' });
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();
    const memory = {
      working: {
        set: vi.fn(),
        get: vi.fn(),
        clear: vi.fn(),
        delete: vi.fn(),
        keys: vi.fn().mockReturnValue([]),
      },
      episodic: {
        append: vi.fn(),
        search: vi.fn().mockReturnValue([]),
        getRecent: vi.fn().mockReturnValue([]),
      },
      shortTerm: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
      longTerm: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
      shared: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), keys: vi.fn() },
    };

    await expect(
      executeFixReview(42, {
        configDir: CONFIG_DIR,
        runner,
        logger,
        auditLog,
        memory: memory as unknown as FixReviewOptions['memory'],
        _prComments: [],
        _reviewFindings: '### Review\n\nFix it.',
      }),
    ).rejects.toThrow();

    expect(memory.episodic.append).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'fix-review-execution',
        value: expect.objectContaining({
          outcome: 'failure',
        }),
      }),
    );
  });

  it('logs summary at end of successful run', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _prComments: [],
      _reviewFindings: '### Review\n\nFix it.',
    });

    expect(logger.summary).toHaveBeenCalled();
  });

  it('checks for pipeline cycles when tracker is provided', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();
    const mockTracker = {
      listIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn().mockResolvedValue({
        id: '42',
        title: 'Test issue',
        description: 'test',
        status: 'open',
      }),
      createIssue: vi.fn().mockResolvedValue({ id: '42', title: '', status: 'open' }),
      updateIssue: vi.fn().mockResolvedValue({ id: '42', title: '', status: 'open' }),
      transitionIssue: vi.fn().mockResolvedValue({ id: '42', title: '', status: 'open' }),
      addComment: vi.fn().mockResolvedValue(undefined),
      getComments: vi.fn().mockResolvedValue([]),
      watchIssues: vi.fn(),
    };

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _reviewFindings: '### Review\n\nPlease fix.',
      tracker: mockTracker as never,
    });

    expect(mockTracker.getComments).toHaveBeenCalledWith('42');
    expect(runner.run).toHaveBeenCalled();
  });

  it('halts when pipeline cycle is detected via tracker', async () => {
    const runner = makeMockRunner();
    const logger = makeSilentLogger();
    const auditLog = makeMockAuditLog();

    const cycleComments = Array.from({ length: 4 }, (_, i) => ({
      body: `Comment\n<!-- ai-sdlc-cycle:fix-review:${i} -->`,
      author: 'bot',
      createdAt: new Date().toISOString(),
    }));

    const mockTracker = {
      listIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn().mockResolvedValue({
        id: '42',
        title: 'Test issue',
        description: 'test',
        status: 'open',
      }),
      createIssue: vi.fn().mockResolvedValue({ id: '42', title: '', status: 'open' }),
      updateIssue: vi.fn().mockResolvedValue({ id: '42', title: '', status: 'open' }),
      transitionIssue: vi.fn().mockResolvedValue({ id: '42', title: '', status: 'open' }),
      addComment: vi.fn().mockResolvedValue(undefined),
      getComments: vi.fn().mockResolvedValue(cycleComments),
      watchIssues: vi.fn(),
    };

    await executeFixReview(42, {
      configDir: CONFIG_DIR,
      runner,
      logger,
      auditLog,
      _reviewFindings: '### Review\n\nPlease fix.',
      tracker: mockTracker as never,
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect(mockTracker.addComment).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('Cycle Detected'),
    );
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        decision: 'denied',
        details: expect.objectContaining({ reason: 'pipeline-cycle-detected' }),
      }),
    );
  });
});
