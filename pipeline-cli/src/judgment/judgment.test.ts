import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evaluateJudgment,
  resolveJudgmentConfig,
  type JudgmentDefinition,
  type JudgmentEvaluationRecord,
} from '@ai-sdlc/reference';
import { buildJudgmentContext, resolveJudgmentArtifactsDir } from './context.js';
import { createJudgmentEventsSink } from './events-sink.js';
import type { OrchestratorEvent } from '../orchestrator/events.js';

interface Input {
  text: string;
}
const def = {
  id: 'ctx.test',
  version: 1,
  egressClass: 'work-item-text',
  direction: 'tighten-only',
  riskClass: 'seam',
  fallback: 'pending',
  buildState: (i: Input) => ({ text: i.text }),
  questions: () => ({ q1: { type: 'noul', instructions: 'ok?' } }),
  compose: () => ({ kind: 'act', decision: true }),
} as JudgmentDefinition<Input, boolean>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judgment-ctx-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseRec(over: Partial<JudgmentEvaluationRecord> = {}): JudgmentEvaluationRecord {
  return {
    ts: '2026-10-01T00:00:00Z',
    judgmentId: 'dor.stage-b',
    version: 1,
    consumerLabel: 'dor.stage-b',
    questionSetHash: null,
    stateHash: null,
    provider: 'jev',
    providerModelKey: null,
    modelVersion: null,
    mode: 'shadow',
    answers: null,
    thresholds: null,
    outcome: { kind: 'abstain', reason: 'disabled' },
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    called: false,
    costUsd: null,
    cacheHit: false,
    ...over,
  };
}

describe('buildJudgmentContext', () => {
  it('returns a usable context with the layer disabled: abstains, writes nothing', async () => {
    const ctx = buildJudgmentContext({
      workDir: dir,
      artifactsDir: join(dir, 'art'),
      env: {},
      loader: { readBaseConfig: () => null },
      taskId: 'T-1',
    });
    expect(ctx.config.provider).toBeUndefined();
    expect(ctx.sinks).toBeUndefined();
    const out = await evaluateJudgment(def, { text: 'x' }, ctx);
    expect(out).toEqual({ kind: 'abstain', reason: 'disabled' });
    expect(existsSync(join(dir, 'art'))).toBe(false);
  });

  it('with a provider configured wires the log and events sinks and the cache', async () => {
    const config = resolveJudgmentConfig({
      spec: { provider: 'jev', model: 'jev-1.13.0', defaults: { cache: true } },
    });
    const events: OrchestratorEvent[] = [];
    const ctx = buildJudgmentContext({
      config,
      artifactsDir: dir,
      env: {},
      sourceKind: 'backlog',
      consumerLabel: 'c',
      now: () => new Date('2026-10-01T00:00:00Z'),
      events: { write: (e) => void events.push(e), reportedUnavailable: new Set() },
      fetchImpl: (async () => {
        throw new Error('network must not be used');
      }) as typeof fetch,
    });
    expect(ctx.sinks).toHaveLength(2);
    expect(ctx.cache).toBeDefined();
    expect(ctx.sourceKind).toBe('backlog');
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const out = await evaluateJudgment(def, { text: 'x' }, ctx);
      expect(out).toEqual({ kind: 'abstain', reason: 'disabled' });
    } finally {
      if (prev !== undefined) process.env.TYPESAFE_API_KEY = prev;
    }
    expect(events.map((e) => e.type)).toEqual(['JudgmentProviderUnavailable']);
    const files = readdirSync(join(dir, '_judgment'));
    expect(files.some((f) => f.startsWith('log-2026-10-01'))).toBe(true);
    expect(
      readFileSync(join(dir, '_judgment', files.find((f) => f.startsWith('log-'))!), 'utf8'),
    ).toContain('"judgmentId":"ctx.test"');
  });

  it('omits the cache when disabled in config and ignores unknown providers', () => {
    const ctx = buildJudgmentContext({
      config: resolveJudgmentConfig({ spec: { provider: 'nonexistent' } }),
      artifactsDir: dir,
    });
    expect(ctx.cache).toBeUndefined();
    expect(ctx.sinks).toHaveLength(2);
  });

  it('resolves the artifacts dir like the rest of pipeline-cli', () => {
    expect(resolveJudgmentArtifactsDir({ artifactsDir: '/a' })).toBe('/a');
    expect(resolveJudgmentArtifactsDir({ env: { ARTIFACTS_DIR: '/b' } })).toBe('/b');
    expect(resolveJudgmentArtifactsDir({ env: {} })).toBe(join(process.cwd(), 'artifacts'));
  });
});

describe('createJudgmentEventsSink', () => {
  it('emits JudgmentEscalated for escalations, with a redacted, bounded reason', () => {
    const events: OrchestratorEvent[] = [];
    const sink = createJudgmentEventsSink({
      write: (e) => void events.push(e),
      now: () => new Date('2026-10-01T00:00:00Z'),
    });
    sink.record(
      baseRec({
        taskId: 'T-9',
        outcome: {
          kind: 'escalate',
          to: 'operator',
          reason: `${'x'.repeat(500)} ghp_abcdefghijklmnopqrstuvwxyz0123456789`,
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'JudgmentEscalated',
      judgmentId: 'dor.stage-b',
      escalateTo: 'operator',
      taskId: 'T-9',
    });
    expect((events[0].reason as string).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(events[0])).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('emits JudgmentProviderUnavailable once per reason per process', () => {
    const events: OrchestratorEvent[] = [];
    const sink = createJudgmentEventsSink({
      write: (e) => void events.push(e),
      reportedUnavailable: new Set(),
    });
    const r = baseRec({ providerUnavailableReason: 'provider-unavailable', taskId: 'T' });
    sink.record(r);
    sink.record(r);
    sink.record(baseRec({ providerUnavailableReason: 'provider-not-registered', provider: null }));
    sink.record(baseRec());
    expect(events.map((e) => e.reason)).toEqual([
      'provider-unavailable',
      'provider-not-registered',
    ]);
    expect(events[0].provider).toBe('jev');
    expect(events[1]).not.toHaveProperty('provider');
  });

  it('swallows writer failures and uses the real writer by default', () => {
    const sink = createJudgmentEventsSink({
      write: () => {
        throw new Error('disk');
      },
    });
    expect(() =>
      sink.record(baseRec({ outcome: { kind: 'escalate', to: 'llm', reason: 'r' } })),
    ).not.toThrow();
    const def2 = createJudgmentEventsSink({ isEnabled: () => false });
    expect(() =>
      def2.record(baseRec({ outcome: { kind: 'escalate', to: 'llm', reason: 'r' } })),
    ).not.toThrow();
  });
});
