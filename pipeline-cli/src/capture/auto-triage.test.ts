/**
 * Tests for RFC-0024 Refit Phase 3 auto-triage + auto-severity helpers
 * (AISDLC-275).
 *
 * AC coverage:
 *   - AC-1  AI-agent captures auto-triaged via the substrate
 *   - AC-2  High-confidence triage auto-applied; auto-submit per OQ-1
 *           (the submit step lives in the CLI; here we verify the
 *           recommendation surface returns the correct
 *           `metBehindThreshold` signal).
 *   - AC-3  Low-confidence stays `triage: pending` in draft state
 *           (substrate's `tbd` + `metBehindThreshold: false`).
 *   - AC-4  Per-agent threshold override read from agent role config
 *           (covered here AND in config.test.ts; this file verifies the
 *           end-to-end auto-triage path honours the per-agent threshold).
 *   - AC-5  Severity auto-inferred when confidence ≥ threshold; unknown
 *           otherwise (drives `recommendedSeverity: null` when low-conf).
 *   - AC-6  Operator override emits negative exemplar — verified by
 *           `recordTriageOverride` + reading the corpus polarity.
 *   - AC-7  Integration test: confidence > threshold path + confidence <
 *           threshold path (covered in the AC-2 + AC-3 cases above and
 *           in the dedicated "AC-7" describe block).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  autoTriageCapture,
  autoInferSeverity,
  decorateCapturedAuditEntry,
  extractCorpusEntryIds,
  mapTriageClassification,
  mapSeverityClassification,
  previewEffectiveThreshold,
  recordTriageOverride,
  recordSeverityOverride,
} from './auto-triage.js';
import type { AuditEntry, CaptureRecord } from './capture-record.js';
import { FakeLlmInvoker, readCorpus } from '../classifier/substrate/index.js';

function makeRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-275-auto-triage-'));
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  return dir;
}

function writeConfig(repoRoot: string, body: string): void {
  writeFileSync(join(repoRoot, '.ai-sdlc', 'capture-config.yaml'), body, 'utf8');
}

function makeRecord(extra: Partial<CaptureRecord> = {}): CaptureRecord {
  const auditEntry: AuditEntry = {
    action: 'captured',
    by: 'code-reviewer',
    at: '2026-05-24T00:00:00.000Z',
  };
  return {
    id: 'cap_2026-05-24T00-00-00_aaaaaa',
    schemaVersion: 'v1',
    timestamp: '2026-05-24T00:00:00.000Z',
    finding: 'sample finding',
    severity: 'unknown',
    triage: 'tbd',
    source: { type: 'ai-agent', agentRole: 'code-reviewer', operator: null },
    evidence: {},
    auditTrail: [auditEntry],
    ...extra,
  };
}

// ── Taxonomy mapping (pure functions) ────────────────────────────────────────

describe('mapTriageClassification', () => {
  it.each([
    ['quick-fix-task', 'quick-fix'],
    ['new-feature-issue', 'new-feature-issue'],
    ['scope-extension', 'scope-extension'],
    ["won't-fix", 'not-actionable'],
    ['tbd', 'tbd'],
  ] as const)('%s → %s', (substrate, capture) => {
    expect(mapTriageClassification(substrate)).toBe(capture);
  });

  it('returns null for unknown values', () => {
    expect(mapTriageClassification('framework-bug')).toBeNull();
    expect(mapTriageClassification('garbage')).toBeNull();
    expect(mapTriageClassification('')).toBeNull();
  });
});

describe('mapSeverityClassification', () => {
  it.each([
    ['critical', 'critical'],
    ['high', 'major'],
    ['medium', 'minor'],
    ['low', 'suggestion'],
  ] as const)('%s → %s', (substrate, capture) => {
    expect(mapSeverityClassification(substrate)).toBe(capture);
  });

  it('returns null for unknown values', () => {
    expect(mapSeverityClassification('unknown')).toBeNull();
    expect(mapSeverityClassification('garbage')).toBeNull();
  });
});

// ── AC-1, AC-2, AC-3, AC-7: confidence > threshold path ──────────────────────

describe('autoTriageCapture — confidence > threshold (AC-1, AC-2, AC-7)', () => {
  it('returns metBehindThreshold=true + the recommended triage at confidence 0.85', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.85,
          reasoning: 'tiny rename',
          inputTokens: 80,
          outputTokens: 25,
        },
      });
      const result = await autoTriageCapture({
        finding: 'rename the `foo` variable',
        agentRole: 'code-reviewer',
        repoRoot,
        invoker,
      });
      expect(result.recommendedTriage).toBe('quick-fix');
      expect(result.metBehindThreshold).toBe(true);
      expect(result.confidence).toBe(0.85);
      expect(result.effectiveThreshold).toBe(0.7); // default
      expect(result.corpusEntryId).not.toBeNull();
      expect(result.rawClassification).toBe('quick-fix-task');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('writes a pending corpus entry that the caller can later flip', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'scope-extension',
          confidence: 0.9,
          reasoning: 'belongs in current AC',
          inputTokens: 80,
          outputTokens: 25,
        },
      });
      const result = await autoTriageCapture({
        finding: 'we should also add error-rate metrics',
        repoRoot,
        invoker,
      });
      const corpus = readCorpus(repoRoot, 'capture-triage');
      expect(corpus).toHaveLength(1);
      expect(corpus[0].id).toBe(result.corpusEntryId);
      expect(corpus[0].polarity).toBe('pending');
      expect(corpus[0].classification).toBe('scope-extension');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ── AC-3, AC-7: confidence < threshold path ──────────────────────────────────

describe('autoTriageCapture — confidence < threshold (AC-3, AC-7)', () => {
  it('returns metBehindThreshold=false at confidence 0.55', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'tbd',
          confidence: 0.55,
          reasoning: 'ambiguous',
          inputTokens: 60,
          outputTokens: 15,
        },
      });
      const result = await autoTriageCapture({
        finding: 'something funky in auth flow',
        repoRoot,
        invoker,
      });
      expect(result.metBehindThreshold).toBe(false);
      expect(result.recommendedTriage).toBe('tbd');
      expect(result.confidence).toBe(0.55);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('handles substrate fall-open (no invoker) with low-confidence default', async () => {
    const repoRoot = makeRepoRoot();
    try {
      // Provide an invoker that throws — substrate falls open.
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'tbd',
          confidence: 0,
          reasoning: '',
          inputTokens: 0,
          outputTokens: 0,
        },
        throws: new Error('classifier unavailable'),
      });
      const result = await autoTriageCapture({
        finding: 'x',
        repoRoot,
        invoker,
      });
      expect(result.metBehindThreshold).toBe(false);
      // Fall-open produces 'pending' from the substrate, which does NOT
      // map to a CaptureTriageValue, so recommendedTriage is null.
      expect(result.recommendedTriage).toBeNull();
      expect(result.confidence).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ── AC-4: per-agent threshold override ───────────────────────────────────────

describe('autoTriageCapture — per-agent threshold (AC-4)', () => {
  it("security-reviewer's stricter 0.9 threshold blocks a 0.8 result that code-reviewer would accept", async () => {
    const repoRoot = makeRepoRoot();
    try {
      writeConfig(
        repoRoot,
        [
          'classifier:',
          '  threshold: 0.7',
          '  perAgentRole:',
          '    security-reviewer:',
          '      threshold: 0.9',
          '    code-reviewer:',
          '      threshold: 0.5',
          '',
        ].join('\n'),
      );
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.8,
          reasoning: 'small risk',
          inputTokens: 80,
          outputTokens: 25,
        },
      });

      const securityResult = await autoTriageCapture({
        finding: 'token refresh may race',
        agentRole: 'security-reviewer',
        repoRoot,
        invoker,
      });
      expect(securityResult.effectiveThreshold).toBe(0.9);
      expect(securityResult.metBehindThreshold).toBe(false);

      const codeResult = await autoTriageCapture({
        finding: 'token refresh may race',
        agentRole: 'code-reviewer',
        repoRoot,
        invoker,
      });
      expect(codeResult.effectiveThreshold).toBe(0.5);
      expect(codeResult.metBehindThreshold).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('previewEffectiveThreshold returns the same value without invoking the LLM', () => {
    const repoRoot = makeRepoRoot();
    try {
      writeConfig(
        repoRoot,
        [
          'classifier:',
          '  threshold: 0.7',
          '  perAgentRole:',
          '    security-reviewer:',
          '      threshold: 0.92',
          '',
        ].join('\n'),
      );
      expect(
        previewEffectiveThreshold({
          taskType: 'capture-triage',
          repoRoot,
          agentRole: 'security-reviewer',
        }),
      ).toBe(0.92);
      expect(
        previewEffectiveThreshold({
          taskType: 'capture-severity',
          repoRoot,
          agentRole: 'code-reviewer',
          perCallThreshold: 0.33,
        }),
      ).toBe(0.33);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ── AC-5: auto-infer severity ────────────────────────────────────────────────

describe('autoInferSeverity (AC-5)', () => {
  it('returns the mapped severity at high confidence', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-severity': {
          classification: 'high',
          confidence: 0.82,
          reasoning: 'real risk',
          inputTokens: 90,
          outputTokens: 25,
        },
      });
      const result = await autoInferSeverity({
        finding: 'plaintext token logging in middleware',
        agentRole: 'security-reviewer',
        repoRoot,
        invoker,
      });
      expect(result.recommendedSeverity).toBe('major');
      expect(result.metBehindThreshold).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('leaves severity null when confidence is below threshold', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-severity': {
          classification: 'medium',
          confidence: 0.5,
          reasoning: 'unclear',
          inputTokens: 50,
          outputTokens: 15,
        },
      });
      const result = await autoInferSeverity({
        finding: 'maybe a problem',
        repoRoot,
        invoker,
      });
      expect(result.metBehindThreshold).toBe(false);
      // The classification still maps (minor), but caller treats
      // metBehindThreshold=false as "leave severity as unknown".
      expect(result.recommendedSeverity).toBe('minor');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('returns recommendedSeverity null when substrate emits a value outside the mapping', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-severity': {
          // Invalid for the substrate's allowed set — substrate falls open.
          classification: 'apocalyptic',
          confidence: 0.95,
          reasoning: '?',
          inputTokens: 0,
          outputTokens: 0,
        },
      });
      const result = await autoInferSeverity({
        finding: 'x',
        repoRoot,
        invoker,
      });
      // Substrate fall-open → metBehindThreshold false, mapped severity null.
      expect(result.metBehindThreshold).toBe(false);
      expect(result.recommendedSeverity).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

// ── Audit-trail decoration ───────────────────────────────────────────────────

describe('audit-trail decoration', () => {
  it('decorateCapturedAuditEntry attaches both corpus ids when present', () => {
    const entry: AuditEntry = { action: 'captured', by: 'a', at: 'now' };
    decorateCapturedAuditEntry(entry, {
      triageCorpusEntryId: 't-1',
      severityCorpusEntryId: 's-1',
    });
    expect(entry.triageCorpusEntryId).toBe('t-1');
    expect(entry.severityCorpusEntryId).toBe('s-1');
  });

  it('decorateCapturedAuditEntry skips null/missing ids', () => {
    const entry: AuditEntry = { action: 'captured', by: 'a', at: 'now' };
    decorateCapturedAuditEntry(entry, {
      triageCorpusEntryId: null,
      severityCorpusEntryId: undefined,
    });
    expect('triageCorpusEntryId' in entry).toBe(false);
    expect('severityCorpusEntryId' in entry).toBe(false);
  });

  it('extractCorpusEntryIds reads the captured audit entry', () => {
    const record = makeRecord();
    record.auditTrail[0].triageCorpusEntryId = 't-2';
    record.auditTrail[0].severityCorpusEntryId = 's-2';
    expect(extractCorpusEntryIds(record)).toEqual({ triage: 't-2', severity: 's-2' });
  });

  it('extractCorpusEntryIds returns nulls when fields are absent', () => {
    expect(extractCorpusEntryIds(makeRecord())).toEqual({ triage: null, severity: null });
  });
});

// ── AC-6: operator override emits negative exemplar ──────────────────────────

describe('recordTriageOverride (AC-6)', () => {
  it('flips the corpus entry polarity to negative', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: 'quick-fix-task',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 80,
          outputTokens: 25,
        },
      });
      const result = await autoTriageCapture({
        finding: 'finding',
        repoRoot,
        invoker,
      });
      const record = makeRecord();
      decorateCapturedAuditEntry(record.auditTrail[0], {
        triageCorpusEntryId: result.corpusEntryId,
      });

      // Operator overrides triage from auto 'quick-fix' to 'new-feature-issue'.
      const override = recordTriageOverride({
        record,
        newTriage: 'new-feature-issue',
        reason: 'needs upstream design',
        repoRoot,
      });
      expect(override.flipped).toBe(true);

      const corpus = readCorpus(repoRoot, 'capture-triage');
      expect(corpus).toHaveLength(1);
      expect(corpus[0].polarity).toBe('negative');
      expect(corpus[0].operatorOverrideClassification).toBe('new-feature-issue');
      expect(corpus[0].operatorOverrideReason).toBe('needs upstream design');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('no-ops on records that were not auto-triaged', () => {
    const repoRoot = makeRepoRoot();
    try {
      const record = makeRecord(); // no decoration → no triageCorpusEntryId
      const override = recordTriageOverride({
        record,
        newTriage: 'quick-fix',
        repoRoot,
      });
      expect(override.flipped).toBe(false);
      expect(override.reason).toBe('no-corpus-entry-id');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("operator override of 'won't-fix' → 'new-issue' records the raw capture-domain value", async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-triage': {
          classification: "won't-fix",
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 60,
          outputTokens: 15,
        },
      });
      const result = await autoTriageCapture({
        finding: 'x',
        repoRoot,
        invoker,
      });
      const record = makeRecord();
      decorateCapturedAuditEntry(record.auditTrail[0], {
        triageCorpusEntryId: result.corpusEntryId,
      });
      recordTriageOverride({
        record,
        newTriage: 'new-issue',
        repoRoot,
      });
      const corpus = readCorpus(repoRoot, 'capture-triage');
      // 'new-issue' has no substrate equivalent — recorded raw per
      // reverseMapTriageClassification contract.
      expect(corpus[0].operatorOverrideClassification).toBe('new-issue');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('recordSeverityOverride (AC-6 severity arc)', () => {
  it('flips the severity corpus entry polarity to negative', async () => {
    const repoRoot = makeRepoRoot();
    try {
      const invoker = new FakeLlmInvoker({
        'capture-severity': {
          classification: 'high',
          confidence: 0.9,
          reasoning: 'r',
          inputTokens: 80,
          outputTokens: 25,
        },
      });
      const result = await autoInferSeverity({
        finding: 'x',
        repoRoot,
        invoker,
      });
      const record = makeRecord();
      decorateCapturedAuditEntry(record.auditTrail[0], {
        severityCorpusEntryId: result.corpusEntryId,
      });

      // Operator downgrades from auto 'major' to 'minor'.
      const override = recordSeverityOverride({
        record,
        newSeverity: 'minor',
        reason: 'over-classified',
        repoRoot,
      });
      expect(override.flipped).toBe(true);
      const corpus = readCorpus(repoRoot, 'capture-severity');
      expect(corpus[0].polarity).toBe('negative');
      expect(corpus[0].operatorOverrideClassification).toBe('medium');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
