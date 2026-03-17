import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { parseTokenUsage, CodexRunner } from './codex.js';
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
    issueId: '99',
    issueNumber: 99,
    issueTitle: 'Add search feature',
    issueBody: 'We need a full-text search.',
    workDir: '/tmp/codex-repo',
    branch: 'ai-sdlc/issue-99',
    constraints: {
      maxFilesPerChange: 10,
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
    // add, commit => empty stdout

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

describe('CodexRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseTokenUsage', () => {
    it('parses usage from NDJSON events', () => {
      const stderr = [
        '{"event":"start","ts":1234}',
        '{"event":"usage","usage":{"input_tokens":100,"output_tokens":50}}',
        '{"event":"done"}',
      ].join('\n');

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        model: 'codex-model',
      });
    });

    it('accumulates usage across multiple events', () => {
      const stderr = [
        '{"usage":{"input_tokens":100,"output_tokens":50}}',
        '{"usage":{"input_tokens":200,"output_tokens":100}}',
      ].join('\n');

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        model: 'codex-model',
      });
    });

    it('supports token_usage alias', () => {
      const stderr = '{"token_usage":{"prompt_tokens":500,"completion_tokens":200}}';

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 500,
        outputTokens: 200,
        model: 'codex-model',
      });
    });

    it('falls back to regex when no JSON events', () => {
      const stderr = 'Input tokens: 1,234\nOutput tokens: 567';

      const result = parseTokenUsage(stderr, 'codex-model');
      expect(result).toEqual({
        inputTokens: 1234,
        outputTokens: 567,
        model: 'codex-model',
      });
    });

    it('returns undefined for empty string', () => {
      expect(parseTokenUsage('', 'model')).toBeUndefined();
    });

    it('returns undefined when no token info', () => {
      expect(parseTokenUsage('codex exec complete', 'model')).toBeUndefined();
    });

    it('ignores JSON lines without usage fields', () => {
      const stderr = [
        '{"event":"start"}',
        '{"event":"message","content":"hello"}',
        '{"event":"done"}',
      ].join('\n');

      expect(parseTokenUsage(stderr, 'model')).toBeUndefined();
    });

    it('parses total tokens fallback', () => {
      const result = parseTokenUsage('Total tokens: 2,000', 'codex-model');
      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(1400);
      expect(result!.outputTokens).toBe(600);
    });

    it('handles JSON events with zero values', () => {
      const stderr = '{"usage":{"input_tokens":0,"output_tokens":0}}';
      // foundJson is true but totals are both 0, so it falls through
      expect(parseTokenUsage(stderr, 'model')).toBeUndefined();
    });
  });

  describe('run()', () => {
    it('returns success with changed files when codex exits 0', async () => {
      setupSpawn({ stdout: 'Implemented search feature', stderr: '' });
      setupGitExec(['src/search.ts', 'src/index.ts']);

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['src/search.ts', 'src/index.ts']);
      expect(result.summary).toContain('Implemented search');
    });

    it('spawns codex with correct arguments and writes prompt to stdin', async () => {
      const child = setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['file.ts']);

      const runner = new CodexRunner();
      await runner.run(makeCtx());

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMock.mock.calls[0];
      expect(cmd).toBe('codex');
      expect(args).toContain('exec');
      expect(args).toContain('-');
      expect(args).toContain('--full-auto');
      expect(args).toContain('--json');
      expect((opts as Record<string, unknown>).cwd).toBe('/tmp/codex-repo');
      expect((opts as Record<string, unknown>).stdio).toEqual(['pipe', 'pipe', 'pipe']);

      // Verify prompt was written to stdin
      expect(child.stdin.write).toHaveBeenCalledTimes(1);
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
    });

    it('returns failure when codex exits with non-zero code', async () => {
      setupSpawn({ stdout: '', stderr: 'fatal error in codex', code: 2 });

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('codex exited with code 2');
      expect(result.error).toContain('fatal error in codex');
    });

    it('returns failure when spawn emits error', async () => {
      setupSpawnError(new Error('ENOENT: codex not found'));

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('returns failure when no files changed', async () => {
      setupSpawn({ stdout: 'No changes needed', stderr: '' });
      setupGitExec([], []);

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('No files were modified');
      expect(result.summary).toBe('Agent made no changes');
    });

    it('includes untracked files in filesChanged', async () => {
      setupSpawn({ stdout: 'Created new module', stderr: '' });
      setupGitExec(['existing.ts'], ['brand-new.ts']);

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['existing.ts', 'brand-new.ts']);
    });

    it('stages and commits files', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['src/search.ts']);

      const runner = new CodexRunner();
      await runner.run(makeCtx());

      const addCall = execFileMock.mock.calls.find((c) => Array.isArray(c[1]) && c[1][0] === 'add');
      expect(addCall).toBeTruthy();

      const commitCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      expect(commitCall).toBeTruthy();
      const commitArgs = commitCall![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('99');
      expect(msg).toContain('Co-Authored-By:');
    });

    it('uses custom commitMessageTemplate and commitCoAuthor', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CodexRunner();
      await runner.run(
        makeCtx({
          commitMessageTemplate: 'chore({issueNumber}): {issueTitle}',
          commitCoAuthor: 'CodexBot <codex@test.com>',
        }),
      );

      const commitCall = execFileMock.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      const commitArgs = commitCall![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('chore(99): Add search feature');
      expect(msg).toContain('CodexBot <codex@test.com>');
    });

    it('parses token usage from NDJSON stderr', async () => {
      const stderr = '{"usage":{"input_tokens":1000,"output_tokens":400}}';
      setupSpawn({ stdout: 'done', stderr });
      setupGitExec(['f.ts']);

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(1000);
      expect(result.tokenUsage!.outputTokens).toBe(400);
    });

    it('includes tokenUsage even when no files changed', async () => {
      const stderr = 'Input tokens: 200\nOutput tokens: 80';
      setupSpawn({ stdout: 'nothing to do', stderr });
      setupGitExec([], []);

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(200);
    });

    it('truncates summary to 2000 chars', async () => {
      const longOutput = 'y'.repeat(3000);
      setupSpawn({ stdout: longOutput, stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.summary.length).toBe(2000);
    });

    it('handles non-Error thrown values', async () => {
      spawnMock.mockImplementation(() => {
        throw 42;
      });

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('42');
    });

    it('uses ctx.timeoutMs when provided', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new CodexRunner();
      await runner.run(makeCtx({ timeoutMs: 120000 }));

      const [, , opts] = spawnMock.mock.calls[0];
      expect((opts as Record<string, unknown>).timeout).toBe(120000);
    });

    it('prefers stderr over stdout in error message on non-zero exit', async () => {
      setupSpawn({ stdout: 'stdout content', stderr: '', code: 1 });

      const runner = new CodexRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      // When stderr is empty, should fall back to stdout
      expect(result.error).toContain('stdout content');
    });
  });
});
