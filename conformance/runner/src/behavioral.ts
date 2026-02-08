/**
 * Behavioral conformance test runner.
 * Evaluates behavioral test fixtures against the reference implementation.
 */

import {
  enforce,
  evaluatePromotion,
  evaluateDemotion,
  validateHandoff,
  scoreComplexity,
  routeByComplexity,
  executeOrchestration,
} from '@ai-sdlc/reference';
import type {
  QualityGate,
  AutonomyPolicy,
  AgentRole,
  EvaluationContext,
  AgentMetrics,
  ComplexityInput,
  OrchestrationPlan,
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
 * Run a single behavioral test fixture (sync tests only).
 * For async tests like orchestration-error, use runBehavioralTestAsync.
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
    case 'complexity-routing':
      return runComplexityRoutingTest(fixture, file);
    case 'orchestration-error':
      // Sync fallback — caller should use runBehavioralTestAsync for this type
      return {
        file,
        description: fixture.description,
        passed: false,
        message: 'orchestration-error tests require runBehavioralTestAsync',
      };
    default:
      return {
        file,
        description: fixture.description,
        passed: false,
        message: `Unknown behavioral test type: ${type}`,
      };
  }
}

/**
 * Run a single behavioral test fixture (supports async tests).
 */
export async function runBehavioralTestAsync(
  fixture: BehavioralFixture,
  file: string,
): Promise<BehavioralResult> {
  if (fixture.test.type === 'orchestration-error') {
    return runOrchestrationErrorTest(fixture, file);
  }
  return runBehavioralTest(fixture, file);
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

function runComplexityRoutingTest(fixture: BehavioralFixture, file: string): BehavioralResult {
  const { input, expected } = fixture.test;
  const complexityInput = input.complexityInput as ComplexityInput;
  const score = scoreComplexity(complexityInput);
  const strategy = routeByComplexity(score);

  const checks: string[] = [];
  if (expected.minScore !== undefined && score < (expected.minScore as number)) {
    checks.push(`score ${score} below minimum ${String(expected.minScore)}`);
  }
  if (expected.maxScore !== undefined && score > (expected.maxScore as number)) {
    checks.push(`score ${score} above maximum ${String(expected.maxScore)}`);
  }
  if (expected.strategy !== undefined && strategy !== expected.strategy) {
    checks.push(`strategy: expected ${String(expected.strategy)}, got ${strategy}`);
  }

  return {
    file,
    description: fixture.description,
    passed: checks.length === 0,
    message: checks.length > 0 ? checks.join('; ') : undefined,
  };
}

async function runOrchestrationErrorTest(
  fixture: BehavioralFixture,
  file: string,
): Promise<BehavioralResult> {
  const { input, expected } = fixture.test;
  const plan = input.plan as OrchestrationPlan;
  const agentDefs = (input.agents ?? {}) as Record<string, AgentRole>;
  const failAgent = input.failAgent as string | null;

  const agents = new Map<string, AgentRole>();
  for (const [name, role] of Object.entries(agentDefs)) {
    agents.set(name, role);
  }

  const taskFn = async (agent: AgentRole) => {
    if (failAgent && agent.metadata.name === failAgent) {
      throw new Error(`${agent.metadata.name} failed`);
    }
    return { ok: true };
  };

  const result = await executeOrchestration(plan, agents, taskFn);

  const checks: string[] = [];
  if (expected.success !== undefined && result.success !== expected.success) {
    checks.push(`success: expected ${String(expected.success)}, got ${String(result.success)}`);
  }
  if (expected.failedAgents) {
    const expectedFailed = expected.failedAgents as string[];
    const actualFailed = result.stepResults.filter((s) => s.state === 'failed').map((s) => s.agent);
    for (const agent of expectedFailed) {
      if (!actualFailed.includes(agent)) {
        checks.push(`expected "${agent}" to fail but it did not`);
      }
    }
  }

  return {
    file,
    description: fixture.description,
    passed: checks.length === 0,
    message: checks.length > 0 ? checks.join('; ') : undefined,
  };
}
