import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import {
  OpenCodeRunner,
  resolveOpenCodeBin,
  resolveOpenCodeModel,
  parseOpenCodeLine,
  runOpenCode,
  fetchSessionTokens,
  parseJsonc,
  remapMcpTable,
  buildDispatchConfig,
  resolveMainCloneRoot,
  type OpenCodeStreamState,
} from './opencode.js';
import type { AgentContext } from './types.js';

/* ------------------------------------------------------------------ */
/*  Mocks                                                              */
/* ------------------------------------------------------------------ */

vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
    execFile: vi.fn(),
    execFileSync: vi.fn(),
  };
});

import { spawn, execFile, execFileSync } from 'node:child_process';

const spawnMock = vi.mocked(spawn);
const execFileMock = vi.mocked(execFile);
const execFileSyncMock = vi.mocked(execFileSync);

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    issueId: '99',
    issueNumber: 99,
    issueTitle: 'Add search feature',
    issueBody: 'We need a full-text search.',
    workDir: '/tmp/opencode-repo',
    branch: 'ai-sdlc/issue-99',
    constraints: {
      maxFilesPerChange: 10,
      requireTests: true,
      blockedPaths: ['.github/workflows/**'],
    },
    model: 'lmstudio/qwen/qwen3.8-27b',
    ...overrides,
  };
}

function makeFakeChild(opts: { stdout?: string; stderr?: string; code?: number; error?: Error }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: vi.fn(), end: vi.fn() };

  // Defer the buffered output + termination until the consumer (runOpenCode)
  // has attached its 'close'/'error' handler. A bare queueMicrotask at setup
  // time would drain on the runner's FIRST await (the pre-run git snapshot)
  // and the events would be lost — the child would never settle the promise.
  let started = false;
  child.on('newListener', (event: string | symbol) => {
    if (event !== 'close' && event !== 'error' || started) return;
    started = true;
    queueMicrotask(() => {
      if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
      if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
      if (opts.error) {
        child.emit('error', opts.error);
        return;
      }
      const code = opts.code ?? 0;
      child.emit('close', code, code === 0 ? null : 'SIGTERM');
    });
  });
  return child;
}

function setupSpawn(opts: { stdout?: string; stderr?: string; code?: number }) {
  const child = makeFakeChild(opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);
  return child;
}

function setupSpawnError(err: Error) {
  const child = makeFakeChild({ error: err });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnMock.mockReturnValue(child as any);
  return child;
}

/* ------------------------------------------------------------------ */
/*  Lifecycle                                                          */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('OPENCODE_BIN', 'opencode-fake');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/*  resolveOpenCodeBin                                                 */
/* ------------------------------------------------------------------ */

