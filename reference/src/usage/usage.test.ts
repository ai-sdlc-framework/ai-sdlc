import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  statSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendModelCalls,
  appendFetchedPriceRows,
  appendManualPriceRows,
  priceCall,
  priceCallBreakdown,
  readCursor,
  readModelCalls,
  readPriceHistory,
  recordModelCall,
  resolveUsageDir,
  selectPriceRow,
  writeCursor,
  SEED_PRICES,
  USAGE_DIR_ENV,
  type ModelCallRecord,
  type PriceRow,
} from './index.js';

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-ledger-test-'));
  savedEnv = process.env[USAGE_DIR_ENV];
  delete process.env[USAGE_DIR_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[USAGE_DIR_ENV];
  else process.env[USAGE_DIR_ENV] = savedEnv;
  try {
    chmodSync(dir, 0o700);
  } catch {
    // already gone
  }
  rmSync(dir, { recursive: true, force: true });
});

function rec(id: string, over: Partial<ModelCallRecord> = {}): ModelCallRecord {
  return {
    schemaVersion: 'v1',
    callId: id,
    ts: '2026-09-15T10:00:00.000Z',
    harness: 'claude-code',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    tokens: { input: 10, cacheWrite5m: 20, cacheWrite1h: 30, cacheRead: 40, output: 50 },
    billingPool: 'subscription-interactive',
    sessionId: 's1',
    agentRole: 'main-session',
    scope: 'framework',
    repo: 'demo',
    taskId: 'T-1',
    source: { file: 'synthetic.jsonl', offset: 0 },
    ...over,
  };
}

async function collect(
  filter: Parameters<typeof readModelCalls>[0],
  d = dir,
): Promise<ModelCallRecord[]> {
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls(filter, { dir: d })) out.push(r);
  return out;
}

function priceRow(over: Partial<PriceRow>): PriceRow {
  return {
    model: 'test-model',
    inputPer1M: 1,
    outputPer1M: 5,
    cacheReadPer1M: 0.1,
    cacheWrite5mPer1M: 1.25,
    cacheWrite1hPer1M: 2,
    source: 'test',
    url: 'https://example.invalid/prices',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    effectiveFrom: '2026-01-01',
    status: 'active',
    ...over,
  };
}

describe('resolveUsageDir', () => {
  it('prefers the explicit option, then the env var, then the home default', () => {
    expect(resolveUsageDir({ dir: '/x/explicit' })).toBe('/x/explicit');
    process.env[USAGE_DIR_ENV] = '/x/env';
    expect(resolveUsageDir()).toBe('/x/env');
    delete process.env[USAGE_DIR_ENV];
    expect(resolveUsageDir().endsWith(join('.ai-sdlc', 'usage'))).toBe(true);
  });

  it('honours the env var for store operations', async () => {
    process.env[USAGE_DIR_ENV] = dir;
    expect(appendModelCalls([rec('a')]).written).toBe(1);
    expect(existsSync(join(dir, 'ledger-2026-09.jsonl'))).toBe(true);
  });
});

