import { describe, expect, it } from 'vitest';
import { validateReviewEvidence } from './validation.js';

const entry = (over: Record<string, unknown> = {}) => ({
  probeId: 'p1',
  status: 'ok',
  harness: 'claude-code',
  model: 'sonnet',
  observations: ['the guard runs before the handler'],
  excerpts: [{ file: 'src/a.ts', startLine: 3, endLine: 9, text: 'if (!user) throw' }],
  commands: [{ command: 'pnpm test', exitStatus: 0, output: 'ok' }],
  answer: { text: 'yes', confidence: 'high' },
  evidenceBytes: 60,
  metrics: { latencyMs: 12, inputTokens: 100, outputTokens: 20, transcriptCaptured: true },
  ...over,
});
const bundle = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  budget: { perProbeBytes: 1000, totalBytes: 5000 },
  totalBytes: 60,
  entries,
  ...over,
});

describe('ReviewEvidence schema', () => {
  it('accepts a bundle with ok, refused, skipped and truncated entries', () => {
    const entries = [
      entry(),
      entry({
        probeId: 'p2',
        status: 'refused',
        harness: 'none',
        model: 'none',
        observations: [],
        excerpts: [],
        commands: [],
        answer: undefined,
        refusals: [{ reason: 'not-tracked', target: '.env' }],
        evidenceBytes: 0,
        metrics: { latencyMs: 0, transcriptCaptured: false },
      }),
      entry({
        probeId: 'p3',
        status: 'skipped',
        harness: 'none',
        model: 'none',
        observations: [],
        excerpts: [],
        commands: [],
        answer: undefined,
        skippedReason: 'run-probe-cap',
        evidenceBytes: 0,
        metrics: { latencyMs: 0, transcriptCaptured: false },
      }),
      entry({
        probeId: 'p4',
        harness: 'codex',
        truncated: true,
        truncation: { marker: '[truncated]', omittedBytes: 10 },
      }),
    ];
    expect(validateReviewEvidence(bundle(entries)).valid).toBe(true);
  });

  it('rejects unknown fields, statuses, harnesses and confidence words', () => {
    expect(validateReviewEvidence(bundle([entry({ extra: 1 })])).valid).toBe(false);
    expect(validateReviewEvidence(bundle([entry({ status: 'done' })])).valid).toBe(false);
    expect(validateReviewEvidence(bundle([entry({ harness: 'gpt' })])).valid).toBe(false);
    expect(
      validateReviewEvidence(bundle([entry({ answer: { text: 'x', confidence: 'certain' } })]))
        .valid,
    ).toBe(false);
  });

  it('requires the fields every entry needs', () => {
    expect(validateReviewEvidence(bundle([entry({ probeId: undefined })])).valid).toBe(false);
    expect(validateReviewEvidence({ schemaVersion: 1, entries: [] }).valid).toBe(false);
    expect(
      validateReviewEvidence(
        bundle([entry({ excerpts: [{ file: 'a.ts', startLine: 0, endLine: 1, text: '' }] })]),
      ).valid,
    ).toBe(false);
  });
});