describe('resolveOpenCodeBin', () => {
  it('honors an explicit OPENCODE_BIN', () => {
    expect(resolveOpenCodeBin({ OPENCODE_BIN: '/x/opencode' } as NodeJS.ProcessEnv)).toBe('/x/opencode');
  });

  it('falls back to opencode on PATH', () => {
    execFileSyncMock.mockReturnValue('opencode\n');
    expect(resolveOpenCodeBin({} as NodeJS.ProcessEnv)).toBe('opencode');
  });

  it('falls back to ~/.opencode/bin/opencode when not on PATH', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(resolveOpenCodeBin({} as NodeJS.ProcessEnv)).toBe(
      join(homedir(), '.opencode', 'bin', 'opencode'),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  resolveOpenCodeModel                                               */
/* ------------------------------------------------------------------ */

describe('resolveOpenCodeModel', () => {
  const base = makeCtx();

  it('prefers ctx.model and keeps provider refs as-is', () => {
    expect(resolveOpenCodeModel({ ...base, model: 'lmstudio/qwen/qwen3.8-27b' })).toBe(
      'lmstudio/qwen/qwen3.8-27b',
    );
    expect(resolveOpenCodeModel({ ...base, model: 'anthropic/claude-sonnet-4-6' })).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('prefixes bare model ids with anthropic/', () => {
    expect(resolveOpenCodeModel({ ...base, model: 'claude-sonnet-4-6' })).toBe(
      'anthropic/claude-sonnet-4-6',
    );
  });

  it('falls back to OPENCODE_MODEL, then AI_SDLC_MODEL', () => {
    vi.stubEnv('OPENCODE_MODEL', 'lmstudio/qwen/qwen3.8-27b');
    expect(resolveOpenCodeModel({ ...base, model: undefined })).toBe('lmstudio/qwen/qwen3.8-27b');
  });

  it('returns undefined when nothing is configured', () => {
    vi.stubEnv('OPENCODE_MODEL', undefined);
    vi.stubEnv('AI_SDLC_MODEL', undefined);
    expect(resolveOpenCodeModel({ ...base, model: undefined })).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  parseOpenCodeLine                                                  */
/* ------------------------------------------------------------------ */

function freshState(): OpenCodeStreamState {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

describe('parseOpenCodeLine', () => {
  it('captures the session id and accumulates text', () => {
    const state = freshState();
    const events: string[] = [];
    parseOpenCodeLine(
      JSON.stringify({ type: 'text', sessionID: 'ses_abc', part: { type: 'text', text: 'hello' } }),
      state,
      (e) => events.push(e.message ?? e.type),
    );
    expect(state.sessionID).toBe('ses_abc');
    expect(state.summaryText).toBe('hello');
    expect(events).toEqual(['hello']);
  });

  it('ignores whitespace-only text', () => {
    const state = freshState();
    parseOpenCodeLine(
      JSON.stringify({ type: 'text', sessionID: 'ses_abc', part: { type: 'text', text: '  \n' } }),
      state,
      () => {
        throw new Error('should not fire');
      },
    );
    expect(state.summaryText).toBeUndefined();
  });

  it('emits tool_start with the command for shell calls', () => {
    const state = freshState();
    const progress: Array<{ type: string; tool?: string; file?: string }> = [];
    parseOpenCodeLine(
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_abc',
        part: {
          type: 'tool',
          tool: 'shell',
          state: { status: 'completed', input: { command: 'pnpm build' } },
        },
      }),
      state,
      (e) =>
        progress.push({ type: e.type, tool: e.tool, file: e.file }),
    );
    expect(progress).toEqual([{ type: 'tool_start', tool: 'shell', file: 'pnpm build' }]);
  });

  it('accumulates tokens (reasoning counts as output) and cost', () => {
    const state = freshState();
    const events: string[] = [];
    parseOpenCodeLine(
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_abc',
        part: {
          type: 'step-finish',
          reason: 'tool-calls',
          cost: 1.5,
          tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 7, write: 0 } },
        },
      }),
      state,
      (e) => events.push(`${e.type}:${e.costUsd}`),
    );
    expect(state.inputTokens).toBe(100);
    expect(state.outputTokens).toBe(15);
    expect(state.cacheReadTokens).toBe(7);
    expect(state.costUsd).toBe(1.5);
    expect(events).toEqual(['cost:1.5']);
  });

  it('records stream-level errors', () => {
    const state = freshState();
    const events: string[] = [];
    parseOpenCodeLine(
      JSON.stringify({
        type: 'error',
        sessionID: 'ses_abc',
        error: { type: 'unknown', message: 'socket closed' },
      }),
      state,
      (e) => events.push(e.type),
    );
    expect(state.streamError).toBe('socket closed');
    expect(events).toEqual(['error']);
  });

  it('ignores non-JSON lines', () => {
    const state = freshState();
    expect(() => parseOpenCodeLine('garbage not json', state)).not.toThrow();
    expect(Object.values(state)).not.toContain('garbage not json');
  });
});

/* ------------------------------------------------------------------ */
/*  fetchSessionTokens                                                 */
/* ------------------------------------------------------------------ */

function mockExecFileResponse(stdout: string) {
  // @ts-expect-error -- partial mock for test
  execFileMock.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb?: unknown) => {
    const callback =
      typeof _opts === 'function' ? _opts : (cb as ((...a: unknown[]) => void) | undefined);
    if (callback) {
      callback(null, { stdout, stderr: '' });
      return undefined as unknown;
    }
    return { stdout, stderr: '' } as unknown;
  });
}

function mockExecFileError(message: string) {
  // @ts-expect-error -- partial mock for test
  execFileMock.mockImplementation((_cmd: unknown, _args: unknown, _opts: unknown, cb?: unknown) => {
    const callback =
      typeof _opts === 'function' ? _opts : (cb as ((...a: unknown[]) => void) | undefined);
    if (callback) {
      callback(new Error(message));
      return undefined as unknown;
    }
    throw new Error(message);
  });
}

describe('fetchSessionTokens', () => {
  it('maps export tokens (output+reasoning, cache read) to TokenUsage', async () => {
    mockExecFileResponse(
      JSON.stringify({
        info: {
          id: 'ses_abc',
          tokens: { input: 5000, output: 200, reasoning: 40, cache: { read: 900, write: 10 } },
        },
      }),
    );
    const usage = await fetchSessionTokens('ses_abc', '/tmp/w', 'lmstudio/qwen/qwen3.8-27b');
    expect(usage).toEqual({
      inputTokens: 5000,
      outputTokens: 240,
      cacheReadTokens: 900,
      model: 'lmstudio/qwen/qwen3.8-27b',
    });
  });

  it('returns undefined when the export fails', async () => {
    mockExecFileError('session not found');
    expect(await fetchSessionTokens('ses_x', '/tmp/w', 'm')).toBeUndefined();
  });

  it('returns undefined when tokens are absent', async () => {
    mockExecFileResponse(JSON.stringify({ info: { id: 'ses_x' } }));
    expect(await fetchSessionTokens('ses_x', '/tmp/w', 'm')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  runOpenCode                                                        */
/* ------------------------------------------------------------------ */

/** A realistic two-step v2 stream: text + tool + finish, then final text. */
const STREAM_OK = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_test1', part: { id: 'prt_1', type: 'step-start' } }),
  JSON.stringify({ type: 'text', sessionID: 'ses_test1', part: { id: 'prt_2', type: 'text', text: 'Let me check.' } }),
  JSON.stringify({ type: 'tool_use', sessionID: 'ses_test1', part: { partID: 'prt_3', type: 'tool', id: 'c1', tool: 'shell', state: { status: 'completed', input: { command: 'pnpm build' } } } }),
  JSON.stringify({ type: 'step_finish', sessionID: 'ses_test1', part: { id: 'prt_4', type: 'step-finish', reason: 'tool-calls', cost: 0, tokens: { input: 1000, output: 50, reasoning: 10, cache: { read: 0, write: 0 } } } }),
  JSON.stringify({ type: 'text', sessionID: 'ses_test1', part: { id: 'prt_5', type: 'text', text: 'Done: implemented search' } }),
  JSON.stringify({ type: 'step_finish', sessionID: 'ses_test1', part: { id: 'prt_6', type: 'step-finish', reason: 'stop', cost: 1.25, tokens: { input: 2000, output: 80, reasoning: 20, cache: { read: 500, write: 0 } } } }),
].join('\n') + '\n';

describe('runOpenCode', () => {
  const baseOpts = {
    workDir: '/tmp/opencode-repo',
    prompt: 'do the thing',
    model: 'lmstudio/qwen/qwen3.8-27b',
    timeoutMs: 5_000,
  };

  it('spawns --standalone --auto --format json with model and prompt', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    await runOpenCode({ ...baseOpts, extraEnv: { AI_SDLC_PROJECT_ROOT: '/tmp/opencode-repo' } });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [bin, args, opts] = spawnMock.mock.calls[0] as any;
    expect(bin).toBe('opencode-fake');
    expect(args).toEqual([
      'run',
      '--standalone',
      '--auto',
      '--format',
      'json',
      '--model',
      'lmstudio/qwen/qwen3.8-27b',
      'do the thing',
    ]);
    expect(opts.cwd).toBe('/tmp/opencode-repo');
    expect(opts.timeout).toBe(5_000);
    expect(opts.env.AI_SDLC_PROJECT_ROOT).toBe('/tmp/opencode-repo');
  });

  it('adds --agent when provided', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    await runOpenCode({ ...baseOpts, agent: 'developer' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (spawnMock.mock.calls[0] as any)[1];
    expect(args).toContain('--agent');
    expect(args[args.indexOf('--agent') + 1]).toBe('developer');
  });

  it('resolves with accumulated stream state on exit 0', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    const result = await runOpenCode(baseOpts);
    expect(result.sessionID).toBe('ses_test1');
    expect(result.stdout).toBe('Done: implemented search');
    expect(result.costUsd).toBe(1.25);
    expect(result.tokenUsage).toEqual({
      inputTokens: 3000,
      outputTokens: 160,
      cacheReadTokens: 500,
      model: 'lmstudio/qwen/qwen3.8-27b',
    });
  });

  it('rejects on non-zero exit with the stderr tail', async () => {
    setupSpawn({ code: 1, stderr: 'kaboom\n' });
    await expect(runOpenCode(baseOpts)).rejects.toThrow('exited with code 1');
  });

  it('rejects on spawn error', async () => {
    setupSpawnError(new Error('ENOENT'));
    await expect(runOpenCode(baseOpts)).rejects.toThrow('spawn error');
  });
});

/* ------------------------------------------------------------------ */
/*  OpenCodeRunner                                                     */
/* ------------------------------------------------------------------ */

/**
 * One execFile implementation serving both the git calls (gitExec) and the
 * `session export` call (fetchSessionTokens), dispatched on the first arg.
 */
function setupRunnerExecFile(opts: {
  diff?: string[];
  cached?: string[];
  untracked?: string[];
  mergeBase?: string;
  commitDiff?: string[];
  session?: { json?: string; error?: string };
  /** Output of `git rev-parse --git-common-dir` (resolveMainCloneRoot). */
  commonDir?: string;
  commonDirError?: string;
}) {
  // @ts-expect-error -- partial mock for test
  execFileMock.mockImplementation((_cmd: unknown, args: unknown, _opts: unknown, cb?: unknown) => {
    const callback =
      typeof _opts === 'function' ? _opts : (cb as ((...a: unknown[]) => void) | undefined);
    const list = Array.isArray(args) ? args : [];
    let stdout = '';
    if (list[0] === 'session') {
      if (opts.session?.error) {
        if (callback) callback(new Error(opts.session.error));
        return undefined as unknown;
      }
      stdout = opts.session?.json ?? '';
    } else {
      const a = list[0] === '-c' ? (list as unknown[]).slice(2) : list;
      if (a[0] === 'diff' && a[1] === '--name-only' && a[2] === '--cached') {
        stdout = (opts.cached ?? []).join('\n');
      } else if (
        a[0] === 'diff' &&
        a[1] === '--name-only' &&
        typeof a[2] === 'string' &&
        (a[2] as string).includes('..')
      ) {
        stdout = (opts.commitDiff ?? []).join('\n');
      } else if (a[0] === 'diff' && a[1] === '--name-only') {
        stdout = (opts.diff ?? []).join('\n');
      } else if (a[0] === 'ls-files') {
        stdout = (opts.untracked ?? []).join('\n');
      } else if (a[0] === 'merge-base') {
        stdout = opts.mergeBase ?? '';
      } else if (a[0] === 'rev-parse' && a[1] === '--git-common-dir') {
        if (opts.commonDirError) {
          if (callback) callback(new Error(opts.commonDirError));
          return undefined as unknown;
        }
        stdout = opts.commonDir ?? '';
      }
      // add / commit / other rev-parse / status -> ''
    }
    if (callback) {
      callback(null, { stdout, stderr: '' });
      return undefined as unknown;
    }
    return { stdout, stderr: '' } as unknown;
  });
}

function exportJson(): string {
  return JSON.stringify({
    info: {
      id: 'ses_test1',
      tokens: { input: 5000, output: 200, reasoning: 40, cache: { read: 900, write: 10 } },
    },
  });
}

/** All execFile args (git + session) as flattened string arrays. */
function execFileArgLists(): string[][] {
  return execFileMock.mock.calls.map((c) => [
    String(c[0]),
    ...(Array.isArray(c[1]) ? (c[1] as unknown[]).map(String) : []),
  ]);
}

/* ------------------------------------------------------------------ */
/*  Dispatch config (OPENCODE_CONFIG_CONTENT)                          */
/* ------------------------------------------------------------------ */

describe('parseJsonc', () => {
  it('strips line and block comments', () => {
    const doc = parseJsonc('{\n// a line comment\n "a": 1, /* block */ "b": 2\n}\n');
    expect(doc).toEqual({ a: 1, b: 2 });
  });

  it('keeps // and /* inside strings intact', () => {
    const doc = parseJsonc('{"url": "https://x/y", "note": "a /* not a comment"}');
    expect(doc).toEqual({ url: 'https://x/y', note: 'a /* not a comment' });
  });

  it('rejects malformed JSON', () => {
    expect(() => parseJsonc('{"a":')).toThrow();
  });
});

describe('remapMcpTable', () => {
  it('re-anchors relative script paths at the main clone, keeps remote/npx entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aisdlc-remap-'));
    try {
      await mkdir(join(dir, 'ai-sdlc-plugin', 'mcp-server', 'dist'), { recursive: true });
      await writeFile(join(dir, 'ai-sdlc-plugin', 'mcp-server', 'dist', 'bin.js'), '');
      const out = remapMcpTable(
        {
          'ai-sdlc': {
            type: 'local',
            command: ['node', 'ai-sdlc-plugin/mcp-server/dist/bin.js'],
            timeout: 30_000,
          },
          remote: { type: 'remote', url: 'https://mcp.example' },
          npx: { command: ['npx', '-y', 'some-pkg'] },
        },
        dir,
      );
      expect(out['ai-sdlc']).toEqual({
        type: 'local',
        command: ['node', join(dir, 'ai-sdlc-plugin/mcp-server/dist/bin.js')],
        timeout: 30_000,
      });
      expect(out.remote).toEqual({ type: 'remote', url: 'https://mcp.example' });
      expect(out.npx).toEqual({ command: ['npx', '-y', 'some-pkg'] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops local entries whose re-anchored script does not exist in the main clone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aisdlc-remap-'));
    try {
      await writeFile(join(dir, 'a.js'), '');
      const out = remapMcpTable(
        {
          built: { command: ['node', 'a.js'] },
          missing: { command: ['node', 'deep/b.js'] },
        },
        dir,
      );
      expect(out.built).toEqual({ command: ['node', join(dir, 'a.js')] });
      expect(out).not.toHaveProperty('missing');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveMainCloneRoot', () => {
  it('maps an absolute --git-common-dir to its parent', async () => {
    setupRunnerExecFile({ commonDir: '/main/.git' });
    expect(await resolveMainCloneRoot('/main/.worktrees/x')).toBe('/main');
  });

  it('resolves a relative --git-common-dir against the checkout (main checkout = self)', async () => {
    setupRunnerExecFile({ commonDir: '.git' });
    expect(await resolveMainCloneRoot('/main')).toBe('/main');
  });

  it('returns undefined when git fails', async () => {
    setupRunnerExecFile({ commonDirError: 'not a git repo' });
    expect(await resolveMainCloneRoot('/nowhere')).toBeUndefined();
  });
});

describe('buildDispatchConfig', () => {
  it('emits autoupdate+snapshot with no mcp key when there is no project config', () => {
    expect(JSON.parse(buildDispatchConfig('/tmp/no-such-dir', undefined))).toEqual({
      autoupdate: false,
      snapshot: false,
    });
  });

  it('re-anchors the project mcp table (comments tolerated) and drops unbuilt dists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aisdlc-dispatchcfg-'));
    const workDir = join(dir, '.worktrees', 'x');
    await mkdir(join(dir, 'ai-sdlc-plugin', 'mcp-server', 'dist'), { recursive: true });
    await writeFile(join(dir, 'ai-sdlc-plugin', 'mcp-server', 'dist', 'bin.js'), '');
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(workDir, 'opencode.json'),
      [
        '{',
        '  // governance config',
        '  "mcp": {',
        '    "ai-sdlc": { "type": "local", "command": ["node", "ai-sdlc-plugin/mcp-server/dist/bin.js"] },',
        '    "ghost": { "type": "local", "command": ["node", "nope/dist/bin.js"] }',
        '  }',
        '}',
      ].join('\n'),
    );
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = JSON.parse(buildDispatchConfig(workDir, dir)) as any;
      expect(cfg.autoupdate).toBe(false);
      expect(cfg.snapshot).toBe(false);
      expect(cfg.mcp['ai-sdlc'].command).toEqual([
        'node',
        join(dir, 'ai-sdlc-plugin/mcp-server/dist/bin.js'),
      ]);
      expect(cfg.mcp).not.toHaveProperty('ghost');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('OpenCodeRunner', () => {
  it('happy path: streams, commits the diff, reports export tokens', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    setupRunnerExecFile({ diff: ['src/search.ts'], session: { json: exportJson() } });

    const res = await new OpenCodeRunner().run(makeCtx());

    expect(res.success).toBe(true);
    expect(res.filesChanged).toEqual(['src/search.ts']);
    expect(res.summary).toBe('Done: implemented search');
    expect(res.tokenUsage).toEqual({
      inputTokens: 5000,
      outputTokens: 240,
      cacheReadTokens: 900,
      model: 'lmstudio/qwen/qwen3.8-27b',
    });

    // The dispatch itself.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [bin, args, opts] = spawnMock.mock.calls[0] as any;
    expect(bin).toBe('opencode-fake');
    expect(args.slice(0, 7)).toEqual([
      'run',
      '--standalone',
      '--auto',
      '--format',
      'json',
      '--model',
      'lmstudio/qwen/qwen3.8-27b',
    ]);
    expect(args[args.length - 1]).toContain('fixing issue #99: Add search feature');
    expect(opts.cwd).toBe('/tmp/opencode-repo');
    expect(opts.env.AI_SDLC_PROJECT_ROOT).toBe('/tmp/opencode-repo');
    expect(opts.env.AI_SDLC_ACTIVE_TASK_ID).toBe('99');

    // The commit flow.
    const all = execFileArgLists();
    expect(all.some((a) => a[0] === 'git' && a.includes('add') && a.includes('src/search.ts'))).toBe(
      true,
    );
    expect(
      all.some((a) =>
        a.some((x) => x.includes('Co-Authored-By:') && x.includes('Add search feature')),
      ),
    ).toBe(true);
  });

  it('injects OPENCODE_CONFIG_CONTENT with the main-clone-anchored mcp table', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aisdlc-runner-cc-'));
    const workDir = join(dir, '.worktrees', 'x');
    // The dist exists in the MAIN clone (the worktree's gitignored copy is
    // realistically absent — only the relative path in opencode.json travels).
    await mkdir(join(dir, 'ai-sdlc-plugin', 'mcp-server', 'dist'), { recursive: true });
    await writeFile(join(dir, 'ai-sdlc-plugin', 'mcp-server', 'dist', 'bin.js'), '');
    await mkdir(workDir, { recursive: true });
    await writeFile(
      join(workDir, 'opencode.json'),
      JSON.stringify({
        mcp: { 'ai-sdlc': { type: 'local', command: ['node', 'ai-sdlc-plugin/mcp-server/dist/bin.js'] } },
      }),
    );

    setupSpawn({ stdout: STREAM_OK, code: 0 });
    setupRunnerExecFile({
      diff: ['src/search.ts'],
      session: { json: exportJson() },
      commonDir: join(dir, '.git'),
    });

    const res = await new OpenCodeRunner().run(makeCtx({ workDir }));

    expect(res.success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [, , opts] = spawnMock.mock.calls[0] as any;
    expect(JSON.parse(opts.env.OPENCODE_CONFIG_CONTENT)).toEqual({
      autoupdate: false,
      snapshot: false,
      mcp: {
        'ai-sdlc': {
          type: 'local',
          command: ['node', join(dir, 'ai-sdlc-plugin/mcp-server/dist/bin.js')],
        },
      },
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('fails loudly when no model is resolvable', async () => {
    vi.stubEnv('OPENCODE_MODEL', undefined);
    vi.stubEnv('AI_SDLC_MODEL', undefined);
    setupRunnerExecFile({});

    const res = await new OpenCodeRunner().run(makeCtx({ model: undefined }));

    expect(res.success).toBe(false);
    expect(res.error).toContain('requires a model');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fails when the process exits non-zero', async () => {
    setupSpawn({ code: 1, stderr: 'kaboom\n' });
    setupRunnerExecFile({});

    const res = await new OpenCodeRunner().run(makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain('exited with code 1');
  });

  it('fails when a stream error ends the session with no final text', async () => {
    setupSpawn({
      code: 0,
      stdout:
        JSON.stringify({ type: 'step_start', sessionID: 'ses_test1', part: { type: 'step-start' } }) +
        '\n' +
        JSON.stringify({
          type: 'error',
          sessionID: 'ses_test1',
          error: { type: 'unknown', message: 'socket closed unexpectedly' },
        }) +
        '\n',
    });
    setupRunnerExecFile({});

    const res = await new OpenCodeRunner().run(makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toContain('stream error');
  });

  it('reports no-changes when the worktree is untouched', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    setupRunnerExecFile({});

    const res = await new OpenCodeRunner().run(makeCtx());

    expect(res.success).toBe(false);
    expect(res.error).toBe('No files were modified');
  });

  it('succeeds when the agent already committed (no re-commit)', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    setupRunnerExecFile({
      mergeBase: 'abc123',
      commitDiff: ['src/a.ts'],
      session: { json: exportJson() },
    });

    const res = await new OpenCodeRunner().run(makeCtx());

    expect(res.success).toBe(true);
    expect(res.filesChanged).toEqual(['src/a.ts']);
    const all = execFileArgLists();
    expect(all.some((a) => a[0] === 'git' && a.includes('add'))).toBe(false);
    expect(all.some((a) => a[0] === 'git' && a.includes('commit'))).toBe(false);
  });

  it('falls back to stream-accumulated tokens when the export fails', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    setupRunnerExecFile({ diff: ['src/search.ts'], session: { error: 'session not found' } });

    const res = await new OpenCodeRunner().run(makeCtx());

    expect(res.success).toBe(true);
    expect(res.tokenUsage).toEqual({
      inputTokens: 3000,
      outputTokens: 160,
      cacheReadTokens: 500,
      model: 'lmstudio/qwen/qwen3.8-27b',
    });
  });

  it('uses the custom commit template and co-author', async () => {
    setupSpawn({ stdout: STREAM_OK, code: 0 });
    setupRunnerExecFile({ diff: ['src/search.ts'], session: { json: exportJson() } });

    await new OpenCodeRunner().run(
      makeCtx({
        commitMessageTemplate: 'fix: {issueNumber} custom {issueTitle}',
        commitCoAuthor: 'Test Agent <bot@ai-sdlc.local>',
      }),
    );

    const all = execFileArgLists();
    const commit = all.find((a) => a[0] === 'git' && a.includes('commit'));
    expect(commit).toBeDefined();
    expect(commit?.join(' ')).toContain('fix: 99 custom Add search feature');
    expect(commit?.join(' ')).toContain('Co-Authored-By: Test Agent <bot@ai-sdlc.local>');
  });
});
