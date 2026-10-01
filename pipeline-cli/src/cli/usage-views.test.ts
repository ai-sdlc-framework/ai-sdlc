import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendModelCalls,
  readCapabilityState,
  type ModelCallRecord,
  type PriceRow,
} from '@ai-sdlc/reference';
import type { OrchestratorEvent } from '../orchestrator/events.js';
import type { IngestResult } from '../usage/ingest-claude.js';
import { defaultUsageConfig } from '../usage/usage-config.js';
import { buildUsageCli, type UsageCliDeps } from './usage.js';

const H = 3_600_000;
const T0 = Date.parse('2026-09-10T00:00:00Z');

let root: string;
let usageDir: string;
let out: string[];
let err: string[];
let events: Array<Omit<OrchestratorEvent, 'ts'>>;
let exitCode: number | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cli-usage-views-'));
  usageDir = join(root, 'usage');
  out = [];
  err = [];
  events = [];
  exitCode = undefined;
  // A stray env var must never point a test at the real usage directory.
  vi.stubEnv('AI_SDLC_USAGE_DIR', usageDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function price(model: string, input: number): PriceRow {
  return {
    model,
    inputPer1M: input,
    outputPer1M: input * 5,
    cacheReadPer1M: input * 0.1,
    cacheWrite5mPer1M: input * 1.25,
    cacheWrite1hPer1M: input * 2,
    source: 'test',
    url: 'https://example.invalid/prices',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    effectiveFrom: '2026-01-01',
    status: 'active',
  };
}

function call(id: string, hours: number, over: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    schemaVersion: 'v1',
    callId: id,
    ts: new Date(T0 + hours * H).toISOString(),
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'model-sonnet-a',
    tokens: { input: 100, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 },
    billingPool: 'subscription-interactive',
    sessionId: 'sess-1',
    agentRole: 'main-session',
    scope: 'framework',
    repo: 'repo-a',
    taskId: 'TASK-1',
    ...over,
  };
}

function deps(now: number, extra: Partial<UsageCliDeps> = {}): UsageCliDeps {
  return {
    usageDir,
    now: () => new Date(now),
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    setExitCode: (c) => void (exitCode = c),
    emit: (e) => void events.push(e),
    priceRows: [price('model-sonnet-a', 2), price('model-opus-a', 10)],
    loadConfig: () => defaultUsageConfig(),
    ...extra,
  };
}

async function run(args: string[], now = T0 + 10 * H, extra: Partial<UsageCliDeps> = {}) {
  await buildUsageCli(args, deps(now, extra)).parseAsync();
  return out.join('');
}

