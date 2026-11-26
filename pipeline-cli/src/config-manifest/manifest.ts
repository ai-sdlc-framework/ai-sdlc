/**
 * Required consumer configuration manifest (AISDLC-910).
 *
 * One list of every file under `.ai-sdlc/` the pipeline reads for attestation
 * and review, with the config version that first required it (`since`). Four
 * consumers share it so they cannot disagree: `/ai-sdlc init` scaffolds from it,
 * `/ai-sdlc execute` Step 1 refuses on it before any worktree or dev budget is
 * spent, `ai-sdlc doctor` reports from it, and SessionStart compares the
 * recorded `configVersion` with the newest `since`. A release that adds a
 * required file adds one entry here and every consumer picks it up.
 *
 * @module config-manifest/manifest
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildExecuteGraph, renderYaml } from '../workflow/graph.js';
import {
  CONTEXT_CONFIG_PATH,
  DEFAULT_PROTECTED_ROOT,
  DEFAULT_RETRIEVAL_ADAPTER,
  DEFAULT_RETRIEVAL_INDEX_PATH,
  DEFAULT_TRACKED_ROOT,
} from '../knowledge/config.js';

/** The command an operator runs to scaffold missing configuration. */
export const INIT_COMMAND = '/ai-sdlc init';

/** Where the recorded config version lives (one line, `configVersion: <semver>`). */
export const CONFIG_VERSION_PATH = '.ai-sdlc/config-version.yaml';

export interface ConfigPrompt {
  key: string;
  question: string;
}

export interface ConfigEntry {
  /** Stable id (the join key for `--format json` consumers). */
  id: string;
  /** Repo-relative path under the project root. */
  path: string;
  /** First config version that required this entry. */
  since: string;
  /** What reads it, in operator words. */
  description: string;
  /**
   * Operator-input entries cannot be written from nothing: they prompt (or take
   * defaults under `--non-interactive`) and `doctor --fix` never scaffolds them.
   */
  operatorInput: boolean;
  /**
   * Scaffolded by init but never required: a missing optional entry does not
   * refuse a run or fail `cli-init --check`.
   */
  optional?: boolean;
  /** Questions asked for this entry; empty for pure-default entries. */
  prompts: readonly ConfigPrompt[];
  /** Render the file from answers. Throws an Error naming what is missing. */
  render(answers: Readonly<Record<string, string>>): string;
}

const REVIEW_POLICY_DEFAULT = `# AI-SDLC Review Policy

Calibration context for the automated review agents. Apply the principles
below before analyzing a PR. Edit freely: this file is yours.

## Golden Rule

**When in doubt, approve with a suggestion; do not request changes.**

## Review Principles

1. **Evidence-first**: trace the code path or do not flag it.
2. **Deterministic-first**: defer to CI for lint, types and coverage.
3. **Trust boundaries**: flag only at real untrusted boundaries.
4. **Severity honesty**: no failure scenario means not critical or major.
5. **Signal over noise**: one good finding beats ten weak ones.
6. **Scope discipline**: do not flag deferred work or unchanged code.
`;

/**
 * Knowledge store configuration (RFC-0053, AISDLC-1408). Every value is the
 * built-in default, so loading this file yields the same config as no file: it
 * exists to show an adopter that the store exists and where its keys go.
 */
const CONTEXT_YAML_DEFAULT = `# AI-SDLC knowledge store configuration (RFC-0053).
# Every value below is the built-in default; deleting this file changes nothing.
# See docs/operations/knowledge-store.md.
knowledge:
  trackedRoot: ${DEFAULT_TRACKED_ROOT} # reviewed, versioned entries
  protectedRoot: ${DEFAULT_PROTECTED_ROOT} # gitignored client material
  # dataRoomRoot: client-data-room/ # optional raw data room, indexed read-only
  classification:
    dataRoomRoots: [] # source paths that mark protected material
    clientIdentifiers: [] # names that mark protected material
  promotion:
    commands: {} # proof command id -> argv list
retrieval:
  adapter: ${DEFAULT_RETRIEVAL_ADAPTER}
  indexPath: ${DEFAULT_RETRIEVAL_INDEX_PATH} # gitignored
`;

