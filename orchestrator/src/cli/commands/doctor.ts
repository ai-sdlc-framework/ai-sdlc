/**
 * ai-sdlc doctor — reports the REAL state of this repo's attestation
 * governance (AISDLC-560).
 *
 * Motivation: `ai-sdlc init` can scaffold every *artifact* of review
 * attestation (`.ai-sdlc/trusted-reviewers.yaml`, `.ai-sdlc/attestations/`,
 * `.github/workflows/verify-attestation.yml`) while installing zero
 * enforcement — by deliberate design (Q3 in the AISDLC-140 redesign:
 * attestation ships audit-only; see `docs/operations/quality-gate.md` and
 * the Q-decisions note at the top of `init-templates.ts`). From inside a
 * freshly initialized repo, a populated keyring is easy to mistake for a
 * working gate: nothing in the repo state contradicts that impression
 * unless you go looking for it.
 *
 * `ai-sdlc doctor` is that "going looking" made instant. It inspects the
 * filesystem (and, best-effort, GitHub branch protection) and reports one
 * of three states:
 *
 *   - `neither`            — no attestation artifacts installed at all.
 *   - `artifacts-only`     — keyring/workflow/attestations dir present,
 *                            but nothing detected that would actually
 *                            block a merge on missing/invalid attestation.
 *   - `fully-configured`   — artifacts present AND a real enforcement
 *                            signal is detected (branch protection
 *                            requiring an approving review, wired through
 *                            `ai-sdlc init --add branch-protection`).
 *
 * `checkAttestationGovernance` is the reusable, hermetically-testable
 * core — it takes only filesystem + subprocess adapters, no CLI/global
 * state, so other consumers (e.g. the SessionStart hook wording fix
 * tracked as AISDLC-561) can import it directly instead of
 * re-implementing the same detection logic.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { formatOutput } from '../formatters/index.js';

// ── Types ──────────────────────────────────────────────────────────────

export type AttestationDoctorState = 'neither' | 'artifacts-only' | 'fully-configured';

export interface AttestationArtifacts {
  /** `.ai-sdlc/trusted-reviewers.yaml` exists. */
  trustedReviewers: boolean;
  /** `.ai-sdlc/attestations/` directory exists. */
  attestationsDir: boolean;
  /** `.github/workflows/verify-attestation.yml` exists. */
  verifyWorkflow: boolean;
}

export interface BranchProtectionCheck {
  /**
   * Whether the check actually ran (i.e. `gh` was available, on PATH,
   * authenticated, and the repo has a resolvable owner/repo). When
   * false, `requiresApprovingReview` / `requiresPrReady` are always
   * false and `error` explains why.
   */
  checked: boolean;
  /** `required_pull_request_reviews.required_approving_review_count >= 1`. */
  requiresApprovingReview: boolean;
  /** `required_status_checks.contexts` includes `ai-sdlc/pr-ready`. */
  requiresPrReady: boolean;
  /** Reason the check could not run, or that the API call failed. */
  error?: string;
}

export interface AttestationDoctorResult {
  state: AttestationDoctorState;
  artifacts: AttestationArtifacts;
  artifactsPresent: boolean;
  branchProtection: BranchProtectionCheck;
  enforcementConfigured: boolean;
  /** Present whenever state !== 'fully-configured'; names the gap explicitly. */
  gap?: string;
  /** The command that closes the gap, when one exists. */
  closingCommand?: string;
}

/**
 * Adapter bag so `checkAttestationGovernance` is hermetically testable
 * with `mkdtemp` fixtures and a stubbed `runCommand` — no real `gh`
 * process, no network, no shared /tmp state. Mirrors the `FeatureAdapters`
 * pattern in `init-features.ts`.
 */
export interface DoctorAdapters {
  /** Test for path existence. Production = `node:fs.existsSync`. */
  exists: (path: string) => boolean;
  /**
   * Run a shell command and capture stdout/exitCode. Production shells
   * out via `execSync`; tests inject a stub. Used only for the
   * best-effort `gh api` branch-protection lookup.
   */
  runCommand: (cmd: string, args: string[]) => { stdout: string; exitCode: number };
}