describe('cli-usage report', () => {
  beforeEach(() => {
    appendModelCalls(
      [
        call('a1', 0, {
          tokens: { input: 1000, cacheWrite5m: 10, cacheWrite1h: 20, cacheRead: 5000, output: 200 },
        }),
        call('a2', 1, { model: 'model-opus-a', taskId: 'TASK-2', agentRole: 'ai-sdlc:developer' }),
        call('a3', 2, { model: 'model-mystery' }),
      ],
      { dir: usageDir },
    );
  });

  it('groups by model in text, json and csv with the same numbers', async () => {
    const text = await run(['report', '--group-by', 'model']);
    expect(text).toContain('model-sonnet-a');
    expect(text).toContain('unpriced');
    expect(text).toMatch(/proxy/);
    out.length = 0;
    const json = JSON.parse(await run(['report', '--group-by', 'model', '--format', 'json']));
    expect(json.rows.map((r: { model: string }) => r.model)).toEqual([
      'model-mystery',
      'model-opus-a',
      'model-sonnet-a',
    ]);
    const sonnet = json.rows.find((r: { model: string }) => r.model === 'model-sonnet-a');
    expect(sonnet).toMatchObject({
      calls: 1,
      input: 1000,
      cacheWrite5m: 10,
      cacheWrite1h: 20,
      cacheRead: 5000,
      output: 200,
    });
    out.length = 0;
    const csv = (await run(['report', '--group-by', 'model', '--format', 'csv']))
      .trim()
      .split('\n');
    expect(csv.find((l) => l.startsWith('model-sonnet-a,'))).toContain(',1000,10,20,5000,200,');
    expect(err.join('')).toMatch(/proxy/);
  });

  it('accepts repeated --group-by and filters by scope and range', async () => {
    const json = JSON.parse(
      await run([
        'report',
        '--group-by',
        'role',
        '--group-by',
        'task',
        '--format',
        'json',
        '--scope',
        'framework',
      ]),
    );
    expect(json.groupBy).toEqual(['role', 'task']);
    expect(json.totals.calls).toBe(3);
    out.length = 0;
    const ranged = JSON.parse(
      await run([
        'report',
        '--format',
        'json',
        '--since',
        new Date(T0 + 1 * H).toISOString(),
        '--until',
        new Date(T0 + 2 * H).toISOString(),
      ]),
    );
    expect(ranged.totals.calls).toBe(1);
    out.length = 0;
    const none = JSON.parse(await run(['report', '--format', 'json', '--scope', 'other']));
    expect(none.totals.calls).toBe(0);
  });

  it('rejects an unparsable date', async () => {
    await run(['report', '--since', 'garbage']);
    expect(exitCode).toBe(1);
    expect(err.join('')).toContain('Invalid --since');
  });

  it('prints the ungrouped total and an empty-ledger message', async () => {
    expect(await run(['report'])).toContain('calls');
    rmSync(usageDir, { recursive: true, force: true });
    out.length = 0;
    expect(await run(['report'])).toContain('No usage recorded');
  });

  it('surfaces config warnings on stderr', async () => {
    await run(['report'], T0 + 10 * H, {
      loadConfig: () => defaultUsageConfig(['Ignored the machine-level usage config: oops.']),
    });
    expect(err.join('')).toContain('Ignored the machine-level usage config');
  });
});

describe('cli-usage task and context', () => {
  beforeEach(() => {
    appendModelCalls(
      [
        call('t1', 0, {
          tokens: { input: 500, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 9000, output: 50 },
        }),
        call('t2', 1, { agentRole: 'ai-sdlc:developer' }),
        call('t3', 2, { taskId: 'TASK-9' }),
        call('o1', 3, {
          scope: 'other',
          repo: undefined,
          taskId: undefined,
          sessionId: 'sess-other',
          tokens: { input: 300, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 100, output: 1 },
        }),
      ],
      { dir: usageDir },
    );
  });

  it('shows one task split by role', async () => {
    const text = await run(['task', 'TASK-1']);
    expect(text).toContain('Task TASK-1');
    expect(text).toContain('main-session');
    expect(text).toContain('ai-sdlc:developer');
    expect(text).not.toContain('TASK-9');
    out.length = 0;
    const json = JSON.parse(await run(['task', 'TASK-1', '--format', 'json']));
    expect(json.totals.calls).toBe(2);
    out.length = 0;
    expect(await run(['task', 'NOPE'])).toContain('No usage recorded for task NOPE');
    out.length = 0;
    expect(await run(['task', 'TASK-1', '--format', 'csv'])).toContain('role,calls');
  });

  it('lists sessions with first-call tokens and shows no path for other scope', async () => {
    const text = await run(['context']);
    expect(text).toContain('sess-1');
    expect(text).toContain('sess-other');
    const otherLine = text.split('\n').find((l) => l.startsWith('sess-other')) ?? '';
    expect(otherLine).toContain('other');
    expect(otherLine.trimEnd().endsWith('-')).toBe(true);
    out.length = 0;
    const json = JSON.parse(await run(['context', '--format', 'json', '--limit', '1']));
    expect(json).toHaveLength(1);
    expect(json[0].session).toBe('sess-1');
    expect(json[0].firstCallTokens).toBe(9500);
    expect(json[0].turns).toBe(3);
  });

  it('rejects an unparsable --until', async () => {
    await run(['context', '--until', 'x']);
    expect(exitCode).toBe(1);
  });
});

