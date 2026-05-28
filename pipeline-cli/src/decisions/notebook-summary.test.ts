/**
 * RFC-0035 Phase 10 (AISDLC-294) — notebook-summary unit tests.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  SubscriptionLedgerEntry,
  SubscriptionLedgerWriter,
} from '../classifier/substrate/index.js';
import type { Decision, StageCOutput } from './decision-record.js';
import {
  DECISION_NOTEBOOK_SUMMARIES_FLAG,
  isNotebookSummariesEnabled,
  notebookSummariesDisabledMessage,
  readNotebookSummary,
  runNotebookSummary,
  writeNotebookSummary,
} from './notebook-summary.js';

function baseDecision(): Decision {
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
      summary: 'Pick a summary surface',
      body: 'Test the notebook summary path',
      reversible: true,
      options: [{ id: 'opt-a', description: 'Persist' }],
    },
    status: { lifecycle: 'open' },
    decisionLog: [],
  };
}

describe('isNotebookSummariesEnabled', () => {
  it('returns false when unset', () => {
    expect(isNotebookSummariesEnabled({})).toBe(false);
  });

  it('returns false on falsy values', () => {
    for (const v of ['off', '0', 'false', 'no', 'disabled', '']) {
      expect(
        isNotebookSummariesEnabled({ [DECISION_NOTEBOOK_SUMMARIES_FLAG]: v } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });

  it('returns true on truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'experimental', 'enabled', 'ON']) {
      expect(
        isNotebookSummariesEnabled({ [DECISION_NOTEBOOK_SUMMARIES_FLAG]: v } as NodeJS.ProcessEnv),
      ).toBe(true);
    }
  });
});

describe('notebookSummariesDisabledMessage', () => {
  it('mentions the flag name', () => {
    expect(notebookSummariesDisabledMessage()).toContain(DECISION_NOTEBOOK_SUMMARIES_FLAG);
  });
});

describe('writeNotebookSummary / readNotebookSummary', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aisdlc-294-summary-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes single-file per decision and reads it back', () => {
    const r = writeNotebookSummary({
      workDir,
      decisionId: 'DEC-0294',
      summaryMarkdown: '## TL;DR\n\n- Persist findings\n',
      model: 'claude-sonnet-4-5',
      now: new Date('2026-05-27T16:00:00.000Z'),
    });
    expect(r.path).toMatch(/\.ai-sdlc\/_decisions\/summaries\/DEC-0294\.md$/);
    expect(readFileSync(r.path, 'utf8')).toContain('<!-- model: claude-sonnet-4-5 -->');

    const back = readNotebookSummary(workDir, 'DEC-0294');
    expect(back?.path).toBe(r.path);
    expect(back?.summaryMarkdown).toContain('## TL;DR');
    expect(back?.summaryMarkdown).not.toContain('<!--');
  });

  it('overwrites previous summary (single-file convention)', () => {
    writeNotebookSummary({
      workDir,
      decisionId: 'DEC-0294',
      summaryMarkdown: 'first',
      now: new Date('2026-05-27T10:00:00.000Z'),
    });
    writeNotebookSummary({
      workDir,
      decisionId: 'DEC-0294',
      summaryMarkdown: 'second',
      now: new Date('2026-05-27T11:00:00.000Z'),
    });
    expect(readNotebookSummary(workDir, 'DEC-0294')?.summaryMarkdown.trim()).toBe('second');
  });

  it('readNotebookSummary returns null when missing', () => {
    expect(readNotebookSummary(workDir, 'DEC-9999')).toBeNull();
  });
});

describe('runNotebookSummary', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'aisdlc-294-runner-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('skips when feature flag is off (default)', async () => {
    const invoker = vi.fn();
    const r = await runNotebookSummary({
      decision: baseDecision(),
      invoker,
      workDir,
      forceEnabled: false,
    });
    expect(r.generated).toBe(false);
    expect(r.skipReason).toBe('disabled');
    expect(invoker).not.toHaveBeenCalled();
  });

  it('generates + persists + debits ledger when enabled', async () => {
    const ledger: SubscriptionLedgerEntry[] = [];
    const ledgerWriter: SubscriptionLedgerWriter = (e) => {
      ledger.push(e);
    };
    const invoker = vi.fn().mockResolvedValue({
      summaryMarkdown: '## TL;DR\n- short',
      model: 'claude-haiku-4-5',
      inputTokens: 800,
      outputTokens: 200,
    });
    const r = await runNotebookSummary({
      decision: baseDecision(),
      invoker,
      workDir,
      forceEnabled: true,
      ledgerWriter,
      now: new Date('2026-05-27T17:00:00.000Z'),
    });
    expect(r.generated).toBe(true);
    expect(r.artifact?.path).toMatch(/DEC-0294\.md$/);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].model).toBe('claude-haiku-4-5');
  });

  it('returns invoker-error when invoker throws', async () => {
    const invoker = vi.fn().mockRejectedValue(new Error('boom'));
    const r = await runNotebookSummary({
      decision: baseDecision(),
      invoker,
      workDir,
      forceEnabled: true,
    });
    expect(r.generated).toBe(false);
    expect(r.skipReason).toBe('invoker-error');
  });

  it('forwards Stage C recommendation when present', async () => {
    const invoker = vi.fn().mockResolvedValue({
      summaryMarkdown: 'body',
      model: 'm',
    });
    const decision = baseDecision();
    const stageC: StageCOutput = {
      corpusEntryId: null,
      effectiveThreshold: 0.7,
      model: 'm',
      metBehindThreshold: true,
      llmAnswerEligible: true,
      recommendation: { optionId: 'opt-a', confidence: 0.8, rationale: 'r' },
      alternativesConsidered: [],
      counterArguments: [],
      subDecisionsImplied: [],
    };
    decision.status = { ...decision.status, evaluation: { stageC } };
    await runNotebookSummary({
      decision,
      invoker,
      workDir,
      forceEnabled: true,
    });
    expect(invoker.mock.calls[0][0].recommendation).toEqual({
      optionId: 'opt-a',
      confidence: 0.8,
      rationale: 'r',
    });
  });

  it('swallows ledger-writer failures', async () => {
    const invoker = vi.fn().mockResolvedValue({
      summaryMarkdown: 'body',
      model: 'm',
      inputTokens: 1,
      outputTokens: 1,
    });
    const r = await runNotebookSummary({
      decision: baseDecision(),
      invoker,
      workDir,
      forceEnabled: true,
      ledgerWriter: () => {
        throw new Error('boom');
      },
    });
    expect(r.generated).toBe(true);
  });
});
