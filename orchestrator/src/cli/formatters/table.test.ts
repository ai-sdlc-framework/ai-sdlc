/**
 * Tests for the human-readable table formatter.
 *
 * AISDLC-78 specifically asserts:
 *  - the `agents` table marks declared-but-not-executed rows with the
 *    `(declared, not yet executed)` hint so a fresh-install user knows
 *    why their just-declared default-agent shows zero tasks; and
 *  - the `health` table emits the deferred-state-store messaging
 *    instead of the older `not configured` string that read like a
 *    setup failure.
 *
 * Other branches are covered to lift the file from 0% — these tests
 * also serve as smoke-tests against accidental shape regressions in the
 * CLI output (snapshot-style on substring assertions, not whole-line
 * matches, so column padding tweaks don't constantly break the suite).
 */

import { describe, it, expect } from 'vitest';
import { formatTable } from './table.js';

describe('formatTable — agents (AISDLC-78 AC #10)', () => {
  it('renders the declared-only marker for declaredOnly rows', () => {
    const out = formatTable({
      type: 'agents',
      agents: [
        {
          agentName: 'default-agent',
          currentLevel: 0,
          totalTasks: 0,
          successCount: 0,
          declaredOnly: true,
        },
      ],
    });
    expect(out).toContain('Agent Roster');
    expect(out).toContain('default-agent');
    expect(out).toContain('(declared, not yet executed)');
    // Total=0 means success% is the dash sentinel, not 0% (which would
    // imply 0/0 success rate, misleading on a fresh install).
    expect(out).toMatch(/default-agent\s+0\s+0\s+-/);
  });

  it('renders executed rows with the last-task date (YYYY-MM-DD slice)', () => {
    const out = formatTable({
      type: 'agents',
      agents: [
        {
          agentName: 'agent-x',
          currentLevel: 2,
          totalTasks: 10,
          successCount: 9,
          lastTaskAt: '2026-04-15T08:30:00Z',
          declaredOnly: false,
        },
      ],
    });
    expect(out).toContain('agent-x');
    expect(out).toContain('2026-04-15');
    // 9/10 → 90%
    expect(out).toContain('90%');
    expect(out).not.toContain('(declared, not yet executed)');
  });

  it('falls back to "-" when an executed agent has no lastTaskAt', () => {
    const out = formatTable({
      type: 'agents',
      agents: [
        {
          agentName: 'no-history',
          currentLevel: 0,
          totalTasks: 1,
          successCount: 0,
          declaredOnly: false,
        },
      ],
    });
    // 0/1 success → 0%
    expect(out).toContain('0%');
    // No lastTaskAt → trailing dash sentinel
    expect(out).toMatch(/no-history\s+0\s+1\s+0%\s+-/);
  });

  it('shows "No agents registered." for empty roster', () => {
    const out = formatTable({ type: 'agents', agents: [] });
    expect(out).toContain('No agents registered.');
  });
});

describe('formatTable — health (AISDLC-78 deferred-state messaging)', () => {
  it('emits the deferred-init hint when state store is not connected', () => {
    const out = formatTable({
      type: 'health',
      configValid: true,
      stateStoreConnected: false,
      errors: [],
    });
    expect(out).toContain('Health Check');
    expect(out).toContain('Config:      valid');
    // The whole point of AISDLC-78 — the older "not configured" string
    // read like a setup failure. Operators now see why and how to
    // pre-create the store.
    expect(out).toContain('deferred (initializes on first pipeline run');
    expect(out).toContain('--init-state');
  });

  it('emits "connected" when the store is live', () => {
    const out = formatTable({
      type: 'health',
      configValid: true,
      stateStoreConnected: true,
      errors: [],
    });
    expect(out).toContain('State Store: connected');
    expect(out).not.toContain('deferred');
  });

  it('lists errors when present', () => {
    const out = formatTable({
      type: 'health',
      configValid: false,
      stateStoreConnected: false,
      errors: ['Config: missing pipeline.yaml', 'State: db corrupted'],
    });
    expect(out).toContain('Config:      INVALID');
    expect(out).toContain('Errors:');
    expect(out).toContain('- Config: missing pipeline.yaml');
    expect(out).toContain('- State: db corrupted');
  });
});