describe('appendModelCalls', () => {
  it('writes a record once and reports the second append as skipped', () => {
    expect(appendModelCalls([rec('a')], { dir })).toEqual({ written: 1, skipped: 0, invalid: 0 });
    expect(appendModelCalls([rec('a')], { dir })).toEqual({ written: 0, skipped: 1, invalid: 0 });
    const lines = readFileSync(join(dir, 'ledger-2026-09.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('skips duplicates within one batch', () => {
    expect(appendModelCalls([rec('a'), rec('a')], { dir }).written).toBe(1);
  });

  it('routes records to the month file of their own timestamp across a boundary', () => {
    const res = appendModelCalls(
      [
        rec('a', { ts: '2026-08-31T23:59:59.999Z' }),
        rec('b', { ts: '2026-09-01T00:00:00.000Z' }),
        rec('c', { ts: '2026-09-30T12:00:00.000Z' }),
      ],
      { dir },
    );
    expect(res.written).toBe(3);
    const read = (f: string) =>
      readFileSync(join(dir, f), 'utf-8')
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as ModelCallRecord).callId);
    expect(read('ledger-2026-08.jsonl')).toEqual(['a']);
    expect(read('ledger-2026-09.jsonl')).toEqual(['b', 'c']);
  });

  it('still skips a present record after the index file is deleted', () => {
    appendModelCalls([rec('a')], { dir });
    for (const f of readdirSync(dir).filter((n) => n.startsWith('dedup-'))) {
      rmSync(join(dir, f));
    }
    expect(appendModelCalls([rec('a')], { dir }).skipped).toBe(1);
    expect(appendModelCalls([rec('z')], { dir }).written).toBe(1);
  });

  it('rebuilds the index when it is out of step with the ledger', () => {
    appendModelCalls([rec('a')], { dir });
    // a ledger line written by something that did not update the index
    writeFileSync(
      join(dir, 'ledger-2026-09.jsonl'),
      `${JSON.stringify(rec('a'))}\n${JSON.stringify(rec('b'))}\n`,
    );
    expect(appendModelCalls([rec('b')], { dir }).skipped).toBe(1);
  });

  it('rebuilds when the index metadata is corrupt and tolerates corrupt ledger lines', () => {
    appendModelCalls([rec('a')], { dir });
    writeFileSync(join(dir, 'dedup-meta.json'), '{not json');
    writeFileSync(
      join(dir, 'ledger-2026-09.jsonl'),
      `garbage line\n${JSON.stringify(rec('a'))}\n\n${JSON.stringify({ nothing: 1 })}\n`,
    );
    expect(appendModelCalls([rec('a')], { dir }).skipped).toBe(1);
  });

  it('counts schema-invalid records and does not write them', () => {
    const bad = { ...rec('a'), model: '' } as ModelCallRecord;
    expect(appendModelCalls([bad], { dir })).toEqual({ written: 0, skipped: 0, invalid: 1 });
    expect(existsSync(join(dir, 'ledger-2026-09.jsonl'))).toBe(false);
  });

  it('does nothing for an empty batch', () => {
    expect(appendModelCalls([], { dir }).written).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never writes repo, task or source for scope other', () => {
    appendModelCalls([rec('a', { scope: 'other' })], { dir });
    const line = JSON.parse(
      readFileSync(join(dir, 'ledger-2026-09.jsonl'), 'utf-8').trim(),
    ) as ModelCallRecord;
    expect(line.repo).toBeUndefined();
    expect(line.taskId).toBeUndefined();
    expect(line.source).toBeUndefined();
  });

  it('keeps every line intact with ten concurrent processes appending', async () => {
    const storePath = resolve(fileURLToPath(new URL('.', import.meta.url)), 'store.ts');
    const childCode = `
      const { appendModelCalls } = await import(${JSON.stringify(storePath)});
      const n = Number(process.argv[1]);
      for (let i = 0; i < 20; i++) {
        appendModelCalls([{
          schemaVersion: 'v1', callId: 'p' + n + '-' + i, ts: '2026-09-15T10:00:00.000Z',
          harness: 'direct', provider: 'anthropic', model: 'claude-sonnet-5',
          tokens: { input: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 1 },
          billingPool: 'unknown', sessionId: 's', agentRole: 'r', scope: 'other',
        }], { dir: process.env.CHILD_DIR });
      }
    `;
    const runs = Array.from(
      { length: 10 },
      (_, n) =>
        new Promise<number | null>((done) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', childCode, String(n)],
            {
              env: { ...process.env, CHILD_DIR: dir },
              cwd: resolve(fileURLToPath(new URL('.', import.meta.url)), '../..'),
              stdio: 'ignore',
            },
          );
          child.on('exit', done);
        }),
    );
    const codes = await Promise.all(runs);
    expect(codes.every((c) => c === 0)).toBe(true);
    const lines = readFileSync(join(dir, 'ledger-2026-09.jsonl'), 'utf-8').trim().split('\n');
    const ids = lines.map((l) => (JSON.parse(l) as ModelCallRecord).callId);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect(appendModelCalls([rec('p0-0')], { dir }).skipped).toBe(1);
  }, 120_000);
});

