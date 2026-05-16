/**
 * `CodexHarnessAdapter` — unit tests (AISDLC-202.2 AC #4).
 *
 * The adapter is exercised against an in-memory `spawnAgent` mock — no
 * real Codex CLI install is required, so this suite runs cleanly in
 * environments without `codex` on PATH (CI, contributor laptops, etc.).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  CODEX_BRIDGE_MISSING_MESSAGE,
  CodexHarnessAdapter,
  DEFAULT_SYSTEM_PROMPTS,
  normalizeReviewerVerdict,
  subprocessCodexSpawnAgent,
  tryParseJson,
  type CodexSpawnAgentFn,
  type CodexSpawnAgentRequest,
  type CodexSpawnAgentResponse,
  type CodexProcessSpawner,
} from './codex-harness.js';
import { coerceReviewerVerdict } from '../../steps/09-iterate.js';
import { aggregateVerdicts } from '../../steps/08-aggregate-verdicts.js';
import type { ReviewerType, SpawnOpts, SubagentResult } from '../../types.js';

const REVIEWER_TYPES: ReviewerType[] = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

const baseOpts: SpawnOpts = {
  type: 'developer',
  prompt: 'Implement task AISDLC-99.',
  cwd: '/work/.worktrees/aisdlc-99',
};

function recordingSpawnAgent(fixtures: Partial<Record<string, CodexSpawnAgentResponse>>): {
  fn: CodexSpawnAgentFn;
  calls: CodexSpawnAgentRequest[];
} {
  const calls: CodexSpawnAgentRequest[] = [];
  const fn: CodexSpawnAgentFn = async (req) => {
    calls.push(req);
    const fixture = fixtures[req.agentType];
    if (!fixture) {
      throw new Error(`no fixture configured for agentType=${req.agentType}`);
    }
    return fixture;
  };
  return { fn, calls };
}

describe('CodexHarnessAdapter — developer dispatch', () => {
  it('passes the developer system prompt + user prompt to the bridge and returns parsed DeveloperReturn', async () => {
    const developerReturn = {
      summary: 'work done',
      filesChanged: ['a.ts'],
      commitSha: 'abc1234',
      verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
      acceptanceCriteriaMet: [1, 2],
    };
    const { fn, calls } = recordingSpawnAgent({
      developer: { output: JSON.stringify(developerReturn) },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn(baseOpts);

    expect(calls).toHaveLength(1);
    const [req] = calls;
    expect(req.agentType).toBe('developer');
    expect(req.userPrompt).toBe(baseOpts.prompt);
    expect(req.cwd).toBe(baseOpts.cwd);
    expect(req.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPTS.developer);
    expect(req.timeoutMs).toBeGreaterThan(0);

    expect(result.status).toBe('success');
    expect(result.type).toBe('developer');
    expect(result.parsed).toEqual(developerReturn);
    expect(result.output).toBe(JSON.stringify(developerReturn));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('respects systemPrompts overrides', async () => {
    const { fn, calls } = recordingSpawnAgent({
      developer: {
        output:
          '{"summary":"x","filesChanged":[],"commitSha":null,"verifications":{"build":"skipped","test":"skipped","lint":"skipped","format":"skipped"},"acceptanceCriteriaMet":[]}',
      },
    });
    const adapter = new CodexHarnessAdapter({
      spawnAgent: fn,
      systemPrompts: { developer: 'CUSTOM PLUGIN BODY HERE' },
    });

    await adapter.spawn(baseOpts);

    expect(calls[0].systemPrompt).toBe('CUSTOM PLUGIN BODY HERE');
  });

  it('passes through the host-side parsed payload when present (no re-parse)', async () => {
    const developerReturn = {
      summary: 'host parsed',
      filesChanged: [],
      commitSha: null,
      verifications: { build: 'skipped', test: 'skipped', lint: 'skipped', format: 'skipped' },
      acceptanceCriteriaMet: [],
    };
    const { fn } = recordingSpawnAgent({
      developer: { output: 'IRRELEVANT NON-JSON OUTPUT', parsed: developerReturn },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn(baseOpts);

    expect(result.status).toBe('success');
    expect(result.parsed).toEqual(developerReturn);
    expect(result.output).toBe('IRRELEVANT NON-JSON OUTPUT');
  });

  it('omits parsed when the developer returned non-JSON prose so Step 6 retry can fire', async () => {
    const { fn } = recordingSpawnAgent({
      developer: { output: 'Done. I committed the work.' },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn(baseOpts);

    expect(result.status).toBe('success');
    expect(result.parsed).toBeUndefined();
    expect(result.output).toBe('Done. I committed the work.');
  });

  it('returns error status when the bridge throws', async () => {
    const adapter = new CodexHarnessAdapter({
      spawnAgent: async () => {
        throw new Error('bridge failure: spawn_agent timed out');
      },
    });

    const result = await adapter.spawn(baseOpts);

    expect(result.status).toBe('error');
    expect(result.error).toContain('bridge failure');
    expect(result.output).toBe('');
  });

  it('forwards per-call timeout to the bridge when provided', async () => {
    const { fn, calls } = recordingSpawnAgent({
      developer: { output: '{}' },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn, defaultTimeoutMs: 1000 });

    await adapter.spawn({ ...baseOpts, timeout: 5000 });

    expect(calls[0].timeoutMs).toBe(5000);
  });
});

describe('CodexHarnessAdapter — reviewer dispatch (AC #1, AC #2)', () => {
  it('returns a canonical ReviewerVerdict envelope tagged with harness=codex', async () => {
    const { fn, calls } = recordingSpawnAgent({
      'code-reviewer': {
        output: JSON.stringify({
          approved: true,
          findings: [],
          summary: 'No blocking findings.',
        }),
      },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'review the diff',
      cwd: '/work',
    });

    expect(calls[0].agentType).toBe('code-reviewer');
    expect(calls[0].systemPrompt).toBe(DEFAULT_SYSTEM_PROMPTS['code-reviewer']);

    expect(result.status).toBe('success');
    expect(result.parsed).toEqual({
      approved: true,
      findings: [],
      summary: 'No blocking findings.',
      harness: 'codex',
    });
  });

  it('stamps harness=codex even when the agent omitted the field', async () => {
    const { fn } = recordingSpawnAgent({
      'security-reviewer': {
        output:
          '{"approved":false,"findings":[{"severity":"critical","message":"injection risk"}],"summary":"blocked"}',
      },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn({
      type: 'security-reviewer',
      prompt: 'review security',
      cwd: '/work',
    });

    expect(result.parsed).toMatchObject({
      approved: false,
      harness: 'codex',
      findings: [{ severity: 'critical', message: 'injection risk' }],
    });
  });

  it('preserves a non-default harness tag if the bridge already set one', async () => {
    const { fn } = recordingSpawnAgent({
      'test-reviewer': {
        output: JSON.stringify({
          approved: true,
          findings: [],
          summary: 'ok',
          harness: 'codex-cli@0.128.0',
        }),
      },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn({
      type: 'test-reviewer',
      prompt: 'review tests',
      cwd: '/work',
    });

    expect(result.parsed).toMatchObject({ harness: 'codex-cli@0.128.0' });
  });

  it('coerces a malformed approval flag (string "true") to a real boolean', async () => {
    const { fn } = recordingSpawnAgent({
      'code-reviewer': {
        output: JSON.stringify({ approved: 'true', findings: [], summary: '' }),
      },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });
    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'r',
      cwd: '/w',
    });

    const v = result.parsed as { approved: boolean };
    expect(v.approved).toBe(true);
    expect(typeof v.approved).toBe('boolean');
  });

  it('parses JSON wrapped in markdown fences (Codex agents sometimes emit ```json)', async () => {
    const { fn } = recordingSpawnAgent({
      'code-reviewer': {
        output:
          'Here is my verdict:\n```json\n{"approved":true,"findings":[],"summary":"ok"}\n```\n',
      },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });
    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'r',
      cwd: '/w',
    });

    expect(result.parsed).toEqual({
      approved: true,
      findings: [],
      summary: 'ok',
      harness: 'codex',
    });
  });

  it('omits parsed when the reviewer returned unparseable prose', async () => {
    const { fn } = recordingSpawnAgent({
      'code-reviewer': { output: 'I think it looks good but I cannot return JSON.' },
    });
    const adapter = new CodexHarnessAdapter({ spawnAgent: fn });
    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'r',
      cwd: '/w',
    });

    expect(result.parsed).toBeUndefined();
  });

  it('reviewer envelopes pass through Step 8 aggregation without manual reshaping (AC #2)', async () => {
    // Hard-bake the AISDLC-201 reproducer: three Codex reviewer outputs, one
    // non-approving, all needing to flow through Step 8 with no hand-edits.
    const adapter = new CodexHarnessAdapter({
      spawnAgent: async (req) => {
        if (req.agentType === 'code-reviewer') {
          return {
            output: JSON.stringify({
              approved: false,
              findings: [{ severity: 'major', file: 'src/foo.ts', line: 42, message: 'naming' }],
              summary: 'Blocking.',
            }),
          };
        }
        if (req.agentType === 'test-reviewer') {
          return {
            output: JSON.stringify({
              approved: true,
              findings: [{ severity: 'minor', message: 'add edge case' }],
              summary: 'tests look ok.',
            }),
          };
        }
        if (req.agentType === 'security-reviewer') {
          return {
            output: JSON.stringify({ approved: true, findings: [], summary: 'clean' }),
          };
        }
        throw new Error(`unexpected agentType=${req.agentType}`);
      },
    });

    const results = await adapter.spawnParallel(
      REVIEWER_TYPES.map((type) => ({ type, prompt: 'review', cwd: '/w' })),
    );
    const verdicts = results.map((r, i) => coerceReviewerVerdict(REVIEWER_TYPES[i], r));
    const aggregate = await aggregateVerdicts({
      verdicts,
      harnessNote: '',
    });

    expect(aggregate.decision).toBe('CHANGES_REQUESTED');
    expect(aggregate.counts.major).toBe(1);
    expect(aggregate.counts.minor).toBe(1);
    expect(aggregate.verdicts).toHaveLength(3);
    // Every verdict is correctly attributed to the codex harness.
    for (const v of aggregate.verdicts) {
      expect(v.harness).toBe('codex');
    }
    // agentId is set per reviewer position by `coerceReviewerVerdict`.
    expect(aggregate.verdicts.map((v) => v.agentId)).toEqual(REVIEWER_TYPES);
  });
});

describe('CodexHarnessAdapter — spawnParallel', () => {
  it('fans out reviewer calls in parallel and preserves order', async () => {
    const order: string[] = [];
    const adapter = new CodexHarnessAdapter({
      spawnAgent: async (req) => {
        order.push(`start:${req.agentType}`);
        // Tiny async tick so the ordering depends on parallel scheduling.
        await new Promise((r) => setTimeout(r, 1));
        order.push(`end:${req.agentType}`);
        return { output: '{"approved":true,"findings":[]}' };
      },
    });

    const results = await adapter.spawnParallel(
      REVIEWER_TYPES.map((type) => ({ type, prompt: 'r', cwd: '/w' })),
    );

    expect(results.map((r) => r.type)).toEqual(REVIEWER_TYPES);
    // Parallel scheduling: all three start before any end.
    const startCount = order.filter((e) => e.startsWith('start:')).length;
    const firstEndIdx = order.findIndex((e) => e.startsWith('end:'));
    expect(startCount).toBe(3);
    expect(firstEndIdx).toBeGreaterThanOrEqual(3);
  });
});

describe('normalizeReviewerVerdict', () => {
  it('returns undefined for non-object inputs', () => {
    expect(normalizeReviewerVerdict(null)).toBeUndefined();
    expect(normalizeReviewerVerdict(undefined)).toBeUndefined();
    expect(normalizeReviewerVerdict(42)).toBeUndefined();
    expect(normalizeReviewerVerdict('string')).toBeUndefined();
  });

  it('defaults missing fields to safe values', () => {
    expect(normalizeReviewerVerdict({})).toEqual({
      approved: false,
      findings: [],
      harness: 'codex',
    });
  });

  it('drops non-array findings rather than crashing aggregation', () => {
    expect(normalizeReviewerVerdict({ approved: true, findings: 'not an array' })).toEqual({
      approved: true,
      findings: [],
      harness: 'codex',
    });
  });
});

describe('tryParseJson', () => {
  it('returns parsed JSON for clean input', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a markdown fence', () => {
    expect(tryParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('returns undefined for empty input', () => {
    expect(tryParseJson('')).toBeUndefined();
    expect(tryParseJson('   \n')).toBeUndefined();
  });

  it('returns undefined for non-JSON prose', () => {
    expect(tryParseJson('not json at all')).toBeUndefined();
  });

  it('returns undefined for fence-with-bad-json', () => {
    expect(tryParseJson('```json\nnot really json\n```')).toBeUndefined();
  });
});

describe('subprocessCodexSpawnAgent', () => {
  const ORIGINAL_ENV = process.env.CODEX_SPAWN_AGENT_BIN;
  beforeEach(() => {
    delete process.env.CODEX_SPAWN_AGENT_BIN;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.CODEX_SPAWN_AGENT_BIN;
    } else {
      process.env.CODEX_SPAWN_AGENT_BIN = ORIGINAL_ENV;
    }
  });

  it('throws a clear configuration message when CODEX_SPAWN_AGENT_BIN is unset', () => {
    expect(() => subprocessCodexSpawnAgent()).toThrow(CODEX_BRIDGE_MISSING_MESSAGE);
  });

  it('reads bridge bin from CODEX_SPAWN_AGENT_BIN env var', () => {
    process.env.CODEX_SPAWN_AGENT_BIN = '/tmp/fake-bridge';
    const fakeSpawn = makeFakeSpawn({
      stdout: JSON.stringify({ output: '{"approved":true}' }),
      exitCode: 0,
    });
    const fn = subprocessCodexSpawnAgent({ spawn: fakeSpawn.spawn });
    expect(typeof fn).toBe('function');
    expect(fakeSpawn.calls).toHaveLength(0); // factory does not spawn until called
  });

  it('writes a JSON-line request envelope to stdin', async () => {
    const fakeSpawn = makeFakeSpawn({
      stdout: JSON.stringify({ output: '{"summary":"ok"}' }),
      exitCode: 0,
    });
    const fn = subprocessCodexSpawnAgent({
      bridgeBin: '/tmp/fake-bridge',
      spawn: fakeSpawn.spawn,
    });

    const response = await fn({
      agentType: 'developer',
      systemPrompt: 'sys',
      userPrompt: 'user',
      cwd: '/cwd',
      timeoutMs: 1000,
    });

    expect(response).toEqual({ output: '{"summary":"ok"}' });
    expect(fakeSpawn.calls[0].command).toBe('/tmp/fake-bridge');
    expect(fakeSpawn.calls[0].options.cwd).toBe('/cwd');
    const stdinPayload = fakeSpawn.calls[0].stdin;
    expect(stdinPayload).toContain('"agentType":"developer"');
    expect(stdinPayload).toContain('"systemPrompt":"sys"');
    expect(stdinPayload).toContain('"userPrompt":"user"');
    expect(stdinPayload).toMatch(/\n$/);
  });

  it('passes through a host-parsed payload', async () => {
    const fakeSpawn = makeFakeSpawn({
      stdout: JSON.stringify({ output: 'raw', parsed: { approved: true, findings: [] } }),
      exitCode: 0,
    });
    const fn = subprocessCodexSpawnAgent({
      bridgeBin: '/tmp/fake-bridge',
      spawn: fakeSpawn.spawn,
    });

    const response = await fn({
      agentType: 'code-reviewer',
      systemPrompt: 'sys',
      userPrompt: 'user',
      cwd: '/cwd',
      timeoutMs: 1000,
    });

    expect(response.output).toBe('raw');
    expect(response.parsed).toEqual({ approved: true, findings: [] });
  });

  it('rejects when the bridge exits non-zero, surfacing stderr', async () => {
    const fakeSpawn = makeFakeSpawn({
      stdout: '',
      stderr: 'spawn_agent: auth failure',
      exitCode: 2,
    });
    const fn = subprocessCodexSpawnAgent({
      bridgeBin: '/tmp/fake-bridge',
      spawn: fakeSpawn.spawn,
    });

    await expect(
      fn({
        agentType: 'developer',
        systemPrompt: '',
        userPrompt: '',
        cwd: '/cwd',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/exited 2.*auth failure/);
  });

  it('treats non-JSON stdout as raw output', async () => {
    const fakeSpawn = makeFakeSpawn({
      stdout: 'not really json output',
      exitCode: 0,
    });
    const fn = subprocessCodexSpawnAgent({
      bridgeBin: '/tmp/fake-bridge',
      spawn: fakeSpawn.spawn,
    });

    const response = await fn({
      agentType: 'developer',
      systemPrompt: '',
      userPrompt: '',
      cwd: '/cwd',
      timeoutMs: 1000,
    });

    expect(response.output).toBe('not really json output');
    expect(response.parsed).toBeUndefined();
  });

  it('rejects when the bridge exits zero with empty stdout', async () => {
    const fakeSpawn = makeFakeSpawn({
      stdout: '',
      exitCode: 0,
    });
    const fn = subprocessCodexSpawnAgent({
      bridgeBin: '/tmp/fake-bridge',
      spawn: fakeSpawn.spawn,
    });

    await expect(
      fn({
        agentType: 'developer',
        systemPrompt: '',
        userPrompt: '',
        cwd: '/cwd',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/empty stdout.*expected JSON envelope/);
  });

  it('times out the bridge when it never closes', async () => {
    vi.useFakeTimers();
    try {
      const fakeSpawn = makeFakeSpawn({ stdout: '', exitCode: 0, neverClose: true });
      const fn = subprocessCodexSpawnAgent({
        bridgeBin: '/tmp/fake-bridge',
        spawn: fakeSpawn.spawn,
      });

      const promise = fn({
        agentType: 'developer',
        systemPrompt: '',
        userPrompt: '',
        cwd: '/cwd',
        timeoutMs: 100,
      });
      // Surface unhandled-rejection during pending state silently — we
      // attach the assertion below.
      promise.catch(() => undefined);
      vi.advanceTimersByTime(150);
      await expect(promise).rejects.toThrow(/timed out after 100ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('end-to-end: CodexHarnessAdapter wired via subprocess bridge yields a canonical reviewer verdict', async () => {
    const fakeSpawn = makeFakeSpawn({
      stdout: JSON.stringify({
        output: JSON.stringify({
          approved: true,
          findings: [],
          summary: 'no blocking findings',
        }),
      }),
      exitCode: 0,
    });
    const adapter = new CodexHarnessAdapter({
      spawnAgent: subprocessCodexSpawnAgent({
        bridgeBin: '/tmp/fake-bridge',
        spawn: fakeSpawn.spawn,
      }),
    });

    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'review',
      cwd: '/w',
    });

    expect(result.status).toBe('success');
    expect(result.parsed).toEqual({
      approved: true,
      findings: [],
      summary: 'no blocking findings',
      harness: 'codex',
    });
  });
});

// ── Test-helpers ────────────────────────────────────────────────────

interface FakeSpawnConfig {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** When true, the child never emits 'close' — used for timeout tests. */
  neverClose?: boolean;
  /** When set, the child emits an 'error' event instead of closing cleanly. */
  spawnError?: Error;
}

