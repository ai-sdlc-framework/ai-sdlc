import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelCalls, type ModelCallRecord } from '@ai-sdlc/reference';
import {
  defaultCodexSessionsDir,
  ingestCodexSessions,
  LIMIT_EVENTS_FILE,
} from './codex-ingester.js';
import { attributeCodexSession } from './codex-attribution.js';
import { formatCodexIngestSummary } from '../cli/usage-codex.js';

let root: string;
let sessions: string;
let usage: string;

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const meta = (id: string, cwd: string, extra: Record<string, unknown> = {}) =>
  line({
    timestamp: '2026-09-01T10:00:00.000Z',
    type: 'session_meta',
    payload: { id, cwd, model_provider: 'openai', ...extra },
  });
const tc = (ts: string, last: unknown, total: unknown, rate_limits: unknown = null) =>
  line({
    timestamp: ts,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: last, total_token_usage: total },
      rate_limits,
    },
  });
const usageObj = (i: number, c: number, o: number, r: number, w = 0) => ({
  input_tokens: i,
  cached_input_tokens: c,
  cache_write_input_tokens: w,
  output_tokens: o,
  reasoning_output_tokens: r,
  total_tokens: i + o,
});

async function readAll(): Promise<ModelCallRecord[]> {
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls({}, { dir: usage })) out.push(r);
  return out;
}

