/**
 * `CopilotHarnessAdapter` — unit tests (AISDLC-429.2 AC #2).
 *
 * The adapter is exercised against an in-memory `spawnAgent` mock — no
 * real Copilot CLI install is required, so this suite runs cleanly in
 * environments without `copilot` on PATH (CI, contributor laptops, etc.).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  COPILOT_BRIDGE_MISSING_MESSAGE,
  CopilotHarnessAdapter,
  DEFAULT_SYSTEM_PROMPTS,
  normalizeReviewerVerdict,
  subprocessCopilotSpawnAgent,
  tryParseJson,
  type CopilotSpawnAgentFn,
  type CopilotSpawnAgentRequest,
  type CopilotSpawnAgentResponse,
  type CopilotProcessSpawner,
} from './copilot-harness.js';
import { coerceReviewerVerdict } from '../../steps/09-iterate.js';
import { aggregateVerdicts } from '../../steps/08-aggregate-verdicts.js';
import type { ReviewerType, SpawnOpts, SubagentResult } from '../../types.js';

const REVIEWER_TYPES: ReviewerType[] = ['code-reviewer', 'test-reviewer', 'security-reviewer'];

const baseOpts: SpawnOpts = {
  type: 'developer',
  prompt: 'Implement task AISDLC-429.2.',
  cwd: '/work/.worktrees/aisdlc-429.2',
};

function recordingSpawnAgent(fixtures: Partial<Record<string, CopilotSpawnAgentResponse>>): {
  fn: CopilotSpawnAgentFn;
  calls: CopilotSpawnAgentRequest[];
} {
  const calls: CopilotSpawnAgentRequest[] = [];
  const fn: CopilotSpawnAgentFn = async (req) => {
    calls.push(req);
    const fixture = fixtures[req.agentType];
    if (!fixture) {
      throw new Error(`no fixture configured for agentType=${req.agentType}`);
    }
    return fixture;
  };
  return { fn, calls };
}

describe('CopilotHarnessAdapter — developer dispatch (AC #2a)', () => {
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
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });

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
    const adapter = new CopilotHarnessAdapter({
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
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn(baseOpts);

    expect(result.status).toBe('success');
    expect(result.parsed).toEqual(developerReturn);
    expect(result.output).toBe('IRRELEVANT NON-JSON OUTPUT');
  });

  it('omits parsed when the developer returned non-JSON prose so Step 6 retry can fire', async () => {
    const { fn } = recordingSpawnAgent({
      developer: { output: 'Done. I committed the work.' },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn(baseOpts);

    expect(result.status).toBe('success');
    expect(result.parsed).toBeUndefined();
    expect(result.output).toBe('Done. I committed the work.');
  });

  it('returns error status when the bridge throws (AC #2d)', async () => {
    const adapter = new CopilotHarnessAdapter({
      spawnAgent: async () => {
        throw new Error('bridge failure: spawn_agent timed out');
      },
    });

    const result = await adapter.spawn(baseOpts);

    expect(result.status).toBe('error');
    expect(result.error).toContain('bridge failure');
    expect(result.output).toBe('');
  });

  it('forwards per-call timeout to the bridge when provided (AC #2c)', async () => {
    const { fn, calls } = recordingSpawnAgent({
      developer: { output: '{}' },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn, defaultTimeoutMs: 1000 });

    await adapter.spawn({ ...baseOpts, timeout: 5000 });

    expect(calls[0].timeoutMs).toBe(5000);
  });

  it('uses defaultTimeoutMs when no per-call timeout is provided (AC #2c)', async () => {
    const { fn, calls } = recordingSpawnAgent({
      developer: { output: '{}' },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn, defaultTimeoutMs: 12345 });

    await adapter.spawn(baseOpts);

    expect(calls[0].timeoutMs).toBe(12345);
  });
});

describe('CopilotHarnessAdapter — reviewer dispatch (AC #2b)', () => {
  it('returns a canonical ReviewerVerdict envelope tagged with harness=copilot', async () => {
    const { fn, calls } = recordingSpawnAgent({
      'code-reviewer': {
        output: JSON.stringify({
          approved: true,
          findings: [],
          summary: 'No blocking findings.',
        }),
      },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });

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
      harness: 'copilot',
    });
  });

  it('stamps harness=copilot even when the agent omitted the field', async () => {
    const { fn } = recordingSpawnAgent({
      'security-reviewer': {
        output:
          '{"approved":false,"findings":[{"severity":"critical","message":"injection risk"}],"summary":"blocked"}',
      },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn({
      type: 'security-reviewer',
      prompt: 'review security',
      cwd: '/work',
    });

    expect(result.parsed).toMatchObject({
      approved: false,
      harness: 'copilot',
      findings: [{ severity: 'critical', message: 'injection risk' }],
    });
  });

  it('test-reviewer returns canonical verdict tagged harness=copilot', async () => {
    const { fn } = recordingSpawnAgent({
      'test-reviewer': {
        output: JSON.stringify({
          approved: true,
          findings: [{ severity: 'minor', message: 'add edge case' }],
          summary: 'tests look ok.',
        }),
      },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn({
      type: 'test-reviewer',
      prompt: 'review tests',
      cwd: '/work',
    });

    expect(result.parsed).toMatchObject({
      approved: true,
      harness: 'copilot',
      findings: [{ severity: 'minor', message: 'add edge case' }],
      summary: 'tests look ok.',
    });
  });

  it('preserves a non-default harness tag if the bridge already set one', async () => {
    const { fn } = recordingSpawnAgent({
      'test-reviewer': {
        output: JSON.stringify({
          approved: true,
          findings: [],
          summary: 'ok',
          harness: 'copilot-cli@1.2.3',
        }),
      },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });

    const result = await adapter.spawn({
      type: 'test-reviewer',
      prompt: 'review tests',
      cwd: '/work',
    });

    expect(result.parsed).toMatchObject({ harness: 'copilot-cli@1.2.3' });
  });

  it('coerces a malformed approval flag (string "true") to a real boolean', async () => {
    const { fn } = recordingSpawnAgent({
      'code-reviewer': {
        output: JSON.stringify({ approved: 'true', findings: [], summary: '' }),
      },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });
    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'r',
      cwd: '/w',
    });

    const v = result.parsed as { approved: boolean };
    expect(v.approved).toBe(true);
    expect(typeof v.approved).toBe('boolean');
  });

  it('parses JSON wrapped in markdown fences (Copilot agents sometimes emit ```json)', async () => {
    const { fn } = recordingSpawnAgent({
      'code-reviewer': {
        output:
          'Here is my verdict:\n```json\n{"approved":true,"findings":[],"summary":"ok"}\n```\n',
      },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });
    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'r',
      cwd: '/w',
    });

    expect(result.parsed).toEqual({
      approved: true,
      findings: [],
      summary: 'ok',
      harness: 'copilot',
    });
  });

  it('omits parsed when the reviewer returned unparseable prose', async () => {
    const { fn } = recordingSpawnAgent({
      'code-reviewer': { output: 'I think it looks good but I cannot return JSON.' },
    });
    const adapter = new CopilotHarnessAdapter({ spawnAgent: fn });
    const result = await adapter.spawn({
      type: 'code-reviewer',
      prompt: 'r',
      cwd: '/w',
    });

    expect(result.parsed).toBeUndefined();
  });

  it('reviewer envelopes pass through coerceReviewerVerdict unchanged (AC #2b)', async () => {
    // Hard-bake a three-reviewer scenario: all outputs flow through coerceReviewerVerdict
    // and aggregateVerdicts without manual reshaping.
    const adapter = new CopilotHarnessAdapter({
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
    // Every verdict is correctly attributed to the copilot harness.
    for (const v of aggregate.verdicts) {
      expect(v.harness).toBe('copilot');
    }
    // agentId is set per reviewer position by `coerceReviewerVerdict`.
    expect(aggregate.verdicts.map((v) => v.agentId)).toEqual(REVIEWER_TYPES);
  });
});

describe('CopilotHarnessAdapter — spawnParallel (AC #2e)', () => {
  it('fans out N calls concurrently and preserves order', async () => {
    const order: string[] = [];
    const adapter = new CopilotHarnessAdapter({
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

  it('returns results in the same order as input opts regardless of completion order', async () => {
    const delays: Record<string, number> = {
      'code-reviewer': 30,
      'test-reviewer': 10,
      'security-reviewer': 20,
    };
    const adapter = new CopilotHarnessAdapter({
      spawnAgent: async (req) => {
        await new Promise((r) => setTimeout(r, delays[req.agentType] ?? 1));
        return {
          output: JSON.stringify({ approved: true, findings: [], summary: req.agentType }),
        };
      },
    });

    const results = await adapter.spawnParallel(
      REVIEWER_TYPES.map((type) => ({ type, prompt: 'r', cwd: '/w' })),
    );

    // Results must be in input order even though completion order differs.
    expect(results.map((r) => r.type)).toEqual(REVIEWER_TYPES);
    for (const [i, r] of results.entries()) {
      const parsed = r.parsed as { summary: string };
      expect(parsed.summary).toBe(REVIEWER_TYPES[i]);
    }
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
      harness: 'copilot',
    });
  });

  it('drops non-array findings rather than crashing aggregation', () => {
    expect(normalizeReviewerVerdict({ approved: true, findings: 'not an array' })).toEqual({
      approved: true,
      findings: [],
      harness: 'copilot',
    });
  });

  it('stamps harness=copilot when harness field is empty string', () => {
    expect(normalizeReviewerVerdict({ approved: true, findings: [], harness: '' })).toEqual({
      approved: true,
      findings: [],
      harness: 'copilot',
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

describe('subprocessCopilotSpawnAgent — bridge configuration (AC #4)', () => {
  const ORIGINAL_ENV = process.env.COPILOT_SPAWN_AGENT_BIN;
  beforeEach(() => {
    delete process.env.COPILOT_SPAWN_AGENT_BIN;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.COPILOT_SPAWN_AGENT_BIN;
    } else {
      process.env.COPILOT_SPAWN_AGENT_BIN = ORIGINAL_ENV;
    }
  });

  it('throws a clear configuration message when COPILOT_SPAWN_AGENT_BIN is unset', () => {
    expect(() => subprocessCopilotSpawnAgent()).toThrow(COPILOT_BRIDGE_MISSING_MESSAGE);
  });

  it('error message names the env var', () => {
    try {
      subprocessCopilotSpawnAgent();
    } catch (err) {
      expect((err as Error).message).toContain('COPILOT_SPAWN_AGENT_BIN');
    }
    expect.assertions(1);
  });

  it('error message includes an install hint', () => {
    try {
      subprocessCopilotSpawnAgent();
    } catch (err) {
      // The install hint should mention installing Copilot CLI or the bridge
      expect((err as Error).message).toMatch(/[Ii]nstall/);
    }
    expect.assertions(1);
  });

  it('reads bridge bin from COPILOT_SPAWN_AGENT_BIN env var', () => {
    process.env.COPILOT_SPAWN_AGENT_BIN = '/tmp/fake-copilot-bridge';
    const fakeSpawn = makeFakeSpawn({
      stdout: JSON.stringify({ output: '{"approved":true}' }),
      exitCode: 0,
    });
    const fn = subprocessCopilotSpawnAgent({ spawn: fakeSpawn.spawn });
    expect(typeof fn).toBe('function');
    expect(fakeSpawn.calls).toHaveLength(0); // factory does not spawn until called
  });

  it('explicit bridgeBin option takes precedence over env var', () => {
    process.env.COPILOT_SPAWN_AGENT_BIN = '/should-not-use-this';
    const fakeSpawn = makeFakeSpawn({
      stdout: JSON.stringify({ output: '{}' }),
      exitCode: 0,
    });
    const fn = subprocessCopilotSpawnAgent({
      bridgeBin: '/explicit-bridge',
      spawn: fakeSpawn.spawn,
    });

    void fn({
      agentType: 'developer',
      systemPrompt: '',
      userPrompt: '',
      cwd: '/cwd',
      timeoutMs: 1000,
    });

    // First call uses the explicit bridgeBin
    expect(fakeSpawn.calls[0]?.command ?? '/explicit-bridge').toBe('/explicit-bridge');
  });

  it('writes a JSON-line request envelope to stdin', async () => {
    const fakeSpawn = makeFakeSpawn({
      stdout: JSON.stringify({ output: '{"summary":"ok"}' }),
      exitCode: 0,
    });
    const fn = subprocessCopilotSpawnAgent({
      bridgeBin: '/tmp/fake-copilot-bridge',
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
    expect(fakeSpawn.calls[0].command).toBe('/tmp/fake-copilot-bridge');
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
    const fn = subprocessCopilotSpawnAgent({
      bridgeBin: '/tmp/fake-copilot-bridge',
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
    const fn = subprocessCopilotSpawnAgent({
      bridgeBin: '/tmp/fake-copilot-bridge',
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
    const fn = subprocessCopilotSpawnAgent({
      bridgeBin: '/tmp/fake-copilot-bridge',
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
    const fn = subprocessCopilotSpawnAgent({
      bridgeBin: '/tmp/fake-copilot-bridge',
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

  it('times out the bridge when it never closes (AC #2c)', async () => {
    vi.useFakeTimers();
    try {
      const fakeSpawn = makeFakeSpawn({ stdout: '', exitCode: 0, neverClose: true });
      const fn = subprocessCopilotSpawnAgent({
        bridgeBin: '/tmp/fake-copilot-bridge',
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

  it('end-to-end: CopilotHarnessAdapter wired via subprocess bridge yields a canonical reviewer verdict', async () => {
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
    const adapter = new CopilotHarnessAdapter({
      spawnAgent: subprocessCopilotSpawnAgent({
        bridgeBin: '/tmp/fake-copilot-bridge',
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
      harness: 'copilot',
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
  spawn: CopilotProcessSpawner;
  calls: Array<{
    command: string;
    args: readonly string[];
    options: { cwd?: string };
    stdin: string;
  }>;
}

function makeFakeSpawn(cfg: FakeSpawnConfig): FakeSpawnRecorder {
  const calls: FakeSpawnRecorder['calls'] = [];
  const fakeSpawn: CopilotProcessSpawner = ((
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
  }) as CopilotProcessSpawner;
  return { spawn: fakeSpawn, calls };
}

// Silence unused-var noise: SubagentResult is consumed via type-checking.
const _typecheck: SubagentResult | undefined = undefined;
void _typecheck;
