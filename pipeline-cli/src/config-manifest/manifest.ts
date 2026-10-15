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
import { now } from '../clock.js';

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

const AGENT_ROLE_DEFAULT = `apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: coding-agent
spec:
  role: coding-agent
  goal: Implement backlog tasks under human review
  backstory: >-
    You are an AI coding agent. You work under strict constraints and every
    change requires review.
  tools:
    - code-editor
    - terminal
    - test-runner
  constraints:
    maxFilesPerChange: 15
`;

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
  name: ${repo}-pipeline
spec:
  triggers:
    - event: issue.labeled
      filter:
        labels:
          - ai-eligible
  providers:
    github:
      type: github
      config:
        org: ${org}
        repo: ${repo}
  stages:
    - name: code
      agent: coding-agent
      timeout: PT10M
      onFailure:
        strategy: retry
        maxRetries: 2
        retryDelay: PT1M
    - name: review
      approval:
        required: true
        blocking: true
        timeout: PT24H
        onTimeout: abort
`;
}

function renderKeyring(answers: Readonly<Record<string, string>>): string {
  const identity = requireAnswer(answers, 'identity');
  const pubkey = requireAnswer(answers, 'pubkey').replace(/\r/g, '').trim();
  if (!pubkey.includes('BEGIN PUBLIC KEY')) {
    throw new Error('pubkey is not a PEM public key (run /ai-sdlc init-signing-key first)');
  }
  const machine = (answers.machine ?? '').trim() || 'default';
  const addedAt = (answers.addedAt ?? '').trim() || now().toISOString().slice(0, 10);
  const pem = pubkey
    .split('\n')
    .map((l) => `      ${l.trim()}`)
    .join('\n');
  return `# Trusted signing keys for review attestations. The verifier reads this file
# from the base branch: every scalar single-quoted, pubkey a block scalar
# indented 6 spaces, no tabs. Add keys with a reviewed PR.
reviewers:
  - identity: '${identity}'
    machine: '${machine}'
    pubkey: |
${pem}
    addedAt: '${addedAt}'
    addedBy: '${identity}'
`;
}

/**
 * The manifest. Add an entry (with the releasing version as `since`) whenever a
 * release starts reading a new file under `.ai-sdlc/`.
 */
export const REQUIRED_CONFIG_MANIFEST: readonly ConfigEntry[] = [
  {
    id: 'trusted-reviewers',
    path: '.ai-sdlc/trusted-reviewers.yaml',
    since: '0.10.0',
    description: 'signing keyring the attestation verifier checks Step 10.6 envelopes against',
    operatorInput: true,
    prompts: [
      { key: 'identity', question: 'Reviewer identity (email or GitHub handle)' },
      { key: 'pubkey', question: 'PEM public key (output of /ai-sdlc init-signing-key)' },
    ],
    render: renderKeyring,
  },
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
    render: () => AGENT_ROLE_DEFAULT,
  },
  {
    id: 'pipeline',
    path: '.ai-sdlc/pipeline.yaml',
    since: '0.1.0',
    description: 'pipeline definition (provider, stages) the orchestrator runs',
    operatorInput: true,
    prompts: [
      { key: 'org', question: 'GitHub organization or user' },
      { key: 'repo', question: 'GitHub repository name' },
    ],
    render: renderPipeline,
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
  return manifest.filter((e) => !existsSync(join(projectDir, e.path)));
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
    const answers: Record<string, string> = {};
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
  if (result.failed.length === 0 && missingConfigEntries(opts.projectDir, manifest).length === 0) {
    writeConfigVersion(opts.projectDir, newestConfigVersion(manifest));
  }
  return result;
}
