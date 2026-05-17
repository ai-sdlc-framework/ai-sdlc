/**
 * Schema-validation tests for `spec/schemas/decision.v1.schema.json`.
 *
 * Asserts that:
 *  1. A representative projected Decision passes the schema.
 *  2. The projection produced by the event log validates against the schema
 *     (round-trip: emit event → project → validate).
 *  3. Obvious malformed shapes are rejected.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import { appendDecisionEvent, makeDecisionOpenedEvent } from './event-log.js';
import { projectDecision } from './projection.js';
import type { Decision } from './decision-record.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'spec',
  'schemas',
  'decision.v1.schema.json',
);

const ajv = new Ajv2020({ strict: false, allErrors: true });
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const validate = ajv.compile(schema);

function expectValid(d: Decision): void {
  const ok = validate(d);
  if (!ok) {
    const errs = (validate.errors ?? []).map(
      (e: ErrorObject) => `${e.instancePath || '(root)'} ${e.message}`,
    );
    throw new Error(`schema rejected valid Decision:\n  ${errs.join('\n  ')}`);
  }
  expect(ok).toBe(true);
}

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'decisions-schema-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('decision.v1.schema.json (AC#1)', () => {
  it('compiles via Ajv2020', () => {
    expect(typeof validate).toBe('function');
    expect(schema.$id).toMatch(/decision\.v1\.schema\.json$/);
    expect(schema.title).toBe('Decision');
  });

  it('accepts a hand-crafted Decision matching §11', () => {
    expectValid({
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Decision',
      metadata: {
        id: 'DEC-0042',
        source: 'rfc-open-question',
        scope: 'rfc:RFC-0035',
        created: '2026-05-08T14:32:00.000Z',
        updated: '2026-05-08T14:32:00.000Z',
      },
      spec: {
        summary: 'Catalog as separate resource vs view projected from existing markdown',
        body: 'Should the Decision resource be a first-class entity...',
        reversible: false,
        options: [
          {
            id: 'opt-a',
            description: 'First-class resource',
            consequences: ['Decision history persists independently'],
            subDecisions: ['How do we keep the catalog in sync?'],
          },
          {
            id: 'opt-b',
            description: 'Projection over existing markdown',
            consequences: ['No sync problem; markdown remains the source'],
          },
        ],
      },
      status: {
        lifecycle: 'open',
        answeredOptionId: null,
        answeredBy: null,
        answeredAt: null,
        routing: {
          assignedActor: 'dominique@reliablegenius.io',
          actorRationale: 'Cross-pillar (Engineering + Operator)',
          llmEligible: false,
        },
        evaluation: { stageA: { blockedRfcCount: 1 } },
        priority: 0.72,
        capacity: { tier: 'l' },
        deadline: null,
      },
      decisionLog: [
        {
          eventVersion: 'v1',
          type: 'decision-opened',
          ts: '2026-05-08T14:32:00.000Z',
          decisionId: 'DEC-0042',
          by: 'dominique@reliablegenius.io',
          source: 'rfc-open-question',
          scope: 'rfc:RFC-0035',
          summary: 'Catalog as separate resource vs view projected from existing markdown',
          options: [{ id: 'opt-a', description: 'First-class resource' }],
        },
      ],
    });
  });

  it('accepts the projection of a freshly-added decision (round-trip)', () => {
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        summary: 'roundtrip',
        options: [{ id: 'opt-a', description: 'A' }],
        routing: { assignedActor: 'op@example.com' },
        capacity: { tier: 's' },
      }),
      { workDir },
    );
    const d = projectDecision('DEC-0001', { workDir });
    expect(d).not.toBeNull();
    expectValid(d!);
  });

  it('rejects an unknown lifecycle value', () => {
    const bad = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Decision',
      metadata: {
        id: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        created: '2026-05-15T10:00:00.000Z',
        updated: '2026-05-15T10:00:00.000Z',
      },
      spec: {
        summary: 'x',
        options: [{ id: 'opt-a', description: 'A' }],
      },
      status: { lifecycle: 'not-a-lifecycle' },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects a malformed DEC id', () => {
    const bad = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Decision',
      metadata: {
        id: 'AISDLC-285',
        source: 'ad-hoc',
        scope: 'workspace',
        created: '2026-05-15T10:00:00.000Z',
        updated: '2026-05-15T10:00:00.000Z',
      },
      spec: {
        summary: 'x',
        options: [{ id: 'opt-a', description: 'A' }],
      },
      status: { lifecycle: 'open' },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects spec with zero options', () => {
    const bad = {
      apiVersion: 'ai-sdlc.io/v1alpha1',
      kind: 'Decision',
      metadata: {
        id: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'workspace',
        created: '2026-05-15T10:00:00.000Z',
        updated: '2026-05-15T10:00:00.000Z',
      },
      spec: { summary: 'x', options: [] },
      status: { lifecycle: 'open' },
    };
    expect(validate(bad)).toBe(false);
  });
});
