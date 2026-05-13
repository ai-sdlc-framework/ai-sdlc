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
// AISDLC-143: the wizard's appendOnce reads existing file content via
// readFileSync to honor the idempotency sentinel. Mock it so tests that
// flip mockExistsSync to "true" don't crash on a missing real file.
const mockReadFileSync = vi.fn<(p: string, enc?: string) => string>(() => '');
// AISDLC-262: ensureGitignore uses appendFileSync (not writeFileSync), which
// the original mock omitted. Without this mock, the real appendFileSync runs
// against the actual repo .gitignore when resolveInstallTarget resolves
// process.cwd() to the worktree root. Mock it to a no-op so tests stay
// hermetic and never write to the real filesystem.
const mockAppendFileSync = vi.fn<(p: string, data: string, enc?: string) => void>();

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: (p: string) => mockExistsSync(p),
    mkdirSync: (p: string, opts?: object) => mockMkdirSync(p, opts),
    writeFileSync: (p: string, data: string, enc?: string) => mockWriteFileSync(p, data, enc),
    readFileSync: (p: string, enc?: string) => mockReadFileSync(p, enc),
    appendFileSync: (p: string, data: string, enc?: string) => mockAppendFileSync(p, data, enc),
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

/**
 * Reset all initCommand option state. AISDLC-143 added several new flags
 * (--yes, --with-X, --add) on top of the original --dry-run/--role/etc.;
 * Commander caches parsed options on the singleton instance, so each test
 * needs a clean slate. Centralized so future flag additions only need one
 * place to add.
 */
function resetInitCommandOptions(cmd: Awaited<ReturnType<typeof getInitProgram>>): void {
  cmd.setOptionValue('dryRun', undefined);
  cmd.setOptionValue('role', undefined);
  cmd.setOptionValue('cursor', undefined);
  cmd.setOptionValue('skipMcp', undefined);
  cmd.setOptionValue('yes', undefined);
  cmd.setOptionValue('withDor', undefined);
  cmd.setOptionValue('withAttestation', undefined);
  cmd.setOptionValue('withClassifier', undefined);
  cmd.setOptionValue('withBranchProtection', undefined);
  cmd.setOptionValue('add', undefined);
  // AISDLC-262
  cmd.setOptionValue('workspace', undefined);
}

