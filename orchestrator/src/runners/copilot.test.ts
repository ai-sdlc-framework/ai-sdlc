import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildPrompt, parseTokenUsage, CopilotRunner } from './copilot.js';
import type { AgentContext } from './types.js';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

// Mock child_process.spawn and child_process.execFile
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

// Lazy import so the mock is in place first
import { spawn, execFile } from 'node:child_process';

const spawnMock = vi.mocked(spawn);
const execFileMock = vi.mocked(execFile);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    issueId: '42',
    issueNumber: 42,
    issueTitle: 'Fix the widget',
    issueBody: 'The widget is broken.',
    workDir: '/tmp/repo',
    branch: 'ai-sdlc/issue-42',
    constraints: {
      maxFilesPerChange: 10,
      requireTests: true,
      blockedPaths: ['.github/workflows/**'],
    },
    ...overrides,
  };
}

/** Create a fake child process EventEmitter with stdout/stderr streams. */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };
  return child;
}

/**
 * Simulate spawn: returns a fake child, schedules stdout/stderr data and a close event.
 */
function setupSpawn(opts: { stdout?: string; stderr?: string; code?: number }) {
  const child = makeFakeChild();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);

  // Schedule async events
  queueMicrotask(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code ?? 0);
  });

  return child;
}

/** Simulate spawn that emits an 'error' event. */
function setupSpawnError(err: Error) {
  const child = makeFakeChild();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);
  queueMicrotask(() => {
    child.emit('error', err);
  });
  return child;
}

/**
 * Mock execFile (git commands) to return expected stdout for diff/ls-files/add/commit.
 */
