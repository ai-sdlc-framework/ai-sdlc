/**
 * `ai-sdlc init` interactive wizard + feature dispatcher (AISDLC-143).
 *
 * Per Q4(b) of the operator-ratified quality-gate redesign, `ai-sdlc init`
 * is a wizard by default with `--yes` for non-interactive (CI/scripts) and
 * `--with-X` flags for explicit opt-in (`--with-dor`, `--with-attestation`,
 * `--with-classifier`, `--with-branch-protection`). This module owns:
 *
 *   1. The ordered prompt list (resolveFeatureSelection).
 *   2. The feature-toggle → file-write dispatcher (applyFeatureSelection).
 *   3. The branch-protection helper (applyBranchProtection) including the
 *      `--dry-run` JSON-print path required by AC #6.
 *   4. The "next steps" summary printed at the end of init (AC #5).
 *
 * Test surface: every public function takes a small options bag with
 * injectable side-effect adapters (prompter, writeFile, runCommand) so the
 * test suite can drive every wizard branch hermetically without spinning
 * up a TTY or shelling out to `gh`. Production callers in `init.ts` pass
 * the real adapters.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ATTESTATION_TEMPLATES,
  BASELINE_WORKFLOW_TEMPLATES,
  CLASSIFIER_TEMPLATES,
  DOR_TEMPLATES,
  HUSKY_PREPUSH_SIGN_SNIPPET,
  type FeatureTemplateSet,
} from './init-templates.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Per-feature on/off bits derived from prompts + flags. */
export interface FeatureSelection {
  dor: boolean;
  attestation: boolean;
  classifier: boolean;
  branchProtection: boolean;
}

/** All feature flags off — used as the initial state before flags + prompts. */
export const NO_FEATURES: FeatureSelection = {
  dor: false,
  attestation: false,
  classifier: false,
  branchProtection: false,
};

/** All features on — the answer used by `--yes` (accept all defaults). */
export const ALL_FEATURES: FeatureSelection = {
  dor: true,
  attestation: true,
  classifier: true,
  branchProtection: true,
};

/** Flag-bag controlling wizard behavior (already parsed from argv). */
export interface WizardFlags {
  /** `--yes` short-circuits the wizard; treats every prompt as "yes". */
  yes: boolean;
  /** `--with-dor` forces the DoR feature on without prompting. */
  withDor: boolean;
  /** `--with-attestation` forces attestation infra on without prompting. */
  withAttestation: boolean;
  /** `--with-classifier` forces the classifier on without prompting. */
  withClassifier: boolean;
  /** `--with-branch-protection` forces branch-protection on without prompting. */
  withBranchProtection: boolean;
  /**
   * `--add <feature>` extends an already-initialized repo with a single
   * feature without re-prompting. AC #7 (idempotent extension). When set,
   * the wizard short-circuits to scaffold ONLY this feature.
   */
  add?: 'dor' | 'attestation' | 'classifier' | 'branch-protection';
  /** `--dry-run` — print what would be done, don't write. */
  dryRun: boolean;
}

/**
 * Single-question prompter contract — accepts a question + default and
 * returns the user's answer. The production adapter wraps `@inquirer/prompts`
 * so the user gets a real readline TTY; tests inject a stub that returns
 * scripted answers without touching stdin.
 *
 * Why a single-question primitive instead of "ask all questions at once":
 * the prompts are conditional in some cases (e.g. branch-protection only
 * makes sense after the user has chosen which CI gates exist). Keeping
 * the primitive small lets `resolveFeatureSelection` decide ordering +
 * skip questions whose answer is already determined by a `--with-X` flag.
 */
export type Prompter = (question: string, defaultYes: boolean) => Promise<boolean>;

/**
 * Side-effect adapter bag — every part of the dispatcher that touches
 * disk or shells out goes through this so tests can assert on intents
 * without mocking `node:fs` globally.
 */
