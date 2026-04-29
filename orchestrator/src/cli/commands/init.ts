/**
 * ai-sdlc init — initialize a project with AI-SDLC config files.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { detectAgents, installMcpServer } from './mcp-setup.js';
import { detectWorkspace, generateWorkspaceYaml, type WorkspaceRepo } from './workspace-detect.js';

const PIPELINE_YAML = `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: default
spec:
  triggers:
    - event: issue.labeled
      filter:
        labels:
          - ai-eligible
  providers:
    sourceControl:
      type: github
      config:
        org: your-org
  stages:
    - name: validate
      qualityGates:
        - default-gates
    - name: code
      agent: default-agent
      timeout: PT30M
      onFailure:
        strategy: retry
        maxRetries: 2
    - name: review
      qualityGates:
        - default-gates
`;

/**
 * Tier-based agent-role templates (AISDLC-79).
 *
 * Three named tiers map to escalating tool surfaces. The default (`coding`)
 * preserves pre-AISDLC-79 behavior plus `NotebookEdit` (parity with the
 * Claude Code SDK's filesystem editing surface). Higher tiers add tools only
 * when their use-case justifies the additional surface area / risk.
 *
 * See `backlog/decisions/AISDLC-79-agent-role-tools-defaults.md` for rationale.
 */
export type AgentRoleTier = 'coding' | 'research' | 'meta';

export const AGENT_ROLE_TIERS: readonly AgentRoleTier[] = ['coding', 'research', 'meta'] as const;

const AGENT_ROLE_YAML_CODING = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: default-agent
spec:
  role: developer
  goal: Implement issue requirements with tests
  # Tier: coding-agent (default).
  # Filesystem + shell editing surface only. No web access, no sub-agent
  # spawning, no Skill loading. This matches the pre-AISDLC-79 default
  # plus NotebookEdit (parity with the Claude Code SDK's editing surface).
  tools:
    - Edit          # write to existing files
    - Write         # create new files
    - Read          # read source / configs
    - Glob          # discover files by pattern
    - Grep          # search code
    - Bash          # run tests, lint, build, git
    - NotebookEdit  # edit Jupyter notebooks (parity with SDK editing surface)
    # Excluded by default (opt in via --role research|meta during init):
    #   - WebFetch    — pulls untrusted remote content into context (research tier)
    #   - WebSearch   — same (research tier)
    #   - Task        — spawns sub-agents; cost + reasoning amplification (meta tier)
    #   - Skill       — loads external skill packs (meta tier)
  constraints:
    maxFilesPerChange: 15
    requireTests: true
    blockedPaths:
      - .github/workflows/**
      - .ai-sdlc/**
`;

const AGENT_ROLE_YAML_RESEARCH = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: default-agent
spec:
  role: research-developer
  goal: Investigate, gather references, and implement issue requirements with tests
  # Tier: research-agent.
  # Coding-tier surface plus read-only web access. Use for tasks that need
  # to consult external docs, package registries, or RFCs.
  tools:
    - Edit          # write to existing files
    - Write         # create new files
    - Read          # read source / configs
    - Glob          # discover files by pattern
    - Grep          # search code
    - Bash          # run tests, lint, build, git
    - NotebookEdit  # edit Jupyter notebooks
    - WebFetch      # fetch a known URL (docs, RFCs, API references)
    - WebSearch     # discover sources by query
    # Excluded (use --role meta to opt in):
    #   - Task        — spawns sub-agents (meta tier)
    #   - Skill       — loads external skill packs (meta tier)
  constraints:
    maxFilesPerChange: 15
    requireTests: true
    blockedPaths:
      - .github/workflows/**
      - .ai-sdlc/**
`;

const AGENT_ROLE_YAML_META = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: default-agent
spec:
  role: meta-developer
  goal: Orchestrate sub-agents, load skill packs, and implement complex multi-step work
  # Tier: meta-agent.
  # Full surface: filesystem + shell + web + sub-agent + skill loading.
  # Use only when the task legitimately needs sub-agent fan-out or external
  # skill packs. Higher cost amplification and broader attack surface.
  tools:
    - Edit          # write to existing files
    - Write         # create new files
    - Read          # read source / configs
    - Glob          # discover files by pattern
    - Grep          # search code
    - Bash          # run tests, lint, build, git
    - NotebookEdit  # edit Jupyter notebooks
    - WebFetch      # fetch a known URL
    - WebSearch     # discover sources by query
    - Task          # spawn sub-agents for parallel / specialized work
    - Skill         # load external skill packs (declared capabilities)
  constraints:
    maxFilesPerChange: 15
    requireTests: true
    blockedPaths:
      - .github/workflows/**
      - .ai-sdlc/**
`;

const AGENT_ROLE_YAML_BY_TIER: Record<AgentRoleTier, string> = {
  coding: AGENT_ROLE_YAML_CODING,
  research: AGENT_ROLE_YAML_RESEARCH,
  meta: AGENT_ROLE_YAML_META,
};

/** Resolve the agent-role.yaml template for a given tier. Default = `coding`. */
export function getAgentRoleYaml(tier: AgentRoleTier = 'coding'): string {
  return AGENT_ROLE_YAML_BY_TIER[tier];
}