function setupGitExec(changedFiles: string[], untrackedFiles: string[] = []) {
  execFileMock.mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb?: unknown) => {
    const callback =
      typeof _opts === 'function' ? _opts : (cb as ((...a: unknown[]) => void) | undefined);
    const gitArgs = Array.isArray(args) ? args : [];

    let stdout = '';
    if (gitArgs[0] === 'diff' && gitArgs[1] === '--name-only') {
      stdout = changedFiles.join('\n');
    } else if (gitArgs[0] === 'ls-files') {
      stdout = untrackedFiles.join('\n');
    } else if (gitArgs[0] === 'add') {
      stdout = '';
    } else if (gitArgs[0] === 'commit') {
      stdout = '';
    }

    if (callback) {
      callback(null, { stdout, stderr: '' });
      return undefined as unknown;
    }
    return { stdout, stderr: '' } as unknown;
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('CopilotRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildPrompt (re-exported from claude-code)', () => {
    it('produces a valid prompt', () => {
      const prompt = buildPrompt(makeCtx());
      expect(prompt).toContain('issue #42');
      expect(prompt).toContain('Fix the widget');
    });
  });

  describe('parseTokenUsage', () => {
    it('parses input/output token counts', () => {
      const result = parseTokenUsage('Input tokens: 1,234\nOutput tokens: 5,678', 'copilot-model');
      expect(result).toEqual({
        inputTokens: 1234,
        outputTokens: 5678,
        model: 'copilot-model',
      });
    });

    it('parses total tokens and estimates split', () => {
      const result = parseTokenUsage('Total tokens: 10000', 'copilot-model');
      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(7000);
      expect(result!.outputTokens).toBe(3000);
    });

    it('returns undefined when no token info', () => {
      expect(parseTokenUsage('some random output', 'model')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(parseTokenUsage('', 'model')).toBeUndefined();
    });

    it('parses output-only token match', () => {
      const result = parseTokenUsage('Output tokens: 300', 'copilot-model');
      expect(result).toEqual({
        inputTokens: 0,
        outputTokens: 300,
        model: 'copilot-model',
      });
    });

    it('handles token counts with underscores and dashes in labels', () => {
      const result = parseTokenUsage('input_tokens: 100\noutput-tokens: 200', 'model');
      expect(result).toEqual({ inputTokens: 100, outputTokens: 200, model: 'model' });
    });
  });

  describe('run()', () => {
    it('returns success with changed files when copilot exits 0', async () => {
      setupSpawn({ stdout: 'I fixed the bug in main.ts', stderr: '' });
      setupGitExec(['src/main.ts']);

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['src/main.ts']);
      expect(result.summary).toContain('I fixed the bug');
    });

    it('spawns copilot with correct arguments', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['file.ts']);

      const runner = new CopilotRunner();
      await runner.run(makeCtx());

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMock.mock.calls[0];
      expect(cmd).toBe('copilot');
      expect(args).toContain('--yolo');
      expect(args).toContain('-p');
      expect(opts).toHaveProperty('cwd', '/tmp/repo');
    });

    it('returns failure when copilot exits with non-zero code', async () => {
      setupSpawn({ stdout: '', stderr: 'copilot error', code: 1 });

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('copilot exited with code 1');
    });

    it('returns failure when spawn emits an error event', async () => {
      setupSpawnError(new Error('ENOENT: copilot not found'));

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('returns failure with no files changed', async () => {
      setupSpawn({ stdout: 'No changes needed', stderr: '' });
      setupGitExec([], []);

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('No files were modified');
      expect(result.summary).toBe('Agent made no changes');
    });

    it('includes untracked files in filesChanged', async () => {
      setupSpawn({ stdout: 'Created new file', stderr: '' });
      setupGitExec(['existing.ts'], ['new-file.ts']);

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['existing.ts', 'new-file.ts']);
    });

    it('stages, commits with default template', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['src/main.ts']);

      const runner = new CopilotRunner();
      await runner.run(makeCtx());

      // Check that git add -A was called
      const addCall = execFileMock.mock.calls.find((c) => Array.isArray(c[1]) && c[1][0] === 'add');
      expect(addCall).toBeTruthy();

      // Check that git commit was called with message containing issue info
      const commitCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      expect(commitCall).toBeTruthy();
      const commitArgs = commitCall![1] as string[];
      expect(commitArgs).toContain('-m');
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('42');
      expect(msg).toContain('Co-Authored-By:');
    });

    it('uses custom commitMessageTemplate and commitCoAuthor', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CopilotRunner();
      await runner.run(
        makeCtx({
          commitMessageTemplate: 'feat({issueNumber}): {issueTitle}',
          commitCoAuthor: 'Bot <bot@test.com>',
        }),
      );

      const commitCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      const commitArgs = commitCall![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('feat(42): Fix the widget');
      expect(msg).toContain('Bot <bot@test.com>');
    });

    it('parses token usage from stderr', async () => {
      setupSpawn({
        stdout: 'done',
        stderr: 'Input tokens: 500\nOutput tokens: 200',
      });
      setupGitExec(['f.ts']);

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(500);
      expect(result.tokenUsage!.outputTokens).toBe(200);
    });

    it('includes tokenUsage even when no files changed', async () => {
      setupSpawn({
        stdout: 'nothing to do',
        stderr: 'Input tokens: 100\nOutput tokens: 50',
      });
      setupGitExec([], []);

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(100);
    });

    it('truncates summary to 2000 chars', async () => {
      const longOutput = 'x'.repeat(3000);
      setupSpawn({ stdout: longOutput, stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.summary.length).toBe(2000);
    });

    it('handles non-Error thrown values', async () => {
      // Simulate spawn throwing a non-Error
      spawnMock.mockImplementation(() => {
        throw 'string error';
      });

      const runner = new CopilotRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });

    it('uses ctx.timeoutMs when provided', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CopilotRunner();
      await runner.run(makeCtx({ timeoutMs: 60000 }));

      const [, , opts] = spawnMock.mock.calls[0];
      expect((opts as Record<string, unknown>).timeout).toBe(60000);
    });
  });
});
