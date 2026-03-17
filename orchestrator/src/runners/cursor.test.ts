import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseStreamJson, parseTokenUsage, CursorRunner } from './cursor.js';
import type { AgentContext } from './types.js';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    execFile: vi.fn(),
  };
});

import { spawn, execFile } from 'node:child_process';

const spawnMock = vi.mocked(spawn);
const execFileMock = vi.mocked(execFile);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    issueId: '7',
    issueNumber: 7,
    issueTitle: 'Refactor auth module',
    issueBody: 'The auth module needs refactoring for clarity.',
    workDir: '/tmp/cursor-repo',
    branch: 'ai-sdlc/issue-7',
    constraints: {
      maxFilesPerChange: 5,
      requireTests: true,
      blockedPaths: ['.github/workflows/**'],
    },
    ...overrides,
  };
}

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

function setupSpawn(opts: { stdout?: string; stderr?: string; code?: number }) {
  const child = makeFakeChild();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);

  queueMicrotask(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code ?? 0);
  });

  return child;
}

function setupSpawnError(err: Error) {
  const child = makeFakeChild();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);
  queueMicrotask(() => {
    child.emit('error', err);
  });
  return child;
}

function setupGitExec(changedFiles: string[], untrackedFiles: string[] = []) {
  // @ts-expect-error -- partial mock for test
  execFileMock.mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb?: unknown) => {
    const callback =
      typeof _opts === 'function' ? _opts : (cb as ((...a: unknown[]) => void) | undefined);
    const gitArgs = Array.isArray(args) ? args : [];

    let stdout = '';
    if (gitArgs[0] === 'diff' && gitArgs[1] === '--name-only') {
      stdout = changedFiles.join('\n');
    } else if (gitArgs[0] === 'ls-files') {
      stdout = untrackedFiles.join('\n');
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

describe('CursorRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseStreamJson', () => {
    it('extracts final assistant message from NDJSON', () => {
      const stdout = [
        '{"role":"system","content":"You are a helpful assistant"}',
        '{"role":"user","content":"Fix the bug"}',
        '{"role":"assistant","content":"I found the issue in main.ts"}',
        '{"role":"assistant","content":"Fixed the bug by updating the handler"}',
      ].join('\n');

      expect(parseStreamJson(stdout)).toBe('Fixed the bug by updating the handler');
    });

    it('skips non-assistant messages', () => {
      const stdout = [
        '{"role":"user","content":"Fix it"}',
        '{"role":"assistant","content":"Done"}',
        '{"role":"user","content":"Thanks"}',
      ].join('\n');

      expect(parseStreamJson(stdout)).toBe('Done');
    });

    it('skips malformed JSON lines', () => {
      const stdout = [
        'not json at all',
        '{"role":"assistant","content":"Valid message"}',
        '{broken json',
      ].join('\n');

      expect(parseStreamJson(stdout)).toBe('Valid message');
    });

    it('falls back to raw stdout when no assistant messages', () => {
      const stdout = '{"role":"system","content":"setup"}\n{"event":"done"}';
      const result = parseStreamJson(stdout);
      expect(result).toBe(stdout.slice(0, 2000));
    });

    it('falls back to raw stdout for empty input', () => {
      expect(parseStreamJson('')).toBe('');
    });

    it('handles objects with non-string content', () => {
      const stdout = '{"role":"assistant","content":123}';
      const result = parseStreamJson(stdout);
      // content is not a string so it is skipped; falls back to raw stdout
      expect(result).toBe(stdout.slice(0, 2000));
    });
  });

  describe('parseTokenUsage', () => {
    it('parses input/output token counts', () => {
      const result = parseTokenUsage('Input tokens: 2,500\nOutput tokens: 800', 'cursor-model');
      expect(result).toEqual({
        inputTokens: 2500,
        outputTokens: 800,
        model: 'cursor-model',
      });
    });

    it('parses total tokens and estimates split', () => {
      const result = parseTokenUsage('Total tokens: 5000', 'cursor-model');
      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(3500);
      expect(result!.outputTokens).toBe(1500);
    });

    it('returns undefined when no token info', () => {
      expect(parseTokenUsage('cursor-agent complete', 'model')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(parseTokenUsage('', 'model')).toBeUndefined();
    });

    it('parses input-only', () => {
      const result = parseTokenUsage('Input tokens: 999', 'model');
      expect(result).toEqual({ inputTokens: 999, outputTokens: 0, model: 'model' });
    });

    it('parses output-only', () => {
      const result = parseTokenUsage('Output tokens: 777', 'model');
      expect(result).toEqual({ inputTokens: 0, outputTokens: 777, model: 'model' });
    });
  });

  describe('run()', () => {
    it('returns success with changed files when cursor-agent exits 0', async () => {
      const ndjson = ['{"role":"assistant","content":"Refactored the auth module"}'].join('\n');
      setupSpawn({ stdout: ndjson, stderr: '' });
      setupGitExec(['src/auth.ts']);

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['src/auth.ts']);
      expect(result.summary).toContain('Refactored the auth module');
    });

    it('spawns cursor-agent with correct arguments', async () => {
      setupSpawn({ stdout: '{"role":"assistant","content":"done"}', stderr: '' });
      setupGitExec(['file.ts']);

      const runner = new CursorRunner();
      await runner.run(makeCtx());

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMock.mock.calls[0];
      expect(cmd).toBe('cursor-agent');
      expect(args).toContain('--print');
      expect(args).toContain('--force');
      expect(args).toContain('--output-format=stream-json');
      expect((opts as Record<string, unknown>).cwd).toBe('/tmp/cursor-repo');
      expect((opts as Record<string, unknown>).stdio).toEqual(['ignore', 'pipe', 'pipe']);
    });

    it('returns failure when cursor-agent exits with non-zero code', async () => {
      setupSpawn({ stdout: '', stderr: 'cursor agent crashed', code: 1 });

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('cursor-agent exited with code 1');
      expect(result.error).toContain('cursor agent crashed');
    });

    it('returns failure when spawn emits error', async () => {
      setupSpawnError(new Error('ENOENT: cursor-agent not found'));

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('returns failure when no files changed', async () => {
      setupSpawn({ stdout: 'nothing', stderr: '' });
      setupGitExec([], []);

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('No files were modified');
      expect(result.summary).toBe('Agent made no changes');
    });

    it('includes untracked files in filesChanged', async () => {
      setupSpawn({ stdout: '{"role":"assistant","content":"Created files"}', stderr: '' });
      setupGitExec(['modified.ts'], ['new-file.ts']);

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['modified.ts', 'new-file.ts']);
    });

    it('stages and commits with default template', async () => {
      setupSpawn({ stdout: '{"role":"assistant","content":"done"}', stderr: '' });
      setupGitExec(['src/auth.ts']);

      const runner = new CursorRunner();
      await runner.run(makeCtx());

      const addCall = execFileMock.mock.calls.find((c) => Array.isArray(c[1]) && c[1][0] === 'add');
      expect(addCall).toBeTruthy();

      const commitCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      expect(commitCall).toBeTruthy();
      const commitArgs = commitCall![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('7');
      expect(msg).toContain('Co-Authored-By:');
    });

    it('uses custom commitMessageTemplate and commitCoAuthor', async () => {
      setupSpawn({ stdout: '{"role":"assistant","content":"done"}', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CursorRunner();
      await runner.run(
        makeCtx({
          commitMessageTemplate: 'refactor({issueNumber}): {issueTitle}',
          commitCoAuthor: 'CursorBot <cursor@test.com>',
        }),
      );

      const commitCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      const commitArgs = commitCall![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('refactor(7): Refactor auth module');
      expect(msg).toContain('CursorBot <cursor@test.com>');
    });

    it('parses token usage from stderr', async () => {
      setupSpawn({
        stdout: '{"role":"assistant","content":"done"}',
        stderr: 'Input tokens: 3,000\nOutput tokens: 1,200',
      });
      setupGitExec(['f.ts']);

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(3000);
      expect(result.tokenUsage!.outputTokens).toBe(1200);
    });

    it('uses parseStreamJson for summary extraction', async () => {
      const ndjson = [
        '{"role":"system","content":"system prompt"}',
        '{"role":"assistant","content":"First response"}',
        '{"role":"assistant","content":"Final response with details"}',
      ].join('\n');
      setupSpawn({ stdout: ndjson, stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.summary).toBe('Final response with details');
    });

    it('includes tokenUsage even when no files changed', async () => {
      setupSpawn({
        stdout: 'nothing',
        stderr: 'Input tokens: 500\nOutput tokens: 100',
      });
      setupGitExec([], []);

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(500);
    });

    it('truncates summary to 2000 chars', async () => {
      const longContent = 'z'.repeat(3000);
      const ndjson = `{"role":"assistant","content":"${longContent}"}`;
      setupSpawn({ stdout: ndjson, stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.summary.length).toBe(2000);
    });

    it('handles non-Error thrown values', async () => {
      spawnMock.mockImplementation(() => {
        throw { message: 'weird object' };
      });

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('uses ctx.timeoutMs when provided', async () => {
      setupSpawn({ stdout: '{"role":"assistant","content":"done"}', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CursorRunner();
      await runner.run(makeCtx({ timeoutMs: 30000 }));

      const [, , opts] = spawnMock.mock.calls[0];
      expect((opts as Record<string, unknown>).timeout).toBe(30000);
    });

    it('falls back to stdout when no exit code error output', async () => {
      setupSpawn({ stdout: 'out message', stderr: '', code: 3 });

      const runner = new CursorRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('out message');
    });
  });
});