export function buildProductionDoctorAdapters(): DoctorAdapters {
  return {
    exists: existsSync,
    runCommand: (cmd, args) => {
      // `execFileSync` (no shell): args pass through as a true argv
      // array, never word-split or shell-interpreted. Mirrors the
      // `runCommand` adapter in `init-features.ts`'s
      // `buildProductionAdapters()`.
      try {
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
  };
}

// ── Detection ─────────────────────────────────────────────────────────

/** Detect which attestation artifacts are present on disk. */
export function detectAttestationArtifacts(
  projectDir: string,
  adapters: Pick<DoctorAdapters, 'exists'>,
): AttestationArtifacts {
  return {
    trustedReviewers: adapters.exists(join(projectDir, '.ai-sdlc', 'trusted-reviewers.yaml')),
    attestationsDir: adapters.exists(join(projectDir, '.ai-sdlc', 'attestations')),
    verifyWorkflow: adapters.exists(
      join(projectDir, '.github', 'workflows', 'verify-attestation.yml'),
    ),
  };
}

/**
 * Best-effort branch-protection lookup via `gh api`. Never throws —
 * absence of `gh`, missing auth, or an unresolvable remote all collapse
 * to `checked: false` with an explanatory `error` rather than crashing
 * `ai-sdlc doctor`.
 */
export function checkBranchProtection(
  // Currently unused — `gh` resolves the repo from cwd via its own
  // git-remote detection. Threaded through for forward-compat with a
  // future `--repo` override and to keep the signature symmetric with
  // `detectAttestationArtifacts`.
  _projectDir: string,
  adapters: Pick<DoctorAdapters, 'runCommand'>,
): BranchProtectionCheck {
  const ownerRepo = adapters.runCommand('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '-q',
    '.nameWithOwner',
  ]);
  if (ownerRepo.exitCode !== 0 || !ownerRepo.stdout.trim()) {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      error:
        'could not resolve owner/repo via `gh repo view` (gh missing, not authenticated, or not a GitHub remote)',
    };
  }
  const slug = ownerRepo.stdout.trim();

  const protection = adapters.runCommand('gh', ['api', `repos/${slug}/branches/main/protection`]);
  if (protection.exitCode !== 0) {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      error: `gh api repos/${slug}/branches/main/protection failed (branch protection likely not configured)`,
    };
  }

  try {
    const body = JSON.parse(protection.stdout) as {
      required_pull_request_reviews?: { required_approving_review_count?: number };
      required_status_checks?: { contexts?: string[] };
    };
    const requiresApprovingReview =
      (body.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1;
    const requiresPrReady = (body.required_status_checks?.contexts ?? []).includes(
      'ai-sdlc/pr-ready',
    );
    return { checked: true, requiresApprovingReview, requiresPrReady };
  } catch {
    return {
      checked: false,
      requiresApprovingReview: false,
      requiresPrReady: false,
      error: 'could not parse `gh api .../protection` response as JSON',
    };
  }
}

/**
 * The reusable core: inspect `projectDir` and classify this repo's
 * attestation governance into one of three states. Pure given its
 * adapters — no console output, no process.exit.
 */
export function checkAttestationGovernance(
  projectDir: string,
  adapters: DoctorAdapters,
): AttestationDoctorResult {
  const artifacts = detectAttestationArtifacts(projectDir, adapters);
  const artifactsPresent =
    artifacts.trustedReviewers || artifacts.attestationsDir || artifacts.verifyWorkflow;

  const branchProtection = checkBranchProtection(projectDir, adapters);
  const enforcementConfigured =
    branchProtection.checked &&
    branchProtection.requiresApprovingReview &&
    branchProtection.requiresPrReady;

  let state: AttestationDoctorState;
  if (!artifactsPresent) {
    state = 'neither';
  } else if (enforcementConfigured) {
    state = 'fully-configured';
  } else {
    state = 'artifacts-only';
  }

  const result: AttestationDoctorResult = {
    state,
    artifacts,
    artifactsPresent,
    branchProtection,
    enforcementConfigured,
  };

  if (state === 'neither') {
    result.gap =
      'No attestation infrastructure installed — no keyring, no attestations dir, no verify-attestation.yml.';
    result.closingCommand = 'ai-sdlc init --add attestation';
  } else if (state === 'artifacts-only') {
    result.gap =
      'Attestation artifacts present (keyring and/or verify-attestation.yml and/or attestations dir), ' +
      'but no enforcement configured. By design (AISDLC-140 Q3) verify-attestation.yml is AUDIT-ONLY — it ' +
      'never fails the build. Nothing currently blocks a merge on missing or invalid review attestation.' +
      (branchProtection.error ? ` (branch-protection check: ${branchProtection.error})` : '');
    result.closingCommand = 'ai-sdlc init --add branch-protection';
  }

  return result;
}