describe('formatTable — run', () => {
  it('renders the pipeline run summary block', () => {
    const out = formatTable({
      type: 'run',
      issueNumber: 42,
      prUrl: 'https://github.com/foo/bar/pull/7',
      filesChanged: 3,
      promotionEligible: true,
    });
    expect(out).toContain('Pipeline Run Result');
    expect(out).toContain('Issue:      #42');
    expect(out).toContain('PR URL:     https://github.com/foo/bar/pull/7');
    expect(out).toContain('Files:      3');
    expect(out).toContain('Promotion:  eligible');
  });

  it('reports "not eligible" when promotionEligible is false', () => {
    const out = formatTable({
      type: 'run',
      issueNumber: 1,
      prUrl: 'https://example.com/pr/1',
      filesChanged: 0,
      promotionEligible: false,
    });
    expect(out).toContain('Promotion:  not eligible');
  });
});

describe('formatTable — status', () => {
  it('renders empty-runs message', () => {
    const out = formatTable({
      type: 'status',
      pipeline: 'default',
      recentRuns: [],
    });
    expect(out).toContain('Pipeline: default');
    expect(out).toContain('No recent runs.');
  });

  it('renders run rows when present', () => {
    const out = formatTable({
      type: 'status',
      pipeline: 'default',
      recentRuns: [
        { runId: 'r-1', issueNumber: 5, status: 'completed', startedAt: '2026-04-20T10:00:00Z' },
        { runId: 'r-2', status: 'running' },
      ],
    });
    expect(out).toContain('r-1');
    expect(out).toContain('#5');
    expect(out).toContain('completed');
    expect(out).toContain('r-2');
    // No issueNumber → fallback dash
    expect(out).toMatch(/r-2\s+-/);
  });
});

describe('formatTable — routing', () => {
  it('groups by strategy and computes percentages', () => {
    const out = formatTable({
      type: 'routing',
      duration: '7d',
      history: [
        { routingStrategy: 'fully-autonomous' },
        { routingStrategy: 'fully-autonomous' },
        { routingStrategy: 'human-review' },
        { routingStrategy: 'fully-autonomous' },
      ],
    });
    expect(out).toContain('Routing Distribution (last 7d)');
    expect(out).toContain('fully-autonomous');
    expect(out).toContain('human-review');
    // 3/4 = 75%
    expect(out).toContain('75%');
    // 1/4 = 25%
    expect(out).toContain('25%');
  });

  it('reports "No routing decisions recorded." when history is empty', () => {
    const out = formatTable({ type: 'routing', history: [] });
    expect(out).toContain('No routing decisions recorded.');
  });
});

describe('formatTable — validate', () => {
  it('renders valid + invalid file rows with error detail', () => {
    const out = formatTable({
      type: 'validate',
      configDir: '.ai-sdlc',
      results: [
        { file: 'pipeline.yaml', kind: 'Pipeline', valid: true, errors: [] },
        {
          file: 'quality-gate.yaml',
          kind: 'QualityGate',
          valid: false,
          errors: [{ path: '/spec/gates', message: 'must be array' }],
        },
      ],
    });
    expect(out).toContain('Validation Results (.ai-sdlc)');
    expect(out).toContain('pipeline.yaml');
    expect(out).toContain('VALID');
    expect(out).toContain('quality-gate.yaml');
    expect(out).toContain('INVALID');
    expect(out).toContain('/spec/gates: must be array');
  });

  it('reports "No YAML files found." for an empty config dir', () => {
    const out = formatTable({
      type: 'validate',
      configDir: '.ai-sdlc',
      results: [],
    });
    expect(out).toContain('No YAML files found.');
  });
});

