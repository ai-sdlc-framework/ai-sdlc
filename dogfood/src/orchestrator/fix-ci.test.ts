import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import {
  executeFixCI,
  countRetryAttempts,
  fetchCILogs,
  RETRY_MARKER,
  MAX_LOG_LINES,
  MAX_FIX_ATTEMPTS,
} from './fix-ci.js';
import type { AgentRunner, AgentResult } from '../runner/types.js';
import type { Logger } from './logger.js';
import type { AuditLog, CIPipeline, BuildStatus } from '@ai-sdlc/reference';
import { createPipelineSecurity } from './security.js';

// Mock child_process — covers git and gh calls.
// fix-ci.ts wraps execFile in a callback-based promise, so the mock
// must call the callback (4th arg) with (err, stdout, stderr).
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      if (args?.[0] === 'branch' && args?.[1] === '--show-current') {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, 'ai-sdlc/issue-42\n', '');
      } else {
        (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      }
    }
    return { stdout: '', stderr: '' };
  }),
}));

const CONFIG_DIR = resolve(import.meta.dirname, '../../../.ai-sdlc');

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
      summary: 'Fixed CI failure',
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

describe('fetchCILogs()', () => {
  it('returns injected logs as-is when short', async () => {
    const logs = 'Error: test failed\n  at test.ts:42';
    const result = await fetchCILogs(12345, logs);
    expect(result).toBe(logs);
  });

  it('truncates when over MAX_LOG_LINES', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const logs = lines.join('\n');
    const result = await fetchCILogs(12345, logs);
    const resultLines = result.split('\n');
    expect(resultLines.length).toBe(MAX_LOG_LINES);
    expect(resultLines[0]).toBe(`line ${200 - MAX_LOG_LINES + 1}`);
    expect(resultLines[resultLines.length - 1]).toBe('line 200');
  });

  it('uses CIPipeline adapter when provided (no injected logs)', async () => {
    const mockCI: CIPipeline = {
      triggerBuild: vi.fn(),
      getBuildStatus: vi.fn().mockResolvedValue({
        id: '999',
        status: 'failed',
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:05:00Z',
      } satisfies BuildStatus),
      getTestResults: vi.fn(),
      getCoverageReport: vi.fn(),
      watchBuildEvents: vi.fn(),
    };

    const result = await fetchCILogs(999, undefined, mockCI);
    expect(mockCI.getBuildStatus).toHaveBeenCalledWith('999');
    expect(result).toContain('failed');
    expect(result).toContain('999');
  });

  it('prefers injected logs over CI adapter', async () => {
    const mockCI: CIPipeline = {
      triggerBuild: vi.fn(),
      getBuildStatus: vi.fn(),
      getTestResults: vi.fn(),
      getCoverageReport: vi.fn(),
      watchBuildEvents: vi.fn(),
    };

    const result = await fetchCILogs(999, 'injected error logs', mockCI);
    expect(result).toBe('injected error logs');
    expect(mockCI.getBuildStatus).not.toHaveBeenCalled();
  });
});