const QUALITY_GATE_YAML = `apiVersion: ai-sdlc.io/v1alpha1
kind: QualityGate
metadata:
  name: default-gates
spec:
  scope:
    authorTypes:
      - ai-agent
  gates:
    - name: has-description
      enforcement: hard-mandatory
      rule:
        metric: description-length
        operator: '>='
        threshold: 1
    - name: has-acceptance-criteria
      enforcement: soft-mandatory
      rule:
        metric: has-acceptance-criteria
        operator: '>='
        threshold: 1
      override:
        requiredRole: tech-lead
        requiresJustification: true
  evaluation:
    pipeline: pre-merge
    timeout: 30s
`;

const AUTONOMY_POLICY_YAML = `apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: default-autonomy
spec:
  levels:
    - level: 0
      name: Supervised
      description: All actions require human approval
      permissions:
        read: ['**']
        write: ['src/**', 'test/**', 'tests/**']
        execute: ['test-suite']
      guardrails:
        requireApproval: all
        maxLinesPerPR: 300
        blockedPaths:
          - .github/workflows/**
          - .ai-sdlc/**
      monitoring: continuous
      minimumDuration: null
    - level: 1
      name: Assisted
      description: Routine changes are autonomous, complex changes need review
      permissions:
        read: ['**']
        write: ['src/**', 'test/**', 'tests/**', 'docs/**']
        execute: ['test-suite', 'lint', 'build']
      guardrails:
        requireApproval: security-critical-only
        maxLinesPerPR: 500
      monitoring: real-time-notification
      minimumDuration: 4w
  promotionCriteria:
    '0-to-1':
      minimumTasks: 10
      conditions:
        - metric: pr-approval-rate
          operator: '>='
          threshold: 0.90
      requiredApprovals:
        - tech-lead
  demotionTriggers:
    - trigger: critical-security-incident
      action: demote-to-0
      cooldown: 4w
    - trigger: test-failure-rate-exceeds-threshold
      action: demote-one-level
      cooldown: 2w
`;

const GITIGNORE_PATHS = ['.ai-sdlc/state.db', '.ai-sdlc/state/', '.ai-sdlc/audit.jsonl'];

