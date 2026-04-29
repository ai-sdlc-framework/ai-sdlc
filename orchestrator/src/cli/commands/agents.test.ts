/**
 * Unit tests for `loadDeclaredAgents` — the helper that surfaces
 * declared-but-not-executed AgentRoles in `ai-sdlc agents` so a fresh
 * install isn't greeted by an empty roster (AISDLC-78 AC #10).
 *
 * These cover the parser branches (single doc, multi-doc, non-AgentRole
 * filtering, missing dir, malformed yaml) plus the integration with the
 * `agents` Commander action that merges the autonomy ledger with the
 * declared list.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadDeclaredAgents } from './agents.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'declared-agents-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadDeclaredAgents', () => {
  it('returns empty array when configDir does not exist', () => {
    const result = loadDeclaredAgents(join(tmpDir, 'does-not-exist'));
    expect(result).toEqual([]);
  });

  it('parses a single-document AgentRole YAML and surfaces declaredOnly=true', () => {
    writeFileSync(
      join(tmpDir, 'agent-role.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: default-agent
spec:
  role: developer
  goal: implement
`,
      'utf-8',
    );

    const result = loadDeclaredAgents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      agentName: 'default-agent',
      currentLevel: 0,
      totalTasks: 0,
      successCount: 0,
      failureCount: 0,
      declaredOnly: true,
    });
  });

  it('parses multi-document YAML separated by `---`', () => {
    writeFileSync(
      join(tmpDir, 'roster.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: alpha
spec:
  role: developer
---
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: beta
spec:
  role: reviewer
`,
      'utf-8',
    );

    const result = loadDeclaredAgents(tmpDir);
    expect(result.map((a) => a.agentName).sort()).toEqual(['alpha', 'beta']);
  });

  it('ignores non-AgentRole kinds (Pipeline, QualityGate, AutonomyPolicy)', () => {
    // Mixed config dir: only the AgentRole entry should surface.
    writeFileSync(
      join(tmpDir, 'pipeline.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: default
`,
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'quality-gate.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: default-gates
`,
      'utf-8',
    );
    writeFileSync(
      join(tmpDir, 'agent-role.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: only-this
`,
      'utf-8',
    );

    const result = loadDeclaredAgents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('only-this');
  });

  it('skips AgentRole entries missing metadata.name', () => {
    writeFileSync(
      join(tmpDir, 'broken.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata: {}
`,
      'utf-8',
    );
    const result = loadDeclaredAgents(tmpDir);
    expect(result).toEqual([]);
  });

  it('swallows malformed YAML without throwing (validate command surfaces those)', () => {
    writeFileSync(
      join(tmpDir, 'broken.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: ok
spec:
  tools:
    - Edit
   bad-indent: oops
:::not yaml
`,
      'utf-8',
    );
    // Add a sibling that's valid so we can confirm we keep going.
    writeFileSync(
      join(tmpDir, 'good.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: still-here
`,
      'utf-8',
    );

    const result = loadDeclaredAgents(tmpDir);
    // The malformed file is silently skipped; the good one still surfaces.
    expect(result.map((a) => a.agentName)).toContain('still-here');
  });

  it('only considers .yaml/.yml files (ignores .json, .md, etc.)', () => {
    writeFileSync(
      join(tmpDir, 'agent-role.json'),
      JSON.stringify({ kind: 'AgentRole', metadata: { name: 'json-agent' } }),
      'utf-8',
    );
    writeFileSync(join(tmpDir, 'README.md'), '# notes', 'utf-8');
    writeFileSync(
      join(tmpDir, 'role.yml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: yml-agent
`,
      'utf-8',
    );

    const result = loadDeclaredAgents(tmpDir);
    // Only the .yml file qualifies; .json and .md are ignored by the filter.
    expect(result.map((a) => a.agentName)).toEqual(['yml-agent']);
  });

  it('handles empty doc segments (e.g. trailing `---`) without surfacing nulls', () => {
    writeFileSync(
      join(tmpDir, 'with-trailing.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: solo
---
`,
      'utf-8',
    );
    const result = loadDeclaredAgents(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('solo');
  });
});

// ── Integration: agents action merges runtime + declared ─────────────

const mockAgentsLedger = vi.fn();
const mockClose = vi.fn();

vi.mock('../../orchestrator.js', () => ({
  Orchestrator: vi.fn().mockImplementation(() => ({
    agents: mockAgentsLedger,
    close: mockClose,
  })),
}));

vi.mock('../formatters/index.js', () => ({
  formatOutput: vi.fn((_fmt: string, data: Record<string, unknown>) => JSON.stringify(data)),
}));

describe('agents command — declared + runtime merge (AISDLC-78 AC #10)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('merges declared agents that have not yet executed with the autonomy ledger', async () => {
    // Ledger has agent-already-ran; config dir declares fresh-agent and
    // the same agent-already-ran (which should be deduped — declared-only
    // is filtered out when the runtime ledger already contains the name).
    mockAgentsLedger.mockResolvedValue([
      {
        agentName: 'agent-already-ran',
        currentLevel: 1,
        totalTasks: 5,
        successCount: 5,
        failureCount: 0,
        lastTaskAt: '2026-04-01T12:00:00Z',
      },
    ]);

    writeFileSync(
      join(tmpDir, 'agent-role.yaml'),
      `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: agent-already-ran
---
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: fresh-agent
`,
      'utf-8',
    );

    const { Command } = await import('commander');
    const { agentsCommand } = await import('./agents.js');

    const program = new Command();
    program.option('-f, --format <type>', '', 'json');
    program.option('-c, --config <path>', '', tmpDir);
    program.exitOverride();
    agentsCommand.exitOverride();
    program.addCommand(agentsCommand);

    await program.parseAsync(['agents'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalled();
    const out = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(out);

    // Two rows: the runtime entry (declaredOnly=false) + the declared-only
    // entry. agent-already-ran must NOT appear twice.
    expect(parsed.agents).toHaveLength(2);
    const ran = parsed.agents.find(
      (a: { agentName: string }) => a.agentName === 'agent-already-ran',
    );
    const fresh = parsed.agents.find((a: { agentName: string }) => a.agentName === 'fresh-agent');
    expect(ran).toBeDefined();
    expect(ran.declaredOnly).toBe(false);
    expect(fresh).toBeDefined();
    expect(fresh.declaredOnly).toBe(true);
    expect(fresh.totalTasks).toBe(0);
  });

  it('reports orchestrator errors via console.error and sets exit code 1', async () => {
    mockAgentsLedger.mockRejectedValue(new Error('db locked'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { Command } = await import('commander');
    const { agentsCommand } = await import('./agents.js');

    const program = new Command();
    program.option('-f, --format <type>', '', 'json');
    program.option('-c, --config <path>', '', tmpDir);
    program.exitOverride();
    agentsCommand.exitOverride();
    program.addCommand(agentsCommand);

    process.exitCode = undefined;
    await program.parseAsync(['agents'], { from: 'user' });

    expect(errSpy).toHaveBeenCalledWith('db locked');
    expect(process.exitCode).toBe(1);
    expect(mockClose).toHaveBeenCalled();

    errSpy.mockRestore();
    process.exitCode = undefined;
  });
});
