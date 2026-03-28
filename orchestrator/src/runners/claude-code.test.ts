import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildPrompt,
  parseTokenUsage,
  ClaudeCodeRunner,
  GitHubActionsRunner,
} from './claude-code.js';
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
 * Wrap plain text in a stream-json result event (NDJSON line).
 * The runner now uses --output-format stream-json, so stdout is NDJSON.
 */
function makeStreamResult(text: string, cost?: number): string {
  const event = {
    type: 'result',
    subtype: 'success',
    result: text,
    total_cost_usd: cost ?? 0.01,
    modelUsage: {
      'test-model': {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 0,
      },
    },
  };
  return JSON.stringify(event) + '\n';
}

function setupSpawn(opts: { stdout?: string; stderr?: string; code?: number }) {
  const child = makeFakeChild();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);

  queueMicrotask(() => {
    // Wrap stdout in stream-json format if it's plain text
    if (opts.stdout) {
      const streamOutput = opts.stdout.startsWith('{')
        ? opts.stdout
        : makeStreamResult(opts.stdout);
      child.stdout.emit('data', Buffer.from(streamOutput));
    }
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

/**
 * Mock execFile for git and lint/format commands.
 * commitFailOnce: if true, the first 'commit' call fails, the second succeeds (tests retry logic).
 */
function setupGitExec(
  changedFiles: string[],
  untrackedFiles: string[] = [],
  opts?: { commitFailOnce?: boolean },
) {
  let commitAttempt = 0;

  // @ts-expect-error -- partial mock for test
  execFileMock.mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb?: unknown) => {
    const callback =
      typeof _opts === 'function' ? _opts : (cb as ((...a: unknown[]) => void) | undefined);
    const cmdStr = typeof _cmd === 'string' ? _cmd : '';
    const gitArgs = Array.isArray(args) ? args : [];

    let stdout = '';
    let error: Error | null = null;

    if (cmdStr === 'git') {
      if (gitArgs[0] === 'diff' && gitArgs[1] === '--name-only') {
        stdout = changedFiles.join('\n');
      } else if (gitArgs[0] === 'ls-files') {
        stdout = untrackedFiles.join('\n');
      } else if (gitArgs[0] === 'commit') {
        commitAttempt++;
        if (opts?.commitFailOnce && commitAttempt === 1) {
          error = new Error('pre-commit hook failed');
        }
      }
      // add => empty stdout
    }
    // lint/format commands (non-git) => succeed silently

    if (callback) {
      if (error) {
        callback(error, { stdout: '', stderr: error.message });
      } else {
        callback(null, { stdout, stderr: '' });
      }
      return undefined as unknown;
    }
    if (error) throw error;
    return { stdout, stderr: '' } as unknown;
  });
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('ClaudeCodeRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildPrompt', () => {
    it('omits lint/format instructions when no commands configured', () => {
      const prompt = buildPrompt(makeCtx());
      expect(prompt).not.toContain('pnpm lint');
      expect(prompt).not.toContain('pnpm format');
      expect(prompt).not.toContain('run `undefined`');
      expect(prompt).toContain('Read the relevant source files');
      expect(prompt).toContain('Implement the fix or feature');
    });

    it('includes lint/format when ctx.lintCommand and ctx.formatCommand set', () => {
      const prompt = buildPrompt(
        makeCtx({
          lintCommand: 'npm run lint',
          formatCommand: 'npm run format',
        }),
      );
      expect(prompt).toContain('`npm run lint`');
      expect(prompt).toContain('`npm run format`');
    });

    it('includes lint/format in CI error branch when commands set', () => {
      const prompt = buildPrompt(
        makeCtx({
          lintCommand: 'pnpm lint',
          formatCommand: 'pnpm format',
          ciErrors: 'Error: test failed',
        }),
      );
      expect(prompt).toContain('CI Failure Logs');
      expect(prompt).toContain('`pnpm lint`');
      expect(prompt).toContain('`pnpm format`');
    });

    it('includes only lintCommand when formatCommand is not set', () => {
      const prompt = buildPrompt(
        makeCtx({
          lintCommand: 'eslint .',
        }),
      );
      expect(prompt).toContain('`eslint .`');
      expect(prompt).not.toContain('format');
    });

    it('includes only formatCommand when lintCommand is not set', () => {
      const prompt = buildPrompt(
        makeCtx({
          formatCommand: 'prettier --write .',
        }),
      );
      expect(prompt).toContain('`prettier --write .`');
      expect(prompt).not.toMatch(/run `.*lint/);
    });

    it('uses dynamic step numbering (steps adjust when instructions omitted)', () => {
      const promptWithCmds = buildPrompt(
        makeCtx({
          lintCommand: 'npm run lint',
          formatCommand: 'npm run format',
        }),
      );
      const promptWithout = buildPrompt(makeCtx());

      const stepsWithCmds = promptWithCmds.match(/^\d+\./gm) ?? [];
      const stepsWithout = promptWithout.match(/^\d+\./gm) ?? [];
      expect(stepsWithCmds.length).toBeGreaterThan(stepsWithout.length);
    });

    it('CI branch with only lintCommand omits format instructions', () => {
      const prompt = buildPrompt(
        makeCtx({
          lintCommand: 'eslint .',
          ciErrors: 'lint error',
        }),
      );
      expect(prompt).toContain('`eslint .`');
      expect(prompt).not.toContain('formatting/prettier');
    });

    it('CI branch with only formatCommand includes format-specific step', () => {
      const prompt = buildPrompt(
        makeCtx({
          formatCommand: 'prettier --write .',
          ciErrors: 'format error',
        }),
      );
      expect(prompt).toContain('formatting/prettier');
      expect(prompt).toContain('`prettier --write .`');
    });

    it('handles non-numeric issueId without hash prefix', () => {
      const prompt = buildPrompt(makeCtx({ issueId: 'PROJ-42' }));
      expect(prompt).toContain('issue PROJ-42');
      expect(prompt).not.toContain('issue #PROJ-42');
    });

    it('handles numeric issueId with hash prefix', () => {
      const prompt = buildPrompt(makeCtx({ issueId: '42' }));
      expect(prompt).toContain('issue #42');
    });

    it('includes episodic context when provided', () => {
      const prompt = buildPrompt(
        makeCtx({
          episodicContext: '## Previous Run\n- Fixed a similar issue in utils.ts',
        }),
      );
      expect(prompt).toContain('## Previous Run');
      expect(prompt).toContain('Fixed a similar issue in utils.ts');
    });

    it('includes memory episodes when memory is provided', () => {
      const prompt = buildPrompt(
        makeCtx({
          memory: {
            episodic: {
              search: vi.fn().mockReturnValue([
                { key: 'issue-42-run-1', metadata: { summary: 'First attempt failed' } },
                { key: 'issue-42-run-2', metadata: { summary: 'Partial fix applied' } },
              ]),
              add: vi.fn(),
              remove: vi.fn(),
              all: vi.fn(),
            },
          } as unknown as AgentContext['memory'],
        }),
      );
      expect(prompt).toContain('## Previous Context');
      expect(prompt).toContain('First attempt failed');
      expect(prompt).toContain('Partial fix applied');
    });

    it('uses episode key when metadata lacks summary', () => {
      const prompt = buildPrompt(
        makeCtx({
          memory: {
            episodic: {
              search: vi.fn().mockReturnValue([{ key: 'issue-42-data', metadata: {} }]),
              add: vi.fn(),
              remove: vi.fn(),
              all: vi.fn(),
            },
          } as unknown as AgentContext['memory'],
        }),
      );
      expect(prompt).toContain('issue-42-data');
    });

    it('skips memory section when no episodes match', () => {
      const prompt = buildPrompt(
        makeCtx({
          memory: {
            episodic: {
              search: vi.fn().mockReturnValue([]),
              add: vi.fn(),
              remove: vi.fn(),
              all: vi.fn(),
            },
          } as unknown as AgentContext['memory'],
        }),
      );
      expect(prompt).not.toContain('## Previous Context');
    });

    it('includes review findings section when reviewFindings provided', () => {
      const prompt = buildPrompt(
        makeCtx({
          reviewFindings:
            '### Review by security-agent\n\nFound SQL injection vulnerability in user input handling.',
        }),
      );
      expect(prompt).toContain('## Review Findings');
      expect(prompt).toContain('### Review by security-agent');
      expect(prompt).toContain('SQL injection vulnerability');
      expect(prompt).toContain('Read the review findings above carefully');
      expect(prompt).toContain('Address all the review findings');
    });

    it('review findings branch includes lint/format instructions when commands set', () => {
      const prompt = buildPrompt(
        makeCtx({
          reviewFindings: '### Review\n\nPlease add tests.',
          lintCommand: 'pnpm lint',
          formatCommand: 'pnpm format',
        }),
      );
      expect(prompt).toContain('## Review Findings');
      expect(prompt).toContain('`pnpm lint`');
      expect(prompt).toContain('`pnpm format`');
    });

    it('includes constraints section in review findings branch', () => {
      const prompt = buildPrompt(
        makeCtx({
          reviewFindings: '### Review\n\nPlease add tests.',
          constraints: {
            maxFilesPerChange: 15,
            requireTests: true,
            blockedPaths: ['.github/workflows/**', '.ai-sdlc/**'],
          },
        }),
      );
      expect(prompt).toContain('## Constraints');
      expect(prompt).toContain('Maximum files to change: 15');
      expect(prompt).toContain('Tests required: true');
      expect(prompt).toContain('.github/workflows/**, .ai-sdlc/**');
    });
  });

  describe('parseTokenUsage', () => {
    it('parses input/output token counts', () => {
      const result = parseTokenUsage('Input tokens: 1,234\nOutput tokens: 5,678', 'test-model');
      expect(result).toEqual({
        inputTokens: 1234,
        outputTokens: 5678,
        model: 'test-model',
      });
    });

    it('returns undefined when no token info in stderr', () => {
      expect(parseTokenUsage('some random output', 'model')).toBeUndefined();
    });

    it('parses total tokens and estimates split', () => {
      const result = parseTokenUsage('Total tokens: 10000', 'model');
      expect(result).toBeDefined();
      expect(result!.inputTokens).toBe(7000);
      expect(result!.outputTokens).toBe(3000);
    });

    it('handles input-only match', () => {
      const result = parseTokenUsage('Input tokens: 500', 'model');
      expect(result).toEqual({
        inputTokens: 500,
        outputTokens: 0,
        model: 'model',
      });
    });

    it('parses cache read tokens', () => {
      const result = parseTokenUsage(
        'Input tokens: 1000\nOutput tokens: 500\nCache read tokens: 200',
        'model',
      );
      expect(result).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        model: 'model',
      });
    });

    it('parses cache hit tokens variant', () => {
      const result = parseTokenUsage(
        'Input tokens: 800\nOutput tokens: 400\nCache hit tokens: 150',
        'model',
      );
      expect(result!.cacheReadTokens).toBe(150);
    });

    it('returns undefined for empty string', () => {
      expect(parseTokenUsage('', 'model')).toBeUndefined();
    });
  });

  describe('run()', () => {
    it('returns success with changed files when claude exits 0', async () => {
      setupSpawn({ stdout: 'I fixed the widget in widget.ts', stderr: '' });
      setupGitExec(['src/widget.ts']);

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['src/widget.ts']);
      expect(result.summary).toContain('I fixed the widget');
    });

    it('spawns claude with correct arguments and writes prompt via stdin', async () => {
      const child = setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['file.ts']);

      const runner = new ClaudeCodeRunner();
      await runner.run(makeCtx());

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMock.mock.calls[0];
      expect(cmd).toBe('claude');
      expect(args).toContain('-p');
      expect(args).toContain('--model');
      expect(args).toContain('--allowedTools');
      expect((opts as Record<string, unknown>).cwd).toBe('/tmp/repo');
      expect((opts as Record<string, unknown>).stdio).toEqual(['pipe', 'pipe', 'pipe']);

      // Prompt written to stdin
      expect(child.stdin.write).toHaveBeenCalledTimes(1);
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
    });

    it('uses ctx.model when provided', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new ClaudeCodeRunner();
      await runner.run(makeCtx({ model: 'claude-opus-4-6' }));

      const [, args] = spawnMock.mock.calls[0];
      const modelIdx = (args as string[]).indexOf('--model');
      expect((args as string[])[modelIdx + 1]).toBe('claude-opus-4-6');
    });

    it('uses ctx.allowedTools when provided', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new ClaudeCodeRunner();
      await runner.run(makeCtx({ allowedTools: ['Read', 'Write'] }));

      const [, args] = spawnMock.mock.calls[0];
      const toolsIdx = (args as string[]).indexOf('--allowedTools');
      expect((args as string[])[toolsIdx + 1]).toBe('Read,Write');
    });

    it('returns failure when claude exits with non-zero code', async () => {
      setupSpawn({ stdout: '', stderr: 'claude error', code: 1 });

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('claude exited with code 1');
    });

    it('returns failure when spawn emits error', async () => {
      setupSpawnError(new Error('ENOENT: claude not found'));

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('returns failure when no files changed', async () => {
      setupSpawn({ stdout: 'No changes', stderr: '' });
      setupGitExec([], []);

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('No files were modified');
      expect(result.summary).toBe('Agent made no changes');
    });

    it('includes untracked files in filesChanged', async () => {
      setupSpawn({ stdout: 'Created new file', stderr: '' });
      setupGitExec(['modified.ts'], ['new.ts']);

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['modified.ts', 'new.ts']);
    });

    it('stages, runs autofix, and commits', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['src/widget.ts']);

      const runner = new ClaudeCodeRunner();
      await runner.run(makeCtx());

      // git add should be called (at least twice: once before autofix, once after)
      const addCalls = execFileMock.mock.calls.filter(
        (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'add',
      );
      expect(addCalls.length).toBeGreaterThanOrEqual(2);

      // git commit should be called
      const commitCall = execFileMock.mock.calls.find(
        (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      expect(commitCall).toBeTruthy();
    });

    it('retries commit on pre-commit hook failure', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['src/widget.ts'], [], { commitFailOnce: true });

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);

      // Commit should have been called twice
      const commitCalls = execFileMock.mock.calls.filter(
        (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      expect(commitCalls.length).toBe(2);
    });

    it('uses custom commitMessageTemplate and commitCoAuthor', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new ClaudeCodeRunner();
      await runner.run(
        makeCtx({
          commitMessageTemplate: 'fix({issueNumber}): {issueTitle}',
          commitCoAuthor: 'ClaudeBot <claude@test.com>',
        }),
      );

      const commitCall = execFileMock.mock.calls.find(
        (c) => c[0] === 'git' && Array.isArray(c[1]) && c[1][0] === 'commit',
      );
      const commitArgs = commitCall![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('fix(42): Fix the widget');
      expect(msg).toContain('ClaudeBot <claude@test.com>');
    });

    it('parses token usage from stderr', async () => {
      setupSpawn({
        stdout: 'done',
        stderr: 'Input tokens: 2,000\nOutput tokens: 800\nCache read tokens: 500',
      });
      setupGitExec(['f.ts']);

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(2000);
      expect(result.tokenUsage!.outputTokens).toBe(800);
      expect(result.tokenUsage!.cacheReadTokens).toBe(500);
    });

    it('includes tokenUsage even when no files changed', async () => {
      setupSpawn({
        stdout: 'nothing',
        stderr: 'Input tokens: 300\nOutput tokens: 100',
      });
      setupGitExec([], []);

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(300);
    });

    it('truncates summary to 2000 chars', async () => {
      const longOutput = 'a'.repeat(3000);
      setupSpawn({ stdout: longOutput, stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.summary.length).toBe(2000);
    });

    it('handles non-Error thrown values', async () => {
      spawnMock.mockImplementation(() => {
        throw 'unexpected string error';
      });

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('unexpected string error');
    });

    it('uses ctx.timeoutMs when provided', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new ClaudeCodeRunner();
      await runner.run(makeCtx({ timeoutMs: 60000 }));

      const [, , opts] = spawnMock.mock.calls[0];
      expect((opts as Record<string, unknown>).timeout).toBe(60000);
    });

    it('runs lint and format commands during autofix', async () => {
      setupSpawn({ stdout: 'done', stderr: '' });
      setupGitExec(['f.ts']);

      const runner = new ClaudeCodeRunner();
      await runner.run(
        makeCtx({
          lintCommand: 'eslint --fix .',
          formatCommand: 'prettier --write .',
        }),
      );

      // Check that format and lint commands were invoked
      const prettierCall = execFileMock.mock.calls.find((c) => c[0] === 'prettier');
      expect(prettierCall).toBeTruthy();

      const eslintCall = execFileMock.mock.calls.find((c) => c[0] === 'eslint');
      expect(eslintCall).toBeTruthy();
    });

    it('autofix continues even if lint/format commands fail', async () => {
      let _callCount = 0;
      setupSpawn({ stdout: 'done', stderr: '' });

      // Override execFile to fail on lint/format but succeed on git
      execFileMock.mockImplementation(
        // @ts-expect-error -- partial mock for test
        (_cmd: unknown, args: unknown, _opts: unknown, cb?: unknown) => {
          const callback =
            typeof _opts === 'function' ? _opts : (cb as ((...a: unknown[]) => void) | undefined);
          const cmdStr = typeof _cmd === 'string' ? _cmd : '';
          const gitArgs = Array.isArray(args) ? args : [];
          _callCount++;

          let stdout = '';

          if (cmdStr === 'git') {
            if (gitArgs[0] === 'diff' && gitArgs[1] === '--name-only') {
              stdout = 'f.ts';
            } else if (gitArgs[0] === 'ls-files') {
              stdout = '';
            }
            if (callback) {
              callback(null, { stdout, stderr: '' });
              return undefined as unknown;
            }
            return { stdout, stderr: '' } as unknown;
          }

          // Non-git commands (lint/format) fail
          if (callback) {
            callback(new Error('lint failed'), { stdout: '', stderr: 'lint error' });
            return undefined as unknown;
          }
          throw new Error('lint failed');
        },
      );

      const runner = new ClaudeCodeRunner();
      const result = await runner.run(
        makeCtx({
          lintCommand: 'eslint --fix .',
          formatCommand: 'prettier --write .',
        }),
      );

      // Should still succeed since lint/format failures are non-fatal
      expect(result.success).toBe(true);
    });
  });

  describe('GitHubActionsRunner alias', () => {
    it('is an alias for ClaudeCodeRunner', () => {
      expect(GitHubActionsRunner).toBe(ClaudeCodeRunner);
    });
  });
});
