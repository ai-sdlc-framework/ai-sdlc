/**
 * RFC-0035 Phase 10 (AISDLC-294) — research-subagent unit tests.
 *
 * Hermetic: stub invoker, tmpdir for artifact writes. Asserts gate logic
 * + persistence layer + SubscriptionLedger debit (AC#5).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SubscriptionLedgerEntry,
  SubscriptionLedgerWriter,
} from '../classifier/substrate/index.js';
import type { Decision, StageCOutput } from './decision-record.js';
import {
  readResearchArtifacts,
  RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD,
  resolveResearchSubagentThreshold,
  runResearchSubagent,
  shouldInvokeResearchSubagent,
  writeResearchArtifact,
} from './research-subagent.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function baseDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'Decision',
    metadata: {
      id: 'DEC-0294',
      source: 'rfc-open-question',
      scope: 'rfc:RFC-0035',
      created: '2026-05-27T10:00:00.000Z',
      updated: '2026-05-27T10:00:00.000Z',
    },
    spec: {
      summary: 'Pick a research subagent transport',
      body: 'Should research findings be ephemeral or persisted?',
      reversible: true,
      options: [
        { id: 'opt-a', description: 'Persist to disk' },
        { id: 'opt-b', description: 'Stream to TUI only' },
      ],
    },
    status: { lifecycle: 'open' },
    decisionLog: [],
    ...overrides,
  };
}

function stageC(overrides: Partial<StageCOutput> = {}): StageCOutput {
  return {
    corpusEntryId: 'corpus-1',
    effectiveThreshold: 0.7,
    model: 'claude-haiku-4-5',
    metBehindThreshold: false,
    llmAnswerEligible: false,
    recommendation: {
      optionId: 'opt-a',
      confidence: 0.45,
      rationale: 'weak signal',
    },
    alternativesConsidered: [],
    counterArguments: [],
    subDecisionsImplied: [],
    ...overrides,
  };
}

// ── threshold resolution ─────────────────────────────────────────────────────

describe('resolveResearchSubagentThreshold', () => {
  it('returns default when field is missing', () => {
    expect(resolveResearchSubagentThreshold({})).toBe(
      RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD,
    );
  });

  it('returns default when field is non-finite', () => {
    expect(resolveResearchSubagentThreshold({ researchSubagentConfidenceThreshold: NaN })).toBe(
      RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD,
    );
  });

  it('clamps out-of-range with stderr warning', () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(resolveResearchSubagentThreshold({ researchSubagentConfidenceThreshold: 0 })).toBe(
      RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD,
    );
    expect(resolveResearchSubagentThreshold({ researchSubagentConfidenceThreshold: 1.5 })).toBe(
      RESEARCH_SUBAGENT_DEFAULT_CONFIDENCE_THRESHOLD,
    );
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('returns supplied value when valid', () => {
    expect(resolveResearchSubagentThreshold({ researchSubagentConfidenceThreshold: 0.55 })).toBe(
      0.55,
    );
  });
});

// ── gate ─────────────────────────────────────────────────────────────────────

describe('shouldInvokeResearchSubagent', () => {
  it('skips when Stage C is missing', () => {
    const r = shouldInvokeResearchSubagent({ stageC: null, threshold: 0.6 });
    expect(r.invoke).toBe(false);
    expect(r.skipReason).toBe('stage-c-missing');
  });

  it('skips when Stage C errored', () => {
    const r = shouldInvokeResearchSubagent({
      stageC: stageC({ error: '(invoker error)' }),
      threshold: 0.6,
    });
    expect(r.invoke).toBe(false);
    expect(r.skipReason).toBe('stage-c-error');
  });

  it('skips when recommendation confidence is non-finite', () => {
    const r = shouldInvokeResearchSubagent({
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: NaN, rationale: 'x' },
      }),
      threshold: 0.6,
    });
    expect(r.invoke).toBe(false);
    expect(r.skipReason).toBe('recommendation-missing');
  });

  it('skips when confidence is at or above threshold', () => {
    const r = shouldInvokeResearchSubagent({
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: 0.6, rationale: 'x' },
      }),
      threshold: 0.6,
    });
    expect(r.invoke).toBe(false);
    expect(r.skipReason).toBe('above-threshold');
    expect(r.observedConfidence).toBe(0.6);
  });

  it('invokes when confidence is strictly below threshold', () => {
    const r = shouldInvokeResearchSubagent({
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: 0.45, rationale: 'x' },
      }),
      threshold: 0.6,
    });
    expect(r.invoke).toBe(true);
    expect(r.observedConfidence).toBe(0.45);
  });
});

// ── persistence ──────────────────────────────────────────────────────────────

describe('writeResearchArtifact / readResearchArtifacts', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aisdlc-294-research-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes findings under .ai-sdlc/_decisions/research/', () => {
    const result = writeResearchArtifact({
      workDir,
      decisionId: 'DEC-0294',
      findingsMarkdown: '## Findings\n\nKubernetes uses X.\n',
      now: new Date('2026-05-27T12:34:56.789Z'),
      model: 'claude-haiku-4-5',
      observedConfidence: 0.42,
    });
    expect(result.path).toMatch(
      /\.ai-sdlc\/_decisions\/research\/DEC-0294-2026-05-27T12-34-56Z\.md$/,
    );
    const written = readFileSync(result.path, 'utf8');
    expect(written).toContain('<!-- decision: DEC-0294 -->');
    expect(written).toContain('<!-- model: claude-haiku-4-5 -->');
    expect(written).toContain('<!-- observedStageCConfidence: 0.420 -->');
    expect(written).toContain('## Findings');
  });

  it('readResearchArtifacts returns empty when dir missing', () => {
    expect(readResearchArtifacts(workDir, 'DEC-0294')).toEqual([]);
  });

  it('readResearchArtifacts returns artifacts newest-first', () => {
    writeResearchArtifact({
      workDir,
      decisionId: 'DEC-0294',
      findingsMarkdown: 'first',
      now: new Date('2026-05-27T10:00:00.000Z'),
    });
    writeResearchArtifact({
      workDir,
      decisionId: 'DEC-0294',
      findingsMarkdown: 'second',
      now: new Date('2026-05-27T11:00:00.000Z'),
    });
    const arts = readResearchArtifacts(workDir, 'DEC-0294');
    expect(arts).toHaveLength(2);
    expect(arts[0].findingsMarkdown.trim()).toBe('second');
    expect(arts[1].findingsMarkdown.trim()).toBe('first');
  });

  it('readResearchArtifacts filters by decision id prefix', () => {
    writeResearchArtifact({
      workDir,
      decisionId: 'DEC-0294',
      findingsMarkdown: 'mine',
      now: new Date('2026-05-27T10:00:00.000Z'),
    });
    writeResearchArtifact({
      workDir,
      decisionId: 'DEC-0295',
      findingsMarkdown: 'other',
      now: new Date('2026-05-27T11:00:00.000Z'),
    });
    const arts = readResearchArtifacts(workDir, 'DEC-0294');
    expect(arts).toHaveLength(1);
    expect(arts[0].findingsMarkdown.trim()).toBe('mine');
  });

  it('readResearchArtifacts strips header comments', () => {
    writeResearchArtifact({
      workDir,
      decisionId: 'DEC-0294',
      findingsMarkdown: '## Findings\n\nbody content',
      now: new Date('2026-05-27T10:00:00.000Z'),
    });
    const arts = readResearchArtifacts(workDir, 'DEC-0294');
    expect(arts[0].findingsMarkdown.startsWith('## Findings')).toBe(true);
    expect(arts[0].findingsMarkdown).not.toContain('<!--');
  });
});

// ── runResearchSubagent (integration) ────────────────────────────────────────

describe('runResearchSubagent', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aisdlc-294-runner-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns invoked:false when gate skips', async () => {
    const stub = vi.fn();
    const r = await runResearchSubagent({
      decision: baseDecision(),
      stageC: null,
      threshold: 0.6,
      invoker: stub,
      workDir,
    });
    expect(r.invoked).toBe(false);
    expect(r.skipReason).toBe('stage-c-missing');
    expect(stub).not.toHaveBeenCalled();
    expect(readdirSync(workDir)).not.toContain('.ai-sdlc');
  });

  it('runs invoker, persists artifact, debits ledger when below threshold', async () => {
    const ledger: SubscriptionLedgerEntry[] = [];
    const ledgerWriter: SubscriptionLedgerWriter = (e) => {
      ledger.push(e);
    };
    const invoker = vi.fn().mockResolvedValue({
      findingsMarkdown: '## Findings\n\nResearch body.',
      model: 'claude-sonnet-4-5',
      inputTokens: 1500,
      outputTokens: 800,
    });

    const r = await runResearchSubagent({
      decision: baseDecision(),
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: 0.42, rationale: 'weak' },
      }),
      threshold: 0.6,
      invoker,
      workDir,
      ledgerWriter,
      now: new Date('2026-05-27T15:00:00.000Z'),
    });

    expect(r.invoked).toBe(true);
    expect(r.observedConfidence).toBe(0.42);
    expect(r.artifact?.path).toMatch(/DEC-0294-2026-05-27T15-00-00Z\.md$/);
    expect(r.response?.model).toBe('claude-sonnet-4-5');

    // AC#5 — ledger debit
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      taskType: 'decision-recommendation',
      model: 'claude-sonnet-4-5',
      inputTokens: 1500,
      outputTokens: 800,
    });
    expect(r.ledgerEntry).toEqual(ledger[0]);

    // invoker received option list + recommendation
    expect(invoker).toHaveBeenCalledOnce();
    const arg = invoker.mock.calls[0][0];
    expect(arg.decisionId).toBe('DEC-0294');
    expect(arg.options).toHaveLength(2);
    expect(arg.recommendation.confidence).toBe(0.42);
  });

  it('handles invoker errors gracefully', async () => {
    const invoker = vi.fn().mockRejectedValue(new Error('LLM timeout'));
    const r = await runResearchSubagent({
      decision: baseDecision(),
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: 0.45, rationale: 'x' },
      }),
      threshold: 0.6,
      invoker,
      workDir,
    });
    expect(r.invoked).toBe(false);
    expect(r.skipReason).toBe('invoker-error');
    expect(r.observedConfidence).toBe(0.45);
    expect(r.artifact).toBeUndefined();
  });

  it('treats missing token counts as zero in ledger entry', async () => {
    const ledger: SubscriptionLedgerEntry[] = [];
    const invoker = vi.fn().mockResolvedValue({
      findingsMarkdown: 'body',
      model: 'claude-haiku-4-5',
      // no inputTokens / outputTokens
    });
    await runResearchSubagent({
      decision: baseDecision(),
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: 0.45, rationale: 'x' },
      }),
      threshold: 0.6,
      invoker,
      workDir,
      ledgerWriter: (e) => {
        ledger.push(e);
      },
    });
    expect(ledger[0].inputTokens).toBe(0);
    expect(ledger[0].outputTokens).toBe(0);
  });

  it('swallows ledger-writer failures (artifact still persisted)', async () => {
    const invoker = vi.fn().mockResolvedValue({
      findingsMarkdown: 'body',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 200,
    });
    const r = await runResearchSubagent({
      decision: baseDecision(),
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: 0.45, rationale: 'x' },
      }),
      threshold: 0.6,
      invoker,
      workDir,
      ledgerWriter: () => {
        throw new Error('ledger boom');
      },
    });
    expect(r.invoked).toBe(true);
    expect(r.artifact).toBeDefined();
  });

  it('passes operator framing through to invoker', async () => {
    const invoker = vi.fn().mockResolvedValue({
      findingsMarkdown: 'body',
      model: 'claude-haiku-4-5',
    });
    await runResearchSubagent({
      decision: baseDecision(),
      stageC: stageC({
        recommendation: { optionId: 'opt-a', confidence: 0.45, rationale: 'x' },
      }),
      threshold: 0.6,
      invoker,
      workDir,
      framing: 'Focus on cost trade-offs',
    });
    expect(invoker.mock.calls[0][0].framing).toBe('Focus on cost trade-offs');
  });
});