/** Ensure .gitignore includes AI-SDLC runtime artifact entries. */
function ensureGitignore(projectDir: string, dryRun: boolean, prefix: string = ''): void {
  const gitignorePath = join(projectDir, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';

  const SENTINEL = '# ai-sdlc:runtime-gitignore';
  if (existing.includes(SENTINEL)) return;

  const missing = GITIGNORE_PATHS.filter(
    (entry) => !existing.split('\n').some((line) => line.trim() === entry),
  );
  if (missing.length === 0) return;

  if (dryRun) {
    console.log(`${prefix}  Would update .gitignore`);
    return;
  }

  const block = (existing.length > 0 ? '\n' : '') + `${SENTINEL}\n` + missing.join('\n') + '\n';
  appendFileSync(gitignorePath, block, 'utf-8');
  console.log(`${prefix}  updated .gitignore`);
}

/** Initialize a single project directory with AI-SDLC config files. */
function initProject(
  projectDir: string,
  configDirName: string,
  dryRun: boolean,
  prefix: string = '',
  tier: AgentRoleTier = 'coding',
): void {
  const configDir = join(projectDir, configDirName);

  const files = [
    { name: 'pipeline.yaml', content: PIPELINE_YAML },
    { name: 'agent-role.yaml', content: getAgentRoleYaml(tier) },
    { name: 'quality-gate.yaml', content: QUALITY_GATE_YAML },
    { name: 'autonomy-policy.yaml', content: AUTONOMY_POLICY_YAML },
  ];

  if (dryRun) {
    console.log(`${prefix}Would create ${configDir}/`);
    for (const f of files) {
      console.log(`${prefix}  ${f.name}`);
    }
    ensureGitignore(projectDir, true, prefix);
    return;
  }

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  for (const f of files) {
    const path = join(configDir, f.name);
    if (existsSync(path)) {
      console.log(`${prefix}  skip ${f.name} (already exists)`);
    } else {
      writeFileSync(path, f.content, 'utf-8');
      console.log(`${prefix}  created ${f.name}`);
    }
  }

  ensureGitignore(projectDir, false, prefix);
}

/** Initialize the workspace root with workspace.yaml. */
function initWorkspaceRoot(
  workspacePath: string,
  repos: WorkspaceRepo[],
  configDirName: string,
  dryRun: boolean,
): void {
  const configDir = join(workspacePath, configDirName);
  const workspaceFile = join(configDir, 'workspace.yaml');
  const workspaceName = basename(workspacePath);
  const yaml = generateWorkspaceYaml(workspaceName, repos);

  if (dryRun) {
    console.log(`Would create ${configDir}/`);
    console.log(`  workspace.yaml`);
    return;
  }

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  if (existsSync(workspaceFile)) {
    console.log(`  skip workspace.yaml (already exists)`);
  } else {
    writeFileSync(workspaceFile, yaml, 'utf-8');
    console.log(`  created workspace.yaml`);
  }
}

export const initCommand = new Command('init')
  .description('Initialize AI-SDLC configuration in the current project')
  .option('--dry-run', 'Show what would be created without writing files')
  .option('--skip-mcp', 'Skip MCP server auto-configuration')
  .option('-d, --dir <path>', 'Config directory name', '.ai-sdlc')
  .option(
    '--role <tier>',
    `Agent-role tool tier: ${AGENT_ROLE_TIERS.join(' | ')} (default: coding)`,
    'coding',
  )
  .action(async (opts) => {
    const projectDir = process.cwd();
    const configDirName = opts.dir ?? '.ai-sdlc';
    const dryRun = !!opts.dryRun;
    const tierInput = (opts.role ?? 'coding') as string;
    if (!AGENT_ROLE_TIERS.includes(tierInput as AgentRoleTier)) {
      console.error(
        `Error: invalid --role value '${tierInput}'. Expected one of: ${AGENT_ROLE_TIERS.join(', ')}.`,
      );
      process.exitCode = 1;
      return;
    }
    const tier = tierInput as AgentRoleTier;

    // Detect workspace (multi-repo parent directory)
    const workspace = detectWorkspace(projectDir);

    if (workspace.isWorkspace) {
      console.log(`Workspace detected with ${workspace.repos.length} repositories:`);
      for (const repo of workspace.repos) {
        console.log(`  ${repo.name} (${repo.path})`);
      }
      console.log('');

      // Initialize workspace root with workspace.yaml
      initWorkspaceRoot(projectDir, workspace.repos, configDirName, dryRun);

      // Cascade into each child repo
      for (const repo of workspace.repos) {
        console.log(`\n${repo.name}/`);
        initProject(repo.absPath, configDirName, dryRun, '  ', tier);
      }

      // MCP setup at workspace root (serves all repos)
      if (!opts.skipMcp) {
        const agents = detectAgents(projectDir, { isWorkspace: true });

        console.log(`\nMCP server setup (workspace root):`);
        console.log(`  detected ${agents.map((a) => a.name).join(', ')}`);

        for (const agent of agents) {
          const status = installMcpServer(projectDir, agent, dryRun);
          const pad = status === 'merged' ? ' ' : '';
          console.log(`  ${status}${pad} ${agent.configPath} (${agent.name})`);
        }
      }

      console.log(`\nAI-SDLC workspace initialized in ${projectDir}/`);
      console.log(`Run 'ai-sdlc health' to verify your configuration.`);
    } else {
      // Single-repo mode (original behavior)
      initProject(projectDir, configDirName, dryRun, '', tier);

      if (!opts.skipMcp) {
        const agents = detectAgents(projectDir);

        console.log(`\nMCP server setup:`);
        console.log(`  detected ${agents.map((a) => a.name).join(', ')}`);

        for (const agent of agents) {
          const status = installMcpServer(projectDir, agent, dryRun);
          const pad = status === 'merged' ? ' ' : '';
          console.log(`  ${status}${pad} ${agent.configPath} (${agent.name})`);
        }
      }

      console.log(`\nAI-SDLC config initialized in ${join(projectDir, configDirName)}/`);
      console.log(`Run 'ai-sdlc health' to verify your configuration.`);
    }
  });
