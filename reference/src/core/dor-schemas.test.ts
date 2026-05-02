/**
 * RFC-0011 Phase 1 schema validation tests.
 *
 * Covers `dor-config.v1.schema.json` and `refinement-verdict.v1.schema.json`
 * via the existing ajv-backed validation harness in `validation.ts`.
 */

import { describe, expect, it } from 'vitest';
import { validate, validateRefinementVerdict, validateArtifact } from './validation.js';

// ── DorConfig fixtures ────────────────────────────────────────────────

const VALID_MINIMAL_DOR_CONFIG = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'DorConfig',
  metadata: { name: 'default-dor' },
  spec: {
    evaluationMode: 'warn-only',
  },
};

const VALID_FULL_DOR_CONFIG = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'DorConfig',
  metadata: { name: 'full-dor', namespace: 'engineering' },
  spec: {
    rubricVersion: 'v1',
    evaluationMode: 'enforce',
    notifications: {
      authorChannel: true,
      dedicatedChannel: {
        slack: '#ai-sdlc-dor',
        github_team: '@ai-sdlc-framework/triage',
      },
    },
    staleness: {
      warnAfterDays: 14,
      closeAfterDays: 28,
      closedLabel: 'closed-as-stale-dor',
    },
    autoPassRules: [
      {
        kind: 'dependency-bump',
        sources: ['dependabot[bot]', 'renovate[bot]'],
        titlePattern: '^bump\\s+\\S+\\s+from\\s+',
        gatesSkipped: [1, 2, 6],
        gatesRetained: [4],
      },
      {
        kind: 'doc-typo',
        sources: ['github-actions[bot]'],
        titlePattern: '^(fix|docs):\\s+typo',
        maxBodyDiffLines: 50,
        gatesSkipped: [],
        gatesRetained: [],
      },
    ],
    escalation: {
      maxRoundsBeforeHumanTriage: 3,
      triageRouters: [{ github_team: '@ai-sdlc-framework/triage' }],
    },
    bypassRequiresRole: 'maintainer',
  },
};

// ── RefinementVerdict fixtures ────────────────────────────────────────

const VALID_MINIMAL_VERDICT = {
  issueId: 'AISDLC-92',
  rubricVersion: 'v1',
  overallVerdict: 'admit',
  gates: [{ gateId: 1, verdict: 'pass', confidence: 'high' }],
  signedAt: '2026-04-30T10:00:00Z',
  evaluatorVersion: 'dor-evaluator@0.1.0',
};

const VALID_FULL_VERDICT = {
  issueId: 'AISDLC-93',
  rubricVersion: 'v1',
  overallVerdict: 'needs-clarification',
  gates: [
    { gateId: 1, verdict: 'pass', confidence: 'high', stage: 'B' },
    {
      gateId: 5,
      verdict: 'fail',
      confidence: 'medium',
      stage: 'A',
      finding: 'Affected surface unnamed',
      clarificationQuestion: 'Which search surface — site, admin, or API?',
    },
    { gateId: 6, verdict: 'skip', confidence: 'low' },
  ],
  signedAt: '2026-04-30T10:01:00Z',
  evaluatorVersion: 'dor-evaluator@0.1.0',
  summary: 'Issue blocked on Gate 5 (affected surface unnamed).',
  questions: ['Which search surface — site, admin, or API?'],
  overallConfidence: 'medium',
};

// ── DorConfig tests ───────────────────────────────────────────────────

describe('validate(DorConfig)', () => {
  it('accepts a minimal DorConfig (only evaluationMode)', () => {
    const result = validate('DorConfig', VALID_MINIMAL_DOR_CONFIG);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('accepts a fully-populated DorConfig', () => {
    const result = validate('DorConfig', VALID_FULL_DOR_CONFIG);
    expect(result.valid).toBe(true);
  });

  it('rejects unknown evaluationMode values', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: { ...VALID_MINIMAL_DOR_CONFIG.spec, evaluationMode: 'block-everything' },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
    expect(result.errors!.length).toBeGreaterThan(0);
  });

  it('rejects DorConfig missing evaluationMode', () => {
    const doc = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'DorConfig',
      metadata: { name: 'broken' },
      spec: {},
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects DorConfig with wrong kind constant', () => {
    const doc = { ...VALID_MINIMAL_DOR_CONFIG, kind: 'Pipeline' };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects DorConfig with extra top-level keys', () => {
    const doc = { ...VALID_MINIMAL_DOR_CONFIG, extraKey: 'nope' };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects autoPassRules with out-of-range gateIds', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        autoPassRules: [{ kind: 'k', sources: ['a'], gatesSkipped: [0, 8] }],
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects autoPassRules with empty sources array', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        autoPassRules: [{ kind: 'k', sources: [] }],
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects staleness without required fields', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        staleness: { warnAfterDays: 14 }, // missing closeAfterDays + closedLabel
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });

  it('rejects notifications.dedicatedChannel with no inner field set', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        notifications: { dedicatedChannel: {} },
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });

  it('accepts notifications.dedicatedChannel with only slack set', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        notifications: { dedicatedChannel: { slack: '#dor-triage' } },
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(true);
  });

  it('accepts evaluationMode=enforce', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: { ...VALID_MINIMAL_DOR_CONFIG.spec, evaluationMode: 'enforce' },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(true);
  });

  it('accepts escalation with the simple triager string (Phase 6)', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        escalation: {
          maxRoundsBeforeHumanTriage: 3,
          triager: '@ai-sdlc-framework/triage',
        },
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(true);
  });

  it('accepts escalation with a Slack channel triager (Phase 6)', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        escalation: {
          maxRoundsBeforeHumanTriage: 5,
          triager: '#ai-sdlc-triage',
        },
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(true);
  });

  it('rejects escalation.triager with empty string (Phase 6)', () => {
    const doc = {
      ...VALID_MINIMAL_DOR_CONFIG,
      spec: {
        ...VALID_MINIMAL_DOR_CONFIG.spec,
        escalation: { triager: '' },
      },
    };
    const result = validate('DorConfig', doc);
    expect(result.valid).toBe(false);
  });
});

