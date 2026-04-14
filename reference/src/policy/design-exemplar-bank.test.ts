import { describe, it, expect } from 'vitest';
import {
  createExemplarBank,
  parseExemplarsFromYaml,
  DESIGN_REVIEW_PRINCIPLES,
  type DesignExemplar,
} from './design-exemplar-bank.js';

const sampleExemplars: DesignExemplar[] = [
  {
    id: 'submit-button-below-fold',
    type: 'true-positive',
    category: 'discoverability',
    scenario: 'Submit button below fold on mobile',
    verdict: 'major — primary CTA not discoverable',
    principle: 'evidence-first',
    confidence: 0.88,
  },
  {
    id: 'hover-state-missing-mobile',
    type: 'false-positive',
    category: 'affordance',
    scenario: 'Card has no hover state in mobile-only context',
    verdict: 'not a usability issue — context is mobile-only',
    principle: 'context-awareness',
  },
  {
    id: 'keyboard-trap-modal',
    type: 'true-positive',
    category: 'navigation',
    scenario: 'Focus not trapped in modal dialog',
    verdict: 'critical — keyboard users cannot complete task',
    principle: 'evidence-first',
    confidence: 0.95,
  },
  {
    id: 'aesthetic-spacing',
    type: 'false-positive',
    category: 'affordance',
    scenario: 'Spacing conforms to tokens but "feels tight"',
    verdict: 'not a usability issue — spacing conforms to design system tokens',
    principle: 'deterministic-first',
  },
  {
    id: 'borderline-form-steps',
    type: 'borderline',
    category: 'efficiency',
    scenario: 'Agent took 8 actions for 5-field form',
    verdict: 'not a usability issue — exploratory behavior is expected',
    principle: 'severity-honesty',
  },
];

describe('DESIGN_REVIEW_PRINCIPLES', () => {
  it('has 7 principles', () => {
    expect(DESIGN_REVIEW_PRINCIPLES).toHaveLength(7);
  });

  it('each has id, name, description', () => {
    for (const p of DESIGN_REVIEW_PRINCIPLES) {
      expect(p.id).toBeDefined();
      expect(p.name).toBeDefined();
      expect(p.description.length).toBeGreaterThan(0);
    }
  });
});

describe('createExemplarBank', () => {
  it('returns all exemplars', () => {
    const bank = createExemplarBank(sampleExemplars);
    expect(bank.getAll()).toHaveLength(5);
  });

  it('filters by category', () => {
    const bank = createExemplarBank(sampleExemplars);
    const affordance = bank.getByCategory('affordance');
    expect(affordance).toHaveLength(2);
  });

  it('filters by type', () => {
    const bank = createExemplarBank(sampleExemplars);
    expect(bank.getByType('true-positive')).toHaveLength(2);
    expect(bank.getByType('false-positive')).toHaveLength(2);
    expect(bank.getByType('borderline')).toHaveLength(1);
  });

  it('filters by principle', () => {
    const bank = createExemplarBank(sampleExemplars);
    expect(bank.getByPrinciple('evidence-first')).toHaveLength(2);
    expect(bank.getByPrinciple('context-awareness')).toHaveLength(1);
  });

  it('looks up by ID', () => {
    const bank = createExemplarBank(sampleExemplars);
    const e = bank.getById('keyboard-trap-modal');
    expect(e).toBeDefined();
    expect(e!.confidence).toBe(0.95);
  });

  it('returns undefined for unknown ID', () => {
    const bank = createExemplarBank(sampleExemplars);
    expect(bank.getById('nonexistent')).toBeUndefined();
  });

  it('returns principles', () => {
    const bank = createExemplarBank();
    expect(bank.getPrinciples()).toHaveLength(7);
  });

  it('adds new exemplars', () => {
    const bank = createExemplarBank([]);
    bank.addExemplar(sampleExemplars[0]);
    expect(bank.getAll()).toHaveLength(1);
  });

  it('counts by type', () => {
    const bank = createExemplarBank(sampleExemplars);
    const counts = bank.countByType();
    expect(counts['true-positive']).toBe(2);
    expect(counts['false-positive']).toBe(2);
    expect(counts.borderline).toBe(1);
  });
});

describe('parseExemplarsFromYaml', () => {
  it('parses YAML-like structure', () => {
    const data = {
      exemplars: [
        {
          id: 'test-1',
          type: 'true-positive',
          category: 'navigation',
          scenario: 'Test scenario',
          verdict: 'Test verdict',
          principle: 'evidence-first',
          confidence: 0.9,
        },
      ],
    };
    const result = parseExemplarsFromYaml(data);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-1');
    expect(result[0].type).toBe('true-positive');
    expect(result[0].confidence).toBe(0.9);
  });
});
