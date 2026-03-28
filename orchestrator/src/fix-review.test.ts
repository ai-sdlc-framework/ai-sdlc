import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import {
  executeFixReview,
  countRetryAttempts,
  fetchReviewFindings,
  RETRY_MARKER,
  MAX_REVIEW_FIX_ATTEMPTS,
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
});
