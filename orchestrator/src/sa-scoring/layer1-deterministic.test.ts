import { describe, it, expect } from 'vitest';
import type { DesignIntentDocument } from '@ai-sdlc/reference';
import { compileDid } from './did-compiler.js';
import { FakeDepparseClient, DepparseError } from './depparse-client.js';
import {
  checkMeasurableSignals,
  checkScopeGate,
  detectAntiPatterns,
  detectConstraintViolations,
  renderPreVerifiedSummary,
  runLayer1,
} from './layer1-deterministic.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDid(overrides: Partial<DesignIntentDocument['spec']> = {}): DesignIntentDocument {
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
        mission: { value: 'Help small businesses onboard in under 60 seconds.' },
        scopeBoundaries: {
          outOfScope: [
            {
              label: 'enterprise SSO',
              identityClass: 'core',
              synonyms: ['SAML', 'OIDC'],
            },
            {
              label: 'custom theming',
              identityClass: 'evolving',
              synonyms: ['white label'],
            },
          ],
        },
        constraints: [
          {
            id: 'no-dev-integration',
            identityClass: 'core',
            concept: 'developer integration',
            relationship: 'must-not-require',
            detectionPatterns: ['requires developer', 'developer must'],
          },
        ],
        antiPatterns: [
          {
            id: 'wizard',
            identityClass: 'core',
            label: 'multi-step wizard',
            detectionPatterns: ['setup wizard', 'step 1 of'],
          },
        ],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Avoid jargon and dense forms.',
            identityClass: 'core',
            measurableSignals: [
              {
                id: 'time-to-value',
                metric: 'secondsToFirstValue',
                threshold: 60,
                operator: 'lte',
              },
            ],
            antiPatterns: [
              {
                id: 'jargon',
                identityClass: 'evolving',
                label: 'unexplained jargon',
                detectionPatterns: ['API token'],
              },
            ],
          },
        ],
      },
      brandIdentity: {
        voiceAntiPatterns: [
          {
            id: 'corporate',
            identityClass: 'evolving',
            label: 'corporate voice',
            detectionPatterns: ['leveraging synergies'],
          },
        ],
        visualIdentity: {
          visualAntiPatterns: [
            {
              id: 'glossy',
              identityClass: 'evolving',
              label: 'glossy gradient',
              detectionPatterns: ['gradient background'],
            },
          ],
        },
      },
      designSystemRef: { name: 'acme-ds' },
      ...overrides,
    },
  };
}

