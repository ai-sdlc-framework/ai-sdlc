/**
 * ai-sdlc init — initialize a project with AI-SDLC config files.
 *
 * AISDLC-78 enhancements:
 *  - Print a 3-line version block at startup so operators see CLI,
 *    orchestrator, and plugin versions in one place. Drift triggers a
 *    visible warning instead of silently shipping mismatched binaries.
 *  - Substitute `your-org` in the pipeline.yaml template using
 *    `git remote get-url origin` (ssh + https forms supported). Falls
 *    back to the placeholder only when no remote is configured.
 *  - Pin `@ai-sdlc/mcp-advisor` in generated `.mcp.json` to the
 *    orchestrator version that ran init, with an inline opt-out hint.
 *  - Skip `.cursor/mcp.json` unless Cursor is detected (project-local
 *    `.cursor/`, user-global `~/.cursor/`) or `--cursor` is passed.
 *
 * AISDLC-143 enhancements (Q4(b) of the quality-gate redesign):
 *  - Default invocation is now an interactive WIZARD (DoR / attestation /
 *    classifier / branch-protection prompts) so adopters get a guided
 *    bootstrap instead of having to read the docs to discover features.
 *  - `--yes` short-circuits all prompts to "accept defaults" (CI/scripts).
 *  - `--with-X` flags opt into individual features without prompting.
 *  - `--add <feature>` extends an already-initialized repo with a single
 *    feature, idempotently — re-running on an initialized repo is safe.
 *  - `.github/workflows/ai-sdlc-gate.yml` is scaffolded UNCONDITIONALLY
 *    so every adopter gets the `ai-sdlc/pr-ready` rollup check on day one
 *    (Q1: prescriptive default).
 *  - A "next steps" summary closes the run with operator action items
 *    conditional on which features were chosen.
 */

import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { detectAgentsDetailed, installMcpServer } from './mcp-setup.js';
import { detectWorkspace, generateWorkspaceYaml, type WorkspaceRepo } from './workspace-detect.js';
import { detectGitRemote, applyRemoteToPipelineYaml } from './git-remote.js';
import { resolveVersions, formatVersionBlock } from '../versions.js';
import {
  applyFeatureSelection,
  buildProductionAdapters,
  ensureClaudeMdPointer,
  renderNextSteps,
  resolveFeatureSelection,
  type FeatureAdapters,
  type FeatureSelection,
  type WizardFlags,
} from './init-features.js';

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
  # backlog: holds settings specific to the backlog-task (/ai-sdlc execute)
  # workflow. These were formerly in a separate pipeline-backlog.yaml file
  # (deprecated by AISDLC-245.5). Slash commands + pipeline-cli readers
  # prefer this canonical location.
  backlog:
    branching:
      pattern: 'ai-sdlc/{issueIdLower}-{slug}'
      targetBranch: main
      cleanup: on-merge
    pullRequest:
      titleTemplate: 'feat: {issueTitle} ({issueId})'
      descriptionSections:
        - summary
        - changes
        - closes
      includeProvenance: true
      closeKeyword: References
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

interface InitProjectOptions {
  /** Pre-rendered pipeline YAML (with org/repo substituted). */
  pipelineYaml: string;
  /** Agent-role tier selection (drives `agent-role.yaml` template). */
  tier: AgentRoleTier;
}