describe('cli-usage window', () => {
  it('reports the session and weekly windows with a projection matching a hand calculation', async () => {
    // Reference model sonnet: 100 input tokens = 100 units per call.
    // Session window opens at the first call (hour 20) and holds the last three calls.
    appendModelCalls([call('w0', 0), call('w1', 20), call('w2', 21), call('w3', 22)], {
      dir: usageDir,
    });
    const now = T0 + 24 * H;
    writeFileSync(
      join(usageDir, 'snapshots.jsonl'),
      `${JSON.stringify({
        ts: new Date(T0 + 19 * H).toISOString(),
        window: 'session',
        usedPercent: 10,
        units: 100,
        source: 'manual',
        modelMix: { 'model-sonnet-a': 1 },
      })}\n`,
    );
    const json = JSON.parse(await run(['window', '--format', 'json'], now));
    const session = json.windows.find((w: { window: string }) => w.window === 'session');
    const weekly = json.windows.find((w: { window: string }) => w.window === 'weekly');
    expect(session.units).toBe(300);
    expect(session.calls).toBe(3);
    expect(weekly.units).toBe(400);
    // Implied session allotment 100 / 0.10 = 1000. Rate = 300 units over 4h since hour 20 = 75/h.
    expect(session.impliedAllotment).toBeCloseTo(1000);
    expect(session.ratePerHour).toBeCloseTo(75);
    expect(session.hoursToLimit).toBeCloseTo((1000 - 300) / 75);
    expect(weekly.impliedAllotment).toBeUndefined();
    expect(json.unitsNote).toMatch(/proxy/);

    out.length = 0;
    const text = await run(['window'], now);
    expect(text).toContain('session window (5h)');
    expect(text).toContain('implied allotment: 1,000 units');
    expect(text).toContain('projected time to the limit 9.3 hours');
    expect(text).toContain('implied allotment: unknown');
    expect(text).toMatch(/proxy/);
  });

  it('says so when no window is open', async () => {
    appendModelCalls([call('x', 0)], { dir: usageDir });
    const text = await run(['window'], T0 + 10 * H);
    expect(text).toContain('no window is open');
  });
});