const KNOWLEDGE_README_DEFAULT = `# Knowledge store

Scored, dated facts that agents and people retrieve just in time (RFC-0053).
Entries live at \`<trunk>/<topic>.md\` under this folder, one fact per file with
YAML frontmatter. Client and data-room material (\`scope: protected\`) goes in the
gitignored \`${DEFAULT_PROTECTED_ROOT}/\` instead, never here.

Roots and retrieval settings are in \`${CONTEXT_CONFIG_PATH}\`. Check entries with
\`cli-context validate\`. The entry schema, ontology and checks are described in
the AI-SDLC docs: docs/operations/knowledge-store.md.
`;

/**
 * Tier-based agent-role templates (AISDLC-79, merged into the manifest by
 * AISDLC-1354 so `/ai-sdlc:setup` and `/ai-sdlc:init` write the same file).
 * `coding` is the default; higher tiers add tools only when the use-case
 * justifies the extra surface. See `backlog/decisions/AISDLC-79-agent-role-tools-defaults.md`.
 */
export type AgentRoleTier = 'coding' | 'research' | 'meta';

export const AGENT_ROLE_TIERS: readonly AgentRoleTier[] = ['coding', 'research', 'meta'] as const;

/**
 * The merge settings every scaffolded agent-role.yaml states (AISDLC-1351). The values are
 * this one constant. They are `never` and empty until the operator decides what a new adopter
 * gets, so nothing is loosened; `up`, `status`, the landing note and doctor read the resolved
 * policy, not this constant, and say so when merging is off.
 */
export const AGENT_ROLE_MERGE_DEFAULTS: {
  allowMerge: 'never' | 'onGreenClean';
  mergeAuthors: readonly string[];
  operational: readonly string[];
} = {
  allowMerge: 'never',
  mergeAuthors: [],
  operational: [],
};

/** Governance block of every scaffolded agent-role.yaml: the merge keys, then the commented lease-push key. */
export function renderAgentRoleGovernance(d = AGENT_ROLE_MERGE_DEFAULTS): string {
  const list = (key: string, items: readonly string[]): string =>
    items.length === 0
      ? `    ${key}: []\n`
      : `    ${key}:\n${items.map((i) => `      - ${i}`).join('\n')}\n`;
  return `  governance:
    # Merge settings (AISDLC-1351). allowMerge: never | onGreenClean. With \`never\`, an empty
    # mergeAuthors or an operational list without land-eligible-prs the board never merges;
    # \`cli-hierarchy up\`, \`status\` and \`doctor\` say so. Set all three to let it land PRs.
    allowMerge: ${d.allowMerge}
${list('mergeAuthors', d.mergeAuthors)}${list('operational', d.operational)}    # allowForcePush defaults to leaseOnOwnBranch (a lease push of a dispatched
    # task's own branch, or the head branch of the PR a fix task was filed to fix;
    # never main/master/protected branches).
    # allowForcePush: leaseOnOwnBranch   # never | leaseOnOwnBranch | lease
`;
}

const AGENT_ROLE_BACKSTORY = `  backstory: >-
    You are an AI coding agent. You work under strict constraints and every
    change requires review.
`;

const AGENT_ROLE_TOOLS_HEAD = `    - Edit          # write to existing files
    - Write         # create new files
    - Read          # read source / configs
    - Glob          # discover files by pattern
    - Grep          # search code
    - Bash          # run tests, lint, build, git
`;

const AGENT_ROLE_TOOLS_TAIL = `    - code-editor
    - terminal
    - test-runner
`;

const AGENT_ROLE_TIER_BODY: Record<
  AgentRoleTier,
  { role: string; goal: string; comment: string; tools: string }