describe('formatTable — complexity', () => {
  it('renders score header + patterns/hotspots/conventions sections', () => {
    const out = formatTable({
      type: 'complexity',
      profile: {
        score: 7,
        filesCount: 250,
        modulesCount: 18,
        dependencyCount: 42,
        architecturalPatterns: [
          { name: 'mvc', confidence: 0.9, description: 'classic mvc' },
          { name: 'event-sourced', confidence: 0.6, description: 'append-only' },
        ],
        hotspots: [{ filePath: 'src/big.ts', churnRate: 0.42, complexity: 18 }],
        conventions: [{ category: 'tests', pattern: '*.test.ts' }],
      },
      context: {},
    });

    expect(out).toContain('Codebase Complexity Profile');
    expect(out).toContain('Score: 7/10');
    expect(out).toContain('Files: 250');
    expect(out).toContain('Modules: 18');
    expect(out).toContain('Deps: 42');
    expect(out).toContain('Architectural Patterns');
    expect(out).toContain('mvc');
    expect(out).toContain('90%');
    expect(out).toContain('Hotspots (top 5)');
    expect(out).toContain('src/big.ts');
    expect(out).toContain('churn: 42%');
    expect(out).toContain('complexity: 18');
    expect(out).toContain('Conventions');
    expect(out).toContain('tests:  *.test.ts');
  });

  it('omits optional sections when arrays are absent', () => {
    const out = formatTable({
      type: 'complexity',
      profile: { score: 3, filesCount: 10, modulesCount: 2, dependencyCount: 5 },
      context: {},
    });
    expect(out).toContain('Score: 3/10');
    expect(out).not.toContain('Architectural Patterns');
    expect(out).not.toContain('Hotspots');
    expect(out).not.toContain('Conventions');
  });
});

describe('formatTable — cost', () => {
  it('renders cost summary, budget block, and per-agent costs', () => {
    const out = formatTable({
      type: 'cost',
      period: '7d',
      summary: {
        totalCostUsd: 12.345,
        totalTokens: 100000,
        entryCount: 8,
        avgCostPerRun: 1.5431,
        costByAgent: { 'agent-a': 8.2, 'agent-b': 4.1 },
      },
      budget: {
        budgetUsd: 50,
        spentUsd: 12.345,
        remainingUsd: 37.655,
        utilizationPercent: 24.69,
        overBudget: false,
      },
    });

    expect(out).toContain('Cost Summary (7d)');
    expect(out).toContain('Total Cost:     $12.35');
    expect(out).toContain('Total Tokens:   100000');
    expect(out).toContain('Runs:           8');
    expect(out).toContain('Avg Cost/Run:   $1.5431');
    expect(out).toContain('Budget:         $50');
    expect(out).toContain('Spent:          $12.35');
    expect(out).toContain('Remaining:      $37.66');
    expect(out).toContain('Utilization:    24.7%');
    expect(out).toContain('Cost by Agent');
    expect(out).toContain('agent-a');
    expect(out).toContain('$8.2000');
    expect(out).toContain('agent-b');
    expect(out).not.toContain('** OVER BUDGET **');
  });

  it('flags over-budget runs and renders filtered agent cost', () => {
    const out = formatTable({
      type: 'cost',
      summary: {
        totalCostUsd: 60,
        totalTokens: 0,
        entryCount: 1,
        avgCostPerRun: 60,
      },
      budget: {
        budgetUsd: 50,
        spentUsd: 60,
        remainingUsd: -10,
        utilizationPercent: 120,
        overBudget: true,
      },
      agent: 'agent-a',
      filteredCost: 60,
    });
    expect(out).toContain('** OVER BUDGET **');
    expect(out).toContain('Filtered (agent-a): $60.0000');
    // No costByAgent key → no per-agent breakdown
    expect(out).not.toContain('Cost by Agent');
  });
});

describe('formatTable — unknown type', () => {
  it('falls through to generic key/value output', () => {
    const out = formatTable({ type: 'mystery-type', alpha: 1, beta: 'two' });
    // Generic dump uses key: JSON.stringify(value) per line.
    expect(out).toContain('alpha: 1');
    expect(out).toContain('beta: "two"');
  });
});