export interface FeatureAdapters {
  /** Resolve to an interactive prompt answer. */
  prompt: Prompter;
  /** Write a file. Production = `node:fs.writeFileSync`. */
  writeFile: (path: string, contents: string) => void;
  /**
   * Append `contents` to `path` exactly once: if `sentinel` is already
   * present in the file, no-op. If the file doesn't exist, behaves like
   * a write. Used for the husky pre-push sign block + CLAUDE.md pointer
   * (both of which need to coexist with user-edited content).
   */
  appendOnce: (path: string, contents: string, sentinel: string) => 'appended' | 'skipped';
  /** mkdir -p. Production = `node:fs.mkdirSync({ recursive: true })`. */
  mkdirp: (path: string) => void;
  /** Test for path existence. Production = `node:fs.existsSync`. */
  exists: (path: string) => boolean;
  /** Run a shell command (used for `gh api`). Production = `execSync`. */
  runCommand: (cmd: string, args: string[]) => { stdout: string; exitCode: number };
  /** Sink for operator-visible output (defaults to console.log). */
  log: (line: string) => void;
}

// ── Production adapter factory ───────────────────────────────────────────

/**
 * Build the production adapter bag. Pulled into a factory so tests can
 * compose a partial override bag (e.g. only override `prompt`) and let
 * the rest fall through to real disk writes.
 *
 * The `prompt` adapter is a lazy import of `@inquirer/prompts.confirm`
 * so that:
 *   1. Tests don't pay the import cost when they inject their own stub.
 *   2. `--yes` runs (which never call `prompt`) don't pay it either.
 *   3. The orchestrator's runtime `dist/` is smaller for the common case.
 */