> = {
  coding: {
    role: 'developer',
    goal: 'Implement issue requirements with tests',
    comment: `  # Tier: coding-agent (default).
  # Filesystem + shell editing surface only. No web access, no sub-agent
  # spawning, no Skill loading. This matches the pre-AISDLC-79 default
  # plus NotebookEdit (parity with the Claude Code SDK's editing surface).
`,
    tools: `${AGENT_ROLE_TOOLS_HEAD}    - NotebookEdit  # edit Jupyter notebooks (parity with SDK editing surface)
    # Excluded by default (opt in via --role research|meta during init):
    #   - WebFetch    - pulls untrusted remote content into context (research tier)
    #   - WebSearch   - same (research tier)
    #   - Task        - spawns sub-agents; cost + reasoning amplification (meta tier)
    #   - Skill       - loads external skill packs (meta tier)
`,
  },
  research: {
    role: 'research-developer',
    goal: 'Investigate, gather references, and implement issue requirements with tests',
    comment: `  # Tier: research-agent.
  # Coding-tier surface plus read-only web access. Use for tasks that need
  # to consult external docs, package registries, or RFCs.
`,
    tools: `${AGENT_ROLE_TOOLS_HEAD}    - NotebookEdit  # edit Jupyter notebooks
    - WebFetch      # fetch a known URL (docs, RFCs, API references)
    - WebSearch     # discover sources by query
    # Excluded (use --role meta to opt in):
    #   - Task        - spawns sub-agents (meta tier)
    #   - Skill       - loads external skill packs (meta tier)
`,
  },
  meta: {
    role: 'meta-developer',
    goal: 'Orchestrate sub-agents, load skill packs, and implement complex multi-step work',
    comment: `  # Tier: meta-agent.
  # Full surface: filesystem + shell + web + sub-agent + skill loading.
  # Use only when the task legitimately needs sub-agent fan-out or external
  # skill packs. Higher cost amplification and broader attack surface.
`,
    tools: `${AGENT_ROLE_TOOLS_HEAD}    - NotebookEdit  # edit Jupyter notebooks
    - WebFetch      # fetch a known URL
    - WebSearch     # discover sources by query
    - Task          # spawn sub-agents for parallel / specialized work
    - Skill         # load external skill packs (declared capabilities)
`,
  },
};

/** Render agent-role.yaml for a tier (default `coding`). */
export function renderAgentRole(tier: AgentRoleTier = 'coding'): string {
  const t = AGENT_ROLE_TIER_BODY[tier];
  return `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: default-agent
spec:
  role: ${t.role}
  goal: ${t.goal}
${AGENT_ROLE_BACKSTORY}${t.comment}  tools:
${t.tools}${AGENT_ROLE_TOOLS_TAIL}  constraints:
    maxFilesPerChange: 15
    requireTests: true
    blockedPaths:
      - .github/workflows/**
      - .ai-sdlc/**
${renderAgentRoleGovernance()}`;
}

function renderAgentRoleFromAnswers(answers: Readonly<Record<string, string>>): string {
  const tier = (answers.tier ?? 'coding') as AgentRoleTier;
  if (!AGENT_ROLE_TIERS.includes(tier)) {
    throw new Error(`invalid tier: ${tier} (expected ${AGENT_ROLE_TIERS.join(', ')})`);
  }
  return renderAgentRole(tier);
}

function requireAnswer(answers: Readonly<Record<string, string>>, key: string): string {
  const v = (answers[key] ?? '').trim();
  if (!v) throw new Error(`missing answer: ${key}`);
  return v;
}

