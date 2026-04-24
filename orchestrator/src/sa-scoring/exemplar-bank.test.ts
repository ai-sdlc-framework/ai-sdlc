import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MIN_TOTAL_EXEMPLARS,
  computeLayerPrecision,
  loadExemplarBank,
  validatePhase2bExemplars,
  type SaExemplar,
  type SaExemplarBank,
} from './exemplar-bank.js';

const BASE_EXEMPLAR_YAML = `
exemplars:
  - id: sa1-tp-1
    dimension: SA-1
    type: true-positive
    issue:
      title: Brand config overlap
      body: Update brand tokens to new theming vocabulary
    layer1Expected:
      hardGated: false
      coreViolationCount: 0
    layer2Expected:
      domainRelevance: 0.72
    verdict: admit
  - id: sa1-fp-1
    dimension: SA-1
    type: false-positive
    issue:
      title: Add SAML federation
      body: Add SAML enterprise SSO support
    layer1Expected:
      hardGated: true
    verdict: reject
  - id: sa2-tp-1
    dimension: SA-2
    type: true-positive
    issue:
      title: Simplify onboarding form
      body: Remove optional fields from the signup form
    layer2Expected:
      overallCoverage: 0.8
    verdict: admit
    principle: approachable
  - id: sa2-fp-1
    dimension: SA-2
    type: false-positive
    issue:
      title: Heavy drop shadow
      body: Add heavy drop shadow on all containers
    verdict: reject
    principle: visual
  - id: sa2-tn-1
    dimension: SA-2
    type: true-negative
    issue:
      title: Internal dashboard metric
      body: Add new internal analytics panel
    verdict: admit
`;

let tempDir: string;
let filePath: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'sa-exemplars-'));
  filePath = join(tempDir, 'sa-exemplars.yaml');
});

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true });
  } catch {
    // ignore
  }
});

describe('loadExemplarBank', () => {
  it('AC #2: returns { sa1: [], sa2: [] } when file missing', () => {
    const bank = loadExemplarBank(join(tempDir, 'missing.yaml'));
    expect(bank.sa1).toEqual([]);
    expect(bank.sa2).toEqual([]);
  });

  it('partitions exemplars by dimension', () => {
    writeFileSync(filePath, BASE_EXEMPLAR_YAML);
    const bank = loadExemplarBank(filePath);
    expect(bank.sa1).toHaveLength(2);
    expect(bank.sa2).toHaveLength(3);
    expect(bank.sa1.every((e) => e.dimension === 'SA-1')).toBe(true);
    expect(bank.sa2.every((e) => e.dimension === 'SA-2')).toBe(true);
  });

  it('preserves expected-layer fields for precision tracking', () => {
    writeFileSync(filePath, BASE_EXEMPLAR_YAML);
    const bank = loadExemplarBank(filePath);
    const tp = bank.sa1.find((e) => e.id === 'sa1-tp-1')!;
    expect(tp.layer1Expected?.hardGated).toBe(false);
    expect(tp.layer2Expected?.domainRelevance).toBe(0.72);
  });

  it('throws on missing required field', () => {
    writeFileSync(
      filePath,
      `exemplars:
  - id: bad
    dimension: SA-1
    type: true-positive
    verdict: admit
`,
    );
    expect(() => loadExemplarBank(filePath)).toThrow(/issue/);
  });

  it('throws on invalid dimension enum', () => {
    writeFileSync(
      filePath,
      `exemplars:
  - id: bad
    dimension: SA-X
    type: true-positive
    issue: { title: t, body: b }
    verdict: admit
`,
    );
    expect(() => loadExemplarBank(filePath)).toThrow(/dimension/);
  });

  it('throws on invalid type enum', () => {
    writeFileSync(
      filePath,
      `exemplars:
  - id: bad
    dimension: SA-1
    type: unknown
    issue: { title: t, body: b }
    verdict: admit
`,
    );
    expect(() => loadExemplarBank(filePath)).toThrow(/type/);
  });

  it('throws on malformed YAML', () => {
    // Unbalanced braces break the YAML lexer.
    writeFileSync(filePath, 'exemplars: {broken: [unclosed');
    expect(() => loadExemplarBank(filePath)).toThrow(/Failed to parse/);
  });

  it('throws when top-level exemplars missing', () => {
    writeFileSync(filePath, 'something: else');
    expect(() => loadExemplarBank(filePath)).toThrow(/exemplars/);
  });

  it('throws when exemplars is not an array', () => {
    writeFileSync(filePath, 'exemplars: not-a-list');
    expect(() => loadExemplarBank(filePath)).toThrow(/array/);
  });
});

