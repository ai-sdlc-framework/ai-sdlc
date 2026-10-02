import { describe, it, expect } from 'vitest';
import {
  createPipelineRegoEvaluator,
  createPipelineCELEvaluator,
  createPipelineABACHook,
  createPipelineExpressionEvaluator,
  createPipelineLLMEvaluator,
  evaluatePipelineGate,
  scorePipelineComplexity,
  evaluatePipelineComplexityRouting,
  checkPermission,
  checkConstraints,
  createTokenAuthenticator,
  parseDuration,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_COMPLEXITY_FACTORS,
  DEFAULT_THRESHOLDS,
} from './policy-evaluators.js';

import {
  FakeJudgmentProvider,
  disabledJudgmentConfig,
  resolveJudgmentConfig,
  scoreComplexity,
  evaluateComplexity,
  type ComplexityInput,
  type EvaluateJudgmentContext,
} from '@ai-sdlc/reference';
import {
  scorePipelineComplexityWithJudgment,
  evaluatePipelineComplexityRoutingWithJudgment,
} from './policy-evaluators.js';
import {
  BOOLEAN_COMPLEXITY_FACTORS,
  COMPLEXITY_FACTORS_ID,
} from './judgment/complexity-factors.js';

function factorCtx(probs: Record<string, number>): EvaluateJudgmentContext {
  const fake = new FakeJudgmentProvider();
  for (const f of BOOLEAN_COMPLEXITY_FACTORS) {
    fake.script(f, { type: 'noul', probability: probs[f] ?? 0 });
  }
  const config = resolveJudgmentConfig({
    spec: {
      provider: 'fake',
      model: 'fake-1',
      judgments: {
        [COMPLEXITY_FACTORS_ID]: {
          mode: 'enforce',
          thresholds: { 'fake@fake-1': { raise: 0.8 } },
          promotion: { 'fake@fake-1': { path: 'override', evidence: 'reviewed samples' } },
        },
      },
    },
  });
  return { config, getProvider: () => fake };
}

describe('Policy evaluators with complexity.factors judgment', () => {
  const base: ComplexityInput = { filesAffected: 6, linesOfChange: 250 };

  it('absent or disabled context equals the sync result', async () => {
    const disabled = { config: disabledJudgmentConfig() } satisfies EvaluateJudgmentContext;
    for (const ctx of [undefined, disabled]) {
      expect(await scorePipelineComplexityWithJudgment(base, 'x', ctx)).toBe(scoreComplexity(base));
      expect(await evaluatePipelineComplexityRoutingWithJudgment(base, 'x', ctx)).toEqual(
        evaluateComplexity(base),
      );
    }
  });

  it('an enabled judgment raises a factor and the score goes up', async () => {
    const ctx = factorCtx({ securitySensitive: 0.95 });
    const score = await scorePipelineComplexityWithJudgment(base, 'rotate keys', ctx);
    expect(score).toBeGreaterThan(scoreComplexity(base));
    const routed = await evaluatePipelineComplexityRoutingWithJudgment(base, 'rotate keys', ctx);
    expect(routed.score).toBe(score);
  });

  it('never lowers an already-true factor', async () => {
    const start: ComplexityInput = { ...base, securitySensitive: true };
    const score = await scorePipelineComplexityWithJudgment(start, 'x', factorCtx({}));
    expect(score).toBe(scoreComplexity(start));
  });
});