export function buildProductionAdapters(): FeatureAdapters {
  return {
    prompt: async (question, defaultYes) => {
      // Lazy import — see docblock above for why.
      const { confirm } = await import('@inquirer/prompts');
      return confirm({ message: question, default: defaultYes });
    },
    writeFile: (path, contents) => writeFileSync(path, contents, 'utf-8'),
    appendOnce: (path, contents, sentinel) => {
      // Make sure the parent dir exists (appendFileSync errors with ENOENT
      // otherwise; we may be writing into a freshly-created `.husky/`).
      mkdirSync(dirname(path), { recursive: true });
      const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
      if (existing.includes(sentinel)) return 'skipped';
      const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(path, existing + sep + contents, 'utf-8');
      return 'appended';
    },
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    exists: (path) => existsSync(path),
    runCommand: (cmd, args) => {
      try {
        // Use `execFileSync` (no shell) so args are passed as a true
        // argv array — never word-split or shell-interpreted. The prior
        // `execSync(\`${cmd} ${args.join(' ')}\`)` form ran the command
        // through `/bin/sh -c` and silently broke whenever any argument
        // contained whitespace (e.g. macOS users with `~/Documents/My
        // Project/` in their projectDir, where the `--input <tmpPath>`
        // arg to `gh api` would word-split and `gh` would see two
        // unrelated tokens — branch protection would silently fail or
        // apply wrong content). Switching to `execFileSync` eliminates
        // both word-splitting AND any shell-injection surface in one
        // change. Stderr stays muted so users still get the clean
        // single-line error rendered by `applyBranchProtection`.
        const stdout = execFileSync(cmd, args, {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return { stdout, exitCode: 0 };
      } catch (err) {
        const e = err as { stdout?: Buffer | string; status?: number };
        return {
          stdout: typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? ''),
          exitCode: e.status ?? 1,
        };
      }
    },
    log: (line) => console.log(line),
  };
}

// ── Wizard ───────────────────────────────────────────────────────────────

/**
 * Resolve the per-feature on/off vector by combining (in priority order):
 *   1. `--add <feature>` — if set, ONLY that feature is on; everything
 *      else is suppressed (idempotent extension, AC #7).
 *   2. `--yes` — accept every default (every feature on).
 *   3. `--with-X` flags — opt-in without prompting.
 *   4. Interactive prompts for any feature still undetermined.
 *
 * Returns a fully-determined FeatureSelection. The dispatcher then writes
 * exactly the union of features marked true.
 */
export async function resolveFeatureSelection(
  flags: WizardFlags,
  adapters: Pick<FeatureAdapters, 'prompt' | 'log'>,
): Promise<FeatureSelection> {
  // ── Path 1: `--add` — single-feature extension ────────────────────────
  if (flags.add) {
    const sel: FeatureSelection = { ...NO_FEATURES };
    switch (flags.add) {
      case 'dor':
        sel.dor = true;
        break;
      case 'attestation':
        sel.attestation = true;
        break;
      case 'classifier':
        sel.classifier = true;
        break;
      case 'branch-protection':
        sel.branchProtection = true;
        break;
    }
    return sel;
  }

  // ── Path 2: `--yes` — all defaults on, no prompts ─────────────────────
  if (flags.yes) {
    return { ...ALL_FEATURES };
  }

  // ── Path 2b: non-TTY auto-fall-through ────────────────────────────────
  // When stdin is not a TTY (CI runners, agent bash, piped input, Docker
  // containers without `-it`), interactive prompts hang then throw an
  // unhandled ExitPromptError. Auto-fall-through to ALL_FEATURES (same
  // as --yes) so adopters can run `ai-sdlc init` in CI without any
  // additional flags. This matches the documented behavior of --yes, which
  // is defined as "accept all defaults non-interactively".
  if (!process.stdin.isTTY) {
    adapters.log(
      'Non-TTY stdin detected — auto-accepting all feature defaults (equivalent to --yes).',
    );
    adapters.log('Pass --yes explicitly to suppress this message.');
    return { ...ALL_FEATURES };
  }

  // ── Path 3+4: `--with-X` overrides + prompts for the rest ─────────────
  const sel: FeatureSelection = { ...NO_FEATURES };

  // DoR
  if (flags.withDor) {
    sel.dor = true;
  } else {
    sel.dor = await adapters.prompt('Will this repo use Definition-of-Ready gates?', true);
  }

  // Attestation
  if (flags.withAttestation) {
    sel.attestation = true;
  } else {
    sel.attestation = await adapters.prompt(
      'Do you want attestation infrastructure (audit-only)?',
      true,
    );
  }

  // Classifier
  if (flags.withClassifier) {
    sel.classifier = true;
  } else {
    sel.classifier = await adapters.prompt(
      'Add review classifier for cost-optimized reviews?',
      true,
    );
  }

  // Branch protection
  if (flags.withBranchProtection) {
    sel.branchProtection = true;
  } else {
    sel.branchProtection = await adapters.prompt(
      'Apply recommended branch protection? (required: ai-sdlc/pr-ready + codecov/patch)',
      true,
    );
  }

  return sel;
}

// ── Dispatcher ───────────────────────────────────────────────────────────

/** Return value of `applyFeatureSelection` — what was actually written. */
export interface ApplyResult {
  /** Files that were newly created on this run. */
  created: string[];
  /** Files that already existed and were left untouched (idempotent). */
  skipped: string[];
  /** Files that would have been created if not for `--dry-run`. */
  wouldCreate: string[];
  /** Branch-protection result, if attempted. */
  branchProtection?: BranchProtectionResult;
}

/**
 * Write the union of feature templates into the project dir. AC #4 says
 * the BASELINE workflow templates (gate workflow) are always written; the
 * per-feature template sets are written only when their toggle is on.
 *
 * Idempotent: any file that already exists at the target path is skipped
 * with a "skip" log line. This is what makes `--add <feature>` safe to
 * run on an already-initialized repo (AC #7).
 */
export async function applyFeatureSelection(
  projectDir: string,
  selection: FeatureSelection,
  flags: WizardFlags,
  adapters: FeatureAdapters,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: [], skipped: [], wouldCreate: [] };

  // Build the union of templates to write.
  const templateSets: FeatureTemplateSet[] = [];

  // `--add` mode: skip the baseline (we're EXTENDING an existing init).
  if (!flags.add) {
    templateSets.push(BASELINE_WORKFLOW_TEMPLATES);
  }
  if (selection.dor) templateSets.push(DOR_TEMPLATES);
  if (selection.attestation) templateSets.push(ATTESTATION_TEMPLATES);
  if (selection.classifier) templateSets.push(CLASSIFIER_TEMPLATES);

  for (const set of templateSets) {
    for (const [relPath, contents] of Object.entries(set.files)) {
      const absPath = join(projectDir, relPath);

      if (flags.dryRun) {
        result.wouldCreate.push(relPath);
        adapters.log(`  would create ${relPath}`);
        continue;
      }

      if (adapters.exists(absPath)) {
        result.skipped.push(relPath);
        adapters.log(`  skip ${relPath} (already exists)`);
        continue;
      }

      // mkdir -p the parent
      adapters.mkdirp(dirname(absPath));
      adapters.writeFile(absPath, contents);
      result.created.push(relPath);
      adapters.log(`  created ${relPath}`);
    }
  }

  // Husky pre-push sign hook is a separate concern from the
  // FeatureTemplateSet because it's an APPEND (not a write-from-empty)
  // — adopters often already have a .husky/pre-push from their existing
  // tooling and we don't want to clobber it. Only fired when attestation
  // is on.
  if (selection.attestation && !flags.dryRun) {
    const hookPath = join(projectDir, '.husky', 'pre-push');
    if (!adapters.exists(hookPath)) {
      // No existing hook — write a minimal one with the sign block.
      adapters.mkdirp(dirname(hookPath));
      adapters.writeFile(
        hookPath,
        `#!/usr/bin/env bash\nset -euo pipefail\n\n${HUSKY_PREPUSH_SIGN_SNIPPET}`,
      );
      result.created.push('.husky/pre-push');
      adapters.log(`  created .husky/pre-push`);
    } else {
      const status = adapters.appendOnce(
        hookPath,
        HUSKY_PREPUSH_SIGN_SNIPPET,
        '# ai-sdlc:attestation-sign-block',
      );
      if (status === 'appended') {
        adapters.log(`  updated .husky/pre-push (appended sign block)`);
      } else {
        result.skipped.push('.husky/pre-push');
        adapters.log(`  skip .husky/pre-push (sign block already present)`);
      }
    }
  } else if (selection.attestation && flags.dryRun) {
    result.wouldCreate.push('.husky/pre-push');
    adapters.log('  would update .husky/pre-push (sign block)');
  }

  // Branch protection (always last — depends on the gate workflow being
  // present so the required check exists when the rule is applied).
  if (selection.branchProtection) {
    result.branchProtection = await applyBranchProtection(projectDir, flags, adapters);
  }

  return result;
}

