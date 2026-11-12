import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { buildKiroArgs, parseKiroStream, KiroRunner } from './kiro.js';
import { DEFAULT_RUNNER_TIMEOUT_MS } from '../defaults.js';
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
/*  Synthetic kiro-cli output                                          */
/* ------------------------------------------------------------------ */

// Event shapes follow `kiro-cli chat --v3 --output-format stream-json`
// (kiro-cli 3.1.0). Session IDs, tool IDs and paths are placeholders.

const SESSION_ID = 'sess_00000000-0000-0000-0000-000000000000';

function event(type: string, data: unknown): string {
  return JSON.stringify({ type, data });
}

function sessionUpdate(update: Record<string, unknown>): string {
  return event('sessionUpdate', { sessionId: SESSION_ID, update });
}

function messageChunk(text: string): string {
  return sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
}

function runFinished(finalText: string, status = 'success', stopReason = 'end_turn'): string {
  return event('runFinished', {
    sessionId: SESSION_ID,
    status,
    stopReason,
    finalText,
    finalTextTruncated: false,
  });
}

function runError(stage: string, message: string): string {
  return event('runError', { sessionId: null, stage, message });
}

/** One JSON object per line, as kiro-cli writes them. */
function jsonl(...lines: string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}

const RUN_STARTED = event('runStarted', {
  payloadSchema: 'acp',
  acpProtocolVersion: 1,
  engine: 'v3',
});

const WRITE_FILE_CALL = sessionUpdate({
  sessionUpdate: 'tool_call',
  toolCallId: 'toolu_placeholder',
  title: 'Write File',
  kind: 'edit',
  status: 'in_progress',
  locations: [{ path: '/work/src/auth.ts' }],
  rawInput: { path: '/work/src/auth.ts', text: 'export {};\n' },
});

const WRITE_FILE_DONE = sessionUpdate({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'toolu_placeholder',
  status: 'completed',
  title: 'Write File',
  content: [
    { type: 'diff', path: 'file:///work/src/auth.ts', oldText: '', newText: 'export {};\n' },
  ],
  rawOutput: { message: 'Created the /work/src/auth.ts file.' },
});

const CREDIT_USAGE = sessionUpdate({
  sessionUpdate: 'session_info_update',
  _meta: {
    kiro: {
      kind: 'session_usage',
      credits: [{ usage: 0.0135, unit: 'credit', unitPlural: 'credits' }],
    },
  },
});

const INFO_STDERR = '[INFO] [KRS] <-- GenerateAssistantResponseCommand done totalEvents=9\n';

const NOT_LOGGED_IN =
  'Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.';

