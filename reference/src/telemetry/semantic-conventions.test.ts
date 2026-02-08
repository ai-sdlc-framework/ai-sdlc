import { describe, it, expect } from 'vitest';
import {
  SPAN_NAMES,
  METRIC_NAMES,
  ATTRIBUTE_KEYS,
  AI_SDLC_PREFIX,
} from './semantic-conventions.js';

describe('SPAN_NAMES', () => {
  it('all span names start with ai_sdlc. prefix', () => {
    for (const name of Object.values(SPAN_NAMES)) {
      expect(name).toMatch(/^ai_sdlc\./);
    }
  });

  it('contains expected span names', () => {
    expect(SPAN_NAMES.PIPELINE_STAGE).toBe('ai_sdlc.pipeline.stage');
    expect(SPAN_NAMES.AGENT_TASK).toBe('ai_sdlc.agent.task');
    expect(SPAN_NAMES.GATE_EVALUATION).toBe('ai_sdlc.gate.evaluation');
    expect(SPAN_NAMES.RECONCILIATION_CYCLE).toBe('ai_sdlc.reconciliation.cycle');
    expect(SPAN_NAMES.HANDOFF).toBe('ai_sdlc.handoff');
  });

  it('has exactly 5 span names', () => {
    expect(Object.keys(SPAN_NAMES)).toHaveLength(5);
  });
});

describe('METRIC_NAMES', () => {
  it('all metric names start with ai_sdlc. prefix', () => {
    for (const name of Object.values(METRIC_NAMES)) {
      expect(name).toMatch(/^ai_sdlc\./);
    }
  });

  it('has exactly 9 metric names', () => {
    expect(Object.keys(METRIC_NAMES)).toHaveLength(9);
  });

  it('contains gauge, counter, and histogram metrics', () => {
    // Gauge
    expect(METRIC_NAMES.AUTONOMY_LEVEL).toBeDefined();
    // Counters
    expect(METRIC_NAMES.GATE_PASS_TOTAL).toBeDefined();
    expect(METRIC_NAMES.GATE_FAIL_TOTAL).toBeDefined();
    expect(METRIC_NAMES.TASK_SUCCESS_TOTAL).toBeDefined();
    expect(METRIC_NAMES.TASK_FAILURE_TOTAL).toBeDefined();
    expect(METRIC_NAMES.PROMOTION_TOTAL).toBeDefined();
    expect(METRIC_NAMES.DEMOTION_TOTAL).toBeDefined();
    // Histograms
    expect(METRIC_NAMES.TASK_DURATION_MS).toBeDefined();
    expect(METRIC_NAMES.RECONCILIATION_DURATION_MS).toBeDefined();
  });
});

describe('ATTRIBUTE_KEYS', () => {
  it('all attribute keys start with ai_sdlc. prefix', () => {
    for (const key of Object.values(ATTRIBUTE_KEYS)) {
      expect(key).toMatch(/^ai_sdlc\./);
    }
  });

  it('has exactly 8 attribute keys', () => {
    expect(Object.keys(ATTRIBUTE_KEYS)).toHaveLength(8);
  });

  it('has no duplicate values', () => {
    const values = Object.values(ATTRIBUTE_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('AI_SDLC_PREFIX', () => {
  it('is "ai_sdlc."', () => {
    expect(AI_SDLC_PREFIX).toBe('ai_sdlc.');
  });
});