describe('executeFixCI()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = '';
  });

  it('full success path — agent called with ciErrors, push happens', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: [],
      _ciLogs: 'Error: lint failed\n  src/foo.ts(10,5): error TS2345',
      auditLog,
    });

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 42,
        ciErrors: expect.stringContaining('lint failed'),
      }),
    );
  });

  it('aborts at max retries without calling runner', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const markers = Array.from({ length: MAX_FIX_ATTEMPTS }, () => `text\n${RETRY_MARKER}`);

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: markers,
      _ciLogs: 'some error',
      auditLog,
    });

    // Should return gracefully, not throw
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('handles agent failure — throws', async () => {
    const runner = makeMockRunner({
      success: false,
      filesChanged: [],
      error: 'Compilation failed',
    });
    const auditLog = makeMockAuditLog();

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
        auditLog,
      }),
    ).rejects.toThrow('Fix-CI agent failed');
  });

  it('enforces guardrails — rejects blocked paths', async () => {
    const runner = makeMockRunner({
      filesChanged: ['.github/workflows/ci.yml', 'src/fix.test.ts'],
    });
    const auditLog = makeMockAuditLog();

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
        auditLog,
      }),
    ).rejects.toThrow('guardrail validation');
  });

  it('records audit entry for retry limit reached', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const markers = Array.from({ length: MAX_FIX_ATTEMPTS }, () => `text\n${RETRY_MARKER}`);

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: markers,
      _ciLogs: 'some error',
      auditLog,
    });

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        decision: 'denied',
        details: expect.objectContaining({ reason: 'retry-limit-reached' }),
      }),
    );
  });

  it('evaluates demotion on agent failure', async () => {
    const runner = makeMockRunner({
      success: false,
      filesChanged: [],
      error: 'Test failed',
    });
    const auditLog = makeMockAuditLog();

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
        auditLog,
      }),
    ).rejects.toThrow('Fix-CI agent failed');

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'evaluate',
        policy: 'demotion',
        details: expect.objectContaining({ trigger: 'failed-test' }),
      }),
    );
  });

  it('increments task success counter on successful fix', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: [],
      _ciLogs: 'Error: lint failed',
      auditLog,
    });

    // getMeter() returns a no-op meter without SDK, so we just verify
    // the pipeline completes without error when counter.add() is called
    expect(runner.run).toHaveBeenCalled();
  });

  it('checks kill switch before fix-CI', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const security = createPipelineSecurity();

    // Activate kill switch
    await security.killSwitch.activate('maintenance');

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
        auditLog,
        security,
      }),
    ).rejects.toThrow('kill switch active');

    expect(runner.run).not.toHaveBeenCalled();
  });

  it('issues and revokes credentials during fix-CI', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const security = createPipelineSecurity();

    const issueSpy = vi.spyOn(security.jitCredentials, 'issue');
    const revokeSpy = vi.spyOn(security.jitCredentials, 'revoke');

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: [],
      _ciLogs: 'Error: lint failed',
      auditLog,
      security,
    });

    expect(issueSpy).toHaveBeenCalledWith('coding-agent', expect.any(Array), expect.any(Number));
    expect(revokeSpy).toHaveBeenCalledWith(expect.stringContaining('cred-'));
  });

  it('uses structured logger when configured', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    // Should complete without error with useStructuredLogger
    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      _prComments: [],
      _ciLogs: 'Error: lint failed',
      auditLog,
      useStructuredLogger: true,
    });

    expect(runner.run).toHaveBeenCalled();
  });

  it('revokes credentials even on agent failure in fix-CI', async () => {
    const runner = makeMockRunner({ success: false, filesChanged: [], error: 'boom' });
    const auditLog = makeMockAuditLog();
    const security = createPipelineSecurity();

    const revokeSpy = vi.spyOn(security.jitCredentials, 'revoke');

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
        auditLog,
        security,
      }),
    ).rejects.toThrow('Fix-CI agent failed');

    // Credentials should still be revoked in the finally block
    expect(revokeSpy).toHaveBeenCalled();
  });

  it('uses CIPipeline adapter when provided', async () => {
    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();
    const mockCIAdapter: CIPipeline = {
      triggerBuild: vi.fn(),
      getBuildStatus: vi.fn().mockResolvedValue({
        id: '5555',
        status: 'failed',
        startedAt: '2025-01-01T00:00:00Z',
        completedAt: '2025-01-01T00:05:00Z',
      } satisfies BuildStatus),
      getTestResults: vi.fn(),
      getCoverageReport: vi.fn(),
      watchBuildEvents: vi.fn(),
    };

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: [],
      auditLog,
      ciAdapter: mockCIAdapter,
    });

    expect(mockCIAdapter.getBuildStatus).toHaveBeenCalledWith('5555');
    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        ciErrors: expect.stringContaining('failed'),
      }),
    );
  });

  // This test must be last — it overrides the global execFile mock
  it('throws for non-matching branch pattern', async () => {
    // Override the mock to return a non-matching branch
    const { execFile } = await import('node:child_process');
    const mockExecFile = vi.mocked(execFile);
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb?: unknown) => {
        if (typeof cb === 'function') {
          const argsList = args as string[];
          if (argsList?.[0] === 'branch' && argsList?.[1] === '--show-current') {
            (cb as (err: null, stdout: string, stderr: string) => void)(
              null,
              'feature/something\n',
              '',
            );
          } else {
            (cb as (err: null, stdout: string, stderr: string) => void)(null, '', '');
          }
        }
        return { stdout: '', stderr: '' } as unknown as ReturnType<typeof execFile>;
      },
    );

    const runner = makeMockRunner();
    const auditLog = makeMockAuditLog();

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
        auditLog,
      }),
    ).rejects.toThrow('does not match ai-sdlc/issue-N pattern');
  });
});
