import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { GitHubActionsRunner } from './github-actions.js';
import type { AgentContext } from './types.js';

// Mock child_process at the module level
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

// Helper to create a mock child process
function createMockChild(exitCode: number, stdoutData: string, stderrData: string = '') {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };

  process.nextTick(() => {
    if (stdoutData) {
      child.stdout.emit('data', Buffer.from(stdoutData));
    }
    if (stderrData) {
      child.stderr.emit('data', Buffer.from(stderrData));
    }
    child.emit('close', exitCode);
  });

  return child;
}

function createErrorChild() {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };

  process.nextTick(() => {
    child.emit('error', new Error('spawn ENOENT'));
  });

  return child;
}

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    issueNumber: 42,
    issueTitle: 'Fix test flakiness',
    issueBody: 'Tests are flaky due to timing issues.',
    workDir: '/tmp/test-repo',
    branch: 'ai-sdlc/issue-42',
    constraints: {
      maxFilesPerChange: 15,
      requireTests: true,
      blockedPaths: ['.github/workflows/**'],
    },
    ...overrides,
  };
}

describe('GitHubActionsRunner', () => {
  let runner: GitHubActionsRunner;
  let spawnMock: ReturnType<typeof vi.fn>;
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    runner = new GitHubActionsRunner();

    const childProcess = await import('node:child_process');
    spawnMock = vi.mocked(childProcess.spawn);
    execFileMock = vi.mocked(childProcess.execFile);

    // Default: claude succeeds
    spawnMock.mockImplementation(() => createMockChild(0, 'Agent completed'));

    // Default: git commands return sensible results
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        const argsArr = args as string[];
        if (cb) {
          if (argsArr.includes('diff') && argsArr.includes('--name-only')) {
            cb(null, { stdout: 'src/foo.ts\n' });
          } else if (argsArr.includes('ls-files')) {
            cb(null, { stdout: '' });
          } else {
            cb(null, { stdout: '' });
          }
        }
        return undefined as unknown as ChildProcess;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns success when agent modifies files', async () => {
    const result = await runner.run(makeContext());

    expect(result.success).toBe(true);
    expect(result.filesChanged).toContain('src/foo.ts');
    expect(result.summary).toBeTruthy();
  });

  it('returns failure when no files are changed', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        if (cb) cb(null, { stdout: '' });
        return undefined as unknown as ChildProcess;
      },
    );

    const result = await runner.run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe('No files were modified');
    expect(result.filesChanged).toEqual([]);
  });

  it('returns failure when claude CLI exits with non-zero code', async () => {
    spawnMock.mockImplementation(() => createMockChild(1, '', 'Model error'));

    const result = await runner.run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('claude exited with code 1');
  });

  it('returns failure when spawn emits an error', async () => {
    spawnMock.mockImplementation(() => createErrorChild());

    const result = await runner.run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn ENOENT');
  });

  it('passes allowedTools and timeoutMs to the claude process', async () => {
    await runner.run(
      makeContext({
        allowedTools: ['Read', 'Write'],
        timeoutMs: 60000,
      }),
    );

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--allowedTools', 'Read,Write']),
      expect.objectContaining({ timeout: 60000 }),
    );
  });

  it('combines tracked and untracked files in filesChanged', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        const argsArr = args as string[];
        if (cb) {
          if (argsArr.includes('diff') && argsArr.includes('--name-only')) {
            cb(null, { stdout: 'src/changed.ts\n' });
          } else if (argsArr.includes('ls-files')) {
            cb(null, { stdout: 'src/new-file.ts\n' });
          } else {
            cb(null, { stdout: '' });
          }
        }
        return undefined as unknown as ChildProcess;
      },
    );

    const result = await runner.run(makeContext());

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual(['src/changed.ts', 'src/new-file.ts']);
  });

  it('truncates summary to 2000 chars', async () => {
    const longOutput = 'x'.repeat(5000);
    spawnMock.mockImplementation(() => createMockChild(0, longOutput));

    const result = await runner.run(makeContext());

    expect(result.success).toBe(true);
    expect(result.summary.length).toBe(2000);
  });

  it('handles git command failures gracefully', async () => {
    execFileMock.mockImplementation(
      (
        _cmd: unknown,
        _args: unknown,
        _opts: unknown,
        cb?: (err: Error | null, result: { stdout: string }) => void,
      ) => {
        if (cb) cb(new Error('git command failed'), { stdout: '' });
        return undefined as unknown as ChildProcess;
      },
    );

    const result = await runner.run(makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain('git command failed');
  });

  it('uses AI_SDLC_MODEL env var when set', async () => {
    const originalEnv = process.env.AI_SDLC_MODEL;
    process.env.AI_SDLC_MODEL = 'custom-model';

    await runner.run(makeContext());

    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'custom-model']),
      expect.any(Object),
    );

    if (originalEnv === undefined) {
      delete process.env.AI_SDLC_MODEL;
    } else {
      process.env.AI_SDLC_MODEL = originalEnv;
    }
  });

  it('sends prompt via stdin', async () => {
    const mockChild = createMockChild(0, 'done');
    spawnMock.mockImplementation(() => mockChild);

    await runner.run(makeContext());

    expect(mockChild.stdin.write).toHaveBeenCalled();
    expect(mockChild.stdin.end).toHaveBeenCalled();
  });

  it('commits changes with proper message', async () => {
    await runner.run(makeContext());

    // git add and git commit should have been called
    const commitCall = execFileMock.mock.calls.find((call: unknown[]) => {
      const args = call[1] as string[];
      return args.includes('commit');
    });
    expect(commitCall).toBeTruthy();
    const commitArgs = commitCall![1] as string[];
    expect(commitArgs).toContain('-m');
    // The commit message should reference the issue
    const msgArg = commitArgs[commitArgs.indexOf('-m') + 1];
    expect(msgArg).toContain('#42');
  });
});