describe('crash-safety, control characters and permissions', () => {
  it('starts a new line when the ledger ends with a partial line', async () => {
    appendModelCalls([rec('a')], { dir });
    const file = join(dir, 'ledger-2026-09.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf-8')}{"callId":"partial`);
    expect(appendModelCalls([rec('b')], { dir }).written).toBe(1);
    const got = (await collect({})).map((r) => r.callId);
    expect(got).toEqual(['a', 'b']);
    expect(appendModelCalls([rec('b')], { dir }).skipped).toBe(1);
  });

  it('rejects a callId containing control characters without touching the index', () => {
    const res = appendModelCalls([rec('bad\nid'), rec('bad\u0000id'), rec('tab\tid'), rec('ok')], {
      dir,
    });
    expect(res).toEqual({ written: 1, skipped: 0, invalid: 3 });
    expect(readFileSync(join(dir, 'dedup-ids.txt'), 'utf-8')).toBe('ok\n');
  });

  it('skips control-character ids found in the ledger when rebuilding the index', () => {
    writeFileSync(
      join(dir, 'ledger-2026-09.jsonl'),
      `${JSON.stringify({ callId: 'x\ny' })}\n${JSON.stringify(rec('fine'))}\n`,
    );
    expect(appendModelCalls([rec('fine')], { dir }).skipped).toBe(1);
    expect(readFileSync(join(dir, 'dedup-ids.txt'), 'utf-8')).toBe('fine\n');
  });

  it.skipIf(process.platform === 'win32')('creates the directory 0700 and files 0600', () => {
    const sub = join(dir, 'fresh');
    appendModelCalls([rec('a')], { dir: sub });
    writeCursor('f.jsonl', 1, { dir: sub });
    appendManualPriceRows([priceRow({})], { dir: sub });
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(sub).filter((n) => !n.startsWith('.'))) {
      expect(statSync(join(sub, f)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('cursors', () => {
  it('returns 0 for an unknown file and persists written offsets', () => {
    expect(readCursor('a.jsonl', { dir })).toBe(0);
    writeCursor('a.jsonl', 123, { dir });
    writeCursor('b.jsonl', 7, { dir });
    expect(readCursor('a.jsonl', { dir })).toBe(123);
    expect(readCursor('b.jsonl', { dir })).toBe(7);
  });

  it('treats a corrupt cursors file as empty', () => {
    writeFileSync(join(dir, 'cursors.json'), '[1,2');
    expect(readCursor('a.jsonl', { dir })).toBe(0);
    writeFileSync(join(dir, 'cursors.json'), '{"a.jsonl": -5}');
    expect(readCursor('a.jsonl', { dir })).toBe(0);
  });
});

describe('recordModelCall', () => {
  it('records a direct call with a generated callId and defaults', async () => {
    const res = recordModelCall(
      { provider: 'openai', model: 'some-model', tokens: { input: 5, output: 2 } },
      { dir },
    );
    expect(res.recorded).toBe(true);
    expect(res.callId.length).toBeGreaterThan(0);
    const [r] = await collect({});
    expect(r.harness).toBe('direct');
    expect(r.callId).toBe(res.callId);
    expect(r.tokens).toEqual({
      input: 5,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 2,
    });
  });

  it('keeps a provider-supplied callId and optional fields', async () => {
    recordModelCall(
      {
        callId: 'msg_1',
        requestId: 'req_1',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        tokens: { input: 1, reasoning: 3, output: 4 },
        scope: 'framework',
        repo: 'demo',
        taskId: 'T-9',
        agentId: 'ag',
      },
      { dir },
    );
    const [r] = await collect({});
    expect(r).toMatchObject({ callId: 'msg_1', requestId: 'req_1', taskId: 'T-9', agentId: 'ag' });
    expect(r.tokens.reasoning).toBe(3);
  });

  it('returns normally when the usage directory is unwritable', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file where a directory is needed');
    const res = recordModelCall(
      { provider: 'anthropic', model: 'm', tokens: { input: 1 } },
      { dir: join(blocker, 'sub') },
    );
    expect(res.recorded).toBe(false);
  });

  it('returns normally for invalid input', () => {
    const res = recordModelCall(
      { provider: 'anthropic', model: '', tokens: { input: 1 } },
      { dir },
    );
    expect(res.recorded).toBe(false);
  });

  it('swallows a thrown error from malformed input', () => {
    const res = recordModelCall(
      { provider: 'anthropic', model: 'm', tokens: undefined as never },
      { dir },
    );
    expect(res.recorded).toBe(true);
    const bad = recordModelCall(null as never, { dir });
    expect(bad.recorded).toBe(false);
  });
});

describe('readModelCalls', () => {
  beforeEach(() => {
    appendModelCalls(
      [
        rec('a', { ts: '2026-08-10T00:00:00.000Z', model: 'claude-opus-5' }),
        rec('b', { ts: '2026-09-02T00:00:00.000Z', agentRole: 'ai-sdlc:developer', taskId: 'T-2' }),
        rec('c', {
          ts: '2026-09-20T00:00:00.000Z',
          scope: 'other',
          billingPool: 'api-key',
          repo: undefined,
        }),
        rec('d', { ts: '2026-10-05T00:00:00.000Z', repo: 'other-repo' }),
      ],
      { dir },
    );
  });

  it('streams everything oldest first without a filter', async () => {
    expect((await collect({})).map((r) => r.callId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters by date range with an exclusive upper bound', async () => {
    const got = await collect({
      from: '2026-09-01T00:00:00Z',
      to: new Date('2026-10-05T00:00:00Z'),
    });
    expect(got.map((r) => r.callId)).toEqual(['b', 'c']);
  });

  it('filters by model, role, scope, repo, task and billing pool', async () => {
    expect((await collect({ model: 'claude-opus-5' })).map((r) => r.callId)).toEqual(['a']);
    expect((await collect({ agentRole: 'ai-sdlc:developer' })).map((r) => r.callId)).toEqual(['b']);
    expect((await collect({ scope: 'other' })).map((r) => r.callId)).toEqual(['c']);
    expect((await collect({ repo: 'other-repo' })).map((r) => r.callId)).toEqual(['d']);
    expect((await collect({ taskId: 'T-2' })).map((r) => r.callId)).toEqual(['b']);
    expect((await collect({ billingPool: 'api-key' })).map((r) => r.callId)).toEqual(['c']);
  });

  it('ignores an unparsable date bound and yields nothing for a missing directory', async () => {
    expect(await collect({ from: 'not-a-date' })).toHaveLength(4);
    expect(await collect({}, join(dir, 'missing'))).toEqual([]);
  });

  it('skips corrupt lines and blank lines', async () => {
    writeFileSync(
      join(dir, 'ledger-2026-11.jsonl'),
      `oops\n\n${JSON.stringify(rec('e', { ts: '2026-11-01T00:00:00.000Z' }))}\n`,
    );
    expect((await collect({ from: '2026-11-01T00:00:00Z' })).map((r) => r.callId)).toEqual(['e']);
  });
});

describe('price table', () => {
  const T = {
    input: 1_000_000,
    cacheWrite5m: 1_000_000,
    cacheWrite1h: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
  };
  const row = priceRow;

  it('returns unpriced for an unknown model and never substitutes another', () => {
    expect(priceCall({ model: 'no-such-model', ts: '2026-09-15T00:00:00Z', tokens: T })).toBe(
      'unpriced',
    );
    expect(
      priceCallBreakdown({ model: 'no-such-model', ts: '2026-09-15T00:00:00Z', tokens: T }),
    ).toBe('unpriced');
  });

  it('prices each token class separately for a known model', () => {
    const b = priceCallBreakdown(
      {
        model: 'test-model',
        ts: '2026-09-15T00:00:00Z',
        tokens: { ...T, input: 2_000_000, output: 500_000 },
      },
      { rows: [row({})] },
    );
    expect(b).toEqual({
      input: 2,
      cacheWrite5m: 1.25,
      cacheWrite1h: 2,
      cacheRead: 0.1,
      output: 2.5,
      total: 2 + 1.25 + 2 + 0.1 + 2.5,
    });
    expect(
      priceCall(
        { model: 'test-model', ts: '2026-09-15T00:00:00Z', tokens: T },
        { rows: [row({})] },
      ),
    ).toBeCloseTo(9.35);
  });

  it('chooses the row in effect at the call timestamp', () => {
    const rows = [
      row({ effectiveFrom: '2026-01-01' }),
      row({ inputPer1M: 9, effectiveFrom: '2026-06-01' }),
    ];
    expect(selectPriceRow(rows, 'test-model', '2026-03-01T00:00:00Z')?.inputPer1M).toBe(1);
    expect(selectPriceRow(rows, 'test-model', '2026-07-01T00:00:00Z')?.inputPer1M).toBe(9);
    expect(selectPriceRow(rows, 'test-model', '2025-12-31T00:00:00Z')).toBeUndefined();
    expect(selectPriceRow(rows, 'test-model', 'garbage')).toBeUndefined();
  });

  it('prefers a manual row and ignores a held row', () => {
    const rows = [
      row({ inputPer1M: 1 }),
      row({ inputPer1M: 7, status: 'held', effectiveFrom: '2026-05-01' }),
      row({ inputPer1M: 3, status: 'manual', effectiveFrom: '2026-02-01' }),
      row({ inputPer1M: 4, effectiveFrom: '2026-06-01' }),
    ];
    expect(selectPriceRow(rows, 'test-model', '2026-09-01T00:00:00Z')?.inputPer1M).toBe(3);
    const noManual = rows.filter((r) => r.status !== 'manual');
    expect(selectPriceRow(noManual, 'test-model', '2026-09-01T00:00:00Z')?.inputPer1M).toBe(4);
    const onlyHeld = [row({ status: 'held' })];
    expect(selectPriceRow(onlyHeld, 'test-model', '2026-09-01T00:00:00Z')).toBeUndefined();
  });

  it('breaks an effective-date tie by the later fetch time', () => {
    const rows = [
      row({ inputPer1M: 1, fetchedAt: '2026-01-02T00:00:00Z' }),
      row({ inputPer1M: 2, fetchedAt: '2026-01-03T00:00:00Z' }),
    ];
    expect(selectPriceRow(rows, 'test-model', '2026-09-01T00:00:00Z')?.inputPer1M).toBe(2);
  });

  it('appends rows to prices.jsonl and merges them with the seed rows', () => {
    const written = appendFetchedPriceRows(
      [
        row({ model: 'claude-sonnet-5', inputPer1M: 99, effectiveFrom: '2026-10-01' }),
        row({ inputPer1M: -1 }),
      ],
      { dir },
    );
    expect(written).toBe(1);
    expect(appendFetchedPriceRows([], { dir })).toBe(0);
    const history = readPriceHistory({ dir });
    expect(history.length).toBe(SEED_PRICES.length + 1);
    const before = priceCall(
      { model: 'claude-sonnet-5', ts: '2026-09-15T00:00:00Z', tokens: T },
      { dir },
    );
    const after = priceCall(
      { model: 'claude-sonnet-5', ts: '2026-10-15T00:00:00Z', tokens: T },
      { dir },
    );
    expect(before).toBeCloseTo(2 + 2.5 + 4 + 0.2 + 10);
    expect(after).toBeCloseTo(99 + 1.25 + 2 + 0.1 + 5);
  });

  it('rejects zero, negative, non-numeric prices and unparsable dates', () => {
    const bad = [
      row({ inputPer1M: 0 }),
      row({ cacheWrite1hPer1M: 0 }),
      row({ outputPer1M: -2 }),
      row({ cacheReadPer1M: Number.NaN }),
      row({ inputPer1M: '1' as unknown as number }),
      row({ fetchedAt: 'yesterday' }),
      row({ effectiveFrom: 'soon' }),
    ];
    expect(appendFetchedPriceRows(bad, { dir })).toBe(0);
    expect(appendManualPriceRows(bad, { dir })).toBe(0);
  });

  it('never lets the fetched entry point produce a manual row', () => {
    appendFetchedPriceRows(
      [
        row({ status: 'manual', model: 'm1' }),
        row({ status: 'held', model: 'm2' }),
        row({ model: 'm3' }),
      ],
      { dir },
    );
    const byModel = Object.fromEntries(
      readPriceHistory({ dir })
        .filter((r) => ['m1', 'm2', 'm3'].includes(r.model))
        .map((r) => [r.model, r.status]),
    );
    expect(byModel).toEqual({ m1: 'active', m2: 'held', m3: 'active' });
  });

  it('forces status manual for the operator entry point and it wins', () => {
    appendFetchedPriceRows([row({ inputPer1M: 1 })], { dir });
    appendManualPriceRows([row({ inputPer1M: 6, status: 'active' })], { dir });
    const rows = readPriceHistory({ dir });
    expect(selectPriceRow(rows, 'test-model', '2026-09-01T00:00:00Z')).toMatchObject({
      inputPer1M: 6,
      status: 'manual',
    });
  });

  it('skips corrupt and structurally invalid lines in prices.jsonl', () => {
    writeFileSync(
      join(dir, 'prices.jsonl'),
      `nope\n\n${JSON.stringify({ model: 'x' })}\n${JSON.stringify(row({ effectiveFrom: 'bad-date' }))}\n${JSON.stringify(row({}))}\n`,
    );
    expect(readPriceHistory({ dir })).toHaveLength(SEED_PRICES.length + 1);
  });

  it('seeds every model named in the design tables and the orchestrator defaults', () => {
    const ids = new Set(SEED_PRICES.map((r) => r.model));
    for (const id of [
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-4-6',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-20250514',
      'claude-3-5-haiku-20241022',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    for (const r of SEED_PRICES) {
      expect(r.fetchedAt.startsWith('2026-09-30')).toBe(true);
      expect(r.url).toMatch(/^https:\/\//);
    }
  });

  it('prices calls made before the seed date with the seed baseline', () => {
    expect(priceCall({ model: 'claude-opus-5', ts: '2026-06-12T00:00:00Z', tokens: T })).not.toBe(
      'unpriced',
    );
  });
});