describe('cli-usage snapshot and allotment', () => {
  beforeEach(() => {
    appendModelCalls([call('s1', 0), call('s2', 1), call('s3', 2)], { dir: usageDir });
  });

  it('appends a calibration point and prints implied allotment = units / fraction used', async () => {
    const text = await run(['snapshot', '--window', 'weekly', '--used-pct', '30'], T0 + 3 * H);
    expect(text).toContain('Recorded weekly snapshot: 300 units at 30%');
    expect(text).toContain('allotment of 1,000 units');
    const stored = JSON.parse(readFileSync(join(usageDir, 'snapshots.jsonl'), 'utf-8').trim());
    expect(stored).toMatchObject({
      window: 'weekly',
      usedPercent: 30,
      units: 300,
      source: 'manual',
    });
    expect(events.map((e) => e.type)).toEqual(['UsageLimitObserved']);
    expect(events[0]).toMatchObject({ window: 'weekly', usedPercent: 30, unitsInWindow: 300 });
    expect(events[0].impliedAllotment).toBeCloseTo(1000);

    out.length = 0;
    const series = JSON.parse(await run(['allotment', '--format', 'json'], T0 + 4 * H));
    expect(series.rows).toHaveLength(1);
    expect(series.rows[0].impliedAllotment).toBeCloseTo(300 / 0.3);
    out.length = 0;
    expect(await run(['allotment'], T0 + 4 * H)).toContain('1,000');
  });

  it('emits AllotmentChangeSuspected when consecutive snapshots differ beyond the tolerance with a similar mix', async () => {
    await run(['snapshot', '--window', 'weekly', '--used-pct', '30'], T0 + 3 * H);
    events.length = 0;
    // Same units, but the provider now shows 60%: implied allotment halves.
    const text = await run(
      [
        'snapshot',
        '--window',
        'weekly',
        '--used-pct',
        '60',
        '--at',
        new Date(T0 + 3 * H + 1000).toISOString(),
      ],
      T0 + 4 * H,
    );
    expect(events.map((e) => e.type)).toEqual(['UsageLimitObserved', 'AllotmentChangeSuspected']);
    expect(events[1]).toMatchObject({ window: 'weekly' });
    expect(events[1].changeRatio).toBeCloseTo(-0.5);
    expect(text).toContain('Probable allotment change: -50.0%');
    out.length = 0;
    expect(await run(['allotment', '--window', 'weekly'], T0 + 5 * H)).toContain(
      'probable allotment change',
    );
  });

  it('does not emit AllotmentChangeSuspected within the tolerance', async () => {
    await run(['snapshot', '--window', 'weekly', '--used-pct', '30'], T0 + 3 * H);
    events.length = 0;
    await run(
      [
        'snapshot',
        '--window',
        'weekly',
        '--used-pct',
        '32',
        '--at',
        new Date(T0 + 3 * H + 1000).toISOString(),
      ],
      T0 + 4 * H,
    );
    expect(events.map((e) => e.type)).toEqual(['UsageLimitObserved']);
  });

  it('uses window observations captured in limit-events as snapshots', async () => {
    writeFileSync(
      join(usageDir, 'limit-events.jsonl'),
      `${JSON.stringify({
        ts: new Date(T0 + 3 * H).toISOString(),
        harness: 'codex',
        sessionId: 's',
        window: 'primary',
        usedPercent: 15,
        windowMinutes: 600,
      })}\n`,
    );
    const series = JSON.parse(await run(['allotment', '--format', 'json'], T0 + 4 * H));
    expect(series.rows).toHaveLength(1);
    expect(series.rows[0]).toMatchObject({ window: 'primary', source: 'harness', units: 300 });
    expect(series.rows[0].impliedAllotment).toBeCloseTo(2000);
  });

  it('tells the operator how to record a first snapshot', async () => {
    expect(await run(['allotment'])).toContain('cli-usage snapshot');
  });

  it('rejects an unknown window, a bad percentage, a bad time and an empty window', async () => {
    await run(['snapshot', '--window', 'nope', '--used-pct', '10']);
    expect(exitCode).toBe(1);
    expect(err.join('')).toContain('Unknown window "nope". Known: session, weekly');
    exitCode = undefined;
    err.length = 0;
    await run(['snapshot', '--window', 'weekly', '--used-pct', '0'], T0 + 3 * H);
    expect(exitCode).toBe(1);
    expect(err.join('')).toContain('greater than 0');
    exitCode = undefined;
    await run(['snapshot', '--window', 'weekly', '--used-pct', '10', '--at', 'zzz']);
    expect(exitCode).toBe(1);
    exitCode = undefined;
    err.length = 0;
    await run(['snapshot', '--window', 'session', '--used-pct', '10'], T0 + 100 * H);
    expect(exitCode).toBe(1);
    expect(err.join('')).toContain('cannot be calibrated');
  });
});

