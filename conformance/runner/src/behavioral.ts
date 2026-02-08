/**
 * Behavioral conformance test runner.
 * Evaluates behavioral test fixtures against the reference implementation.
 */

import { enforce, evaluatePromotion, evaluateDemotion, validateHandoff } from '@ai-sdlc/reference';
import type {
  QualityGate,
  AutonomyPolicy,
  AgentRole,
  EvaluationContext,
  AgentMetrics,
} from '@ai-sdlc/reference';

export interface BehavioralFixture {
  kind: 'BehavioralTest';
  apiVersion: string;
  description: string;
  metadata: {
    conformanceLevel: 'core' | 'full';
  };
  test: {
    type: string;
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
  };
}

export interface BehavioralResult {
  file: string;
  description: string;
  passed: boolean;
  message?: string;
}

/**
 * Type guard for behavioral test fixtures.
 */
export function isBehavioralFixture(doc: unknown): doc is BehavioralFixture {
  return (
    typeof doc === 'object' &&
    doc !== null &&
    (doc as Record<string, unknown>).kind === 'BehavioralTest'
  );
}

/**
 * Run a single behavioral test fixture.
 */
export function runBehavioralTest(fixture: BehavioralFixture, file: string): BehavioralResult {
  const { type } = fixture.test;

  switch (type) {
    case 'quality-gate-evaluation':
      return runQualityGateTest(fixture, file);
    case 'autonomy-promotion':
      return runAutonomyPromotionTest(fixture, file);
    case 'autonomy-demotion':
      return runAutonomyDemotionTest(fixture, file);
    case 'handoff-validation':
      return runHandoffValidationTest(fixture, file);
    default:
      return {
        file,
        description: fixture.description,
        passed: false,
        message: `Unknown behavioral test type: ${type}`,
      };
  }
}

function runQualityGateTest(fixture: BehavioralFixture, file: string): BehavioralResult {
  const { input, expected } = fixture.test;
  const qualityGate = input.qualityGate as QualityGate;
  const context = input.context as EvaluationContext;
  const result = enforce(qualityGate, context);

  const passed = result.allowed === expected.allowed;
  return {
    file,
    description: fixture.description,
    passed,
    message: passed
      ? undefined
      : `Expected allowed=${String(expected.allowed)}, got allowed=${String(result.allowed)}`,
  };
}

function runAutonomyPromotionTest(fixture: BehavioralFixture, file: string): BehavioralResult {
  const { input, expected } = fixture.test;
  const policy = input.policy as AutonomyPolicy;
  const agent = input.agent as AgentMetrics;
  const result = evaluatePromotion(policy, agent);

  const checks: string[] = [];
  if (result.eligible !== expected.eligible) {
    checks.push(`eligible: expected ${String(expected.eligible)}, got ${String(result.eligible)}`);
  }
  if (expected.fromLevel !== undefined && result.fromLevel !== expected.fromLevel) {
    checks.push(
      `fromLevel: expected ${String(expected.fromLevel)}, got ${String(result.fromLevel)}`,
    );
  }
  if (expected.toLevel !== undefined && result.toLevel !== expected.toLevel) {
    checks.push(`toLevel: expected ${String(expected.toLevel)}, got ${String(result.toLevel)}`);
  }

  return {
    file,
    description: fixture.description,
    passed: checks.length === 0,
    message: checks.length > 0 ? checks.join('; ') : undefined,
  };
}

function runAutonomyDemotionTest(fixture: BehavioralFixture, file: string): BehavioralResult {
  const { input, expected } = fixture.test;
  const policy = input.policy as AutonomyPolicy;
  const agent = input.agent as AgentMetrics;
  const activeTrigger = input.activeTrigger as string;
  const result = evaluateDemotion(policy, agent, activeTrigger);

  const checks: string[] = [];
  if (result.demoted !== expected.demoted) {
    checks.push(`demoted: expected ${String(expected.demoted)}, got ${String(result.demoted)}`);
  }
  if (expected.fromLevel !== undefined && result.fromLevel !== expected.fromLevel) {
    checks.push(
      `fromLevel: expected ${String(expected.fromLevel)}, got ${String(result.fromLevel)}`,
    );
  }
  if (expected.toLevel !== undefined && result.toLevel !== expected.toLevel) {
    checks.push(`toLevel: expected ${String(expected.toLevel)}, got ${String(result.toLevel)}`);
  }

  return {
    file,
    description: fixture.description,
    passed: checks.length === 0,
    message: checks.length > 0 ? checks.join('; ') : undefined,
  };
}

function runHandoffValidationTest(fixture: BehavioralFixture, file: string): BehavioralResult {
  const { input, expected } = fixture.test;
  const from = input.from as AgentRole;
  const to = input.to as AgentRole;
  const payload = (input.payload ?? {}) as Record<string, unknown>;
  const error = validateHandoff(from, to, payload);

  const isValid = error === null;
  const passed = isValid === expected.valid;

  return {
    file,
    description: fixture.description,
    passed,
    message: passed
      ? undefined
      : `Expected valid=${String(expected.valid)}, got valid=${String(isValid)}${error ? `: ${error.message}` : ''}`,
  };
}
