/**
 * ai-sdlc init — initialize a project with AI-SDLC config files.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export const initCommand = new Command('init')
  .description('Initialize AI-SDLC configuration in the current project')
  .option('--dry-run', 'Show what would be created without writing files')
  .option('-d, --dir <path>', 'Config directory name', '.ai-sdlc')
  .action(async (opts) => {
    const configDir = join(process.cwd(), opts.dir ?? '.ai-sdlc');

    const files = [
      { name: 'pipeline.yaml', content: PIPELINE_YAML },
      { name: 'agent-role.yaml', content: AGENT_ROLE_YAML },
      { name: 'quality-gate.yaml', content: QUALITY_GATE_YAML },
      { name: 'autonomy-policy.yaml', content: AUTONOMY_POLICY_YAML },
    ];

    if (opts.dryRun) {
      console.log(`Would create ${configDir}/`);
      for (const f of files) {
        console.log(`  ${f.name}`);
      }
      return;
    }

    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    for (const f of files) {
      const path = join(configDir, f.name);
      if (existsSync(path)) {
        console.log(`  skip ${f.name} (already exists)`);
      } else {
        writeFileSync(path, f.content, 'utf-8');
        console.log(`  created ${f.name}`);
      }
    }

    // Create state directory for SQLite store
    const stateDir = join(configDir, 'state');
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
      console.log(`  created state/`);
    }

    console.log(`\nAI-SDLC config initialized in ${configDir}/`);
    console.log(`Run 'ai-sdlc health' to verify your configuration.`);
  });
