import { describe, it, expect } from 'vitest';
import {
  evaluateLLMRule,
  createStubLLMEvaluator,
  type LLMEvaluationResult,
} from './llm-evaluator.js';

const allPassResults: LLMEvaluationResult[] = [
  { dimension: 'factuality', score: 0.95, confidence: 0.9 },
  { dimension: 'hallucination', score: 0.98, confidence: 0.85 },
  { dimension: 'relevance', score: 0.92, confidence: 0.88 },
  { dimension: 'toxicity', score: 0.99, confidence: 0.95 },
  { dimension: 'bias', score: 0.97, confidence: 0.9 },
  { dimension: 'completeness', score: 0.88, confidence: 0.8 },
];

describe('evaluateLLMRule', () => {
  it('passes when all scores meet thresholds', async () => {
    const evaluator = createStubLLMEvaluator(allPassResults);
    const verdict = await evaluateLLMRule(
      {
        dimensions: ['factuality', 'relevance'],
        thresholds: { factuality: 0.9, relevance: 0.85 },
      },
      'test content',
      evaluator,
    );
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toHaveLength(0);
    expect(verdict.results).toHaveLength(2);
  });

  it('fails when a score is below threshold', async () => {
    const evaluator = createStubLLMEvaluator([
      { dimension: 'factuality', score: 0.7, confidence: 0.9 },
    ]);
    const verdict = await evaluateLLMRule(
      {
        dimensions: ['factuality'],
        thresholds: { factuality: 0.9 },
      },
      'test content',
      evaluator,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0].dimension).toBe('factuality');
    expect(verdict.failures[0].score).toBe(0.7);
    expect(verdict.failures[0].threshold).toBe(0.9);
  });

  it('handles boundary scores (exactly at threshold)', async () => {
    const evaluator = createStubLLMEvaluator([
      { dimension: 'toxicity', score: 0.9, confidence: 0.95 },
    ]);
    const verdict = await evaluateLLMRule(
      {
        dimensions: ['toxicity'],
        thresholds: { toxicity: 0.9 },
      },
      'test content',
      evaluator,
    );
    expect(verdict.passed).toBe(true);
  });

  it('fails for missing dimensions with thresholds', async () => {
    const evaluator = createStubLLMEvaluator([]); // No results at all
    const verdict = await evaluateLLMRule(
      {
        dimensions: ['bias'],
        thresholds: { bias: 0.8 },
      },
      'test content',
      evaluator,
    );
    expect(verdict.passed).toBe(false);
    expect(verdict.failures[0].dimension).toBe('bias');
    expect(verdict.failures[0].score).toBe(0);
  });

  it('passes when no thresholds are specified', async () => {
    const evaluator = createStubLLMEvaluator(allPassResults);
    const verdict = await evaluateLLMRule(
      {
        dimensions: ['factuality', 'relevance'],
        thresholds: {},
      },
      'test content',
      evaluator,
    );
    expect(verdict.passed).toBe(true);
  });

  it('includes all results in the verdict', async () => {
    const evaluator = createStubLLMEvaluator(allPassResults);
    const verdict = await evaluateLLMRule(
      {
        dimensions: ['factuality', 'hallucination', 'completeness'],
        thresholds: { factuality: 0.9 },
      },
      'test content',
      evaluator,
    );
    expect(verdict.results).toHaveLength(3);
  });
});

describe('createStubLLMEvaluator', () => {
  it('returns only requested dimensions', async () => {
    const evaluator = createStubLLMEvaluator(allPassResults);
    const results = await evaluator.evaluate('content', ['factuality']);
    expect(results).toHaveLength(1);
    expect(results[0].dimension).toBe('factuality');
  });

  it('returns empty array for non-matching dimensions', async () => {
    const evaluator = createStubLLMEvaluator([
      { dimension: 'factuality', score: 0.9, confidence: 0.8 },
    ]);
    const results = await evaluator.evaluate('content', ['toxicity']);
    expect(results).toHaveLength(0);
  });
});