describe('Policy evaluators', () => {
  describe('createPipelineRegoEvaluator()', () => {
    it('creates a Rego evaluator', () => {
      const evaluator = createPipelineRegoEvaluator();
      expect(typeof evaluator.evaluate).toBe('function');
      expect(typeof evaluator.validate).toBe('function');
    });

    it('evaluates simple Rego expressions', () => {
      const evaluator = createPipelineRegoEvaluator();
      const result = evaluator.evaluate('input.x >= 5', { input: { x: 10 } });
      expect(result).toBe(true);
    });
  });

  describe('createPipelineCELEvaluator()', () => {
    it('creates a CEL evaluator', () => {
      const evaluator = createPipelineCELEvaluator();
      expect(typeof evaluator.evaluate).toBe('function');
      expect(typeof evaluator.validate).toBe('function');
    });

    it('evaluates simple CEL expressions', () => {
      const evaluator = createPipelineCELEvaluator();
      const result = evaluator.evaluate('x >= 5', { x: 10 });
      expect(result).toBe(true);
    });
  });

  describe('createPipelineABACHook()', () => {
    it('creates an ABAC authorization hook', () => {
      const hook = createPipelineABACHook([
        { name: 'allow-src', effect: 'allow', expression: 'true' },
      ]);
      expect(typeof hook).toBe('function');
    });

    it('evaluates ABAC policies', () => {
      const hook = createPipelineABACHook([
        { name: 'allow-all', effect: 'allow', expression: 'true' },
      ]);
      const result = hook({
        agent: 'code-agent',
        action: 'write',
        target: 'src/main.ts',
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('createPipelineExpressionEvaluator()', () => {
    it('creates an expression evaluator', () => {
      const evaluator = createPipelineExpressionEvaluator();
      expect(typeof evaluator.evaluate).toBe('function');
    });

    it('evaluates simple expressions', () => {
      const evaluator = createPipelineExpressionEvaluator();
      expect(evaluator.evaluate('10 >= 5', {})).toBe(true);
      expect(evaluator.evaluate('3 > 5', {})).toBe(false);
    });
  });

  describe('createPipelineLLMEvaluator()', () => {
    it('creates a stub LLM evaluator', () => {
      const evaluator = createPipelineLLMEvaluator();
      expect(typeof evaluator.evaluate).toBe('function');
    });
  });

  describe('evaluatePipelineGate()', () => {
    it('evaluates a metric gate', () => {
      const result = evaluatePipelineGate(
        {
          name: 'test',
          enforcement: 'hard-mandatory',
          rule: { metric: 'coverage', operator: '>=', threshold: 80 },
        },
        { authorType: 'ai-agent', repository: 'test', metrics: { coverage: 90 } },
      );
      expect(result.verdict).toBe('pass');
    });

    it('fails a metric gate below threshold', () => {
      const result = evaluatePipelineGate(
        {
          name: 'test',
          enforcement: 'hard-mandatory',
          rule: { metric: 'coverage', operator: '>=', threshold: 80 },
        },
        { authorType: 'ai-agent', repository: 'test', metrics: { coverage: 50 } },
      );
      expect(result.verdict).toBe('fail');
    });
  });

  describe('scorePipelineComplexity()', () => {
    it('scores a simple issue as low complexity', () => {
      const score = scorePipelineComplexity({
        filesAffected: 2,
        linesOfChange: 50,
      });
      expect(score).toBeLessThanOrEqual(5);
    });
  });

  describe('evaluatePipelineComplexityRouting()', () => {
    it('returns a complexity result with routing', () => {
      const result = evaluatePipelineComplexityRouting({
        filesAffected: 2,
        linesOfChange: 50,
      });
      expect(result.score).toBeDefined();
      expect(result.strategy).toBeDefined();
    });
  });

  describe('reference re-exports', () => {
    it('checkPermission evaluates path permissions', () => {
      const result = checkPermission(
        { read: ['**'], write: ['src/**'], execute: [] },
        'write',
        'src/main.ts',
      );
      expect(result.allowed).toBe(true);
    });

    it('checkConstraints validates agent constraints', () => {
      const result = checkConstraints(
        { maxFilesPerChange: 10, requireTests: false },
        'src/main.ts',
      );
      expect(result.allowed).toBe(true);
    });

    it('createTokenAuthenticator creates an authenticator', () => {
      const tokenMap = new Map([
        [
          'valid-token',
          { actor: 'agent', actorType: 'ai-agent' as const, roles: [], groups: [], scopes: [] },
        ],
      ]);
      const auth = createTokenAuthenticator(tokenMap);
      expect(typeof auth.authenticate).toBe('function');
    });

    it('parseDuration parses duration strings', () => {
      expect(parseDuration('1h')).toBe(3600000);
      expect(parseDuration('30m')).toBe(1800000);
    });

    it('DEFAULT_COOLDOWN_MS is a number', () => {
      expect(typeof DEFAULT_COOLDOWN_MS).toBe('number');
    });

    it('DEFAULT_COMPLEXITY_FACTORS is defined', () => {
      expect(DEFAULT_COMPLEXITY_FACTORS).toBeDefined();
    });

    it('DEFAULT_THRESHOLDS is defined', () => {
      expect(DEFAULT_THRESHOLDS).toBeDefined();
    });
  });
});