// ── Branch protection ────────────────────────────────────────────────────

export interface BranchProtectionResult {
  /** Whether the rule was actually applied. False in dry-run. */
  applied: boolean;
  /** The PUT body as a JSON string (always populated for visibility). */
  bodyJson: string;
  /** Error message from `gh api`, if non-zero exit. */
  error?: string;
}

/**
 * Recommended branch-protection ruleset for AI-SDLC adopters. AC #1 #4:
 * the required checks are `ai-sdlc/pr-ready` (the gate aggregator) and
 * `codecov/patch` (the de facto coverage signal). Other AI-SDLC apps
 * post their own statuses but they're all rolled into pr-ready.
 *
 * The body conforms to the GitHub REST API
 * `PUT /repos/{owner}/{repo}/branches/{branch}/protection` schema.
 */
export const RECOMMENDED_BRANCH_PROTECTION_BODY = {
  required_status_checks: {
    strict: true,
    contexts: ['ai-sdlc/pr-ready', 'codecov/patch'],
  },
  enforce_admins: false,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
  },
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
};

/**
 * Apply (or print, in dry-run) the recommended branch protection rule
 * to the `main` branch of the repo at `projectDir`. AC #6 explicitly
 * requires that `--dry-run` print the JSON without applying.
 *
 * The repo identity (`owner/repo`) is resolved by shelling out to
 * `gh repo view --json nameWithOwner -q .nameWithOwner`. We could parse
 * the git remote ourselves (see git-remote.ts) but `gh` already resolves
 * forks + renames + custom default branches consistently, and the user
 * needs `gh` on PATH for the PUT to work anyway.
 */