describe('validatePhase2bExemplars', () => {
  function buildBank(samples: SaExemplar[]): SaExemplarBank {
    const sa1 = samples.filter((s) => s.dimension === 'SA-1');
    const sa2 = samples.filter((s) => s.dimension === 'SA-2');
    return { sa1, sa2 };
  }

  function ex(overrides: Partial<SaExemplar>): SaExemplar {
    return {
      id: 'x',
      dimension: 'SA-1',
      type: 'true-positive',
      issue: { title: 't', body: 'b' },
      verdict: 'admit',
      ...overrides,
    };
  }

  it('AC #3: flags total < 5, missing TP, missing FP', () => {
    const bank = buildBank([
      ex({ id: '1', dimension: 'SA-1', type: 'true-negative' }),
      ex({ id: '2', dimension: 'SA-2', type: 'true-negative' }),
    ]);
    const result = validatePhase2bExemplars(bank);
    expect(result.ready).toBe(false);
    const reasons = result.gaps.map((g) => g.reason);
    expect(reasons.some((r) => r.includes('≥5 exemplars total'))).toBe(true);
    expect(reasons.some((r) => r.includes('SA-1 needs ≥1 true-positive'))).toBe(true);
    expect(reasons.some((r) => r.includes('SA-2 needs ≥1 true-positive'))).toBe(true);
    expect(reasons.some((r) => r.includes('SA-1 needs ≥1 false-positive'))).toBe(true);
    expect(reasons.some((r) => r.includes('SA-2 needs ≥1 false-positive'))).toBe(true);
  });

  it('flags entire missing dimension', () => {
    const bank = buildBank([
      ex({ id: '1', dimension: 'SA-1', type: 'true-positive' }),
      ex({ id: '2', dimension: 'SA-1', type: 'false-positive' }),
      ex({ id: '3', dimension: 'SA-1', type: 'true-negative' }),
      ex({ id: '4', dimension: 'SA-1', type: 'true-negative' }),
      ex({ id: '5', dimension: 'SA-1', type: 'true-negative' }),
    ]);
    const result = validatePhase2bExemplars(bank);
    expect(result.ready).toBe(false);
    expect(result.gaps.some((g) => g.dimension === 'SA-2')).toBe(true);
  });

  it('AC #3: passes when ≥5 total + both dims have TP + FP', () => {
    const bank = buildBank([
      ex({ id: '1', dimension: 'SA-1', type: 'true-positive' }),
      ex({ id: '2', dimension: 'SA-1', type: 'false-positive' }),
      ex({ id: '3', dimension: 'SA-2', type: 'true-positive' }),
      ex({ id: '4', dimension: 'SA-2', type: 'false-positive' }),
      ex({ id: '5', dimension: 'SA-2', type: 'true-negative' }),
    ]);
    const result = validatePhase2bExemplars(bank);
    expect(result.ready).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('constant matches spec minimum', () => {
    expect(MIN_TOTAL_EXEMPLARS).toBe(5);
  });
});

describe('computeLayerPrecision', () => {
  it('computes precision + recall correctly', () => {
    const ex = (dimension: 'SA-1' | 'SA-2', type: SaExemplar['type']): SaExemplar => ({
      id: `${dimension}-${type}`,
      dimension,
      type,
      issue: { title: 't', body: 'b' },
      verdict: 'admit',
    });
    const exemplars: SaExemplar[] = [
      ex('SA-1', 'true-positive'),
      ex('SA-1', 'true-positive'),
      ex('SA-1', 'false-positive'),
      ex('SA-1', 'true-negative'),
      ex('SA-1', 'false-negative'),
    ];
    const p = computeLayerPrecision(exemplars);
    expect(p.truePositives).toBe(2);
    expect(p.falsePositives).toBe(1);
    expect(p.trueNegatives).toBe(1);
    expect(p.falseNegatives).toBe(1);
    expect(p.precision).toBeCloseTo(2 / 3, 6);
    expect(p.recall).toBeCloseTo(2 / 3, 6);
  });

  it('handles empty list', () => {
    const p = computeLayerPrecision([]);
    expect(p.precision).toBe(0);
    expect(p.recall).toBe(0);
  });

  it('handles no TP+FP (all TN+FN)', () => {
    const ex = (type: SaExemplar['type']): SaExemplar => ({
      id: type,
      dimension: 'SA-1',
      type,
      issue: { title: 't', body: 'b' },
      verdict: 'admit',
    });
    const p = computeLayerPrecision([ex('true-negative'), ex('false-negative')]);
    expect(p.precision).toBe(0);
    expect(p.recall).toBe(0);
  });
});

describe('AC #1: schema validates §B.6.4 example exemplars', () => {
  // Load the loader (same validation codepath as the schema).
  it('3 example exemplars per §B.6.4 round-trip through the loader', () => {
    const yaml = `exemplars:
  - id: brand-config-vocabulary-overlap
    dimension: SA-1
    type: true-positive
    issue:
      title: Brand configuration vocabulary overlap
      body: Update tokens for theming vocabulary overlap
    layer2Expected:
      domainRelevance: 0.72
    verdict: admit
  - id: unrelated-saml
    dimension: SA-1
    type: false-positive
    issue:
      title: SAML federation
      body: Add SAML single-sign-on for enterprise customers
    layer1Expected:
      hardGated: true
    verdict: reject
  - id: principle-approachable
    dimension: SA-2
    type: true-positive
    issue:
      title: Simplify onboarding
      body: Reduce mandatory fields in signup flow
    layer3Expected:
      principleAlignment: 0.85
      reasoning: aligns with approachable principle
    verdict: admit
    principle: approachable
`;
    writeFileSync(filePath, yaml);
    const bank = loadExemplarBank(filePath);
    expect(bank.sa1).toHaveLength(2);
    expect(bank.sa2).toHaveLength(1);
    expect(bank.sa2[0].layer3Expected?.principleAlignment).toBe(0.85);
  });
});