function opts() {
  return { sessionsDir: sessions, dir: usage };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-ingest-'));
  sessions = join(root, 'sessions', '2026', '09', '01');
  usage = join(root, 'usage');
  mkdirSync(sessions, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function frameworkRepo(): string {
  const repo = join(root, 'myrepo');
  mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(repo, '.worktrees', 'aisdlc-650'), { recursive: true });
  return repo;
}

describe('ingestCodexSessions', () => {
  it('writes one record per token_count event with token classes mapped', async () => {
    const repo = frameworkRepo();
    const cwd = join(repo, '.worktrees', 'aisdlc-650');
    writeFileSync(
      join(sessions, 'rollout-a.jsonl'),
      meta('sess-a', cwd, { model: 'gpt-5-codex', git: { branch: 'main' } }) +
        tc(
          '2026-09-01T10:01:00.000Z',
          usageObj(1000, 400, 50, 20, 100),
          usageObj(1000, 400, 50, 20),
        ) +
        tc('2026-09-01T10:02:00.000Z', usageObj(2000, 1000, 80, 0), usageObj(3000, 1400, 130, 20)) +
        tc('2026-09-01T10:03:00.000Z', usageObj(500, 0, 10, 5), usageObj(3500, 1400, 140, 25)),
    );
    const res = ingestCodexSessions(opts());
    expect(res).toMatchObject({ filesScanned: 1, written: 3, errors: 0 });
    const recs = await readAll();
    expect(recs).toHaveLength(3);
    const r0 = recs.find((r) => r.callId === 'codex:sess-a:0')!;
    expect(r0).toMatchObject({
      harness: 'codex',
      billingPool: 'codex-plan',
      model: 'gpt-5-codex',
      provider: 'openai',
      scope: 'framework',
      repo: 'myrepo',
      taskId: 'AISDLC-650',
      sessionId: 'sess-a',
    });
    expect(r0.tokens).toEqual({
      input: 500,
      cacheWrite5m: 100,
      cacheWrite1h: 0,
      cacheRead: 400,
      output: 50,
      reasoning: 20,
    });
    expect(r0.source?.file).toContain('rollout-a.jsonl');
    expect(recs.find((r) => r.callId === 'codex:sess-a:1')!.tokens.input).toBe(1000);
    expect(recs.find((r) => r.callId === 'codex:sess-a:2')!.tokens.output).toBe(10);
  });

  it('writes one flagged record for a session that reports only a total', async () => {
    writeFileSync(
      join(sessions, 'rollout-b.jsonl'),
      meta('sess-b', join(root, 'nowhere')) +
        tc('2026-09-01T10:01:00.000Z', undefined, { input_tokens: 100, output_tokens: 20 }) +
        tc('2026-09-01T10:02:00.000Z', undefined, {
          input_tokens: 300,
          output_tokens: 60,
          total_tokens: 360,
        }),
    );
    expect(ingestCodexSessions(opts()).written).toBe(1);
    const [rec] = await readAll();
    expect(rec.breakdownMissing).toBe(true);
    expect(rec.tokens).toMatchObject({ input: 360, output: 0, cacheRead: 0 });
    expect(rec.model).toBe('unknown');
    expect(rec.scope).toBe('other');
    expect(rec.repo).toBeUndefined();
    expect(rec.source).toBeUndefined();
  });

  it('is idempotent and picks up only appended events', async () => {
    const f = join(sessions, 'rollout-c.jsonl');
    writeFileSync(
      f,
      meta('sess-c', root) +
        tc('2026-09-01T10:01:00.000Z', usageObj(10, 0, 1, 0), usageObj(10, 0, 1, 0)),
    );
    expect(ingestCodexSessions(opts()).written).toBe(1);
    expect(ingestCodexSessions(opts())).toMatchObject({ written: 0, skipped: 0 });
    appendFileSync(f, tc('2026-09-01T10:02:00.000Z', usageObj(20, 0, 2, 0), usageObj(30, 0, 3, 0)));
    expect(ingestCodexSessions(opts()).written).toBe(1);
    expect(await readAll()).toHaveLength(2);
    const back = ingestCodexSessions({ ...opts(), backfill: true });
    expect(back).toMatchObject({ written: 0, skipped: 2 });
  });

  it('skips repeated identical totals and retries a truncated last line', async () => {
    const f = join(sessions, 'rollout-d.jsonl');
    const u = usageObj(10, 0, 1, 0);
    const second = tc('2026-09-01T10:02:00.000Z', usageObj(5, 0, 1, 0), usageObj(15, 0, 2, 0));
    writeFileSync(
      f,
      meta('sess-d', root) +
        tc('2026-09-01T10:01:00.000Z', u, u) +
        tc('2026-09-01T10:01:01.000Z', u, u) +
        second.slice(0, 30),
    );
    expect(ingestCodexSessions(opts()).written).toBe(1);
    writeFileSync(
      f,
      meta('sess-d', root) +
        tc('2026-09-01T10:01:00.000Z', u, u) +
        tc('2026-09-01T10:01:01.000Z', u, u) +
        second,
    );
    expect(ingestCodexSessions(opts()).written).toBe(1);
  });

  it('writes limit observations for non-empty rate_limits only', async () => {
    writeFileSync(
      join(sessions, 'rollout-e.jsonl'),
      meta('sess-e', root) +
        tc('2026-09-01T10:01:00.000Z', usageObj(10, 0, 1, 0), usageObj(10, 0, 1, 0), null) +
        tc('2026-09-01T10:02:00.000Z', usageObj(10, 0, 1, 0), usageObj(20, 0, 2, 0), {}) +
        tc('2026-09-01T10:03:00.000Z', usageObj(10, 0, 1, 0), usageObj(30, 0, 3, 0), {
          primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1788300000 },
          secondary: { used_percent: 40, window_minutes: 10080, resets_at: '2026-09-07T00:00:00Z' },
          junk: 'x',
        }),
    );
    const res = ingestCodexSessions(opts());
    expect(res.limitEvents).toBe(2);
    const rows = readFileSync(join(usage, LIMIT_EVENTS_FILE), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      window: 'primary',
      usedPercent: 12.5,
      windowMinutes: 300,
      harness: 'codex',
    });
    expect(rows[0].resetsAt).toBe(new Date(1788300000 * 1000).toISOString());
    expect(rows[1].resetsAt).toBe('2026-09-07T00:00:00.000Z');
    ingestCodexSessions(opts());
    expect(readFileSync(join(usage, LIMIT_EVENTS_FILE), 'utf-8').trim().split('\n')).toHaveLength(
      2,
    );
  });

  it('writes no limit file when no event carries rate_limits', async () => {
    writeFileSync(
      join(sessions, 'rollout-f.jsonl'),
      meta('sess-f', root) +
        tc('2026-09-01T10:01:00.000Z', usageObj(10, 0, 1, 0), usageObj(10, 0, 1, 0), null),
    );
    ingestCodexSessions(opts());
    expect(() => readFileSync(join(usage, LIMIT_EVENTS_FILE))).toThrow();
  });

  it('honours framework-only scope and contains per-file errors', async () => {
    writeFileSync(
      join(sessions, 'rollout-g.jsonl'),
      meta('sess-g', root) +
        tc('2026-09-01T10:01:00.000Z', usageObj(10, 0, 1, 0), usageObj(10, 0, 1, 0)),
    );
    writeFileSync(join(sessions, 'garbage.jsonl'), 'not json\n[1,2]\n{"payload":3}\n');
    const res = ingestCodexSessions({ ...opts(), frameworkOnly: true });
    expect(res.written).toBe(0);
    expect(res.errors).toBe(0);
    const bad = ingestCodexSessions({
      sessionsDir: sessions,
      dir: join(root, 'usage', 'x', '\0bad'),
    });
    expect(bad.errors).toBeGreaterThan(0);
  });

  it('returns an empty result when the sessions directory is missing', async () => {
    expect(
      ingestCodexSessions({ sessionsDir: join(root, 'absent'), dir: usage }).filesScanned,
    ).toBe(0);
  });

  it('resolves the default sessions directory from CODEX_HOME', async () => {
    expect(defaultCodexSessionsDir({ CODEX_HOME: '/x/codex' })).toBe('/x/codex/sessions');
    expect(defaultCodexSessionsDir({})).toMatch(/\.codex[\\/]sessions$/);
  });

  it('formats a summary', async () => {
    expect(
      formatCodexIngestSummary({
        filesScanned: 1,
        written: 2,
        skipped: 3,
        invalid: 0,
        limitEvents: 4,
        errors: 0,
      }),
    ).toContain('Calls written: 2');
  });
});

describe('attributeCodexSession', () => {
  it('resolves task from branch, then sentinel, and reports other scope without cwd', async () => {
    const repo = join(root, 'r2');
    mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
    expect(attributeCodexSession(repo, 'ai-sdlc/aisdlc-12-thing')).toEqual({
      scope: 'framework',
      repo: 'r2',
      taskId: 'AISDLC-12',
    });
    writeFileSync(join(repo, '.active-task'), 'AISDLC-99\n');
    expect(attributeCodexSession(repo, 'main').taskId).toBe('AISDLC-99');
    expect(attributeCodexSession(undefined, undefined)).toEqual({ scope: 'other' });
    expect(attributeCodexSession(join(root, 'plain'), 'x')).toEqual({ scope: 'other' });
    const cache = new Map();
    const a = attributeCodexSession(repo, 'main', cache);
    expect(attributeCodexSession(repo, 'main', cache)).toBe(a);
  });
});