/** A successful file-editing run: tool call, agent reply, credit usage, runFinished. */
function successStream(finalText = 'Refactored the auth module'): string {
  return jsonl(
    RUN_STARTED,
    WRITE_FILE_CALL,
    WRITE_FILE_DONE,
    messageChunk(finalText),
    CREDIT_USAGE,
    runFinished(finalText),
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    issueId: '7',
    issueNumber: 7,
    issueTitle: 'Refactor auth module',
    issueBody: 'The auth module needs refactoring for clarity.',
    workDir: '/tmp/kiro-repo',
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

function setupSpawn(opts: {
  stdout?: string | string[];
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals;
}) {
  const child = makeFakeChild();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);

  queueMicrotask(() => {
    const stdoutChunks = typeof opts.stdout === 'string' ? [opts.stdout] : (opts.stdout ?? []);
    for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code === undefined ? 0 : opts.code, opts.signal ?? null);
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

function spawnEnoent(cmd: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT', path: cmd });
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

function gitCall(subcommand: string) {
  return execFileMock.mock.calls.find((c) => Array.isArray(c[1]) && c[1][0] === subcommand);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('KiroRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('buildKiroArgs', () => {
    it('builds a headless V3 chat argv with stream-json output and the prompt last', () => {
      expect(buildKiroArgs('do the thing', undefined)).toEqual([
        'chat',
        '--no-interactive',
        '--v3',
        '--trust-workspace',
        '--trust-all-tools',
        '--output-format',
        'stream-json',
        'do the thing',
      ]);
    });

    it('adds --model <id> before the prompt when a model is set, never -m', () => {
      const args = buildKiroArgs('do the thing', 'some-model');

      expect(args.slice(-3)).toEqual(['--model', 'some-model', 'do the thing']);
      expect(args).not.toContain('-m');
    });

    it('omits --model when the model is an empty string', () => {
      const args = buildKiroArgs('do the thing', '');

      expect(args).not.toContain('--model');
      expect(args).not.toContain('-m');
    });
  });

  describe('parseKiroStream', () => {
    it('uses runFinished finalText and ignores tool calls and usage updates', () => {
      const result = parseKiroStream(successStream('Refactored the auth module'));

      expect(result).toEqual({ succeeded: true, text: 'Refactored the auth module' });
    });

    it('falls back to streamed agent text when finalText is empty', () => {
      const stdout = jsonl(
        RUN_STARTED,
        messageChunk('Created '),
        messageChunk('the file'),
        runFinished(''),
      );

      expect(parseKiroStream(stdout)).toEqual({ succeeded: true, text: 'Created the file' });
    });

    it('reports a runError with its stage and message', () => {
      const result = parseKiroStream(jsonl(runError('auth', NOT_LOGGED_IN)));

      expect(result.succeeded).toBe(false);
      expect(result.failure).toBe(`auth error: ${NOT_LOGGED_IN}`);
    });

    it('treats a runFinished with a non-success status as a failure', () => {
      const result = parseKiroStream(
        jsonl(
          RUN_STARTED,
          messageChunk('partial'),
          runFinished('partial', 'cancelled', 'cancelled'),
        ),
      );

      expect(result.succeeded).toBe(false);
      expect(result.failure).toContain('cancelled');
    });

    it('is not successful when the stream has no terminal event', () => {
      const result = parseKiroStream(jsonl(RUN_STARTED, messageChunk('still working')));

      expect(result.succeeded).toBe(false);
      expect(result.failure).toBeUndefined();
      expect(result.text).toBe('still working');
    });

    it('skips malformed, non-object and unknown-type lines', () => {
      const stdout = [
        'not json at all',
        '{broken json',
        'null',
        '42',
        event('somethingNew', { foo: 'bar' }),
        sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image' } }),
        runFinished('Done'),
      ].join('\n');

      expect(parseKiroStream(stdout)).toEqual({ succeeded: true, text: 'Done' });
    });

    it('handles CRLF line endings and a final line without a newline', () => {
      const stdout = `${RUN_STARTED}\r\n${messageChunk('Done')}\r\n${runFinished('Done')}`;

      expect(parseKiroStream(stdout)).toEqual({ succeeded: true, text: 'Done' });
    });

    it('returns an unsuccessful empty result for empty input', () => {
      expect(parseKiroStream('')).toEqual({ succeeded: false, text: '' });
    });
  });

  describe('run()', () => {
    it('returns success with changed files when kiro-cli finishes successfully', async () => {
      setupSpawn({ stdout: successStream('Refactored the auth module'), stderr: INFO_STDERR });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['src/auth.ts']);
      expect(result.summary).toBe('Refactored the auth module');
      expect(result.error).toBeUndefined();
    });

    it('spawns kiro-cli with the headless argv, cwd, stdio and default timeout', async () => {
      setupSpawn({ stdout: successStream() });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      await runner.run(makeCtx());

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = spawnMock.mock.calls[0];
      expect(cmd).toBe('kiro-cli');
      expect((args as string[]).slice(0, 7)).toEqual([
        'chat',
        '--no-interactive',
        '--v3',
        '--trust-workspace',
        '--trust-all-tools',
        '--output-format',
        'stream-json',
      ]);
      expect((args as string[]).at(-1)).toContain('You are fixing issue #7: Refactor auth module');
      expect((opts as Record<string, unknown>).cwd).toBe('/tmp/kiro-repo');
      expect((opts as Record<string, unknown>).stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect((opts as Record<string, unknown>).timeout).toBe(DEFAULT_RUNNER_TIMEOUT_MS);
    });

    it('passes KIRO_API_KEY through the inherited environment, never argv', async () => {
      vi.stubEnv('KIRO_API_KEY', 'kiro-test-placeholder-key');
      setupSpawn({ stdout: successStream() });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      await runner.run(makeCtx());

      const [, args, opts] = spawnMock.mock.calls[0];
      const env = (opts as { env: Record<string, string | undefined> }).env;
      expect(env.KIRO_API_KEY).toBe('kiro-test-placeholder-key');
      expect((args as string[]).join(' ')).not.toContain('kiro-test-placeholder-key');
    });

    it('does not treat informational stderr as a failure', async () => {
      setupSpawn({ stdout: successStream(), stderr: INFO_STDERR, code: 0 });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
    });

    it('reports a setup error when kiro-cli is not installed', async () => {
      setupSpawnError(spawnEnoent('kiro-cli'));

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.summary).toBe('Agent execution failed');
      expect(result.error).toContain('Kiro CLI not found');
      expect(result.error).toContain('`kiro-cli` is not on PATH');
      expect(result.error).toContain('https://kiro.dev/docs/cli/');
      expect(result.error).toContain('KIRO_API_KEY');
    });

    it('does not blame kiro-cli when the openshell wrapper is missing', async () => {
      setupSpawnError(spawnEnoent('openshell'));

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx({ sandboxId: 'sandbox-1' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('spawn openshell ENOENT');
      expect(result.error).not.toContain('Kiro CLI not found');
    });

    it('passes other spawn errors through unchanged', async () => {
      setupSpawnError(
        Object.assign(new Error('spawn kiro-cli EACCES'), { code: 'EACCES' }) as Error,
      );

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('spawn kiro-cli EACCES');
    });

    it('surfaces the auth runError when KIRO_API_KEY is missing', async () => {
      setupSpawn({
        stdout: jsonl(runError('auth', NOT_LOGGED_IN)),
        stderr: `${NOT_LOGGED_IN}\n`,
        code: 1,
      });

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.filesChanged).toEqual([]);
      expect(result.error).toBe(`kiro-cli exited with code 1: auth error: ${NOT_LOGGED_IN}`);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('surfaces an invalid-key runError', async () => {
      setupSpawn({
        stdout: jsonl(
          RUN_STARTED,
          runError('prompt', 'Access denied. Please check your authentication. (code -32000)'),
        ),
        stderr: '[ERROR] [KRS] HTTP 403 body={"message":"The bearer token is invalid."}\n',
        code: 1,
      });

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain('kiro-cli exited with code 1: prompt error: Access denied');
    });

    it('surfaces an unknown-model runError', async () => {
      setupSpawn({
        stdout: jsonl(
          RUN_STARTED,
          runError('prompt', "The model 'no-such-model' is not available. (code -32000)"),
        ),
        stderr: INFO_STDERR,
        code: 1,
      });

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain("The model 'no-such-model' is not available");
    });

    it('falls back to stderr when a non-zero exit has no runError', async () => {
      setupSpawn({ stdout: jsonl(RUN_STARTED), stderr: 'kiro-cli crashed', code: 3 });

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('kiro-cli exited with code 3: kiro-cli crashed');
    });

    it('falls back to stdout when a non-zero exit has no runError or stderr', async () => {
      setupSpawn({ stdout: 'out message', stderr: '', code: 4 });

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('kiro-cli exited with code 4: out message');
    });

    it('reports the signal when kiro-cli is killed (e.g. by the timeout)', async () => {
      setupSpawn({
        stdout: jsonl(RUN_STARTED, messageChunk('working')),
        stderr: 'interrupted',
        code: null,
        signal: 'SIGTERM',
      });

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('kiro-cli was terminated by SIGTERM: interrupted');
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('fails without committing when exit 0 has no runFinished event', async () => {
      setupSpawn({ stdout: jsonl(RUN_STARTED, messageChunk('half')), stderr: INFO_STDERR });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('kiro-cli exited with code 0: no runFinished event in output');
      expect(gitCall('commit')).toBeUndefined();
    });

    it('fails without committing when runFinished is not a success', async () => {
      setupSpawn({ stdout: jsonl(RUN_STARTED, runFinished('', 'cancelled', 'cancelled')) });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'kiro-cli exited with code 0: run finished with status cancelled',
      );
      expect(gitCall('commit')).toBeUndefined();
    });

    it('parses stdout split across data chunks mid-line', async () => {
      const stdout = successStream('Split across chunks');
      const cut = stdout.indexOf('finalText') + 3;
      setupSpawn({ stdout: [stdout.slice(0, cut), stdout.slice(cut)] });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.summary).toBe('Split across chunks');
    });

    it('returns failure when no files changed', async () => {
      setupSpawn({ stdout: jsonl(RUN_STARTED, messageChunk('OK'), runFinished('OK')) });
      setupGitExec([], []);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBe('No files were modified');
      expect(result.summary).toBe('Agent made no changes');
    });

    it('includes untracked files in filesChanged', async () => {
      setupSpawn({ stdout: successStream('Created files') });
      setupGitExec(['modified.ts'], ['new-file.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['modified.ts', 'new-file.ts']);
    });

    it('stages and commits with default template', async () => {
      setupSpawn({ stdout: successStream() });
      setupGitExec(['src/auth.ts']);

      const runner = new KiroRunner();
      await runner.run(makeCtx());

      expect(gitCall('add')).toBeTruthy();
      const commitCall = gitCall('commit');
      expect(commitCall).toBeTruthy();
      const commitArgs = commitCall![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('7');
      expect(msg).toContain('Co-Authored-By:');
    });

    it('uses custom commitMessageTemplate and commitCoAuthor', async () => {
      setupSpawn({ stdout: successStream() });
      setupGitExec(['f.ts']);

      const runner = new KiroRunner();
      await runner.run(
        makeCtx({
          commitMessageTemplate: 'refactor({issueNumber}): {issueTitle}',
          commitCoAuthor: 'KiroBot <kiro@test.com>',
        }),
      );

      const commitArgs = gitCall('commit')![1] as string[];
      const msg = commitArgs[commitArgs.indexOf('-m') + 1];
      expect(msg).toContain('refactor(7): Refactor auth module');
      expect(msg).toContain('KiroBot <kiro@test.com>');
    });

    it('leaves tokenUsage undefined because Kiro reports credits, not tokens', async () => {
      setupSpawn({ stdout: successStream(), stderr: 'Input tokens: 3,000\nOutput tokens: 1,200' });
      setupGitExec(['f.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.tokenUsage).toBeUndefined();
    });

    it('truncates summary to 2000 chars', async () => {
      setupSpawn({ stdout: successStream('z'.repeat(3000)) });
      setupGitExec(['f.ts']);

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(true);
      expect(result.summary.length).toBe(2000);
    });

    it('uses ctx.timeoutMs when provided', async () => {
      setupSpawn({ stdout: successStream() });
      setupGitExec(['f.ts']);

      const runner = new KiroRunner();
      await runner.run(makeCtx({ timeoutMs: 30000 }));

      const [, , opts] = spawnMock.mock.calls[0];
      expect((opts as Record<string, unknown>).timeout).toBe(30000);
    });

    it('wraps kiro-cli in openshell sandbox connect when sandboxId is set', async () => {
      setupSpawn({ stdout: successStream() });
      setupGitExec(['f.ts']);

      const runner = new KiroRunner();
      await runner.run(makeCtx({ sandboxId: 'sandbox-1' }));

      const [cmd, args] = spawnMock.mock.calls[0];
      expect(cmd).toBe('openshell');
      expect((args as string[]).slice(0, 7)).toEqual([
        'sandbox',
        'connect',
        'sandbox-1',
        '--',
        'kiro-cli',
        'chat',
        '--no-interactive',
      ]);
    });

    it('handles non-Error thrown values', async () => {
      spawnMock.mockImplementation(() => {
        throw { message: 'weird object' };
      });

      const runner = new KiroRunner();
      const result = await runner.run(makeCtx());

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('spawns argv without --model when AI_SDLC_KIRO_MODEL is unset', async () => {
      // DEFAULT_KIRO_MODEL is read once at module import time in defaults.ts.
      expect(process.env.AI_SDLC_KIRO_MODEL).toBeUndefined();

      setupSpawn({ stdout: successStream() });
      setupGitExec(['f.ts']);

      const runner = new KiroRunner();
      await runner.run(makeCtx());

      const [, args] = spawnMock.mock.calls[0];
      expect(args).not.toContain('--model');
      expect(args).not.toContain('-m');
    });
  });
});
