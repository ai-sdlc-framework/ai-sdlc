/**
 * AJV schema round-trip tests for `metric-snapshot.v1.schema.json` (AISDLC-544).
 *
 * Covers AC #1 (schema) acceptance criteria:
 *   - Accept a well-formed MetricSnapshot
 *   - Reject missing required fields (apiVersion, kind, metadata, spec)
 *   - Reject wrong apiVersion const value
 *   - Reject wrong kind const value
 *   - Reject metricId that violates the kebab-case pattern
 *   - Reject unknown top-level property (additionalProperties: false)
 *   - Reject invalid date-time in spec.recordedAt
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { metricSnapshotV1Schema } from './generated-schemas.js';

// Handle CJS default export interop
const _Ajv2020 = Ajv2020 as unknown as typeof Ajv2020.default;
const _addFormats = addFormats as unknown as typeof addFormats.default;

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WELL_FORMED = {
  apiVersion: 'ai-sdlc.io/v1alpha1',
  kind: 'MetricSnapshot',
  metadata: {
    journey: 'spry-engage/onboarding',
    metricId: 'completion-rate',
  },
  spec: {
    value: 0.65,
    recordedAt: '2026-06-01T00:00:00.000Z',
    sourceTool: 'mixpanel',
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('metric-snapshot.v1.schema.json — AJV round-trip', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let validate: any;

  beforeAll(() => {
    const ajv = new _Ajv2020({ allErrors: true, strict: false });
    _addFormats(ajv);
    validate = ajv.compile(metricSnapshotV1Schema);
  });

  it('accepts a well-formed MetricSnapshot', () => {
    const ok = validate(WELL_FORMED);
    expect(ok).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('accepts MetricSnapshot with optional labels, annotations, windowStart, windowEnd', () => {
    const withOptionals = {
      ...WELL_FORMED,
      metadata: {
        ...WELL_FORMED.metadata,
        labels: { env: 'production' },
        annotations: { 'ai-sdlc.io/note': 'weekly snapshot' },
      },
      spec: {
        ...WELL_FORMED.spec,
        windowStart: '2026-05-25T00:00:00.000Z',
        windowEnd: '2026-06-01T00:00:00.000Z',
      },
    };
    expect(validate(withOptionals)).toBe(true);
  });

  it('rejects when required field "apiVersion" is missing', () => {
    const { apiVersion: _, ...missing } = WELL_FORMED;
    expect(validate(missing)).toBe(false);
    expect(validate.errors).not.toBeNull();
  });

  it('rejects when required field "kind" is missing', () => {
    const { kind: _, ...missing } = WELL_FORMED;
    expect(validate(missing)).toBe(false);
  });

  it('rejects when required field "metadata" is missing', () => {
    const { metadata: _, ...missing } = WELL_FORMED;
    expect(validate(missing)).toBe(false);
  });

  it('rejects when required field "spec" is missing', () => {
    const { spec: _, ...missing } = WELL_FORMED;
    expect(validate(missing)).toBe(false);
  });

  it('rejects wrong apiVersion const value', () => {
    const bad = { ...WELL_FORMED, apiVersion: 'ai-sdlc.io/v2' };
    expect(validate(bad)).toBe(false);
  });

  it('rejects wrong kind const value', () => {
    const bad = { ...WELL_FORMED, kind: 'NotAMetricSnapshot' };
    expect(validate(bad)).toBe(false);
  });

  it('rejects metricId that violates the kebab-case pattern (uppercase)', () => {
    const bad = {
      ...WELL_FORMED,
      metadata: { ...WELL_FORMED.metadata, metricId: 'Completion-Rate' },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects metricId that violates the kebab-case pattern (leading digit)', () => {
    const bad = {
      ...WELL_FORMED,
      metadata: { ...WELL_FORMED.metadata, metricId: '1invalid' },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects unknown top-level property (additionalProperties: false)', () => {
    const bad = { ...WELL_FORMED, unknownField: 'should-be-rejected' };
    expect(validate(bad)).toBe(false);
  });

  it('rejects unknown property inside spec (additionalProperties: false)', () => {
    const bad = {
      ...WELL_FORMED,
      spec: { ...WELL_FORMED.spec, extraField: 42 },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects non-number spec.value', () => {
    const bad = { ...WELL_FORMED, spec: { ...WELL_FORMED.spec, value: 'not-a-number' } };
    expect(validate(bad)).toBe(false);
  });

  it('rejects invalid date-time in spec.recordedAt', () => {
    const bad = {
      ...WELL_FORMED,
      spec: { ...WELL_FORMED.spec, recordedAt: 'not-a-date' },
    };
    expect(validate(bad)).toBe(false);
  });
});