describe('checkScopeGate', () => {
  it('AC #1: core out-of-scope synonym match → hardGated=true', () => {
    const compiled = compileDid(makeDid());
    const result = checkScopeGate('Add SAML federation support for enterprise customers', compiled);
    expect(result.hardGated).toBe(true);
    expect(result.outOfScopeHits).toHaveLength(1);
    expect(result.outOfScopeHits[0].label).toBe('enterprise SSO');
    expect(result.outOfScopeHits[0].identityClass).toBe('core');
  });

  it('AC #2: evolving out-of-scope match → hardGated=false + warning', () => {
    const compiled = compileDid(makeDid());
    const result = checkScopeGate('Add white label theming support', compiled);
    expect(result.hardGated).toBe(false);
    expect(result.warnings.length).toBe(1);
    expect(result.outOfScopeHits[0].identityClass).toBe('evolving');
  });

  it('returns clean result when no scope terms match', () => {
    const compiled = compileDid(makeDid());
    const result = checkScopeGate('Add inventory count on dashboard', compiled);
    expect(result.hardGated).toBe(false);
    expect(result.outOfScopeHits).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('does NOT trigger on partial-word matches', () => {
    const compiled = compileDid(makeDid());
    const result = checkScopeGate('something prefixSAMLsuffix here', compiled);
    expect(result.outOfScopeHits).toEqual([]);
  });

  it('records inScopeHits when the issue mentions an in-scope label or synonym', () => {
    const did = makeDid({
      soulPurpose: {
        mission: { value: 'm' },
        scopeBoundaries: {
          inScope: [
            { label: 'customer onboarding', synonyms: ['account signup'] },
            { label: 'payment processing', identityClass: 'core' },
          ],
        },
        designPrinciples: [
          {
            id: 'p',
            name: 'P',
            description: 'd',
            measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
          },
        ],
      },
    });
    const compiled = compileDid(did);
    const result = checkScopeGate('Improve account signup flow with card payments', compiled);
    expect(result.inScopeHits).toHaveLength(1);
    expect(result.inScopeHits[0].label).toBe('customer onboarding');
    expect(result.inScopeHits[0].synonym).toBe('account signup');
    expect(result.hardGated).toBe(false);
  });

  it('recognises inScope matches via the label itself (no synonym)', () => {
    const did = makeDid({
      soulPurpose: {
        mission: { value: 'm' },
        scopeBoundaries: {
          inScope: [{ label: 'payments', identityClass: 'core' }],
        },
        designPrinciples: [
          {
            id: 'p',
            name: 'P',
            description: 'd',
            measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
          },
        ],
      },
    });
    const compiled = compileDid(did);
    const result = checkScopeGate('Add payments retry logic', compiled);
    expect(result.inScopeHits).toHaveLength(1);
    expect(result.inScopeHits[0].label).toBe('payments');
    expect(result.inScopeHits[0].synonym).toBeUndefined();
  });
});

describe('detectConstraintViolations', () => {
  it('AC #3: core constraint violation via depparse match increments count', async () => {
    const compiled = compileDid(makeDid());
    const client = new FakeDepparseClient();
    client.setResponse({
      matches: [
        {
          pattern: 'requires developer',
          matchedText: 'requires developer',
          depPath: ['dobj'],
          construction: 'dobj(require)',
        },
      ],
    });
    const result = await detectConstraintViolations(
      'This feature requires developer involvement.',
      compiled,
      client,
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].constraintId).toBe('no-dev-integration');
    expect(result.violations[0].identityClass).toBe('core');
    expect(result.depparseSkipped).toBe(false);
  });

  it('skips silently when depparse returns model-unavailable', async () => {
    const compiled = compileDid(makeDid());
    const client = {
      match: async () => {
        throw new DepparseError('model-unavailable', 'nope', 503);
      },
      healthz: async () => ({ status: 'ok', modelLoaded: false }),
    };
    const result = await detectConstraintViolations('x', compiled, client);
    expect(result.violations).toEqual([]);
    expect(result.depparseSkipped).toBe(true);
  });

  it('propagates non-recoverable errors (bad-request)', async () => {
    const compiled = compileDid(makeDid());
    const client = {
      match: async () => {
        throw new DepparseError('bad-request', 'bad json', 400);
      },
      healthz: async () => ({ status: 'ok', modelLoaded: false }),
    };
    await expect(detectConstraintViolations('x', compiled, client)).rejects.toBeInstanceOf(
      DepparseError,
    );
  });

  it('returns no violations for must-require constraints (positive only)', async () => {
    const did = makeDid();
    did.spec.soulPurpose.constraints = [
      {
        id: 'needs-consent',
        concept: 'user consent',
        relationship: 'must-require',
        detectionPatterns: ['user consent'],
      },
    ];
    const compiled = compileDid(did);
    const client = new FakeDepparseClient();
    client.setResponse({
      matches: [
        {
          pattern: 'user consent',
          matchedText: 'user consent',
          depPath: [],
          construction: 'substring',
        },
      ],
    });
    const result = await detectConstraintViolations('Gets user consent', compiled, client);
    // Positive constraints are checked via measurable signals, not depparse violations.
    expect(result.violations).toEqual([]);
  });
});

describe('detectAntiPatterns', () => {
  it('matches product-level antiPatterns', () => {
    const compiled = compileDid(makeDid());
    const { product, design } = detectAntiPatterns(
      'Introduce a setup wizard for new onboarding flow.',
      compiled,
    );
    expect(product.hits).toHaveLength(1);
    expect(product.hits[0].scope).toBe('product');
    expect(design.hits).toEqual([]);
  });

  it('matches per-principle antiPatterns with principleId', () => {
    const compiled = compileDid(makeDid());
    const { design } = detectAntiPatterns(
      'Users must manage their API token configuration manually.',
      compiled,
    );
    const principleHit = design.hits.find((h) => h.scope === 'design-principle');
    expect(principleHit).toBeDefined();
    expect(principleHit!.principleId).toBe('approachable');
  });

  it('matches voice and visual antiPatterns into the design bucket', () => {
    const compiled = compileDid(makeDid());
    const { design } = detectAntiPatterns(
      'Leveraging synergies with a gradient background design.',
      compiled,
    );
    const scopes = design.hits.map((h) => h.scope);
    expect(scopes).toContain('voice');
    expect(scopes).toContain('visual');
  });

  it('returns empty when no anti-pattern matches', () => {
    const compiled = compileDid(makeDid());
    const { product, design } = detectAntiPatterns('plain boring text', compiled);
    expect(product.hits).toEqual([]);
    expect(design.hits).toEqual([]);
  });
});

describe('checkMeasurableSignals', () => {
  it('returns pass when observed value satisfies operator', () => {
    const compiled = compileDid(makeDid());
    const result = checkMeasurableSignals({ secondsToFirstValue: 30 }, compiled);
    const check = result.checks.find((c) => c.id === 'time-to-value');
    expect(check!.status).toBe('pass');
    expect(result.coreFailureCount).toBe(0);
  });

  it('returns fail and increments coreFailureCount for core signal', () => {
    const compiled = compileDid(makeDid());
    const result = checkMeasurableSignals({ secondsToFirstValue: 120 }, compiled);
    const check = result.checks.find((c) => c.id === 'time-to-value');
    expect(check!.status).toBe('fail');
    expect(result.coreFailureCount).toBe(1);
  });

  it('returns missing when observed value absent', () => {
    const compiled = compileDid(makeDid());
    const result = checkMeasurableSignals({}, compiled);
    const check = result.checks.find((c) => c.id === 'time-to-value');
    expect(check!.status).toBe('missing');
    expect(result.coreFailureCount).toBe(0);
  });

  it('evaluates all numeric operators (gte/lte/gt/lt/eq/neq) and defaults unknown to fail', () => {
    const didWithOps = makeDid({
      soulPurpose: {
        mission: { value: 'm' },
        designPrinciples: [
          {
            id: 'p',
            name: 'P',
            description: 'd',
            measurableSignals: [
              { id: 'op-gte', metric: 'valGte', threshold: 10, operator: 'gte' },
              { id: 'op-lte', metric: 'valLte', threshold: 10, operator: 'lte' },
              { id: 'op-gt', metric: 'valGt', threshold: 10, operator: 'gt' },
              { id: 'op-lt', metric: 'valLt', threshold: 10, operator: 'lt' },
              { id: 'op-eq', metric: 'valEq', threshold: 10, operator: 'eq' },
              { id: 'op-neq', metric: 'valNeq', threshold: 10, operator: 'neq' },
              {
                id: 'op-unknown',
                metric: 'valUnknown',
                threshold: 10,
                operator: 'bogus' as never,
              },
            ],
          },
        ],
      },
    });
    const compiled = compileDid(didWithOps);
    const result = checkMeasurableSignals(
      {
        valGte: 11, // passes >= 10
        valLte: 9, // passes <= 10
        valGt: 11, // passes > 10
        valLt: 9, // passes < 10
        valEq: 10, // passes == 10
        valNeq: 11, // passes != 10
        valUnknown: 10, // unknown operator — defaults to fail
      },
      compiled,
    );
    const byId = new Map(result.checks.map((c) => [c.id, c]));
    expect(byId.get('op-gte')!.status).toBe('pass');
    expect(byId.get('op-lte')!.status).toBe('pass');
    expect(byId.get('op-gt')!.status).toBe('pass');
    expect(byId.get('op-lt')!.status).toBe('pass');
    expect(byId.get('op-eq')!.status).toBe('pass');
    expect(byId.get('op-neq')!.status).toBe('pass');
    expect(byId.get('op-unknown')!.status).toBe('fail');
  });
});

describe('runLayer1 — end-to-end integration', () => {
  it('aggregates results and sets hardGated on core scope fail', async () => {
    const compiled = compileDid(makeDid());
    const result = await runLayer1({
      issueText: 'Add SAML support for enterprise and a setup wizard.',
      compiled,
      depparse: new FakeDepparseClient(),
    });
    expect(result.hardGated).toBe(true);
    expect(result.coreViolationCount).toBeGreaterThan(0);
    expect(result.preVerifiedSummary).toContain('Hard gated: yes');
  });

  it('returns non-gated result on clean text', async () => {
    const compiled = compileDid(makeDid());
    const result = await runLayer1({
      issueText: 'Add inventory sync via webhook for internal analytics.',
      compiled,
      depparse: new FakeDepparseClient(),
    });
    expect(result.hardGated).toBe(false);
    expect(result.coreViolationCount).toBe(0);
  });

  it('counts evolving vs core violations separately', async () => {
    const compiled = compileDid(makeDid());
    const result = await runLayer1({
      issueText: 'Add white label theming with leveraging synergies and gradient background.',
      compiled,
      depparse: new FakeDepparseClient(),
    });
    expect(result.evolvingViolationCount).toBeGreaterThan(0);
    expect(result.hardGated).toBe(false);
  });
});

describe('renderPreVerifiedSummary (AC #4)', () => {
  it('matches the §B.6.1 template shape (snapshot)', () => {
    const summary = renderPreVerifiedSummary({
      scopeGate: {
        inScopeHits: [],
        outOfScopeHits: [
          {
            label: 'enterprise SSO',
            synonym: 'SAML',
            identityClass: 'core',
            matchedText: 'SAML',
          },
        ],
        hardGated: true,
        warnings: [],
      },
      constraintViolations: {
        violations: [
          {
            constraintId: 'no-dev-integration',
            concept: 'developer integration',
            relationship: 'must-not-require',
            pattern: 'requires developer',
            matchedText: 'requires developer',
            construction: 'dobj(require)',
            identityClass: 'core',
          },
        ],
        depparseSkipped: false,
      },
      product: { hits: [] },
      design: { hits: [] },
      measurable: { checks: [], coreFailureCount: 0 },
      hardGated: true,
      coreViolationCount: 2,
      evolvingViolationCount: 0,
    });

    // Template sections present in order.
    const h1 = summary.indexOf('## Deterministic verification');
    const scope = summary.indexOf('### Scope gate');
    const constraints = summary.indexOf('### Constraint violations');
    const anti = summary.indexOf('### Anti-pattern hits');
    const signals = summary.indexOf('### Measurable signals');
    expect(h1).toBeLessThan(scope);
    expect(scope).toBeLessThan(constraints);
    expect(constraints).toBeLessThan(anti);
    expect(anti).toBeLessThan(signals);

    // Specific content checks
    expect(summary).toContain('Hard gated: yes');
    expect(summary).toContain('Core violations: 2');
    expect(summary).toContain('Evolving violations: 0');
    expect(summary).toContain('enterprise SSO');
    expect(summary).toContain('via "SAML"');
    expect(summary).toContain('no-dev-integration');
    expect(summary).toContain('dobj(require)');
  });

  it('emits "None detected" placeholders for empty sections', () => {
    const summary = renderPreVerifiedSummary({
      scopeGate: { inScopeHits: [], outOfScopeHits: [], hardGated: false, warnings: [] },
      constraintViolations: { violations: [], depparseSkipped: false },
      product: { hits: [] },
      design: { hits: [] },
      measurable: { checks: [], coreFailureCount: 0 },
      hardGated: false,
      coreViolationCount: 0,
      evolvingViolationCount: 0,
    });
    expect(summary).toContain('No out-of-scope hits');
    expect(summary).toContain('### Constraint violations\n- None detected');
    expect(summary).toContain('### Anti-pattern hits\n- None detected');
    expect(summary).toContain('No failing signals');
  });

  it('surfaces depparse-skipped note when sidecar was unavailable', () => {
    const summary = renderPreVerifiedSummary({
      scopeGate: { inScopeHits: [], outOfScopeHits: [], hardGated: false, warnings: [] },
      constraintViolations: { violations: [], depparseSkipped: true },
      product: { hits: [] },
      design: { hits: [] },
      measurable: { checks: [], coreFailureCount: 0 },
      hardGated: false,
      coreViolationCount: 0,
      evolvingViolationCount: 0,
    });
    expect(summary).toContain('depparse sidecar unavailable');
  });

  it('lists failing measurable signals with operator, threshold, and observed value', () => {
    const summary = renderPreVerifiedSummary({
      scopeGate: { inScopeHits: [], outOfScopeHits: [], hardGated: false, warnings: [] },
      constraintViolations: { violations: [], depparseSkipped: false },
      product: { hits: [] },
      design: { hits: [] },
      measurable: {
        checks: [
          {
            id: 'time-to-value',
            metric: 'secondsToFirstValue',
            threshold: 60,
            operator: 'lte',
            observedValue: 120,
            identityClass: 'core',
            status: 'fail',
          },
          {
            id: 'margin',
            metric: 'grossMargin',
            threshold: 0.3,
            operator: 'gte',
            identityClass: 'evolving',
            status: 'missing',
          },
          {
            id: 'uptime',
            metric: 'uptime',
            threshold: 0.99,
            operator: 'gte',
            observedValue: 0.999,
            identityClass: 'core',
            status: 'pass',
          },
        ],
        coreFailureCount: 1,
      },
      hardGated: false,
      coreViolationCount: 1,
      evolvingViolationCount: 0,
    });
    expect(summary).toContain('time-to-value');
    expect(summary).toContain('secondsToFirstValue lte 60');
    expect(summary).toContain('observed 120');
    // Only failing signals appear in the list.
    expect(summary).not.toContain('margin (grossMargin');
    expect(summary).not.toContain('uptime (uptime');
  });

  it('renders observed="n/a" when a failing check has no observedValue', () => {
    const summary = renderPreVerifiedSummary({
      scopeGate: { inScopeHits: [], outOfScopeHits: [], hardGated: false, warnings: [] },
      constraintViolations: { violations: [], depparseSkipped: false },
      product: { hits: [] },
      design: { hits: [] },
      measurable: {
        checks: [
          {
            id: 'x',
            metric: 'x',
            threshold: 1,
            operator: 'gte',
            identityClass: 'core',
            status: 'fail',
          },
        ],
        coreFailureCount: 1,
      },
      hardGated: false,
      coreViolationCount: 1,
      evolvingViolationCount: 0,
    });
    expect(summary).toContain('observed n/a');
  });
});
