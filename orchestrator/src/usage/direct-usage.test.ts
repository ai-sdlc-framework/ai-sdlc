import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelCalls, type ModelCallRecord } from '@ai-sdlc/reference';
import { ReviewAgentRunner } from '../runners/review-agent.js';
import { SecurityTriageRunner } from '../runners/security-triage.js';
import { OpenAITextEmbedding3Small } from '../embedding/adapters/openai-text-embedding-3-small.js';
import { anthropicTokens, reportApiKeyCall } from './direct-usage.js';
import type { AgentContext } from '../runners/types.js';

let tmp: string;
let usageDir: string;
let unwritableDir: string;

function ctx(): AgentContext {
  return {
    issueId: 'PR-7',
    issueTitle: 't',
    issueBody: 'b',
    workDir: '/tmp',
    branch: 'x',
    constraints: { maxFilesPerChange: 0, requireTests: false, blockedPaths: [] },
  };
}

async function ledger(dir = usageDir): Promise<ModelCallRecord[]> {
  const out: ModelCallRecord[] = [];
  for await (const r of readModelCalls({}, { dir })) out.push(r);
  return out;
}

function anthropicFetch(verdict: unknown, usage: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: JSON.stringify(verdict) }],
      usage,
      model: 'claude-sonnet-4-5-20250929',
    }),
    text: async () => '',
  }));
}

const REVIEW_VERDICT = { approved: true, findings: [], summary: 'ok' };
const TRIAGE_VERDICT = { riskScore: 1, reasoning: 'fine', flags: [], recommendation: 'accept' };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'direct-usage-'));
  usageDir = join(tmp, 'usage');
  // A file where a directory is expected makes every write fail.
  writeFileSync(join(tmp, 'blocker'), 'x');
  unwritableDir = join(tmp, 'blocker', 'usage');
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

describe('review runner reporting', () => {
  it('writes one api-key record with the provider-reported counts', async () => {
    vi.stubGlobal(
      'fetch',
      anthropicFetch(REVIEW_VERDICT, {
        input_tokens: 120,
        output_tokens: 33,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 7,
      }),
    );
    const runner = new ReviewAgentRunner({ reviewType: 'critic', apiKey: 'k', usageDir });
    const res = await runner.run(ctx());
    expect(res.success).toBe(true);
    const recs = await ledger();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      harness: 'direct',
      billingPool: 'api-key',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      agentRole: 'review-critic',
      scope: 'framework',
      taskId: 'PR-7',
    });
    expect(recs[0].tokens).toMatchObject({
      input: 120,
      output: 33,
      cacheRead: 40,
      cacheWrite5m: 7,
    });
  });

  it('returns the normal result when the usage directory is unwritable', async () => {
    vi.stubGlobal('fetch', anthropicFetch(REVIEW_VERDICT, { input_tokens: 1, output_tokens: 1 }));
    const runner = new ReviewAgentRunner({
      reviewType: 'testing',
      apiKey: 'k',
      usageDir: unwritableDir,
    });
    const res = await runner.run(ctx());
    expect(res.success).toBe(true);
    expect(res.tokenUsage).toMatchObject({ inputTokens: 1, outputTokens: 1 });
  });

  it('reports nothing when the provider returns no usage', async () => {
    vi.stubGlobal('fetch', anthropicFetch(REVIEW_VERDICT, undefined));
    const runner = new ReviewAgentRunner({ reviewType: 'testing', apiKey: 'k', usageDir });
    expect((await runner.run(ctx())).success).toBe(true);
    expect(await ledger()).toHaveLength(0);
  });
});

describe('security triage reporting', () => {
  it('writes one record per API call', async () => {
    vi.stubGlobal('fetch', anthropicFetch(TRIAGE_VERDICT, { input_tokens: 50, output_tokens: 9 }));
    const runner = new SecurityTriageRunner({ apiKey: 'k', usageDir });
    const res = await runner.run(ctx());
    expect(res.success).toBe(true);
    const recs = await ledger();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      billingPool: 'api-key',
      agentRole: 'security-triage',
      taskId: 'PR-7',
    });
    expect(recs[0].tokens).toMatchObject({ input: 50, output: 9 });
  });

  it('returns the normal result when the usage directory is unwritable', async () => {
    vi.stubGlobal('fetch', anthropicFetch(TRIAGE_VERDICT, { input_tokens: 5, output_tokens: 2 }));
    const runner = new SecurityTriageRunner({ apiKey: 'k', usageDir: unwritableDir });
    const res = await runner.run(ctx());
    expect(res.success).toBe(true);
    expect(res.tokenUsage).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });
});

describe('embedding adapter reporting', () => {
  const originalKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test';
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  const vec = () => new Array(1536).fill(0.1);
  const okFetch = (total: number) =>
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ embedding: vec(), index: 0 }],
        usage: { prompt_tokens: total, total_tokens: total },
      }),
    }));

  it('writes one record per embed call with the total in input', async () => {
    vi.stubGlobal('fetch', okFetch(321));
    const adapter = new OpenAITextEmbedding3Small(undefined, { usageDir });
    const v = await adapter.embed('hello');
    expect(v).toHaveLength(1536);
    await adapter.embedBatch(['a']);
    const recs = await ledger();
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({
      provider: 'openai',
      model: 'text-embedding-3-small',
      billingPool: 'api-key',
      agentRole: 'embedding',
    });
    expect(recs[0].tokens).toMatchObject({ input: 321, output: 0 });
  });

  it('returns the normal result when the usage directory is unwritable', async () => {
    vi.stubGlobal('fetch', okFetch(10));
    const cb = vi.fn();
    const adapter = new OpenAITextEmbedding3Small(cb, { usageDir: unwritableDir });
    expect(await adapter.embed('hello')).toHaveLength(1536);
    expect(cb).toHaveBeenCalledOnce();
  });
});

describe('direct-usage helpers', () => {
  it('maps Anthropic usage with missing fields to zero', () => {
    expect(anthropicTokens({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0 });
  });

  it('never throws, even for an invalid report', () => {
    expect(() =>
      reportApiKeyCall({
        provider: '',
        model: '',
        tokens: { input: -1 },
        agentRole: 'x',
        usageDir: unwritableDir,
      }),
    ).not.toThrow();
  });
});
