/**
 * Tests for the public `classify()` API (AISDLC-321 AC-1, AC-2, AC-3, AC-9).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classify } from './classify.js';
import { FakeLlmInvoker } from './fake-invoker.js';
import { readCorpus, resolveCorpusFilePath } from './corpus.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, DEFAULT_HAIKU_MODEL } from './config.js';
import type { SubscriptionLedgerEntry } from './types.js';

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), 'aisdlc-321-classify-'));
}

describe('classify — happy path', () => {
  it('returns a decision that meets the default 0.7 threshold (AC-3)', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.82,
          reasoning: 'small fix',
          inputTokens: 100,
          outputTokens: 30,
        },
      });
      const result = await classify({ text: 'rename a variable' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
      });
      expect(result.classification).toBe('quick-fix-task');
      expect(result.confidence).toBe(0.82);
      expect(result.metBehindThreshold).toBe(true);
      expect(result.effectiveThreshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
      expect(result.model).toBe(DEFAULT_HAIKU_MODEL);
      expect(result.corpusEntryId).not.toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('flags low-confidence decisions as below threshold (AC-3)', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-severity': {
          classification: 'medium',
          confidence: 0.5,
          reasoning: 'genuinely unclear',
          inputTokens: 100,
          outputTokens: 30,
        },
      });
      const result = await classify({ text: 'maybe a problem' }, 'capture-severity', {
        invoker,
        repoRoot: repo,
      });
      expect(result.metBehindThreshold).toBe(false);
      expect(result.classification).toBe('medium');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classify — per-call + per-org threshold overrides (AC-3)', () => {
  it('per-call threshold overrides the default', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.75,
          reasoning: 'r',
          inputTokens: 100,
          outputTokens: 30,
        },
      });
      const lax = await classify({ text: 'x' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        threshold: 0.5,
      });
      const strict = await classify({ text: 'y' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        threshold: 0.9,
      });
      expect(lax.metBehindThreshold).toBe(true);
      expect(lax.effectiveThreshold).toBe(0.5);
      expect(strict.metBehindThreshold).toBe(false);
      expect(strict.effectiveThreshold).toBe(0.9);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('per-org config from capture-config.yaml overrides default', async () => {
    const repo = makeRepo();
    try {
      mkdirSync(join(repo, '.ai-sdlc'), { recursive: true });
      writeFileSync(
        join(repo, '.ai-sdlc', 'capture-config.yaml'),
        'classifier:\n  threshold: 0.85\n',
        'utf8',
      );
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.75,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      const result = await classify({ text: 'x' }, 'capture-triage', { invoker, repoRoot: repo });
      expect(result.effectiveThreshold).toBe(0.85);
      expect(result.metBehindThreshold).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classify — model resolution (AC-2)', () => {
  it('uses the default Haiku model when nothing overrides', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': (req) => ({
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: `seen model: ${req.model}`,
          inputTokens: 0,
          outputTokens: 0,
        }),
      });
      const result = await classify({ text: 'x' }, 'capture-triage', { invoker, repoRoot: repo });
      expect(result.model).toBe(DEFAULT_HAIKU_MODEL);
      expect(result.reasoning).toContain(DEFAULT_HAIKU_MODEL);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('honours per-call model override', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': (req) => ({
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: `model: ${req.model}`,
          inputTokens: 0,
          outputTokens: 0,
        }),
      });
      const result = await classify({ text: 'x' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        model: 'claude-sonnet-4-5',
      });
      expect(result.model).toBe('claude-sonnet-4-5');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classify — corpus capture (AC-4)', () => {
  it('appends one corpus entry per call', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        default: {
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      await classify({ text: 'a' }, 'capture-triage', { invoker, repoRoot: repo });
      await classify({ text: 'b' }, 'capture-triage', { invoker, repoRoot: repo });
      const corpus = readCorpus(repo, 'capture-triage');
      expect(corpus).toHaveLength(2);
      expect(corpus.map((e) => e.input.text)).toEqual(['a', 'b']);
      expect(corpus.every((e) => e.polarity === 'pending')).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('skipCorpus opt disables corpus write', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        default: {
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      const result = await classify({ text: 'a' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        skipCorpus: true,
      });
      expect(result.corpusEntryId).toBeNull();
      expect(readCorpus(repo, 'capture-triage')).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes to <repo>/.ai-sdlc/classifier-corpus/<task-type>.yaml by default', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        default: {
          classification: 'is-capture',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      await classify({ text: 'a' }, 'pr-comment-is-capture', { invoker, repoRoot: repo });
      const expectedPath = resolveCorpusFilePath(repo, 'pr-comment-is-capture');
      expect(expectedPath).toBe(
        join(repo, '.ai-sdlc', 'classifier-corpus', 'pr-comment-is-capture.yaml'),
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classify — failure modes', () => {
  it('returns pending sentinel when invoker throws', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({ throws: new Error('network down') });
      const result = await classify({ text: 'x' }, 'capture-triage', { invoker, repoRoot: repo });
      expect(result.classification).toBe('pending');
      expect(result.confidence).toBe(0);
      expect(result.metBehindThreshold).toBe(false);
      expect(result.reasoning).toContain('network down');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('returns pending sentinel when no invoker supplied', async () => {
    const repo = makeRepo();
    try {
      const result = await classify({ text: 'x' }, 'capture-triage', { repoRoot: repo });
      expect(result.classification).toBe('pending');
      expect(result.confidence).toBe(0);
      expect(result.reasoning).toContain('no invoker');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects disallowed classification + records the LLM raw output', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-severity': {
          classification: 'maybe-high', // not in allowed set
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      const result = await classify({ text: 'x' }, 'capture-severity', { invoker, repoRoot: repo });
      // Falls open — confidence forced to 0.
      expect(result.confidence).toBe(0);
      expect(result.metBehindThreshold).toBe(false);
      // Corpus entry captures the raw LLM output for post-mortem.
      const corpus = readCorpus(repo, 'capture-severity');
      expect(corpus[0].classification).toBe('maybe-high');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects out-of-range confidence', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 1.5,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      const result = await classify({ text: 'x' }, 'capture-triage', { invoker, repoRoot: repo });
      expect(result.confidence).toBe(0);
      expect(result.metBehindThreshold).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects non-string classification', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          // @ts-expect-error — simulating a malformed LLM response shape
          classification: 42,
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      const result = await classify({ text: 'x' }, 'capture-triage', { invoker, repoRoot: repo });
      expect(result.metBehindThreshold).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classify — subscription ledger (AC-9)', () => {
  it('calls the ledger writer with the LLM-reported token counts', async () => {
    const repo = makeRepo();
    try {
      const ledgerEntries: SubscriptionLedgerEntry[] = [];
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 420,
          outputTokens: 80,
        },
      });
      await classify({ text: 'x' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        ledgerWriter: (e) => {
          ledgerEntries.push(e);
        },
      });
      expect(ledgerEntries).toHaveLength(1);
      expect(ledgerEntries[0].inputTokens).toBe(420);
      expect(ledgerEntries[0].outputTokens).toBe(80);
      expect(ledgerEntries[0].taskType).toBe('capture-triage');
      expect(ledgerEntries[0].model).toBe(DEFAULT_HAIKU_MODEL);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does NOT call the ledger writer when invocation failed', async () => {
    const repo = makeRepo();
    try {
      const ledgerEntries: SubscriptionLedgerEntry[] = [];
      const invoker = new FakeLlmInvoker({ throws: new Error('boom') });
      await classify({ text: 'x' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        ledgerWriter: (e) => {
          ledgerEntries.push(e);
        },
      });
      expect(ledgerEntries).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ledger write failure does NOT break classification', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 1,
          outputTokens: 1,
        },
      });
      const result = await classify({ text: 'x' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        ledgerWriter: () => {
          throw new Error('ledger down');
        },
      });
      expect(result.classification).toBe('quick-fix-task');
      expect(result.metBehindThreshold).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('clamps negative token counts to 0', async () => {
    const repo = makeRepo();
    try {
      const ledgerEntries: SubscriptionLedgerEntry[] = [];
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: -5,
          outputTokens: 12.7,
        },
      });
      await classify({ text: 'x' }, 'capture-triage', {
        invoker,
        repoRoot: repo,
        ledgerWriter: (e) => {
          ledgerEntries.push(e);
        },
      });
      expect(ledgerEntries[0].inputTokens).toBe(0);
      expect(ledgerEntries[0].outputTokens).toBe(12);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classify — multi-task-type support (AC-8)', () => {
  it('serves all 5 task types via the same entry point', async () => {
    const repo = makeRepo();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
        'capture-severity': {
          classification: 'medium',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
        'pr-comment-is-capture': {
          classification: 'is-capture',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
        'dor-answer-is-new-concern': {
          classification: 'new-concern',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
        'decision-recommendation': {
          classification: 'option-a',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      const triage = await classify({ text: 'x' }, 'capture-triage', { invoker, repoRoot: repo });
      const severity = await classify({ text: 'x' }, 'capture-severity', {
        invoker,
        repoRoot: repo,
      });
      const prComment = await classify({ text: 'x' }, 'pr-comment-is-capture', {
        invoker,
        repoRoot: repo,
      });
      const dorAnswer = await classify({ text: 'x' }, 'dor-answer-is-new-concern', {
        invoker,
        repoRoot: repo,
      });
      const decision = await classify(
        { text: 'x', context: { optionIds: ['option-a', 'option-b'] } },
        'decision-recommendation',
        { invoker, repoRoot: repo },
      );
      expect(triage.classification).toBe('quick-fix-task');
      expect(severity.classification).toBe('medium');
      expect(prComment.classification).toBe('is-capture');
      expect(dorAnswer.classification).toBe('new-concern');
      expect(decision.classification).toBe('option-a');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