export async function applyBranchProtection(
  projectDir: string,
  flags: WizardFlags,
  adapters: Pick<FeatureAdapters, 'runCommand' | 'log'>,
): Promise<BranchProtectionResult> {
  const bodyJson = JSON.stringify(RECOMMENDED_BRANCH_PROTECTION_BODY, null, 2);

  if (flags.dryRun) {
    adapters.log('');
    adapters.log('Branch-protection dry-run — would PUT the following body:');
    adapters.log(bodyJson);
    adapters.log('');
    adapters.log('  endpoint: PUT /repos/{owner}/{repo}/branches/main/protection');
    adapters.log('  apply with: gh api -X PUT repos/{owner}/{repo}/branches/main/protection ...');
    return { applied: false, bodyJson };
  }

  // Resolve owner/repo via gh.
  const ownerRepo = adapters.runCommand('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '-q',
    '.nameWithOwner',
  ]);
  if (ownerRepo.exitCode !== 0) {
    return {
      applied: false,
      bodyJson,
      error: `gh repo view failed: ${ownerRepo.stdout.trim() || 'unknown error'}`,
    };
  }
  const slug = ownerRepo.stdout.trim();
  if (!slug) {
    return {
      applied: false,
      bodyJson,
      error: 'gh repo view returned empty owner/repo',
    };
  }

  // Use the file-based input form so we don't have to thread quoted JSON
  // through a shell. We write to a tmpfile, point gh at it, and let the
  // adapter's runCommand spawn `gh` directly.
  const tmpPath = join(projectDir, '.ai-sdlc', 'branch-protection-body.json');
  // adapters.runCommand can't write files, so we use the underlying
  // primitives directly here — branch protection is a one-shot operation
  // and doesn't need to be hermetic in the same way as the file writes.
  // Tests inject a stub that intercepts the runCommand call and never
  // touches this path. See test for the contract.
  try {
    mkdirSync(dirname(tmpPath), { recursive: true });
    writeFileSync(tmpPath, bodyJson, 'utf-8');
  } catch (err) {
    return {
      applied: false,
      bodyJson,
      error: `failed to stage branch-protection body: ${(err as Error).message}`,
    };
  }

  const apply = adapters.runCommand('gh', [
    'api',
    '-X',
    'PUT',
    `repos/${slug}/branches/main/protection`,
    '--input',
    tmpPath,
  ]);
  if (apply.exitCode !== 0) {
    return {
      applied: false,
      bodyJson,
      error: `gh api PUT failed: ${apply.stdout.trim() || 'unknown error'}`,
    };
  }

  adapters.log(`  applied branch protection to ${slug}:main`);
  return { applied: true, bodyJson };
}

// ── Next-steps summary ───────────────────────────────────────────────────

/**
 * Print the structured "next steps" summary at the end of init. AC #5:
 * the summary must include operator action items conditional on which
 * features were chosen (e.g. `gh secret set` commands when attestation
 * was opted in).
 *
 * Returns the rendered summary as a string in addition to logging it,
 * so tests can assert on it without re-stringifying console output.
 */
