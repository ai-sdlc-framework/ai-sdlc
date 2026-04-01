import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REVIEW_CONFIGS,
  type SdkReviewConfig,
  runParallelSdkReviews,
} from './sdk-review-runner.js';

describe('DEFAULT_REVIEW_CONFIGS', () => {
  it('has 3 reviewer configurations', () => {
    expect(DEFAULT_REVIEW_CONFIGS).toHaveLength(3);
  });

  it('covers testing, security, and critic types', () => {
    const types = DEFAULT_REVIEW_CONFIGS.map((c) => c.type);
    expect(types).toContain('testing');
    expect(types).toContain('security');
    expect(types).toContain('critic');
  });

  it('security reviewer cannot use Bash', () => {
    const security = DEFAULT_REVIEW_CONFIGS.find((c) => c.type === 'security')!;
    expect(security.disallowedTools).toContain('Bash');
  });

  it('no reviewer can use Edit or Write', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.disallowedTools).toContain('Edit');
      expect(config.disallowedTools).toContain('Write');
    }
  });

  it('no reviewer can spawn sub-agents', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.disallowedTools).toContain('AgentTool');
    }
  });

  it('all reviewers have Read access', () => {
    for (const config of DEFAULT_REVIEW_CONFIGS) {
      expect(config.allowedTools).toContain('Read');
    }
  });
});

describe('runParallelSdkReviews', () => {
  it('returns error when SDK is not installed', async () => {
    const result = await runParallelSdkReviews({
      diff: 'some diff content',
      prTitle: 'Fix bug',
      prNumber: 42,
      workDir: '/tmp/test',
    });

    expect(result.allApproved).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('claude-agent-sdk');
  });

  it('accepts custom review configs', async () => {
    const custom: SdkReviewConfig[] = [
      {
        type: 'testing',
        allowedTools: ['Read'],
        disallowedTools: ['Bash'],
        maxBudgetUsd: 0.25,
        maxTurns: 10,
      },
    ];

    const result = await runParallelSdkReviews({
      diff: 'diff',
      prTitle: 'Test',
      prNumber: 1,
      workDir: '/tmp',
      reviewConfigs: custom,
    });

    // Will fail on SDK import, but shouldn't crash
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
