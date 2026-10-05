/**
 * AISDLC-690: direct-API model defaults come from the central module and each
 * stays overridable by its existing environment variable.
 */
import { describe, expect, it } from 'vitest';
import { CLAUDE_OPUS_MODEL_ID, CLAUDE_SONNET_MODEL_ID } from '@ai-sdlc/reference';
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_MODEL, DEFAULT_MODEL_COSTS } from './defaults.js';
import { CostTracker } from './cost-tracker.js';
import { GenericLLMRunner } from './runners/generic-llm.js';
import { RunnerRegistry } from './runners/runner-registry.js';

describe('direct-API model defaults', () => {
  it('read the central module', () => {
    expect(DEFAULT_MODEL).toBe(CLAUDE_SONNET_MODEL_ID);
    expect(DEFAULT_ANTHROPIC_MODEL).toBe(CLAUDE_SONNET_MODEL_ID);
  });

  it('ANTHROPIC_MODEL overrides the anthropic runner default', () => {
    const base = new RunnerRegistry();
    base.discoverFromEnv({ ANTHROPIC_API_KEY: 'k' });
    expect((base.get('anthropic') as GenericLLMRunner).getConfig().model).toBe(
      DEFAULT_ANTHROPIC_MODEL,
    );
    const pinned = new RunnerRegistry();
    pinned.discoverFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'pinned-model' });
    expect((pinned.get('anthropic') as GenericLLMRunner).getConfig().model).toBe('pinned-model');
  });

  it('every default model has a price entry; an unknown model is unpriced', () => {
    expect(DEFAULT_MODEL_COSTS[CLAUDE_SONNET_MODEL_ID]).toBeDefined();
    expect(DEFAULT_MODEL_COSTS[CLAUDE_OPUS_MODEL_ID]).toBeDefined();
    expect(CostTracker.isPriced(CLAUDE_SONNET_MODEL_ID)).toBe(true);
    expect(CostTracker.isPriced('claude-not-a-model-9')).toBe(false);
  });
});