export function renderNextSteps(
  selection: FeatureSelection,
  result: ApplyResult,
  adapters: Pick<FeatureAdapters, 'log'>,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('━━━ Next steps ━━━');
  lines.push('');

  // Always present (baseline gate)
  lines.push('1. Commit the scaffolded files:');
  lines.push('     git add .ai-sdlc .github/workflows package.json');
  lines.push('     git commit -m "chore: bootstrap AI-SDLC config"');
  lines.push('');

  let stepN = 2;

  if (selection.dor) {
    lines.push(`${stepN}. DoR (Definition-of-Ready) is in WARN-ONLY mode by default.`);
    lines.push('     Tune .ai-sdlc/dor-config.yaml then flip evaluationMode: enforce');
    lines.push('     after a soak window confirms the false-positive rate is low.');
    lines.push('');
    stepN++;
  }

  if (selection.attestation) {
    lines.push(`${stepN}. Attestation infrastructure was scaffolded in AUDIT-ONLY mode.`);
    lines.push('     a) Bootstrap your signing key: /ai-sdlc init-signing-key');
    lines.push('     b) Open a PR adding the printed YAML block to');
    lines.push('        .ai-sdlc/trusted-reviewers.yaml');
    // AISDLC-152: removed the optional CI-side signer step (the AISDLC-87
    // CI-attestor was retired in AISDLC-140 sub-4 alongside attestation
    // becoming audit-only). New adopters no longer need to provision the
    // AI_SDLC_CI_ATTESTOR_PRIVATE_KEY secret.
    lines.push('');
    stepN++;
  }

  if (selection.classifier) {
    lines.push(`${stepN}. Review classifier config was scaffolded.`);
    lines.push('     The classifier RUNTIME ships in AISDLC-141 (follow-up). Until');
    lines.push('     that lands, .ai-sdlc/review-classifier.yaml is advisory only.');
    lines.push('');
    stepN++;
  }

  if (selection.branchProtection) {
    if (result.branchProtection?.applied) {
      lines.push(`${stepN}. Branch protection on \`main\` was updated.`);
      lines.push('     Required checks: ai-sdlc/pr-ready, codecov/patch');
    } else if (result.branchProtection?.error) {
      lines.push(`${stepN}. Branch protection was NOT applied:`);
      lines.push(`     ${result.branchProtection.error}`);
      lines.push('     After resolving (gh auth login, repo permissions, etc.) re-run:');
      lines.push('     ai-sdlc init --add branch-protection');
    } else {
      lines.push(`${stepN}. Branch protection (dry-run) — see JSON above; apply with:`);
      lines.push('     ai-sdlc init --add branch-protection');
    }
    lines.push('');
    stepN++;
  }

  lines.push(`${stepN}. Verify your configuration: ai-sdlc health`);
  lines.push('');
  lines.push(
    'Adopter docs: https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/init.md',
  );

  const out = lines.join('\n');
  for (const line of lines) adapters.log(line);
  return out;
}

// ── CLAUDE.md recommendation pointer (AC #4) ─────────────────────────────

/**
 * The pointer block we append to CLAUDE.md so a freshly-initialized repo's
 * Claude Code sessions know where to find the AI-SDLC quality-gate docs.
 * Idempotent — guarded by a sentinel so re-running init doesn't duplicate
 * the block.
 */
export const CLAUDE_MD_POINTER = `
<!-- ai-sdlc:recommendation-pointer -->
## AI-SDLC quality gate

This repo is bootstrapped with the AI-SDLC framework. The single PR-ready
merge gate is \`ai-sdlc/pr-ready\` (see \`.github/workflows/ai-sdlc-gate.yml\`).
Run \`ai-sdlc health\` to verify your local config; see
\`docs/operations/init.md\` for the adopter guide.
<!-- end ai-sdlc:recommendation-pointer -->
`;

/** Sentinel marker used by the CLAUDE.md pointer for idempotency. */
export const CLAUDE_MD_SENTINEL = '<!-- ai-sdlc:recommendation-pointer -->';

/**
 * Append the recommendation pointer to CLAUDE.md (or create the file if
 * missing). Idempotent: if the sentinel is already present we no-op.
 */
export function ensureClaudeMdPointer(
  projectDir: string,
  adapters: Pick<FeatureAdapters, 'exists' | 'writeFile' | 'appendOnce' | 'log'>,
  dryRun: boolean,
): void {
  const path = join(projectDir, 'CLAUDE.md');

  if (dryRun) {
    adapters.log('  would update CLAUDE.md (recommendation pointer)');
    return;
  }

  if (!adapters.exists(path)) {
    adapters.writeFile(path, `# Project instructions\n${CLAUDE_MD_POINTER}`);
    adapters.log('  created CLAUDE.md');
    return;
  }

  const status = adapters.appendOnce(path, CLAUDE_MD_POINTER, CLAUDE_MD_SENTINEL);
  if (status === 'appended') {
    adapters.log('  updated CLAUDE.md (recommendation pointer)');
  } else {
    adapters.log('  skip CLAUDE.md (recommendation pointer already present)');
  }
}
