import { describe, it, expect } from 'vitest';
import { RunCard } from './run-card';
import type { RunSummary } from '@/lib/types';

describe('RunCard', () => {
  it('renders a completed run', () => {
    const run: RunSummary = {
      runId: 'abc12345-xyz',
      pipelineType: 'feature',
      status: 'completed',
      costUsd: 0.42,
      issueNumber: 123,
    };
    const result = RunCard({ run });
    expect(result).toBeTruthy();
  });

  it('renders a failed run', () => {
    const run: RunSummary = {
      runId: 'fail-run',
      pipelineType: 'fix-ci',
      status: 'failed',
    };
    const result = RunCard({ run });
    expect(result).toBeTruthy();
  });

  it('renders without optional fields', () => {
    const run: RunSummary = {
      runId: 'minimal',
      pipelineType: 'bugfix',
      status: 'pending',
    };
    const result = RunCard({ run });
    expect(result).toBeTruthy();
  });
});