describe('cli-usage ingest reports the usage.ingest capability', () => {
  const ok: IngestResult = {
    filesScanned: 1,
    callsWritten: 1,
    repeatsSkipped: 0,
    errors: 0,
    limitEvents: 0,
    otherScopeSkipped: 0,
    timedOut: false,
  };

  it('is live after a successful ingest and degraded after a failed one', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const onIngestCapability = (o: 'live' | 'degraded', r?: string): void => void seen.push([o, r]);
    await run(['ingest', '--json'], T0, { onIngestCapability, ingest: async () => ok });
    await run(['ingest', '--json'], T0, {
      onIngestCapability,
      ingest: async () => ({ ...ok, errors: 2 }),
    });
    await expect(
      run(['ingest'], T0, {
        onIngestCapability,
        ingest: async () => {
          throw new Error('boom with /private/path');
        },
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([
      ['live', undefined],
      ['degraded', '2 transcript errors'],
      ['degraded', 'ingest failed'],
    ]);
  });

  it('does not report when ingestion is disabled', async () => {
    const seen: string[] = [];
    await run(['ingest'], T0, {
      onIngestCapability: (o) => void seen.push(o),
      ingest: async () => ({ ...ok, disabled: 'remote-sandbox' }),
    });
    expect(seen).toEqual([]);
  });

  it('records state in the usage directory by default', async () => {
    vi.stubEnv('ARTIFACTS_DIR', '');
    await run(['ingest', '--json'], T0, { ingest: async () => ok });
    const row = readCapabilityState(usageDir).find((r) => r.id === 'usage.ingest');
    expect(row?.status).toBe('live');
    expect(row?.lastLiveAt).toBe(new Date(T0).toISOString());
    await run(['ingest', '--json'], T0 + H, { ingest: async () => ({ ...ok, errors: 1 }) });
    const after = readCapabilityState(usageDir).find((r) => r.id === 'usage.ingest');
    expect(after?.status).toBe('degraded');
    expect(after?.lastDegradedReason).toBe('1 transcript errors');
  });
});

describe('cli-usage scorecard', () => {
  let repo: string;
  beforeEach(() => {
    repo = join(root, 'repo-a');
    mkdirSync(join(repo, '.ai-sdlc', 'reviews'), { recursive: true });
    const rec = (iteration: number, verdict: string, severities: string[] = []) =>
      JSON.stringify({
        taskId: 'TASK-1',
        prNumber: null,
        commitSha: 'a'.repeat(40),
        iteration,
        role: 'code',
        harness: 'claude-code',
        timestamp: 't',
        verdict,
        findings: severities.map((severity) => ({ severity, summary: 's', title: 't' })),
      });
    writeFileSync(
      join(repo, '.ai-sdlc', 'reviews', 'task-1.jsonl'),
      `${rec(1, 'approved', ['minor'])}\n`,
    );
    appendModelCalls(
      [
        call('s1', 0, { agentRole: 'ai-sdlc:developer', repo: 'repo-a' }),
        call('s2', 1, { agentRole: 'ai-sdlc:developer', repo: 'repo-a', taskId: 'TASK-9' }),
        call('s3', 1, { agentRole: 'ai-sdlc:developer', repo: 'repo-b', taskId: 'TASK-7' }),
        call('s4', 1, { scope: 'other', repo: undefined, taskId: undefined }),
      ],
      { dir: usageDir },
    );
  });

  it('prints a scorecard for the current repository and writes evidence without other-scope data', async () => {
    const evidence = join(root, 'evidence');
    const text = await run(['scorecard', '--format', 'json', '--write-evidence', evidence], T0, {
      repoRoot: repo,
      artifactsDir: join(root, 'art'),
    });
    const json = JSON.parse(text);
    expect(json.rows).toHaveLength(1);
    expect(json.rows[0]).toMatchObject({ role: 'developer', tasks: 1, approved: 1 });
    expect(json.noOutcome).toBe(1);
    expect(json.minTasks).toBe(30);
    const files = readdirSync(evidence);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(evidence, files[0]), 'utf8');
    expect(body).not.toContain('TASK-7');
    expect(body).not.toContain('"other"');
    expect(err.join('')).toContain('Wrote 1 evidence file');
  });

  it('supports text and csv output, role and since filters', async () => {
    const extra = { repoRoot: repo, artifactsDir: join(root, 'art') };
    expect(await run(['scorecard', '--role', 'developer'], T0, extra)).toContain('insufficient');
    out.length = 0;
    expect(await run(['scorecard', '--format', 'csv'], T0, extra)).toContain('first_pass');
    out.length = 0;
    expect(await run(['scorecard', '--since', '2030-01-01'], T0, extra)).toContain(
      'No scored tasks',
    );
  });

  it('rejects a bad --since', async () => {
    await run(['scorecard', '--since', 'nope'], T0, { repoRoot: repo });
    expect(exitCode).toBe(1);
  });
});
