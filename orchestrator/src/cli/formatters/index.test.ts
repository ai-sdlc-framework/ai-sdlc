/**
 * Formatter dispatch tests — confirm `formatOutput` routes to the
 * correct backend and that the json/minimal helpers behave on the
 * agents type that AISDLC-78 added the declared-only marker to (so
 * machine consumers also see the flag).
 */

import { describe, it, expect } from 'vitest';
import { formatOutput } from './index.js';
import { formatJson } from './json.js';
import { formatMinimal } from './minimal.js';

describe('formatOutput dispatch', () => {
  const sample = { type: 'agents', agents: [{ agentName: 'a', currentLevel: 0, totalTasks: 0 }] };

  it("returns table output for format='table'", () => {
    const out = formatOutput('table', sample);
    expect(out).toContain('Agent Roster');
  });

  it("returns JSON output for format='json'", () => {
    const out = formatOutput('json', sample);
    // Pretty-printed JSON includes 2-space indent
    expect(out).toMatch(/^\{\n {2}"type":/);
    expect(JSON.parse(out)).toEqual(sample);
  });

  it("returns minimal output for format='minimal'", () => {
    const out = formatOutput('minimal', sample);
    expect(out).toBe('Agents: 1');
  });

  it('defaults to table when format is unrecognized', () => {
    const out = formatOutput('xml', sample);
    expect(out).toContain('Agent Roster');
  });
});

describe('formatJson', () => {
  it('produces stable pretty-printed JSON', () => {
    const out = formatJson({ a: 1, b: [2, 3] });
    expect(out).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  });
});

describe('formatMinimal', () => {
  it('renders run summary as one line', () => {
    expect(formatMinimal({ type: 'run', prUrl: 'https://x/y', filesChanged: 3 })).toBe(
      'PR: https://x/y (3 files)',
    );
  });

  it('renders status as pipeline + run count', () => {
    expect(formatMinimal({ type: 'status', pipeline: 'default', recentRuns: [{}, {}, {}] })).toBe(
      'Pipeline: default | Runs: 3',
    );
  });

  it('renders OK when health passes', () => {
    expect(formatMinimal({ type: 'health', configValid: true, errors: [] })).toBe('OK');
  });

  it('renders UNHEALTHY with error list when health fails', () => {
    expect(formatMinimal({ type: 'health', configValid: false, errors: ['e1', 'e2'] })).toBe(
      'UNHEALTHY: e1; e2',
    );
  });

  it('renders agents count', () => {
    expect(formatMinimal({ type: 'agents', agents: [{}, {}] })).toBe('Agents: 2');
  });

  it('renders routing decisions count + duration', () => {
    expect(formatMinimal({ type: 'routing', history: [{}, {}], duration: '24h' })).toBe(
      'Routing decisions: 2 (last 24h)',
    );
  });

  it('renders complexity score line', () => {
    expect(
      formatMinimal({
        type: 'complexity',
        profile: { score: 6, filesCount: 100, modulesCount: 5 },
      }),
    ).toBe('Complexity: 6/10 | 100 files | 5 modules');
  });

  it('renders cost line', () => {
    expect(
      formatMinimal({
        type: 'cost',
        summary: { totalCostUsd: 1.234, entryCount: 3 },
        budget: { utilizationPercent: 12.5 },
      }),
    ).toBe('Cost: $1.23 | Budget: 13% used | Runs: 3');
  });

  it('falls back to JSON.stringify for unknown type', () => {
    const out = formatMinimal({ type: 'mystery', x: 1 });
    expect(out).toBe(JSON.stringify({ type: 'mystery', x: 1 }));
  });
});