describe('init command', () => {
  it('respects --dry-run flag', async () => {
    const cmd = await getInitProgram();
    resetInitCommandOptions(cmd);
    // --yes so the wizard doesn't prompt for stdin in a test env
    await cmd.parseAsync(['--dry-run', '--yes'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Would create');
    expect(output).toContain('pipeline.yaml');
  });

  it('creates config files when directory does not exist', async () => {
    // existsSync returns false for dir check AND each file check
    mockExistsSync.mockReturnValue(false);

    const cmd = await getInitProgram();
    resetInitCommandOptions(cmd);
    await cmd.parseAsync(['--skip-mcp', '--yes'], { from: 'user' });

    expect(mockMkdirSync).toHaveBeenCalled();
    // The legacy single-repo init writes 4 files (pipeline.yaml,
    // agent-role.yaml, quality-gate.yaml, autonomy-policy.yaml). The
    // AISDLC-143 wizard adds more (gate workflow, dor, attestation,
    // classifier templates, husky, CLAUDE.md). With --yes the full
    // baseline + every feature is on, so we assert ≥ the legacy count.
    expect(mockWriteFileSync.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('skips files that already exist', async () => {
    // AISDLC-262: `resolveInstallTarget` checks whether `<git-root>/.ai-sdlc/`
    // exists as a directory. If it returns true, init refuses with an error
    // (nesting guard). To exercise the "skip existing files" path, we must
    // return false for the configDir existence check (so we don't trigger the
    // nesting guard) but true for individual file checks (so the 4-file
    // scaffold sees them as "already present" and skips them).
    // We use a path-aware mock: the configDir path ends exactly with `.ai-sdlc`
    // (no trailing slash, no sub-path); individual files are deeper paths.
    mockExistsSync.mockImplementation((p: string) => {
      // Return false for the bare configDir check (AISDLC-262 nesting guard)
      // so init proceeds without refusing. Return true for everything else
      // (individual file paths) so init skips writing them.
      const normalized = String(p).replace(/\\/g, '/');
      if (/\/\.ai-sdlc$/.test(normalized)) return false;
      return true;
    });

    const cmd = await getInitProgram();
    resetInitCommandOptions(cmd);
    await cmd.parseAsync(['--skip-mcp', '--yes'], { from: 'user' });

    // The legacy 4-file scaffold writes nothing (everything already exists).
    // The wizard's appendOnce (husky + CLAUDE.md) writes if our sentinel
    // is missing — and on this mock every file "exists" but has no content
    // tracked, so appendOnce DOES write. Assert that the LEGACY files were
    // skipped (the original behavior the test guards) and ignore wizard
    // append calls.
    const legacyFileWrites = mockWriteFileSync.mock.calls.filter((c) => {
      const path = String(c[0] ?? '');
      return (
        path.endsWith('/pipeline.yaml') ||
        path.endsWith('/agent-role.yaml') ||
        path.endsWith('/quality-gate.yaml') ||
        path.endsWith('/autonomy-policy.yaml')
      );
    });
    expect(legacyFileWrites).toHaveLength(0);
    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('skip');
  });
});

// ── init --role tier defaults (AISDLC-79) ────────────────────────────

describe('init command — agent-role tiers (AISDLC-79)', () => {
  /**
   * Capture the agent-role.yaml content the init command writes for a given
   * --role argv. Returns the content string (the second arg to writeFileSync).
   *
   * Re-imports the module each call so we get a fresh Commander instance and
   * avoid stale option state between tier tests.
   */
  async function captureAgentRoleYaml(argv: string[]): Promise<string | undefined> {
    vi.resetModules();
    mockExistsSync.mockReturnValue(false);

    const { initCommand } = await import('./init.js');
    resetInitCommandOptions(initCommand);

    await initCommand.parseAsync(['--skip-mcp', '--yes', ...argv], { from: 'user' });

    const call = mockWriteFileSync.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('agent-role.yaml'),
    );
    return call ? (call[1] as string) : undefined;
  }

  it('defaults to coding tier (no --role flag) — preserves pre-AISDLC-79 behavior + NotebookEdit', async () => {
    const yaml = await captureAgentRoleYaml([]);
    expect(yaml).toBeDefined();
    expect(yaml).toContain('Tier: coding-agent (default)');
    // Coding tier tools
    expect(yaml).toMatch(/^\s*-\s*Edit\b/m);
    expect(yaml).toMatch(/^\s*-\s*Write\b/m);
    expect(yaml).toMatch(/^\s*-\s*Read\b/m);
    expect(yaml).toMatch(/^\s*-\s*Glob\b/m);
    expect(yaml).toMatch(/^\s*-\s*Grep\b/m);
    expect(yaml).toMatch(/^\s*-\s*Bash\b/m);
    expect(yaml).toMatch(/^\s*-\s*NotebookEdit\b/m);
    // Excluded tools must NOT appear as actual list items (commented mentions are fine)
    expect(yaml).not.toMatch(/^\s*-\s*WebFetch\b/m);
    expect(yaml).not.toMatch(/^\s*-\s*WebSearch\b/m);
    expect(yaml).not.toMatch(/^\s*-\s*Task\b/m);
    expect(yaml).not.toMatch(/^\s*-\s*Skill\b/m);
  });

  it('--role coding produces the same template as the default', async () => {
    const yaml = await captureAgentRoleYaml(['--role', 'coding']);
    expect(yaml).toBeDefined();
    expect(yaml).toContain('Tier: coding-agent (default)');
    expect(yaml).toMatch(/^\s*-\s*NotebookEdit\b/m);
    expect(yaml).not.toMatch(/^\s*-\s*WebFetch\b/m);
  });

  it('--role research adds WebFetch + WebSearch on top of coding tier', async () => {
    const yaml = await captureAgentRoleYaml(['--role', 'research']);
    expect(yaml).toBeDefined();
    expect(yaml).toContain('Tier: research-agent');
    expect(yaml).toMatch(/^\s*-\s*Edit\b/m);
    expect(yaml).toMatch(/^\s*-\s*NotebookEdit\b/m);
    expect(yaml).toMatch(/^\s*-\s*WebFetch\b/m);
    expect(yaml).toMatch(/^\s*-\s*WebSearch\b/m);
    // Still excludes meta-tier tools
    expect(yaml).not.toMatch(/^\s*-\s*Task\b/m);
    expect(yaml).not.toMatch(/^\s*-\s*Skill\b/m);
  });

  it('--role meta adds Task + Skill on top of research tier', async () => {
    const yaml = await captureAgentRoleYaml(['--role', 'meta']);
    expect(yaml).toBeDefined();
    expect(yaml).toContain('Tier: meta-agent');
    expect(yaml).toMatch(/^\s*-\s*Edit\b/m);
    expect(yaml).toMatch(/^\s*-\s*NotebookEdit\b/m);
    expect(yaml).toMatch(/^\s*-\s*WebFetch\b/m);
    expect(yaml).toMatch(/^\s*-\s*WebSearch\b/m);
    expect(yaml).toMatch(/^\s*-\s*Task\b/m);
    expect(yaml).toMatch(/^\s*-\s*Skill\b/m);
  });

  it('rejects invalid --role value with exit code 1', async () => {
    vi.resetModules();
    mockExistsSync.mockReturnValue(false);

    const { initCommand } = await import('./init.js');
    resetInitCommandOptions(initCommand);

    // No --yes here: invalid --role exits before the wizard runs, so the
    // test never blocks on stdin even without --yes. We deliberately do
    // NOT pass --yes so that an early-exit regression (validating --role
    // AFTER the wizard runs) would surface as a hung test.
    await initCommand.parseAsync(['--skip-mcp', '--role', 'bogus'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errOutput = consoleErrorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(errOutput).toContain("invalid --role value 'bogus'");
    expect(errOutput).toContain('coding');
    expect(errOutput).toContain('research');
    expect(errOutput).toContain('meta');
    // No files should have been written when validation fails
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('exposes getAgentRoleYaml + AGENT_ROLE_TIERS from init module', async () => {
    vi.resetModules();
    const mod = await import('./init.js');
    expect(mod.AGENT_ROLE_TIERS).toEqual(['coding', 'research', 'meta']);
    expect(mod.getAgentRoleYaml('coding')).toContain('coding-agent (default)');
    expect(mod.getAgentRoleYaml('research')).toContain('research-agent');
    expect(mod.getAgentRoleYaml('meta')).toContain('meta-agent');
    // Default arg = 'coding'
    expect(mod.getAgentRoleYaml()).toBe(mod.getAgentRoleYaml('coding'));
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

    expect(mockRun).toHaveBeenCalledWith('42');
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

    expect(mockCost).toHaveBeenCalledWith(expect.objectContaining({ budget: 200 }));
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
    void program.parseAsync(['dashboard', '--refresh', '50'], { from: 'user' });

    // Wait for initial render
    await new Promise((r) => setTimeout(r, 150));

    // Dashboard should have called orchestrator.dashboard() at least once
    expect(mockDashboard).toHaveBeenCalled();

    writeSpy.mockRestore();
  });
});

// ── validate ─────────────────────────────────────────────────────────

const mockValidateConfigFiles = vi.fn();

vi.mock('../../validate-config.js', () => ({
  validateConfigFiles: (...args: unknown[]) => mockValidateConfigFiles(...args),
}));

describe('validate command', () => {
  it('shows validation results for all files', async () => {
    mockValidateConfigFiles.mockReturnValue([
      { file: 'pipeline.yaml', kind: 'Pipeline', valid: true, errors: [] },
      {
        file: 'quality-gate.yaml',
        kind: 'QualityGate',
        valid: false,
        errors: [
          {
            path: '/spec/gates/0/rule',
            message: 'Value must match exactly one of the allowed variants',
          },
        ],
      },
    ]);

    const { validateCommand } = await import('./validate.js');
    const program = wrapCommand(validateCommand);
    await program.parseAsync(['validate'], { from: 'user' });

    expect(mockValidateConfigFiles).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('passes --file filter', async () => {
    mockValidateConfigFiles.mockReturnValue([
      { file: 'pipeline.yaml', kind: 'Pipeline', valid: true, errors: [] },
    ]);

    const { validateCommand } = await import('./validate.js');
    const program = wrapCommand(validateCommand);
    await program.parseAsync(['validate', '--file', 'pipeline.yaml'], { from: 'user' });

    expect(mockValidateConfigFiles).toHaveBeenCalledWith(expect.any(String), 'pipeline.yaml');
    expect(process.exitCode).toBeUndefined();
  });

  it('exits 0 when all files are valid', async () => {
    mockValidateConfigFiles.mockReturnValue([
      { file: 'pipeline.yaml', kind: 'Pipeline', valid: true, errors: [] },
      { file: 'autonomy-policy.yaml', kind: 'AutonomyPolicy', valid: true, errors: [] },
    ]);

    const { validateCommand } = await import('./validate.js');
    const program = wrapCommand(validateCommand);
    await program.parseAsync(['validate'], { from: 'user' });

    expect(process.exitCode).toBeUndefined();
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
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Watch mode started'));
  });
});
