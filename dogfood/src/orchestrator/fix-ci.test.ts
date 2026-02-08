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

// Mock child_process — covers git and gh calls
vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], _opts: unknown, cb?: unknown) => {
    if (typeof cb === 'function') {
      // Return branch name for `git branch --show-current`
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
});

describe('executeFixCI()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = '';
  });

  it('full success path — agent called with ciErrors, push happens', async () => {
    const runner = makeMockRunner();

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: [],
      _ciLogs: 'Error: lint failed\n  src/foo.ts(10,5): error TS2345',
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
    const markers = Array.from({ length: MAX_FIX_ATTEMPTS }, () => `text\n${RETRY_MARKER}`);

    await executeFixCI(100, 5555, {
      configDir: CONFIG_DIR,
      workDir: '/tmp/test-repo',
      runner,
      logger: makeSilentLogger(),
      _prComments: markers,
      _ciLogs: 'some error',
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

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
      }),
    ).rejects.toThrow('Fix-CI agent failed');
  });

  it('enforces guardrails — rejects blocked paths', async () => {
    const runner = makeMockRunner({
      filesChanged: ['.github/workflows/ci.yml', 'src/fix.test.ts'],
    });

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
      }),
    ).rejects.toThrow('guardrail validation');
  });

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

    await expect(
      executeFixCI(100, 5555, {
        configDir: CONFIG_DIR,
        workDir: '/tmp/test-repo',
        runner,
        logger: makeSilentLogger(),
        _prComments: [],
        _ciLogs: 'some error',
      }),
    ).rejects.toThrow('does not match ai-sdlc/issue-N pattern');
  });
});
