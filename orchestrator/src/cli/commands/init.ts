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
  stages:
    - name: validate
      type: gate
    - name: code
      type: agent
      timeout: 30m
      onFailure:
        action: retry
        maxRetries: 2
    - name: review
      type: gate
  triggers:
    - event: issue.labeled
      filters:
        - field: label
          value: ai-sdlc
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
  gates:
    - name: has-description
      rule:
        metric: description-length
        operator: gt
        threshold: 0
      enforcement: mandatory
    - name: has-acceptance-criteria
      rule:
        metric: has-acceptance-criteria
        operator: gte
        threshold: 1
      enforcement: warning
`;

const AUTONOMY_POLICY_YAML = `apiVersion: ai-sdlc.io/v1alpha1
kind: AutonomyPolicy
metadata:
  name: default-autonomy
spec:
  levels:
    - level: 0
      name: supervised
      permissions:
        read: ["**"]
        write: ["src/**", "test/**", "tests/**"]
        execute: []
      guardrails:
        maxLinesPerPR: 300
        blockedPaths:
          - .github/workflows/**
          - .ai-sdlc/**
  promotionCriteria:
    - metric: tasks-completed
      threshold: 10
  demotionTriggers:
    - trigger: failed-test
      threshold: 3
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

    console.log(`\nAI-SDLC config initialized in ${configDir}/`);
  });
