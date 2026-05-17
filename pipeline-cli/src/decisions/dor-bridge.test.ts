/**
 * RFC-0035 Phase 4 — DoR-to-Decision bridge unit tests.
 *
 * Covers acceptance criteria AC#1–AC#4 at the bridge level; the
 * end-to-end integration test (AC#5, queryable via cli-decisions list)
 * lives in `dor-integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dorClarificationOptions, emitDorDecisions, resolveDorDecision } from './dor-bridge.js';
import { listDecisions, projectDecision } from './projection.js';
import { DECISION_CATALOG_FLAG } from './feature-flag.js';
import type { RefinementVerdict } from '../dor/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeVerdict(
  questions: string[],
  overall: RefinementVerdict['overallVerdict'] = 'needs-clarification',
  issueId = 'AISDLC-288',
): RefinementVerdict {
  return {
    issueId,
    rubricVersion: 'v1',
    overallVerdict: overall,
    gates: [],
    signedAt: new Date().toISOString(),
    evaluatorVersion: 'test-v1',
    questions,
  };
}

const FLAG_ON = { [DECISION_CATALOG_FLAG]: 'experimental' } as NodeJS.ProcessEnv;
const FLAG_OFF = {} as NodeJS.ProcessEnv;

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dor-bridge-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── dorClarificationOptions ───────────────────────────────────────────────────

describe('dorClarificationOptions', () => {
  it('returns the three standard DoR resolution options', () => {
    const opts = dorClarificationOptions();
    expect(opts).toHaveLength(3);
    const ids = opts.map((o) => o.id);
    expect(ids).toContain('provide-answer');
    expect(ids).toContain('bypass-gate');
    expect(ids).toContain('reject-issue');
  });

  it('every option has a non-empty description', () => {
    for (const opt of dorClarificationOptions()) {
      expect(opt.description.length).toBeGreaterThan(0);
    }
  });

  it('every option has at least one consequence', () => {
    for (const opt of dorClarificationOptions()) {
      expect(opt.consequences?.length).toBeGreaterThanOrEqual(1);
    }
  });
});

// ── AC#4 — feature flag degrade-open ─────────────────────────────────────────

describe('AC#4 — feature flag degrade-open', () => {
  it('emitDorDecisions returns enabled:false when flag is off', () => {
    const verdict = makeVerdict(['What does "faster" mean?']);
    const result = emitDorDecisions(verdict, { workDir, env: FLAG_OFF });
    expect(result.enabled).toBe(false);
    expect(result.emitted).toBe(0);
    expect(result.decisionIds).toEqual([]);
    expect(result.disabledReason).toMatch(/AI_SDLC_DECISION_CATALOG/);
  });

  it('emitDorDecisions writes no events to the log when flag is off', () => {
    const verdict = makeVerdict(['Which auth flow?']);
    emitDorDecisions(verdict, { workDir, env: FLAG_OFF });
    const { decisions } = listDecisions({ workDir });
    expect(decisions).toHaveLength(0);
  });

  it('resolveDorDecision returns enabled:false and writes nothing when flag is off', () => {
    const r = resolveDorDecision('DEC-0001', 'provide-answer', { workDir, env: FLAG_OFF });
    expect(r.enabled).toBe(false);
    expect(r.path).toBe('');
    const { decisions } = listDecisions({ workDir });
    expect(decisions).toHaveLength(0);
  });
});

// ── AC#1 — DoR clarification rounds emit Decision records ─────────────────────

describe('AC#1 — clarification rounds emit Decision records', () => {
  it('emits one Decision per clarification question', () => {
    const verdict = makeVerdict(['Which auth flow?', 'What is the expected response time?']);
    const result = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    expect(result.enabled).toBe(true);
    expect(result.emitted).toBe(2);
    expect(result.decisionIds).toHaveLength(2);

    const { decisions } = listDecisions({ workDir });
    expect(decisions).toHaveLength(2);
  });

  it('emits nothing when the verdict has no questions', () => {
    const verdict = makeVerdict([]);
    const result = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    expect(result.emitted).toBe(0);
    expect(result.decisionIds).toHaveLength(0);

    const { decisions } = listDecisions({ workDir });
    expect(decisions).toHaveLength(0);
  });

  it('emits nothing for an admit verdict (no questions)', () => {
    const verdict = makeVerdict([], 'admit');
    const result = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    expect(result.emitted).toBe(0);
  });

  it('allocates sequential DEC-NNNN ids within the same call', () => {
    const verdict = makeVerdict(['Q1', 'Q2', 'Q3']);
    const result = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    expect(result.decisionIds).toEqual(['DEC-0001', 'DEC-0002', 'DEC-0003']);
  });

  it('continues allocation from existing log state', () => {
    // Seed the log with one existing decision so ids start at 0002.
    emitDorDecisions(makeVerdict(['Q1']), { workDir, env: FLAG_ON });
    const result = emitDorDecisions(makeVerdict(['Q2', 'Q3']), { workDir, env: FLAG_ON });
    expect(result.decisionIds).toEqual(['DEC-0002', 'DEC-0003']);
  });
});

// ── AC#2 — each question becomes a Decision with question + options ────────────

describe('AC#2 — Decision shape for each clarification question', () => {
  it('uses the verbatim question as the Decision summary', () => {
    const question = 'Which auth flow does this refer to?';
    const verdict = makeVerdict([question]);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });

    const decision = projectDecision(decisionIds[0]!, { workDir });
    expect(decision).not.toBeNull();
    expect(decision!.spec.summary).toBe(question);
  });

  it('sets source: dor-clarification', () => {
    const verdict = makeVerdict(['Q?']);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decision = projectDecision(decisionIds[0]!, { workDir });
    expect(decision!.metadata.source).toBe('dor-clarification');
  });

  it('includes the standard three resolution options', () => {
    const verdict = makeVerdict(['What shard?']);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decision = projectDecision(decisionIds[0]!, { workDir });
    const ids = decision!.spec.options.map((o) => o.id);
    expect(ids).toContain('provide-answer');
    expect(ids).toContain('bypass-gate');
    expect(ids).toContain('reject-issue');
  });

  it('marks decisions reversible:true', () => {
    const verdict = makeVerdict(['Is X or Y?']);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decision = projectDecision(decisionIds[0]!, { workDir });
    expect(decision!.spec.reversible).toBe(true);
  });

  it('sets the scope to issue:<issueId> by default', () => {
    const verdict = makeVerdict(['Q?'], 'needs-clarification', 'AISDLC-123');
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decision = projectDecision(decisionIds[0]!, { workDir });
    expect(decision!.metadata.scope).toBe('issue:AISDLC-123');
  });

  it('accepts a custom issueScope override', () => {
    const verdict = makeVerdict(['Q?'], 'needs-clarification', 'gh#42');
    const { decisionIds } = emitDorDecisions(verdict, {
      workDir,
      env: FLAG_ON,
      issueScope: 'github-issue:gh#42',
    });
    const decision = projectDecision(decisionIds[0]!, { workDir });
    expect(decision!.metadata.scope).toBe('github-issue:gh#42');
  });

  it('includes a body mentioning the issueId and verdict', () => {
    const verdict = makeVerdict(['Q?'], 'needs-clarification', 'AISDLC-288');
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decision = projectDecision(decisionIds[0]!, { workDir });
    expect(decision!.spec.body).toMatch(/AISDLC-288/);
    expect(decision!.spec.body).toMatch(/needs-clarification/);
  });

  it('lifecycle starts as open', () => {
    const verdict = makeVerdict(['Q?']);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decision = projectDecision(decisionIds[0]!, { workDir });
    expect(decision!.status.lifecycle).toBe('open');
  });
});

// ── AC#3 — operator answers feed back into Decision resolution ────────────────

describe('AC#3 — operator answers resolve Decisions', () => {
  it('resolves a decision to lifecycle:answered with the chosen option', () => {
    const verdict = makeVerdict(['Q?']);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decisionId = decisionIds[0]!;

    resolveDorDecision(decisionId, 'provide-answer', {
      workDir,
      env: FLAG_ON,
      by: 'dominique@reliablegenius.io',
    });

    const decision = projectDecision(decisionId, { workDir });
    expect(decision!.status.lifecycle).toBe('answered');
    expect(decision!.status.answeredOptionId).toBe('provide-answer');
    expect(decision!.status.answeredBy).toBe('dominique@reliablegenius.io');
    expect(decision!.status.answeredAt).toBeTruthy();
  });

  it('records the answer as an operator-answered event in the decision log', () => {
    const verdict = makeVerdict(['Q?']);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const decisionId = decisionIds[0]!;

    resolveDorDecision(decisionId, 'bypass-gate', { workDir, env: FLAG_ON });

    const decision = projectDecision(decisionId, { workDir });
    expect(decision!.decisionLog).toHaveLength(2);
    expect(decision!.decisionLog[1]!.type).toBe('operator-answered');
  });

  it('can resolve any of the three standard options', () => {
    for (const optId of ['provide-answer', 'bypass-gate', 'reject-issue']) {
      const tmpVerdictWorkDir = mkdtempSync(join(tmpdir(), 'resolve-opt-'));
      try {
        const verdict = makeVerdict(['Q?']);
        const { decisionIds } = emitDorDecisions(verdict, {
          workDir: tmpVerdictWorkDir,
          env: FLAG_ON,
        });
        resolveDorDecision(decisionIds[0]!, optId, { workDir: tmpVerdictWorkDir, env: FLAG_ON });
        const d = projectDecision(decisionIds[0]!, { workDir: tmpVerdictWorkDir });
        expect(d!.status.answeredOptionId).toBe(optId);
      } finally {
        rmSync(tmpVerdictWorkDir, { recursive: true, force: true });
      }
    }
  });

  it('resolveDorDecision returns the path where the event was appended', () => {
    const verdict = makeVerdict(['Q?']);
    const { decisionIds } = emitDorDecisions(verdict, { workDir, env: FLAG_ON });
    const r = resolveDorDecision(decisionIds[0]!, 'provide-answer', { workDir, env: FLAG_ON });
    expect(r.enabled).toBe(true);
    expect(r.path).toMatch(/events\.jsonl$/);
  });
});