/** Initialize a single project directory with AI-SDLC config files. */
function initProject(
  projectDir: string,
  configDirName: string,
  dryRun: boolean,
  prefix: string = '',
  options: InitProjectOptions = { pipelineYaml: PIPELINE_YAML, tier: 'coding' },
): void {
  const configDir = join(projectDir, configDirName);

  const files = [
    { name: 'pipeline.yaml', content: options.pipelineYaml },
    { name: 'agent-role.yaml', content: getAgentRoleYaml(options.tier) },
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

/**
 * Build the WizardFlags struct from Commander's parsed options. Pulled
 * out into a function so tests can drive the wizard pipeline directly
 * without going through Commander's stateful option store.
 */
export function buildWizardFlags(opts: Record<string, unknown>): WizardFlags {
  const addRaw = typeof opts.add === 'string' ? opts.add : undefined;
  let add: WizardFlags['add'];
  if (
    addRaw === 'dor' ||
    addRaw === 'attestation' ||
    addRaw === 'classifier' ||
    addRaw === 'branch-protection'
  ) {
    add = addRaw;
  }
  return {
    yes: !!opts.yes,
    withDor: !!opts.withDor,
    withAttestation: !!opts.withAttestation,
    withClassifier: !!opts.withClassifier,
    withBranchProtection: !!opts.withBranchProtection,
    add,
    dryRun: !!opts.dryRun,
  };
}

/** Validate a `--add` arg and return either the normalized value or null+error. */
function validateAddArg(
  addRaw: unknown,
): { ok: true; value?: WizardFlags['add'] } | { ok: false; error: string } {
  if (addRaw === undefined || addRaw === null || addRaw === false) return { ok: true };
  if (typeof addRaw !== 'string') return { ok: false, error: `--add must be a string` };
  const allowed = ['dor', 'attestation', 'classifier', 'branch-protection'];
  if (!allowed.includes(addRaw)) {
    return {
      ok: false,
      error: `--add: unknown feature '${addRaw}'. Expected one of: ${allowed.join(', ')}.`,
    };
  }
  return { ok: true, value: addRaw as WizardFlags['add'] };
}

export const initCommand = new Command('init')
  .description('Initialize AI-SDLC configuration in the current project')
  .option('--dry-run', 'Show what would be created without writing files')
  .option('--skip-mcp', 'Skip MCP server auto-configuration')
  .option('--cursor', 'Force-install Cursor MCP config even if Cursor is not detected')
  .option('-d, --dir <path>', 'Config directory name', '.ai-sdlc')
  .option(
    '--role <tier>',
    `Agent-role tool tier: ${AGENT_ROLE_TIERS.join(' | ')} (default: coding)`,
    'coding',
  )
  // ── AISDLC-143 wizard flags ─────────────────────────────────────────
  .option('-y, --yes', 'Accept all defaults (non-interactive; CI/scripts)')
  .option('--with-dor', 'Scaffold Definition-of-Ready gate config + workflow')
  .option('--with-attestation', 'Scaffold attestation infrastructure (audit-only)')
  .option('--with-classifier', 'Scaffold review classifier config stub')
  .option(
    '--with-branch-protection',
    'Apply recommended branch-protection rule to main (requires gh)',
  )
  .option(
    '--add <feature>',
    'Extend an already-initialized repo with a single feature: dor | attestation | classifier | branch-protection',
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
    const cursorOptIn = !!opts.cursor;

    // ── Validate --add early so we error before doing any work. ────────
    const addCheck = validateAddArg(opts.add);
    if (!addCheck.ok) {
      console.error(`Error: ${addCheck.error}`);
      process.exitCode = 1;
      return;
    }
    const flags = buildWizardFlags(opts);

    // ── --add path: extend an already-initialized repo ────────────────
    // AC #7: skip the "always-scaffold-baseline" path entirely; the
    // wizard dispatcher's `--add` branch knows to write only the chosen
    // feature's templates (no pipeline.yaml, no MCP setup, no workspace
    // detection). This is the safe re-run path on a repo that already
    // ran `ai-sdlc init` once.
    if (flags.add) {
      const adapters: FeatureAdapters = buildProductionAdapters();
      const selection: FeatureSelection = await resolveFeatureSelection(flags, adapters);
      console.log(`Extending AI-SDLC config with --add ${flags.add}:`);
      console.log('');
      const result = await applyFeatureSelection(projectDir, selection, flags, adapters);
      renderNextSteps(selection, result, adapters);
      // Reviewer feedback (round 2, suggestion #5): when the operator
      // explicitly requested branch-protection via a non-interactive flag
      // (--add branch-protection here; --yes / --with-branch-protection
      // in runWizardStage) and the apply failed (gh missing, not
      // authenticated, etc.), surface a non-zero exit so CI scripts can
      // detect failure instead of seeing the silent log line.
      if (
        flags.add === 'branch-protection' &&
        result.branchProtection &&
        !result.branchProtection.applied &&
        result.branchProtection.error
      ) {
        process.exitCode = 1;
      }
      return;
    }

    // ── version provenance (AC #1) ────────────────────────────────────
    const versions = resolveVersions({ workDir: projectDir });
    console.log(formatVersionBlock(versions));
    console.log('');

    // ── pipeline.yaml org/repo substitution (AC #2) ───────────────────
    const remote = detectGitRemote({ cwd: projectDir });
    const pipelineYaml = applyRemoteToPipelineYaml(PIPELINE_YAML, remote);
    if (remote.detected) {
      console.log(`Detected git remote: ${remote.org}/${remote.repo}`);
    } else {
      console.log(
        `No git origin remote detected — pipeline.yaml will use the 'your-org' placeholder.`,
      );
    }
    console.log('');

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
        // Per-repo remote detection so each child gets its own org/repo.
        const childRemote = detectGitRemote({ cwd: repo.absPath });
        const childPipeline = applyRemoteToPipelineYaml(PIPELINE_YAML, childRemote);
        if (childRemote.detected) {
          console.log(`  detected remote: ${childRemote.org}/${childRemote.repo}`);
        }
        initProject(repo.absPath, configDirName, dryRun, '  ', {
          pipelineYaml: childPipeline,
          tier,
        });
      }

      // MCP setup at workspace root (serves all repos)
      if (!opts.skipMcp) {
        const { detected, skipped } = detectAgentsDetailed(projectDir, {
          isWorkspace: true,
          pinVersion: versions.orchestrator,
          cursorOptIn,
        });

        console.log(`\nMCP server setup (workspace root):`);
        console.log(`  detected ${detected.map((a) => a.name).join(', ') || '(none)'}`);
        for (const sk of skipped) {
          console.log(`  skip ${sk.name} — ${sk.reason}`);
        }

        for (const agent of detected) {
          const status = installMcpServer(projectDir, agent, dryRun);
          const pad = status === 'merged' ? ' ' : '';
          console.log(`  ${status}${pad} ${agent.configPath} (${agent.name})`);
        }
      }

      console.log(`\nAI-SDLC workspace initialized in ${projectDir}/`);

      // ── AISDLC-143 wizard (workspace root) ────────────────────────
      // The wizard runs ONCE at the workspace root: the baseline gate
      // workflow + per-feature workflows live at `<workspace-root>/.github/`,
      // not in each child repo. Children share the same CI from the
      // root since GHA workflows always live at the repo root anyway.
      await runWizardStage(projectDir, flags);

      console.log(`Run 'ai-sdlc health' to verify your configuration.`);
    } else {
      // Single-repo mode (original behavior)
      initProject(projectDir, configDirName, dryRun, '', { pipelineYaml, tier });

      if (!opts.skipMcp) {
        const { detected, skipped } = detectAgentsDetailed(projectDir, {
          pinVersion: versions.orchestrator,
          cursorOptIn,
        });

        console.log(`\nMCP server setup:`);
        console.log(`  detected ${detected.map((a) => a.name).join(', ') || '(none)'}`);
        for (const sk of skipped) {
          console.log(`  skip ${sk.name} — ${sk.reason}`);
        }

        for (const agent of detected) {
          const status = installMcpServer(projectDir, agent, dryRun);
          const pad = status === 'merged' ? ' ' : '';
          console.log(`  ${status}${pad} ${agent.configPath} (${agent.name})`);
        }
      }

      console.log(`\nAI-SDLC config initialized in ${join(projectDir, configDirName)}/`);

      // ── AISDLC-143 wizard (single-repo) ──────────────────────────
      await runWizardStage(projectDir, flags);

      console.log(`Run 'ai-sdlc health' to verify your configuration.`);
    }
  });

