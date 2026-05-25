/**
 * Tests for `cli-cost-report --unified` (RFC-0019 OQ-7 / AISDLC-340 AC#5).
 *
 * Covers:
 *  - JSONL cost-ledger aggregation (input/output/embedding categories)
 *  - Subscription-ledger cost-conversion
 *  - Bucket aggregation by (costModel, category, source, consumer)
 *  - `--since` filtering
 *  - Output formats (text, json, csv)
 *  - CLI router happy path + error path (missing required input)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildUnifiedReport,
  convertSubscriptionWindowToCost,
  loadCostLedgerJsonl,
  loadSubscriptionLedgerDir,
  renderCsv,
  renderTextTable,
  runCostReportCli,
  SUBSCRIPTION_DEFAULTS,
  type UnifiedCostRow,
} from './cost-report.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cost-report-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function writeJsonl(path: string, entries: object[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}

function makeChatEntry(
  model: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  agentName = 'default-agent',
  createdAt?: string,
): object {
  return {
    runId: 'run-1',
    agentName,
    pipelineType: 'main',
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    createdAt,
  };
}

function makeEmbeddingEntry(
  provider: string,
  modelVersion: string,
  tokens: number,
  costUsd: number,
  consumerLabel = 'rfc-0009-tessellation-drift',
): object {
  return {
    runId: 'run-1',
    agentName: consumerLabel,
    pipelineType: 'embeddingTokens',
    model: `${provider}@${modelVersion}`,
    inputTokens: tokens,
    outputTokens: 0,
    totalTokens: tokens,
    costUsd,
    stageName: 'sha256-account',
  };
}

// ── loadCostLedgerJsonl ──────────────────────────────────────────────────────

describe('loadCostLedgerJsonl', () => {
  it('returns empty when the file does not exist', () => {
    expect(loadCostLedgerJsonl(join(tmp, 'absent.jsonl'))).toEqual([]);
  });

  it('classifies embedding entries into a single embeddingTokens row with consumer label', () => {
    const path = join(tmp, 'ledger.jsonl');
    writeJsonl(path, [
      makeEmbeddingEntry('openai-text-embedding-3-small', '2024-01-25', 1000, 0.00002),
    ]);
    const rows = loadCostLedgerJsonl(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      costModel: 'pay-per-token',
      category: 'embeddingTokens',
      source: 'openai-text-embedding-3-small@2024-01-25',
      consumer: 'rfc-0009-tessellation-drift',
      tokens: 1000,
      recordCount: 1,
    });
    expect(rows[0].costUsd).toBeCloseTo(0.00002, 8);
  });

  it('splits chat entries into input + output rows cost-prorated by token share', () => {
    const path = join(tmp, 'ledger.jsonl');
    // 100 input + 100 output + $0.0008 → 50/50 cost split.
    writeJsonl(path, [makeChatEntry('claude-sonnet-4-5', 100, 100, 0.0008, 'developer')]);
    const rows = loadCostLedgerJsonl(path);

    expect(rows).toHaveLength(2);
    const input = rows.find((r) => r.category === 'inputTokens')!;
    const output = rows.find((r) => r.category === 'outputTokens')!;
    expect(input.tokens).toBe(100);
    expect(input.costUsd).toBeCloseTo(0.0004, 8);
    expect(output.tokens).toBe(100);
    expect(output.costUsd).toBeCloseTo(0.0004, 8);
    expect(input.consumer).toBe('developer');
  });

  it('honors --since filter', () => {
    const path = join(tmp, 'ledger.jsonl');
    writeJsonl(path, [
      makeChatEntry('m', 10, 10, 0.001, 'a', '2026-04-01T00:00:00Z'),
      makeChatEntry('m', 20, 20, 0.002, 'a', '2026-06-01T00:00:00Z'),
    ]);
    const rows = loadCostLedgerJsonl(path, { since: new Date('2026-05-01T00:00:00Z') });
    expect(rows.every((r) => r.tokens === 20)).toBe(true);
  });

  it('silently skips blank lines and malformed JSON', () => {
    const path = join(tmp, 'ledger.jsonl');
    writeFileSync(
      path,
      '\n' +
        JSON.stringify(makeChatEntry('m', 100, 100, 0.001)) +
        '\nnot json here\n' +
        JSON.stringify(makeEmbeddingEntry('p', 'v', 50, 0.0001)) +
        '\n',
      'utf-8',
    );
    const rows = loadCostLedgerJsonl(path);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('emits an "other" row when costUsd > 0 but no tokens are present', () => {
    const path = join(tmp, 'ledger.jsonl');
    writeJsonl(path, [
      {
        runId: 'r',
        agentName: 'x',
        pipelineType: 'main',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0.5,
      },
    ]);
    const rows = loadCostLedgerJsonl(path);
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('other');
    expect(rows[0].costUsd).toBe(0.5);
  });
});

// ── subscription cost-conversion ─────────────────────────────────────────────

describe('convertSubscriptionWindowToCost', () => {
  it('cost-converts using the documented per-window math', () => {
    const state = { windowStart: '2026-05-23T00:00:00Z', consumedTokens: 100_000 };
    // 100K of 200K window consumed = 50%.
    // 5h window in 720h month = 144 windows/month.
    // $200/mo / 144 windows = ~$1.389 per window.
    // 50% of $1.389 ~ $0.6944.
    const row = convertSubscriptionWindowToCost(
      state,
      'claude-code-default-tenant.json',
      200,
      5,
      200_000,
    );
    expect(row.costModel).toBe('subscription-quota');
    expect(row.category).toBe('subscription-window');
    expect(row.tokens).toBe(100_000);
    expect(row.costUsd).toBeCloseTo(0.6944, 3);
  });

  it('returns zero cost for a window with zero quota declared (safety)', () => {
    const state = { windowStart: 's', consumedTokens: 1000 };
    const row = convertSubscriptionWindowToCost(state, 'f', 200, 5, 0);
    expect(row.costUsd).toBe(0);
  });
});

describe('loadSubscriptionLedgerDir', () => {
  it('returns empty when the directory does not exist', () => {
    expect(loadSubscriptionLedgerDir(join(tmp, 'no-ledger'), 200, 5, 200_000)).toEqual([]);
  });

  it('emits one row per *.json file in the directory', () => {
    const ledgerDir = join(tmp, '_ledger');
    mkdirSync(ledgerDir);
    writeFileSync(
      join(ledgerDir, 'claude-code-org1.json'),
      JSON.stringify({ windowStart: '2026-05-23T00:00:00Z', consumedTokens: 50_000 }),
    );
    writeFileSync(
      join(ledgerDir, 'codex-org1.json'),
      JSON.stringify({ windowStart: '2026-05-23T00:00:00Z', consumedTokens: 25_000 }),
    );
    writeFileSync(join(ledgerDir, 'README.md'), 'ignore me');

    const rows = loadSubscriptionLedgerDir(ledgerDir, 200, 5, 200_000);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.costModel === 'subscription-quota')).toBe(true);
  });

  it('silently skips unparseable JSON files', () => {
    const ledgerDir = join(tmp, '_ledger');
    mkdirSync(ledgerDir);
    writeFileSync(join(ledgerDir, 'corrupt.json'), '{not json');
    writeFileSync(
      join(ledgerDir, 'ok.json'),
      JSON.stringify({ windowStart: 's', consumedTokens: 1000 }),
    );
    const rows = loadSubscriptionLedgerDir(ledgerDir, 200, 5, 200_000);
    expect(rows).toHaveLength(1);
  });
});

// ── buildUnifiedReport ───────────────────────────────────────────────────────

describe('buildUnifiedReport', () => {
  it('aggregates duplicate buckets within a single source', () => {
    const path = join(tmp, 'ledger.jsonl');
    writeJsonl(path, [
      makeEmbeddingEntry('p', 'v', 100, 0.01),
      makeEmbeddingEntry('p', 'v', 200, 0.02),
      makeEmbeddingEntry('p', 'v', 300, 0.03, 'rfc-0008-ppa-similarity'),
    ]);
    const rows = buildUnifiedReport({ costLedgerJsonl: path });

    expect(rows).toHaveLength(2);
    const driftRow = rows.find((r) => r.consumer === 'rfc-0009-tessellation-drift')!;
    const ppaRow = rows.find((r) => r.consumer === 'rfc-0008-ppa-similarity')!;
    expect(driftRow.tokens).toBe(300);
    expect(driftRow.recordCount).toBe(2);
    expect(driftRow.costUsd).toBeCloseTo(0.03, 8);
    expect(ppaRow.tokens).toBe(300);
    expect(ppaRow.recordCount).toBe(1);
  });

  it('emits both cost-ledger AND subscription-quota rows in one report', () => {
    const ledgerJsonl = join(tmp, 'ledger.jsonl');
    writeJsonl(ledgerJsonl, [makeEmbeddingEntry('p', 'v', 100, 0.01)]);

    const ledgerDir = join(tmp, '_ledger');
    mkdirSync(ledgerDir);
    writeFileSync(
      join(ledgerDir, 'claude-code-x.json'),
      JSON.stringify({ windowStart: 's', consumedTokens: 100_000 }),
    );

    const rows = buildUnifiedReport({ costLedgerJsonl: ledgerJsonl, ledgerDir });
    const costModels = new Set(rows.map((r) => r.costModel));
    expect(costModels.has('pay-per-token')).toBe(true);
    expect(costModels.has('subscription-quota')).toBe(true);
  });

  it('returns rows sorted by (costModel, category, source, consumer)', () => {
    const path = join(tmp, 'ledger.jsonl');
    writeJsonl(path, [
      makeEmbeddingEntry('z-provider', 'v', 1, 0.001),
      makeEmbeddingEntry('a-provider', 'v', 1, 0.001),
      makeChatEntry('sonnet', 100, 0, 0.001),
    ]);
    const rows = buildUnifiedReport({ costLedgerJsonl: path });
    const sources = rows.map((r) => r.source);
    // Embedding entries sorted by source within their bucket.
    const embeddingSources = rows
      .filter((r) => r.category === 'embeddingTokens')
      .map((r) => r.source);
    expect(embeddingSources).toEqual([...embeddingSources].sort());
    expect(sources.length).toBeGreaterThan(0);
  });

  it('honors --since when forwarded through', () => {
    const path = join(tmp, 'ledger.jsonl');
    writeJsonl(path, [
      makeChatEntry('m', 10, 10, 0.001, 'a', '2026-04-01T00:00:00Z'),
      makeChatEntry('m', 20, 20, 0.002, 'a', '2026-06-01T00:00:00Z'),
    ]);
    const rows = buildUnifiedReport({
      costLedgerJsonl: path,
      since: new Date('2026-05-01T00:00:00Z'),
    });
    const totalTokens = rows.reduce((s, r) => s + r.tokens, 0);
    expect(totalTokens).toBe(40); // 20 + 20
  });
});

// ── renderers ────────────────────────────────────────────────────────────────

describe('renderTextTable', () => {
  it('renders an empty message for zero rows', () => {
    expect(renderTextTable([])).toContain('No cost data found');
  });

  it('emits a TOTAL footer summing all rows', () => {
    const rows: UnifiedCostRow[] = [
      {
        costModel: 'pay-per-token',
        category: 'inputTokens',
        source: 'sonnet',
        consumer: 'dev',
        tokens: 100,
        costUsd: 0.01,
        recordCount: 1,
      },
      {
        costModel: 'pay-per-token',
        category: 'outputTokens',
        source: 'sonnet',
        consumer: 'dev',
        tokens: 200,
        costUsd: 0.02,
        recordCount: 1,
      },
    ];
    const out = renderTextTable(rows);
    expect(out).toContain('TOTAL');
    expect(out).toContain('300');
    expect(out).toContain('0.03');
  });
});

describe('renderCsv', () => {
  it('produces parseable CSV with header', () => {
    const rows: UnifiedCostRow[] = [
      {
        costModel: 'pay-per-token',
        category: 'embeddingTokens',
        source: 'openai@v',
        consumer: 'drift',
        tokens: 100,
        costUsd: 0.01,
        recordCount: 1,
      },
    ];
    const csv = renderCsv(rows);
    expect(csv.split('\n')[0]).toBe(
      'costModel,category,source,consumer,tokens,costUsd,recordCount',
    );
    expect(csv).toContain('pay-per-token,embeddingTokens,openai@v,drift,100,0.010000,1');
  });

  it('quotes values containing commas/quotes/newlines', () => {
    const rows: UnifiedCostRow[] = [
      {
        costModel: 'pay-per-token',
        category: 'other',
        source: 'a,b',
        consumer: 'has "quote"',
        tokens: 0,
        costUsd: 0,
        recordCount: 1,
      },
    ];
    const csv = renderCsv(rows);
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"has ""quote"""');
  });
});

// ── CLI router ───────────────────────────────────────────────────────────────

describe('runCostReportCli', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('exits with non-zero when no input source is supplied', async () => {
    process.argv = ['node', 'cli-cost-report'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit-1');
    }) as unknown as typeof process.exit);
    await expect(runCostReportCli()).rejects.toThrow('exit-1');
    exitSpy.mockRestore();
  });

  it('produces JSON output when --format=json', async () => {
    const path = join(tmp, 'ledger.jsonl');
    writeJsonl(path, [makeEmbeddingEntry('p', 'v', 100, 0.01)]);
    const stdoutChunks: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as unknown as typeof process.stdout.write);

    process.argv = ['node', 'cli-cost-report', '--cost-ledger-jsonl', path, '--format', 'json'];
    await runCostReportCli();
    const out = stdoutChunks.join('');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].category).toBe('embeddingTokens');
    writeSpy.mockRestore();
  });

  it('exports SUBSCRIPTION_DEFAULTS so operators can override them visibly', () => {
    expect(SUBSCRIPTION_DEFAULTS.monthlyUsd).toBe(200);
    expect(SUBSCRIPTION_DEFAULTS.windowHours).toBe(5);
    expect(SUBSCRIPTION_DEFAULTS.windowTokens).toBe(200_000);
  });
});

// ── vitest spy import (kept at end so the top reads cleanly) ─────────────────

import { vi } from 'vitest';