// ── Rendering ─────────────────────────────────────────────────────────

/** Render a human-readable report. Used by the table formatter + tests. */
export function renderDoctorReport(result: AttestationDoctorResult): string[] {
  const lines: string[] = [];
  lines.push('AI-SDLC Doctor — Attestation Governance');
  lines.push('─'.repeat(50));

  const stateLabel: Record<AttestationDoctorState, string> = {
    neither: 'NEITHER — no attestation artifacts installed',
    'artifacts-only': 'ARTIFACTS-ONLY — installed, not enforced',
    'fully-configured': 'FULLY CONFIGURED — artifacts + enforcement',
  };
  lines.push(`State: ${stateLabel[result.state]}`);
  lines.push('');

  lines.push('Artifacts:');
  lines.push(
    `  trusted-reviewers.yaml:      ${result.artifacts.trustedReviewers ? 'present' : 'absent'}`,
  );
  lines.push(
    `  .ai-sdlc/attestations/:      ${result.artifacts.attestationsDir ? 'present' : 'absent'}`,
  );
  lines.push(
    `  verify-attestation.yml:      ${result.artifacts.verifyWorkflow ? 'present' : 'absent'}`,
  );
  lines.push('');

  lines.push('Enforcement:');
  if (result.branchProtection.checked) {
    lines.push(
      `  branch protection (main):    requires approving review = ${result.branchProtection.requiresApprovingReview}, requires ai-sdlc/pr-ready = ${result.branchProtection.requiresPrReady}`,
    );
  } else {
    lines.push(
      `  branch protection (main):    unknown (${result.branchProtection.error ?? 'not checked'})`,
    );
  }
  lines.push(`  enforcement configured:      ${result.enforcementConfigured}`);
  lines.push('');

  if (result.gap) {
    lines.push('Gap:');
    lines.push(`  ${result.gap}`);
    lines.push('');
  }
  if (result.closingCommand) {
    lines.push(`Close it with: ${result.closingCommand}`);
    lines.push('');
  }

  if (result.state === 'fully-configured') {
    lines.push('Note: attestation itself remains an audit trail, not an independently-verified');
    lines.push('signal — "enforcement" here means branch protection requires a human approving');
    lines.push("review before merge, per the framework's audit-at-source design.");
  }

  return lines;
}

// ── Command ───────────────────────────────────────────────────────────

/**
 * Builds the `doctor` Command. `buildAdapters` defaults to the real
 * filesystem/`gh` adapters; tests inject a stub factory so the
 * branch-protection state (and therefore the exit-code contract) is
 * deterministic without shelling out to a real `gh` process.
 */
export function createDoctorCommand(
  buildAdapters: () => DoctorAdapters = buildProductionDoctorAdapters,
): Command {
  return new Command('doctor')
    .description("Report this repo's real attestation-governance state (artifacts vs. enforcement)")
    .action(async (_opts, cmd) => {
      const globalOpts = cmd.parent?.opts() ?? {};
      const format = globalOpts.format ?? 'table';
      const projectDir = process.cwd();

      const adapters = buildAdapters();
      const result = checkAttestationGovernance(projectDir, adapters);

      if (format === 'json') {
        console.log(formatOutput('json', result as unknown as Record<string, unknown>));
      } else if (format === 'minimal') {
        console.log(
          formatOutput('minimal', {
            type: 'doctor',
            ...result,
          } as unknown as Record<string, unknown>),
        );
      } else {
        for (const line of renderDoctorReport(result)) {
          console.log(line);
        }
      }

      if (result.state !== 'fully-configured') {
        process.exitCode = 1;
      }
    });
}

export const doctorCommand = createDoctorCommand();
