import { describe, it, expect } from 'vitest';
import type { DesignIntentDocument } from '@ai-sdlc/reference';
import { compileDid, FakeDepparseClient } from '@ai-sdlc/orchestrator';
import {
  FALSE_POSITIVE_THRESHOLD,
  computeFalsePositiveRate,
  renderPatternReport,
  resolveField,
  runFieldAgainstText,
} from './cli-pattern-test.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDid(): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: { value: 'Make onboarding feel like one decision.' },
        constraints: [
          {
            id: 'no-technical-expertise',
            concept: 'technical expertise',
            relationship: 'must-not-require',
            detectionPatterns: [
              'requires technical expertise',
              'needs developer involvement',
              'developer integration required',
            ],
          },
        ],
        scopeBoundaries: {
          outOfScope: [
            {
              label: 'enterprise SSO',
              synonyms: ['SAML', 'OIDC'],
            },
          ],
        },
        antiPatterns: [
          {
            id: 'wizard',
            label: 'multi-step wizard',
            detectionPatterns: ['setup wizard', 'step 1 of'],
          },
        ],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Avoid jargon.',
            measurableSignals: [{ id: 'ttv', metric: 's', threshold: 60, operator: 'lte' }],
          },
        ],
      },
      designSystemRef: { name: 'acme-ds' },
    },
  };
}

describe('resolveField', () => {
  it('resolves constraint path', () => {
    const result = resolveField(makeDid(), 'constraints.no-technical-expertise');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.kind).toBe('constraint');
      expect(result.needsDepparse).toBe(true);
      expect(result.detectionPatterns).toHaveLength(3);
    }
  });

  it('resolves outOfScope path', () => {
    const result = resolveField(makeDid(), 'scopeBoundaries.outOfScope.enterprise SSO');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.kind).toBe('outOfScope');
      expect(result.needsDepparse).toBe(false);
      // label + 2 synonyms
      expect(result.detectionPatterns).toHaveLength(3);
    }
  });

  it('resolves product antiPattern', () => {
    const result = resolveField(makeDid(), 'antiPatterns.wizard');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.kind).toBe('antiPattern');
      expect(result.needsDepparse).toBe(false);
    }
  });

  it('returns error for unknown field', () => {
    const result = resolveField(makeDid(), 'constraints.unknown');
    expect('error' in result).toBe(true);
  });

  it('returns error for unrecognized path', () => {
    const result = resolveField(makeDid(), 'nope.bad.path');
    expect('error' in result).toBe(true);
  });
});

describe('runFieldAgainstText — constraint path (AC #1)', () => {
  it('matches pattern via fake depparse; report includes field + issue + match glyphs', async () => {
    const did = makeDid();
    const compiled = compileDid(did);
    const field = resolveField(did, 'constraints.no-technical-expertise');
    expect('error' in field).toBe(false);
    if ('error' in field) return;

    const client = new FakeDepparseClient();
    client.setResponse({
      matches: [
        {
          pattern: 'developer integration required',
          matchedText: 'developer integration',
          depPath: ['pobj', 'prep'],
          construction: 'prep(for)',
        },
      ],
    });

    const result = await runFieldAgainstText({
      issueText: 'Add inventory sync via webhook for developer integration',
      did,
      compiled,
      field,
      depparse: client,
    });

    expect(result.violation).toBe(true);
    expect(
      result.matches.find((m) => m.pattern === 'developer integration required')?.matched,
    ).toBe(true);
    expect(result.report).toContain('Pattern test:');
    expect(result.report).toContain('Matched patterns:');
    expect(result.report).toContain('✓ developer integration required');
    expect(result.report).toContain('Constraint violation: YES');
    expect(result.report).toContain('prep(for)');
  });

  it('no match → all glyphs are ✗ and violation=NO', async () => {
    const did = makeDid();
    const compiled = compileDid(did);
    const field = resolveField(did, 'constraints.no-technical-expertise');
    if ('error' in field) return;

    const client = new FakeDepparseClient();
    client.setResponse({ matches: [] });

    const result = await runFieldAgainstText({
      issueText: 'Add a dashboard widget for inventory count',
      did,
      compiled,
      field,
      depparse: client,
    });
    expect(result.violation).toBe(false);
    expect(result.matches.every((m) => !m.matched)).toBe(true);
    expect(result.report).toContain('Constraint violation: NO');
  });
});

describe('runFieldAgainstText — outOfScope path', () => {
  it('matches on label or synonym', async () => {
    const did = makeDid();
    const compiled = compileDid(did);
    const field = resolveField(did, 'scopeBoundaries.outOfScope.enterprise SSO');
    if ('error' in field) return;

    const result = await runFieldAgainstText({
      issueText: 'Add SAML federation for enterprise accounts',
      did,
      compiled,
      field,
      depparse: new FakeDepparseClient(),
    });
    expect(result.violation).toBe(true);
    expect(result.matches.find((m) => m.pattern === 'SAML')?.matched).toBe(true);
  });
});

