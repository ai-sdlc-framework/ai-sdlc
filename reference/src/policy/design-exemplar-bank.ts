/**
 * Design Review Exemplar Bank (RFC-0006 Addendum A §A.6).
 *
 * Loads labeled examples from YAML and provides lookup for
 * calibrating AI and human design reviewers.
 */

// ── The 7 Design Review Principles ───────────────────────────────────

export const DESIGN_REVIEW_PRINCIPLES = [
  {
    id: 'evidence-first',
    name: 'Evidence-First',
    description:
      "Trace the user's path or don't flag it. A usability issue without an action trace is not a valid finding.",
  },
  {
    id: 'deterministic-first',
    name: 'Deterministic-First',
    description:
      'Defer to Design CI for accessibility, tokens, spacing, type scale, state completeness. Do not duplicate automated checks.',
  },
  {
    id: 'context-awareness',
    name: 'Context Awareness',
    description:
      'Evaluate the component in its page/flow context, not just in isolation. A component that works in Storybook but breaks visual rhythm on the actual page is a valid finding.',
  },
  {
    id: 'severity-honesty',
    name: 'Severity Honesty',
    description:
      'No failure scenario = not critical/major. If the agent completed the task but took one extra step, that is minor at most.',
  },
  {
    id: 'signal-over-noise',
    name: 'Signal Over Noise',
    description:
      'One well-evidenced usability finding is worth more than ten vague aesthetic observations.',
  },
  {
    id: 'persona-grounding',
    name: 'Persona Grounding',
    description:
      'Findings must specify which persona type experienced the issue. A finding that only affects a high-tech-confidence persona interacting non-standardly is advisory, not major.',
  },
  {
    id: 'scope-discipline',
    name: 'Scope Discipline',
    description:
      "Don't flag design choices that are consistent with the established design language. The simulation tests usability, not aesthetic preference.",
  },
] as const;

export type PrincipleId = (typeof DESIGN_REVIEW_PRINCIPLES)[number]['id'];

// ── Exemplar Types ───────────────────────────────────────────────────

export interface DesignExemplar {
  id: string;
  type: 'true-positive' | 'false-positive' | 'borderline';
  category: string;
  scenario: string;
  verdict: string;
  principle: PrincipleId;
  confidence?: number;
  note?: string;
}

export interface ExemplarBank {
  /** Get all exemplars. */
  getAll(): DesignExemplar[];
  /** Get exemplars by category. */
  getByCategory(category: string): DesignExemplar[];
  /** Get exemplars by type (true-positive, false-positive, borderline). */
  getByType(type: DesignExemplar['type']): DesignExemplar[];
  /** Get exemplars by principle. */
  getByPrinciple(principle: PrincipleId): DesignExemplar[];
  /** Lookup a specific exemplar by ID. */
  getById(id: string): DesignExemplar | undefined;
  /** Get the 7 design review principles. */
  getPrinciples(): typeof DESIGN_REVIEW_PRINCIPLES;
  /** Add a new exemplar (e.g., from feedback flywheel). */
  addExemplar(exemplar: DesignExemplar): void;
  /** Get count by type. */
  countByType(): Record<DesignExemplar['type'], number>;
}

/**
 * Create an exemplar bank from a list of exemplars.
 */
export function createExemplarBank(exemplars: DesignExemplar[] = []): ExemplarBank {
  const bank = [...exemplars];

  return {
    getAll() {
      return [...bank];
    },

    getByCategory(category) {
      return bank.filter((e) => e.category === category);
    },

    getByType(type) {
      return bank.filter((e) => e.type === type);
    },

    getByPrinciple(principle) {
      return bank.filter((e) => e.principle === principle);
    },

    getById(id) {
      return bank.find((e) => e.id === id);
    },

    getPrinciples() {
      return DESIGN_REVIEW_PRINCIPLES;
    },

    addExemplar(exemplar) {
      bank.push(exemplar);
    },

    countByType() {
      const counts: Record<string, number> = {
        'true-positive': 0,
        'false-positive': 0,
        borderline: 0,
      };
      for (const e of bank) counts[e.type]++;
      return counts as Record<DesignExemplar['type'], number>;
    },
  };
}

/**
 * Parse exemplars from a YAML-like structure (the format used in
 * .ai-sdlc/design-review-exemplars.yaml).
 */
export function parseExemplarsFromYaml(data: {
  exemplars: Array<{
    id: string;
    type: string;
    category: string;
    scenario: string;
    verdict: string;
    principle: string;
    confidence?: number;
    note?: string;
  }>;
}): DesignExemplar[] {
  return data.exemplars.map((e) => ({
    id: e.id,
    type: e.type as DesignExemplar['type'],
    category: e.category,
    scenario: e.scenario,
    verdict: e.verdict,
    principle: e.principle as PrincipleId,
    confidence: e.confidence,
    note: e.note,
  }));
}