function renderPipeline(answers: Readonly<Record<string, string>>): string {
  const org = requireAnswer(answers, 'org');
  const repo = requireAnswer(answers, 'repo');
  return `apiVersion: ai-sdlc.io/v1alpha1
kind: Pipeline
metadata:
  name: default
spec:
  triggers:
    - event: issue.assigned
  providers:
    sourceControl:
      type: github
      config:
        org: ${org}
        repo: ${repo}
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
}

/**
 * The manifest. Add an entry (with the releasing version as `since`) whenever a
 * release starts reading a new file under `.ai-sdlc/`.
 */
export const REQUIRED_CONFIG_MANIFEST: readonly ConfigEntry[] = [
  {
    id: 'review-policy',
    path: '.ai-sdlc/review-policy.md',
    since: '0.10.0',
    description: 'review policy the attestation verifier hashes and reviewers read',
    operatorInput: false,
    prompts: [],
    render: () => REVIEW_POLICY_DEFAULT,
  },
  {
    id: 'agent-role',
    path: '.ai-sdlc/agent-role.yaml',
    since: '0.1.0',
    description: 'agent role, governance and blocked-path policy read by every hook',
    operatorInput: false,
    prompts: [],
    render: renderAgentRoleFromAnswers,
  },
  {
    id: 'pipeline',
    path: '.ai-sdlc/pipeline.yaml',
    since: '0.1.0',
    description: 'pipeline definition (triggers, providers) the orchestrator runs',
    operatorInput: true,
    prompts: [
      { key: 'org', question: 'GitHub organization or user' },
      { key: 'repo', question: 'GitHub repository name' },
    ],
    render: renderPipeline,
  },
  {
    id: 'workflow',
    path: '.ai-sdlc/workflow.yaml',
    since: '0.36.0',
    description: 'workflow graph document (RFC-0056); nothing reads it at run time yet',
    operatorInput: false,
    optional: true,
    prompts: [],
    render: () => renderYaml(buildExecuteGraph()),
  },
  {
    id: 'context',
    path: CONTEXT_CONFIG_PATH,
    since: '0.45.0',
    description: 'knowledge store and retrieval settings (RFC-0053); defaults apply when absent',
    operatorInput: false,
    optional: true,
    prompts: [],
    render: () => CONTEXT_YAML_DEFAULT,
  },
  {
    id: 'knowledge-readme',
    path: `${DEFAULT_TRACKED_ROOT}/README.md`,
    since: '0.45.0',
    description: 'tracked knowledge store root (RFC-0053); entries are added under it',
    operatorInput: false,
    optional: true,
    prompts: [],
    render: () => KNOWLEDGE_README_DEFAULT,
  },
];

// ── Versions ──────────────────────────────────────────────────────────────

function parts(v: string): number[] {
  return v
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
}

/** Numeric semver compare on major.minor.patch: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The newest `since` in the manifest: the config version a fully-initialized repo records. */
export function newestConfigVersion(
  manifest: readonly ConfigEntry[] = REQUIRED_CONFIG_MANIFEST,
): string {
  return manifest.reduce((m, e) => (compareVersions(e.since, m) > 0 ? e.since : m), '0.0.0');
}

export function readConfigVersion(projectDir: string): string | null {
  const p = join(projectDir, CONFIG_VERSION_PATH);
  if (!existsSync(p)) return null;
  const m = readFileSync(p, 'utf8').match(/^configVersion:\s*['"]?([0-9][^\s'"]*)['"]?\s*$/m);
  return m ? m[1] : null;
}

export function writeConfigVersion(projectDir: string, version: string): void {
  const p = join(projectDir, CONFIG_VERSION_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `configVersion: '${version}'\n`, 'utf8');
}

// ── Evaluation (shared by preflight, doctor, SessionStart) ───────────────

export function missingConfigEntries(
  projectDir: string,
  manifest: readonly ConfigEntry[] = REQUIRED_CONFIG_MANIFEST,
): ConfigEntry[] {
  return manifest.filter((e) => e.optional !== true && !existsSync(join(projectDir, e.path)));
}

/** One line per missing entry. The single wording for preflight and doctor. */
export function formatMissingEntry(entry: ConfigEntry): string {
  return `missing required config ${entry.path} (${entry.description}; required since ${entry.since})`;
}

export function missingConfigRemediation(): string {
  return `Run \`${INIT_COMMAND}\` (or \`ai-sdlc doctor --fix\` for entries that need no input) to scaffold it.`;
}

