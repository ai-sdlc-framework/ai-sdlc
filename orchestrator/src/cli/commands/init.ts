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

const AGENT_ROLE_YAML = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: default-agent
spec:
  role: developer
  goal: Implement issue requirements with tests
  tools:
    - Edit
    - Write
    - Read
    - Glob
    - Grep
    - Bash
  constraints:
    maxFilesPerChange: 15
    requireTests: true
    blockedPaths:
      - .github/workflows/**
      - .ai-sdlc/**
`;

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

const GITIGNORE_ENTRIES = [
  '# AI-SDLC runtime artifacts',
  '.ai-sdlc/state.db',
  '.ai-sdlc/state/',
  '.ai-sdlc/audit.jsonl',
];

/** Ensure .gitignore includes AI-SDLC runtime artifact entries. */
function ensureGitignore(projectDir: string, dryRun: boolean, prefix: string = ''): void {
  const gitignorePath = join(projectDir, '.gitignore');
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf-8') : '';

  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (missing.length === 0) return;

  if (dryRun) {
    console.log(`${prefix}  Would update .gitignore`);
    return;
  }

  const block = '\n' + missing.join('\n') + '\n';
  appendFileSync(gitignorePath, block, 'utf-8');
  console.log(`${prefix}  updated .gitignore`);
}

/** Initialize a single project directory with AI-SDLC config files. */
function initProject(
  projectDir: string,
  configDirName: string,
  dryRun: boolean,
  prefix: string = '',
): void {
  const configDir = join(projectDir, configDirName);

  const files = [
    { name: 'pipeline.yaml', content: PIPELINE_YAML },
    { name: 'agent-role.yaml', content: AGENT_ROLE_YAML },
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
  .action(async (opts) => {
    const projectDir = process.cwd();
    const configDirName = opts.dir ?? '.ai-sdlc';
    const dryRun = !!opts.dryRun;

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
        initProject(repo.absPath, configDirName, dryRun, '  ');
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
      initProject(projectDir, configDirName, dryRun);

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