// ── RefinementVerdict tests ───────────────────────────────────────────

describe('validateRefinementVerdict()', () => {
  it('accepts a minimal verdict (single passing gate)', () => {
    const result = validateRefinementVerdict(VALID_MINIMAL_VERDICT);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  it('accepts a fully-populated verdict with mixed verdicts and stages', () => {
    const result = validateRefinementVerdict(VALID_FULL_VERDICT);
    expect(result.valid).toBe(true);
  });

  it('rejects overallVerdict outside the enum', () => {
    const doc = { ...VALID_MINIMAL_VERDICT, overallVerdict: 'maybe' };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects gateId outside 1-7 range', () => {
    const doc = {
      ...VALID_MINIMAL_VERDICT,
      gates: [{ gateId: 8, verdict: 'pass', confidence: 'high' }],
    };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects per-gate verdict outside the enum', () => {
    const doc = {
      ...VALID_MINIMAL_VERDICT,
      gates: [{ gateId: 1, verdict: 'maybe-pass', confidence: 'high' }],
    };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects per-gate confidence outside the enum', () => {
    const doc = {
      ...VALID_MINIMAL_VERDICT,
      gates: [{ gateId: 1, verdict: 'pass', confidence: 'extreme' }],
    };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects rubricVersion outside the enum', () => {
    const doc = { ...VALID_MINIMAL_VERDICT, rubricVersion: 'v2' };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects gates array with > 7 entries', () => {
    const doc = {
      ...VALID_MINIMAL_VERDICT,
      gates: Array.from({ length: 8 }, (_, i) => ({
        gateId: ((i % 7) + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7,
        verdict: 'pass',
        confidence: 'high',
      })),
    };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects empty gates array', () => {
    const doc = { ...VALID_MINIMAL_VERDICT, gates: [] };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects missing required top-level fields', () => {
    const doc = { issueId: 'X', overallVerdict: 'admit' };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects extra top-level keys', () => {
    const doc = { ...VALID_MINIMAL_VERDICT, sneaky: 'field' };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('rejects signedAt that is not ISO-8601', () => {
    const doc = { ...VALID_MINIMAL_VERDICT, signedAt: 'last Tuesday' };
    const result = validateRefinementVerdict(doc);
    expect(result.valid).toBe(false);
  });

  it('accepts all three confidence levels', () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      const doc = {
        ...VALID_MINIMAL_VERDICT,
        gates: [{ gateId: 1, verdict: 'pass', confidence }],
      };
      const result = validateRefinementVerdict(doc);
      expect(result.valid).toBe(true);
    }
  });

  it('accepts all three verdict values per gate', () => {
    for (const verdict of ['pass', 'fail', 'skip'] as const) {
      const doc = {
        ...VALID_MINIMAL_VERDICT,
        gates: [{ gateId: 1, verdict, confidence: 'high' }],
      };
      const result = validateRefinementVerdict(doc);
      expect(result.valid).toBe(true);
    }
  });

  it('accepts both stages on a gate', () => {
    for (const stage of ['A', 'B'] as const) {
      const doc = {
        ...VALID_MINIMAL_VERDICT,
        gates: [{ gateId: 1, verdict: 'pass', confidence: 'high', stage }],
      };
      const result = validateRefinementVerdict(doc);
      expect(result.valid).toBe(true);
    }
  });
});

// ── Generic artifact validator surface ────────────────────────────────

describe('validateArtifact()', () => {
  it('routes RefinementVerdict through the same compiler cache', () => {
    const r1 = validateArtifact('RefinementVerdict', VALID_MINIMAL_VERDICT);
    const r2 = validateArtifact('RefinementVerdict', VALID_FULL_VERDICT);
    expect(r1.valid).toBe(true);
    expect(r2.valid).toBe(true);
  });
});