interface FakeSpawnRecorder {
  spawn: CodexProcessSpawner;
  calls: Array<{
    command: string;
    args: readonly string[];
    options: { cwd?: string };
    stdin: string;
  }>;
}

function makeFakeSpawn(cfg: FakeSpawnConfig): FakeSpawnRecorder {
  const calls: FakeSpawnRecorder['calls'] = [];
  const fakeSpawn: CodexProcessSpawner = ((
    command: string,
    args: readonly string[],
    options: { cwd?: string },
  ) => {
    let stdinBuffer = '';
    const stdinSink = new Writable({
      write(chunk, _enc, cb) {
        stdinBuffer += chunk.toString();
        cb();
      },
    });
    stdinSink.on('finish', () => {
      // Lock in the recorded stdin payload at the time the writer ends.
      calls[calls.length - 1].stdin = stdinBuffer;
    });

    const stdoutStream = Readable.from(cfg.stdout ? [Buffer.from(cfg.stdout)] : []);
    const stderrStream = Readable.from(cfg.stderr ? [Buffer.from(cfg.stderr)] : []);

    const proc = new EventEmitter() as unknown as ChildProcess;
    (proc as unknown as { stdin: Writable | null }).stdin = stdinSink;
    (proc as unknown as { stdout: Readable | null }).stdout = stdoutStream;
    (proc as unknown as { stderr: Readable | null }).stderr = stderrStream;
    (proc as unknown as { kill: (signal?: string) => boolean }).kill = () => true;

    calls.push({ command, args, options, stdin: '' });

    if (cfg.spawnError) {
      // Defer so the listener attaches first.
      setImmediate(() => proc.emit('error', cfg.spawnError));
      return proc;
    }

    if (!cfg.neverClose) {
      // Defer the close until next tick so listeners attach first.
      setImmediate(() => {
        proc.emit('close', cfg.exitCode ?? 0);
      });
    }
    return proc;
  }) as CodexProcessSpawner;
  return { spawn: fakeSpawn, calls };
}

// Silence unused-var noise: SubagentResult is consumed via type-checking.
const _typecheck: SubagentResult | undefined = undefined;
void _typecheck;
