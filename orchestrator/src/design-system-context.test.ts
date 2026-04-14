import { describe, it, expect } from 'vitest';
import {
  selectContextStrategy,
  reEvaluateStrategy,
  type TaskContext,
} from './design-system-context.js';
import type { DesignSystemBinding } from '@ai-sdlc/reference';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeBinding(): DesignSystemBinding {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignSystemBinding',
    metadata: { name: 'test-ds' },
    spec: {
      stewardship: {
        designAuthority: { principals: ['design-lead'], scope: [] },
        engineeringAuthority: { principals: ['eng-lead'], scope: [] },
      },
      designToolAuthority: 'collaborative',
      tokens: {
        provider: 'tokens-studio',
        format: 'w3c-dtcg',
        source: { repository: 'org/tokens' },
        versionPolicy: 'minor',
      },
      catalog: { provider: 'storybook-mcp' },
      compliance: { coverage: { minimum: 85 } },
    },
  };
}

describe('selectContextStrategy', () => {
  it('step 1: tokens-only for token-change trigger with no component mods', () => {
    const task: TaskContext = { triggerEvent: 'design-token.changed' };
    const result = selectContextStrategy(task, makeBinding());
    expect(result.strategy).toBe('tokens-only');
    expect(result.reason).toContain('Token-change');
  });

  it('step 2: manifest-first for existing component modifications', () => {
    const task: TaskContext = { modifiesComponents: true };
    const result = selectContextStrategy(task, makeBinding());
    expect(result.strategy).toBe('manifest-first');
  });

  it('step 3: full for new component creation', () => {
    const task: TaskContext = { createsNewComponent: true };
    const result = selectContextStrategy(task, makeBinding());
    expect(result.strategy).toBe('full');
    expect(result.reason).toContain('New component');
  });

  it('step 4: full when touching both tokens and components', () => {
    const task: TaskContext = { touchesTokensAndComponents: true };
    const result = selectContextStrategy(task, makeBinding());
    expect(result.strategy).toBe('full');
    expect(result.reason).toContain('both tokens and components');
  });

  it('step 5: full when reusability score < 0.5', () => {
    const task: TaskContext = { reusabilityScore: 0.3 };
    const result = selectContextStrategy(task, makeBinding());
    expect(result.strategy).toBe('full');
    expect(result.reason).toContain('0.3');
  });

  it('defaults to manifest-first', () => {
    const task: TaskContext = {};
    const result = selectContextStrategy(task, makeBinding());
    expect(result.strategy).toBe('manifest-first');
    expect(result.reason).toContain('Default');
  });

  it('step 1 does not trigger if components are also modified', () => {
    const task: TaskContext = {
      triggerEvent: 'design-token.changed',
      modifiesComponents: true,
    };
    const result = selectContextStrategy(task, makeBinding());
    // Should fall through to step 2 (manifest-first), not tokens-only
    expect(result.strategy).toBe('manifest-first');
  });

  it('reusability above 0.5 does not force full', () => {
    const task: TaskContext = { reusabilityScore: 0.7 };
    const result = selectContextStrategy(task, makeBinding());
    expect(result.strategy).toBe('manifest-first'); // default
  });
});

describe('reEvaluateStrategy', () => {
  it('detects strategy change when scope changes', () => {
    const original: TaskContext = { triggerEvent: 'design-token.changed' };
    const updated: TaskContext = {
      triggerEvent: 'design-token.changed',
      modifiesComponents: true,
      createsNewComponent: true,
    };
    const result = reEvaluateStrategy(original, updated, makeBinding());
    expect(result.changed).toBe(true);
    expect(result.result.strategy).toBe('full');
    expect(result.reason).toBe('scope-changed-at-impact-review');
  });

  it('reports no change when scope is the same', () => {
    const task: TaskContext = { modifiesComponents: true };
    const result = reEvaluateStrategy(task, task, makeBinding());
    expect(result.changed).toBe(false);
  });
});
