/**
 * RFC-0018 Phase 5 — WCAG version evolution (AISDLC-469, OQ-7).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import {
  WCAG_VERSIONS,
  WCAG_VERSION_SUPERSEDED_DECISION_KIND,
  evaluateWcagVersion,
  computeJourneyScopedScores,
  type JourneyContext,
  type JourneyDeclaration,
} from './journey-sa2-router.js';

const schema = JSON.parse(
  readFileSync(new URL('../../spec/schemas/journey.v1.schema.json', import.meta.url), 'utf8'),
) as { properties: { accessibility: { properties: { wcagVersion: { enum: string[] } } } } };

function ctxFor(version: (typeof WCAG_VERSIONS)[number]): JourneyContext {
  const journey: JourneyDeclaration = {
    id: 'j',
    scope: 'soul',
    completionCriteria: { kind: 'terminal-success-state', target: 'done' },
    accessibility: { wcagLevel: 'AAA', wcagVersion: version, conformanceTarget: 100 },
    successMetrics: [],
  } as JourneyDeclaration;
  return {
    journeysBySoul: { s: [journey] },
    workItemTargeting: [{ id: 'T-1', targetedJourneys: ['s/j'] }],
    journeyScores: {},
  } as unknown as JourneyContext;
}

describe('additive wcagVersion enum (AC #1)', () => {
  it('keeps existing versions and appends new ones', () => {
    expect(WCAG_VERSIONS).toEqual(['2.0', '2.1', '2.2', '3.0']);
  });
  it('schema enum matches the router list', () => {
    expect(schema.properties.accessibility.properties.wcagVersion.enum).toEqual([...WCAG_VERSIONS]);
  });
});

describe('wcag-version-superseded Decision (AC #2)', () => {
  it('emits a low-severity advisory for 2.0', () => {
    const d = evaluateWcagVersion('2.0');
    expect(d).not.toBeNull();
    expect(d?.kind).toBe(WCAG_VERSION_SUPERSEDED_DECISION_KIND);
    expect(d?.kind).toBe('wcag-version-superseded');
    expect(d?.severity).toBe('low');
    expect(d?.advisory).toBe(true);
    expect(d?.declaredVersion).toBe('2.0');
  });
  it.each(['2.1', '2.2', '3.0', 'bogus'])('emits nothing for %s', (v) => {
    expect(evaluateWcagVersion(v)).toBeNull();
  });
});

describe('no Eρ₅ impact (AC #3)', () => {
  it('scores are identical regardless of declared wcagVersion', () => {
    const strip = (r: ReturnType<typeof computeJourneyScopedScores>) => ({
      sa2: r.sa2,
      ck: r.ck,
      er5Elevated: r.er5Elevated,
    });
    const base = strip(computeJourneyScopedScores('T-1', 0.5, 0.5, false, ctxFor('2.2')));
    for (const v of WCAG_VERSIONS) {
      expect(strip(computeJourneyScopedScores('T-1', 0.5, 0.5, false, ctxFor(v)))).toEqual(base);
    }
  });
});

describe('runtime wiring through computeJourneyScopedScores (AC #2)', () => {
  it('surfaces the advisory for a targeted WCAG 2.0 journey', () => {
    const r = computeJourneyScopedScores('T-1', 0.5, 0.5, false, ctxFor('2.0'));
    expect(r.advisories).toHaveLength(1);
    expect(r.advisories[0].kind).toBe('wcag-version-superseded');
    expect(r.advisories[0].severity).toBe('low');
  });
  it('surfaces no advisory for non-superseded versions or untargeted items', () => {
    expect(computeJourneyScopedScores('T-1', 0.5, 0.5, false, ctxFor('2.2')).advisories).toEqual(
      [],
    );
    expect(computeJourneyScopedScores('T-9', 0.5, 0.5, false, ctxFor('2.0')).advisories).toEqual(
      [],
    );
  });
});

describe('WCAG 3.0 forward-compat (AC #4, #5)', () => {
  it('accepts 3.0 without a superseded advisory', () => {
    expect(evaluateWcagVersion('3.0')).toBeNull();
  });
  it('doc publishes the scoring-model shift', () => {
    const doc = readFileSync(
      new URL('../../docs/operations/wcag-version-evolution.md', import.meta.url),
      'utf8',
    );
    expect(doc).toContain('wcag-version-superseded');
    expect(doc).toContain('scoringModel');
    expect(doc).toMatch(/binary/i);
    expect(doc).toMatch(/graduated/i);
  });
});