describe('runFieldAgainstText — antiPattern path', () => {
  it('matches anti-pattern detection patterns', async () => {
    const did = makeDid();
    const compiled = compileDid(did);
    const field = resolveField(did, 'antiPatterns.wizard');
    if ('error' in field) return;

    const result = await runFieldAgainstText({
      issueText: 'Introduce a setup wizard for first-time users.',
      did,
      compiled,
      field,
      depparse: new FakeDepparseClient(),
    });
    expect(result.violation).toBe(true);
    expect(result.matches.find((m) => m.pattern === 'setup wizard')?.matched).toBe(true);
  });
});

describe('renderPatternReport', () => {
  it('includes every section of the §B.10.1 template', () => {
    const report = renderPatternReport({
      fieldPath: 'constraints.foo',
      fieldLabel: 'must-not-require foo',
      issueText: 'hello\nworld',
      matches: [
        { pattern: 'alpha', matched: true, construction: 'dobj(require)' },
        { pattern: 'beta', matched: false },
      ],
      violation: true,
      depparseSkipped: false,
    });
    expect(report).toContain('Pattern test: constraints.foo');
    expect(report).toContain('Field: must-not-require foo');
    expect(report).toContain('Issue text: "hello world"');
    expect(report).toContain('✓ alpha (dobj(require))');
    expect(report).toContain('✗ beta');
    expect(report).toContain('Constraint violation: YES');
  });

  it('surfaces depparse-skipped message', () => {
    const report = renderPatternReport({
      fieldPath: 'constraints.foo',
      fieldLabel: 'must-not-require foo',
      issueText: 'x',
      matches: [],
      violation: false,
      depparseSkipped: true,
    });
    expect(report).toContain('Depparse sidecar unavailable');
  });
});

describe('computeFalsePositiveRate (AC #2, AC #3)', () => {
  it('computes FP/TN/TP/FN correctly', () => {
    const outcomes = [
      { expected: true, matched: true }, // TP
      { expected: true, matched: true }, // TP
      { expected: true, matched: false }, // FN
      { expected: false, matched: true }, // FP
      { expected: false, matched: false }, // TN
      { expected: false, matched: false }, // TN
    ];
    const stats = computeFalsePositiveRate(outcomes);
    expect(stats.truePositive).toBe(2);
    expect(stats.falsePositive).toBe(1);
    expect(stats.trueNegative).toBe(2);
    expect(stats.falseNegative).toBe(1);
    // FP rate = FP / (FP + TN) = 1 / 3
    expect(stats.falsePositiveRate).toBeCloseTo(1 / 3, 6);
  });

  it('returns 0 FP-rate when denominator is empty', () => {
    const stats = computeFalsePositiveRate([{ expected: true, matched: true }]);
    expect(stats.falsePositiveRate).toBe(0);
  });

  it('threshold value is 0.20', () => {
    expect(FALSE_POSITIVE_THRESHOLD).toBe(0.2);
  });

  it('AC #2: 5 positives + 5 labeled negatives with 1 FP → FP rate 20% (at the gate)', () => {
    const outcomes = [
      // 5 positives, all match
      { expected: true, matched: true },
      { expected: true, matched: true },
      { expected: true, matched: true },
      { expected: true, matched: true },
      { expected: true, matched: true },
      // 5 negatives, 1 matches (false positive)
      { expected: false, matched: true },
      { expected: false, matched: false },
      { expected: false, matched: false },
      { expected: false, matched: false },
      { expected: false, matched: false },
    ];
    const stats = computeFalsePositiveRate(outcomes);
    expect(stats.falsePositiveRate).toBeCloseTo(0.2, 6);
    // At the threshold (not above) — the CLI exits 0 when `rate <= threshold`.
    expect(stats.falsePositiveRate <= FALSE_POSITIVE_THRESHOLD).toBe(true);
  });

  it('AC #3: FP rate 40% exceeds the gate and would exit 1', () => {
    const outcomes = [
      { expected: false, matched: true },
      { expected: false, matched: true },
      { expected: false, matched: false },
      { expected: false, matched: false },
      { expected: false, matched: false },
    ];
    const stats = computeFalsePositiveRate(outcomes);
    expect(stats.falsePositiveRate).toBeCloseTo(0.4, 6);
    expect(stats.falsePositiveRate > FALSE_POSITIVE_THRESHOLD).toBe(true);
  });
});

describe('AC #4: lazy depparse connection', () => {
  it('FakeDepparseClient never issues a network call', async () => {
    const did = makeDid();
    const compiled = compileDid(did);
    const field = resolveField(did, 'constraints.no-technical-expertise');
    if ('error' in field) return;

    const client = new FakeDepparseClient();
    // No setResponse — falls back to substring matching.
    await runFieldAgainstText({
      issueText: 'plain inventory widget',
      did,
      compiled,
      field,
      depparse: client,
    });
    expect(client.callLog.length).toBeGreaterThan(0); // the scorer called it
    // But no HTTP layer was touched — callLog is in-process only.
  });
});