/** Full refusal text: every missing entry, then the init command. Empty when nothing is missing. */
export function formatMissingConfig(missing: readonly ConfigEntry[]): string {
  if (missing.length === 0) return '';
  return [...missing.map(formatMissingEntry), missingConfigRemediation()].join('\n');
}

/**
 * Step 1 preflight: refuse before any worktree or dev dispatch when an entry
 * the run reads is missing. `ok: true` when nothing is missing.
 */
export function configPreflight(
  projectDir: string,
  manifest: readonly ConfigEntry[] = REQUIRED_CONFIG_MANIFEST,
): { ok: true } | { ok: false; reason: string; missing: ConfigEntry[] } {
  const missing = missingConfigEntries(projectDir, manifest);
  if (missing.length === 0) return { ok: true };
  return { ok: false, reason: formatMissingConfig(missing), missing };
}

/** SessionStart one-liner; `null` when the recorded configVersion is current or no `.ai-sdlc/` exists. */
export function configVersionNotice(
  projectDir: string,
  manifest: readonly ConfigEntry[] = REQUIRED_CONFIG_MANIFEST,
): string | null {
  if (!existsSync(join(projectDir, '.ai-sdlc'))) return null;
  const newest = newestConfigVersion(manifest);
  const recorded = readConfigVersion(projectDir);
  if (recorded !== null && compareVersions(recorded, newest) >= 0) return null;
  return `ai-sdlc: project config is ${recorded ?? 'unversioned'}, release requires ${newest}; run \`${INIT_COMMAND}\` to scaffold new entries.`;
}

// ── Scaffolding (init, doctor --fix) ─────────────────────────────────────

export type PromptFn = (question: string, defaultValue: string | undefined) => Promise<string>;

export interface ScaffoldOptions {
  projectDir: string;
  manifest?: readonly ConfigEntry[];
  /** Interactive prompt; absent means non-interactive (defaults only). */
  prompt?: PromptFn;
  /** Default answers by prompt key (git remote, git email, key file contents...). */
  defaults?: Readonly<Record<string, string>>;
  /** Overwrite existing entries. */
  force?: boolean;
  /** Skip operator-input entries (doctor --fix). */
  skipOperatorInput?: boolean;
  /** Do not write the config-version stamp (callers scaffolding into a custom config dir). */
  skipVersionStamp?: boolean;
}

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
  /** Entries that could not be written, with the missing names. */
  failed: { id: string; path: string; reason: string }[];
}

export async function scaffoldConfig(opts: ScaffoldOptions): Promise<ScaffoldResult> {
  const manifest = opts.manifest ?? REQUIRED_CONFIG_MANIFEST;
  const result: ScaffoldResult = { created: [], skipped: [], failed: [] };
  for (const entry of manifest) {
    const abs = join(opts.projectDir, entry.path);
    if (existsSync(abs) && opts.force !== true) {
      result.skipped.push(entry.path);
      continue;
    }
    if (entry.operatorInput && opts.skipOperatorInput === true) {
      result.skipped.push(entry.path);
      continue;
    }
    // Non-prompted defaults (e.g. the agent-role `tier`) reach render() as answers.
    const answers: Record<string, string> = { ...opts.defaults };
    for (const p of entry.prompts) {
      const def = opts.defaults?.[p.key];
      answers[p.key] = opts.prompt ? await opts.prompt(p.question, def) : (def ?? '');
      if (!answers[p.key] && def) answers[p.key] = def;
    }
    try {
      const content = entry.render(answers);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
      result.created.push(entry.path);
    } catch (err) {
      result.failed.push({ id: entry.id, path: entry.path, reason: (err as Error).message });
    }
  }
  // Stamp the version only when nothing required is still missing, so a skipped
  // operator-input entry keeps SessionStart's notice alive.
  if (
    opts.skipVersionStamp !== true &&
    result.failed.length === 0 &&
    missingConfigEntries(opts.projectDir, manifest).length === 0
  ) {
    writeConfigVersion(opts.projectDir, newestConfigVersion(manifest));
  }
  return result;
}
export * from './runtime-gitignore.js';
