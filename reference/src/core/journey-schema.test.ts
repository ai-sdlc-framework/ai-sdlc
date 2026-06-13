/**
 * RFC-0018 Phase 1 — journey.v1 schema constraint tests.
 *
 * Covers AISDLC-494 acceptance criteria:
 *   AC #1: if/then conditional — target is required when kind=terminal-success-state.
 *   AC #2: contains constraint — at least 1 state must have terminal:true AND successState:true.
 *   AC #3: maxItems on states/transitions/successMetrics/designImperatives;
 *          maxLength on transition from/to/trigger strings.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import _Ajv2020 from 'ajv/dist/2020.js';
import _addFormats from 'ajv-formats';
import { SCHEMAS } from './generated-schemas.js';

// Handle CJS default export interop
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

type AjvInstance = InstanceType<typeof Ajv2020>;

let ajv: AjvInstance;

beforeAll(() => {
  ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // Register all schemas so cross-schema $ref resolution works.
  for (const schema of Object.values(SCHEMAS)) {
    ajv.addSchema(schema);
  }
});

function validateJourney(doc: unknown) {
  const validator = ajv.getSchema('https://ai-sdlc.io/schemas/v1alpha1/journey.v1.schema.json');
  if (!validator) throw new Error('journey.v1 schema not found in registry');
  const valid = validator(doc);
  return { valid, errors: validator.errors ?? [] };
}

// ── Minimal valid journey fixture ─────────────────────────────────────────────

const MINIMAL_VALID_JOURNEY = {
  id: 'onboarding',
  scope: 'soul',
  states: [
    { id: 'start', terminal: false },
    { id: 'done', terminal: true, successState: true },
  ],
  transitions: [{ from: 'start', to: 'done', trigger: 'complete-profile' }],
  completionCriteria: { kind: 'terminal-success-state', target: 'done' },
  accessibility: {
    wcagLevel: 'AA',
    wcagVersion: '2.2',
    conformanceTarget: 90,
  },
};

// ── AC #1: if/then — target required when kind=terminal-success-state ─────────

describe('AC#1: completionCriteria target required when kind=terminal-success-state', () => {
  it('accepts a valid journey with kind=terminal-success-state and target set', () => {
    const { valid } = validateJourney(MINIMAL_VALID_JOURNEY);
    expect(valid).toBe(true);
  });

  it('rejects a journey with kind=terminal-success-state and NO target', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      completionCriteria: { kind: 'terminal-success-state' }, // target missing
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a journey with kind=all-states-reached and no target (target not required)', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      completionCriteria: { kind: 'all-states-reached' },
    };
    const { valid } = validateJourney(doc);
    expect(valid).toBe(true);
  });

  it('accepts a journey with kind=all-states-reached even with a target set', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      completionCriteria: { kind: 'all-states-reached', target: 'done' },
    };
    const { valid } = validateJourney(doc);
    expect(valid).toBe(true);
  });
});

// ── AC #2: contains — at least 1 terminal success state ───────────────────────

describe('AC#2: states must contain at least one terminal:true + successState:true state', () => {
  it('accepts a journey where one state has terminal:true and successState:true', () => {
    const { valid } = validateJourney(MINIMAL_VALID_JOURNEY);
    expect(valid).toBe(true);
  });

  it('rejects a journey where no state has terminal:true + successState:true (all non-terminal)', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      states: [
        { id: 'start', terminal: false },
        { id: 'middle', terminal: false },
      ],
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a journey where terminal:true exists but successState is false', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      states: [
        { id: 'start', terminal: false },
        { id: 'failed', terminal: true, successState: false }, // failure state only
      ],
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a journey with both a failure terminal and a success terminal', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      states: [
        { id: 'start', terminal: false },
        { id: 'done', terminal: true, successState: true },
        { id: 'abandoned', terminal: true, successState: false },
      ],
      transitions: [
        { from: 'start', to: 'done', trigger: 'complete' },
        { from: 'start', to: 'abandoned', trigger: 'timeout' },
      ],
    };
    const { valid } = validateJourney(doc);
    expect(valid).toBe(true);
  });
});

// ── AC #3: maxItems and maxLength bounds ──────────────────────────────────────

describe('AC#3: maxItems on states/transitions/successMetrics/designImperatives; maxLength on transition strings', () => {
  it('rejects states array exceeding 100 items', () => {
    const tooManyStates = Array.from({ length: 101 }, (_, i) => ({
      id: `s${String(i).padStart(3, '0')}`,
      terminal: false,
    }));
    // We still need at least one success state; swap last to success terminal
    tooManyStates[100] = {
      id: 's100',
      terminal: true,
      successState: true,
    } as (typeof tooManyStates)[0];
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      states: tooManyStates,
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts states array at exactly 100 items', () => {
    const states = Array.from({ length: 99 }, (_, i) => ({
      id: `s${String(i).padStart(3, '0')}`,
      terminal: false,
    }));
    states.push({ id: 'done', terminal: true, successState: true } as (typeof states)[0]);
    const transitions = [{ from: 's000', to: 'done', trigger: 'finish' }];
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      states,
      transitions,
    };
    const { valid } = validateJourney(doc);
    expect(valid).toBe(true);
  });

  it('rejects successMetrics array exceeding 50 items', () => {
    const tooManyMetrics = Array.from({ length: 51 }, (_, i) => ({
      id: `metric-${i}`,
    }));
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      successMetrics: tooManyMetrics,
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects designImperatives array exceeding 50 items', () => {
    const tooManyImperatives = Array.from({ length: 51 }, (_, i) => `imperative-${i}`);
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      designImperatives: tooManyImperatives,
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a transition "to" string longer than 64 chars', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      transitions: [
        {
          from: 'start',
          to: 'a'.repeat(65),
          trigger: 'complete-profile',
        },
      ],
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a transition "trigger" string longer than 128 chars', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      transitions: [
        {
          from: 'start',
          to: 'done',
          trigger: 't'.repeat(129),
        },
      ],
    };
    const { valid, errors } = validateJourney(doc);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts a transition "to" string at exactly 64 chars', () => {
    const doc = {
      ...MINIMAL_VALID_JOURNEY,
      states: [
        { id: 'start', terminal: false },
        { id: 'aa'.repeat(32), terminal: true, successState: true }, // 64 chars
      ],
      transitions: [
        {
          from: 'start',
          to: 'aa'.repeat(32),
          trigger: 'complete-profile',
        },
      ],
      completionCriteria: { kind: 'terminal-success-state', target: 'aa'.repeat(32) },
    };
    const { valid } = validateJourney(doc);
    expect(valid).toBe(true);
  });
});