/**
 * Run the AISDLC-143 wizard stage: prompt the user (or short-circuit on
 * --yes / --with-X), apply the chosen feature templates, append the
 * CLAUDE.md pointer, and render the "next steps" summary.
 *
 * Pulled out of the inline action body so both the single-repo and
 * workspace-root branches share the same wiring. Adapters are built
 * once here (production = real disk writes; tests inject stubs by
 * calling `applyFeatureSelection`/`renderNextSteps` directly).
 */
async function runWizardStage(projectDir: string, flags: WizardFlags): Promise<void> {
  const adapters: FeatureAdapters = buildProductionAdapters();
  console.log('');
  console.log('━━━ Feature wizard ━━━');
  console.log('');
  const selection: FeatureSelection = await resolveFeatureSelection(flags, adapters);
  console.log('');
  console.log('Scaffolding selected features:');
  const result = await applyFeatureSelection(projectDir, selection, flags, adapters);
  ensureClaudeMdPointer(projectDir, adapters, flags.dryRun);
  renderNextSteps(selection, result, adapters);

  // Reviewer feedback (round 2, suggestion #5): when branch-protection
  // was non-interactively requested (--with-branch-protection or --yes,
  // both used by CI scripts) and the apply failed (gh missing, not
  // authenticated, etc.), surface a non-zero exit so CI can detect
  // failure instead of seeing the silent log line. Interactive prompt
  // answers don't trip this — the human already saw the error and can
  // re-run `ai-sdlc init --add branch-protection` themselves.
  const branchProtectionRequestedNonInteractively = flags.yes || flags.withBranchProtection;
  if (
    branchProtectionRequestedNonInteractively &&
    result.branchProtection &&
    !result.branchProtection.applied &&
    result.branchProtection.error
  ) {
    process.exitCode = 1;
  }
}
