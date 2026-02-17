/**
 * CLI command tests — exercises each command by mocking the Orchestrator class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ── Mock Orchestrator ────────────────────────────────────────────────

const mockRun = vi.fn();
const mockClose = vi.fn();
const mockStart = vi.fn();
const mockStatus = vi.fn();
const mockHealth = vi.fn();
const mockAgents = vi.fn();
const mockRouting = vi.fn();
const mockComplexity = vi.fn();
const mockCost = vi.fn();
const mockDashboard = vi.fn();

vi.mock('../../orchestrator.js', () => ({
  Orchestrator: vi.fn().mockImplementation(() => ({
    run: mockRun,
    close: mockClose,
    start: mockStart,
    status: mockStatus,
    health: mockHealth,
    agents: mockAgents,
    routing: mockRouting,
    complexity: mockComplexity,
    cost: mockCost,
    dashboard: mockDashboard,
  })),
}));

// Mock formatOutput to return JSON for easy assertion
vi.mock('../formatters/index.js', () => ({
  formatOutput: vi.fn((_fmt: string, data: Record<string, unknown>) => JSON.stringify(data)),
}));

// Mock dashboard renderer
vi.mock('../dashboard-renderer.js', () => ({
  renderDashboardFrame: vi.fn(() => 'DASHBOARD_FRAME'),
}));

vi.mock('../../defaults.js', async () => {
  const actual = await vi.importActual<typeof import('../../defaults.js')>('../../defaults.js');
  return actual;
});

// fs mock state
const mockExistsSync = vi.fn<(p: string) => boolean>(() => false);
const mockMkdirSync = vi.fn<(p: string, opts?: object) => void>();
const mockWriteFileSync = vi.fn<(p: string, data: string, enc?: string) => void>();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => mockExistsSync(p),
    mkdirSync: (p: string, opts?: object) => mockMkdirSync(p, opts),
    writeFileSync: (p: string, data: string, enc?: string) => mockWriteFileSync(p, data, enc),
  };
});

let consoleSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  consoleSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  process.exitCode = undefined;
});

// ── Helper: wrap a subcommand under a parent program ─────────────────

function wrapCommand(cmd: Command): Command {
  const program = new Command();
  program.option('-f, --format <type>', 'Output format', 'json');
  program.option('-c, --config <path>', 'Config directory');
  program.exitOverride();
  cmd.exitOverride();
  program.addCommand(cmd);
  return program;
}

// ── init ─────────────────────────────────────────────────────────────

// init command tests need fresh Command instances since Commander is stateful.
// We re-create programs per test to avoid stale --dry-run state.

async function getInitProgram() {
  // The initCommand is a module-level singleton in init.ts,
  // but Commander's `parse` mutates internal state. We create a
  // fresh wrapper program each time, but the singleton itself persists.
  // To work around this, we test via the parent program pattern.
  const { initCommand } = await import('./init.js');
  return initCommand;
}

describe('init command', () => {
  it('respects --dry-run flag', async () => {
    const cmd = await getInitProgram();
    await cmd.parseAsync(['--dry-run'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Would create');
    expect(output).toContain('pipeline.yaml');
  });

  it('creates config files when directory does not exist', async () => {
    // existsSync returns false for dir check AND each file check
    mockExistsSync.mockReturnValue(false);

    const cmd = await getInitProgram();
    // Commander caches parsed options on the same instance.
    // Reset options to clear any --dry-run from prior test.
    cmd.setOptionValue('dryRun', undefined);
    await cmd.parseAsync([], { from: 'user' });

    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalledTimes(4);
  });

  it('skips files that already exist', async () => {
    mockExistsSync.mockReturnValue(true);

    const cmd = await getInitProgram();
    cmd.setOptionValue('dryRun', undefined);
    await cmd.parseAsync([], { from: 'user' });

    expect(mockWriteFileSync).not.toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('skip');
  });
});

// ── run ──────────────────────────────────────────────────────────────

describe('run command', () => {
  it('passes issue number to orchestrator.run', async () => {
    mockRun.mockResolvedValue({
      prUrl: 'https://github.com/test/pr/1',
      filesChanged: ['file.ts'],
      promotionEligible: false,
    });

    const { runCommand } = await import('./run.js');
    const program = wrapCommand(runCommand);
    await program.parseAsync(['run', '-i', '42'], { from: 'user' });

    expect(mockRun).toHaveBeenCalledWith(42);
    expect(consoleSpy).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it('handles errors gracefully', async () => {
    mockRun.mockRejectedValue(new Error('pipeline failed'));

    const { runCommand } = await import('./run.js');
    const program = wrapCommand(runCommand);
    await program.parseAsync(['run', '-i', '99'], { from: 'user' });

    expect(consoleErrorSpy).toHaveBeenCalledWith('pipeline failed');
    expect(process.exitCode).toBe(1);
    expect(mockClose).toHaveBeenCalled();
  });
});

// ── status ───────────────────────────────────────────────────────────

describe('status command', () => {
  it('works without --issue filter', async () => {
    mockStatus.mockResolvedValue({
      config: { pipeline: { metadata: { name: 'test-pipeline' } } },
      recentRuns: [],
    });

    const { statusCommand } = await import('./status.js');
    const program = wrapCommand(statusCommand);
    await program.parseAsync(['status'], { from: 'user' });

    expect(mockStatus).toHaveBeenCalledWith(undefined);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('passes issue filter to orchestrator.status', async () => {
    mockStatus.mockResolvedValue({
      config: { pipeline: { metadata: { name: 'test' } } },
      recentRuns: [{ runId: 'r-1', status: 'completed' }],
    });

    const { statusCommand } = await import('./status.js');
    const program = wrapCommand(statusCommand);
    await program.parseAsync(['status', '-i', '5'], { from: 'user' });

    expect(mockStatus).toHaveBeenCalledWith(5);
  });
});

// ── health ───────────────────────────────────────────────────────────

describe('health command', () => {
  it('reports healthy state', async () => {
    mockHealth.mockResolvedValue({
      configValid: true,
      stateStoreConnected: true,
      errors: [],
    });

    const { healthCommand } = await import('./health.js');
    const program = wrapCommand(healthCommand);
    await program.parseAsync(['health'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('sets exit code 1 when errors present', async () => {
    mockHealth.mockResolvedValue({
      configValid: false,
      stateStoreConnected: false,
      errors: ['Config: missing pipeline.yaml'],
    });

    const { healthCommand } = await import('./health.js');
    const program = wrapCommand(healthCommand);
    await program.parseAsync(['health'], { from: 'user' });

    expect(process.exitCode).toBe(1);
  });
});

// ── agents ───────────────────────────────────────────────────────────

describe('agents command', () => {
  it('lists all agents', async () => {
    mockAgents.mockResolvedValue([
      { agentName: 'agent-1', autonomyLevel: 2, totalRuns: 10 },
      { agentName: 'agent-2', autonomyLevel: 0, totalRuns: 3 },
    ]);

    const { agentsCommand } = await import('./agents.js');
    const program = wrapCommand(agentsCommand);
    await program.parseAsync(['agents'], { from: 'user' });

    expect(mockAgents).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('filters by agent name argument', async () => {
    mockAgents.mockResolvedValue([
      { agentName: 'agent-1', autonomyLevel: 2, totalRuns: 10 },
      { agentName: 'agent-2', autonomyLevel: 0, totalRuns: 3 },
    ]);

    const { agentsCommand } = await import('./agents.js');
    const program = wrapCommand(agentsCommand);
    await program.parseAsync(['agents', 'agent-1'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].agentName).toBe('agent-1');
  });
});

// ── routing ──────────────────────────────────────────────────────────

describe('routing command', () => {
  it('shows routing history', async () => {
    mockRouting.mockResolvedValue([
      { issueNumber: 1, strategy: 'fully-autonomous', decidedAt: new Date().toISOString() },
    ]);

    const { routingCommand } = await import('./routing.js');
    const program = wrapCommand(routingCommand);
    await program.parseAsync(['routing'], { from: 'user' });

    expect(mockRouting).toHaveBeenCalledWith({ limit: 200 });
    expect(consoleSpy).toHaveBeenCalled();
  });
});

// ── complexity ───────────────────────────────────────────────────────

describe('complexity command', () => {
  it('shows complexity profile', async () => {
    mockComplexity.mockResolvedValue({
      profile: { score: 5, filesCount: 100 },
      context: { summary: 'Medium complexity' },
    });

    const { complexityCommand } = await import('./complexity.js');
    const program = wrapCommand(complexityCommand);
    await program.parseAsync(['complexity'], { from: 'user' });

    expect(mockComplexity).toHaveBeenCalledWith({ analyze: undefined });
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('passes --analyze flag', async () => {
    mockComplexity.mockResolvedValue({
      profile: { score: 7 },
      context: {},
    });

    const { complexityCommand } = await import('./complexity.js');
    const program = wrapCommand(complexityCommand);
    await program.parseAsync(['complexity', '--analyze'], { from: 'user' });

    expect(mockComplexity).toHaveBeenCalledWith({ analyze: true });
  });
});

// ── cost ─────────────────────────────────────────────────────────────

describe('cost command', () => {
  it('shows cost summary', async () => {
    mockCost.mockResolvedValue({
      summary: { totalCostUsd: 50, totalTokens: 100000 },
      budget: { budgetUsd: 500, spentUsd: 50, remainingUsd: 450 },
    });

    const { costCommand } = await import('./cost.js');
    const program = wrapCommand(costCommand);
    await program.parseAsync(['cost'], { from: 'user' });

    expect(mockCost).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('passes --budget flag', async () => {
    mockCost.mockResolvedValue({
      summary: { totalCostUsd: 0 },
      budget: { budgetUsd: 200, spentUsd: 0, remainingUsd: 200 },
    });

    const { costCommand } = await import('./cost.js');
    const program = wrapCommand(costCommand);
    await program.parseAsync(['cost', '--budget', '200'], { from: 'user' });

    expect(mockCost).toHaveBeenCalledWith(
      expect.objectContaining({ budget: 200 }),
    );
  });
});

// ── dashboard ────────────────────────────────────────────────────────

describe('dashboard command', () => {
  it('starts dashboard render loop', async () => {
    mockDashboard.mockResolvedValue({
      runs: [],
      agents: [],
      costSummary: { totalCostUsd: 0 },
      budgetStatus: { budgetUsd: 500 },
    });

    // Mock stdout to prevent ANSI escape codes in test
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { dashboardCommand } = await import('./dashboard.js');
    const program = wrapCommand(dashboardCommand);

    // Dashboard starts an interval and never resolves
    void program.parseAsync(
      ['dashboard', '--refresh', '50'],
      { from: 'user' },
    );

    // Wait for initial render
    await new Promise((r) => setTimeout(r, 150));

    // Dashboard should have called orchestrator.dashboard() at least once
    expect(mockDashboard).toHaveBeenCalled();

    writeSpy.mockRestore();
  });
});

// ── start ────────────────────────────────────────────────────────────

describe('start command', () => {
  it('starts watch mode', async () => {
    const mockStop = vi.fn();
    mockStart.mockResolvedValue({ stop: mockStop });

    const { startCommand } = await import('./start.js');
    const program = wrapCommand(startCommand);
    await program.parseAsync(['start'], { from: 'user' });

    expect(mockStart).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Watch mode started'),
    );
  });
});
