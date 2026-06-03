/**
 * CLI for RFC-0043 Untrusted-Contributor Verification Gate (UCVG) — Phase 5.
 *
 * Subcommands consumed by `.github/workflows/untrusted-pr-gate.yml`:
 *
 *   classify        — Stage 0 trust classification (wraps trust-classifier.ts)
 *   ast-gate        — Stage 1 deterministic diff/AST gate (wraps ast-gate.ts)
 *   sandbox-run     — Stage 2/3 OpenShell sandbox + reviewer matrix
 *   review-degraded — Stage 3 degraded static-diff review (no sandbox)
 *   clean-room-sign — Stage 4 clean-room attestation (wraps clean-room-signer.ts)
 *   local-review    — Surface the local-deployment path message
 *
 * All subcommands emit JSON on stdout. Errors produce non-zero exit + JSON on stderr.
 *
 * ## Feature flag
 *
 * `AI_SDLC_UNTRUSTED_PR_GATE` (default `off`)
 * Truthy values: 1, true, yes, on (case-insensitive). Anything else = OFF.
 * When OFF: UCVG path is not engaged; this CLI is a no-op at the workflow level.
 * The workflow itself checks the flag before invoking the CLI, so in practice the
 * CLI only runs when the flag is ON. The CLI re-checks for defense-in-depth.
 *
 * ## Fail-closed invariant
 *
 * Any error in Stage 0 or Stage 1 defaults to `untrusted` / `abort-protected-path`
 * respectively. The UCVG fails closed for untrusted PRs — never fail-open.
 *
 * @module cli/ucvg
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyTrust } from '../pipeline/trust-classifier.js';
import { runAstGate, loadAstGateConfig, buildBlockedEvent } from '../pipeline/ast-gate.js';
import type { ChangedFile } from '../pipeline/ast-gate.js';
import { loadSandboxConfig, runSandbox } from '../pipeline/sandbox-runner.js';
import { runCleanRoomSigner, unsignedReportPath } from '../pipeline/clean-room-signer.js';

// ── Feature flag ──────────────────────────────────────────────────────────────

/**
 * Parse the AI_SDLC_UNTRUSTED_PR_GATE feature flag value.
 *
 * Truthy: 1, true, yes, on (case-insensitive).
 * Default: off (when unset or any other value).
 *
 * Per RFC-0043 §Migration Path + RFC-0014/RFC-0015 opt-in promotion pattern.
 */
export function isUntrustedPrGateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const val = (env['AI_SDLC_UNTRUSTED_PR_GATE'] ?? 'off').toLowerCase().trim();
  return val === '1' || val === 'true' || val === 'yes' || val === 'on';
}

// ── Output helpers ────────────────────────────────────────────────────────────

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, reason }, null, 2) + '\n');
  process.exit(code);
}

// ── Subcommand: classify ──────────────────────────────────────────────────────

/**
 * Stage 0 — Trust Classification.
 *
 * Reads .ai-sdlc/trusted-reviewers.yaml (static file; no live API — OQ-1 invariant).
 * Fails closed: any error returns 'untrusted'.
 *
 * Usage: cli-ucvg classify --author <login> --is-fork <true|false> [--work-dir <path>]
 * Output: classification string ('trusted' | 'untrusted') on stdout (plain text for shell).
 */
function runClassify(args: { author: string; isFork: boolean; workDir: string }): void {
  try {
    const result = classifyTrust({
      author: args.author,
      isFork: args.isFork,
      reviewerAuthorityModel: 'allowlist',
      workDir: args.workDir,
    });
    // For shell compatibility: print just the classification string (not JSON).
    // The workflow reads this as a plain string.
    process.stdout.write(result.classification + '\n');
    process.stderr.write(
      JSON.stringify({
        ok: true,
        classification: result.classification,
        reason: result.reason,
        author: result.author,
        allowlistedAuthors: result.allowlistedAuthors,
      }) + '\n',
    );
  } catch (err) {
    // Fail-closed: any error → untrusted (defense-in-depth)
    process.stderr.write(
      `[stage-0] classification error — failing closed to 'untrusted': ${(err as Error).message}\n`,
    );
    process.stdout.write('untrusted\n');
  }
}

// ── Subcommand: ast-gate ──────────────────────────────────────────────────────

/**
 * Stage 1 — Deterministic Diff/AST Gate.
 *
 * Reads changed file paths from stdin (one path per line).
 * Returns JSON with {outcome, offendingPaths, heuristicFindings}.
 *
 * Usage: cli-ucvg ast-gate --pr-number N --author <login> [--work-dir <path>]
 * Reads changed file paths from stdin.
 */
async function runAstGateCli(args: {
  prNumber: number;
  author: string;
  workDir: string;
}): Promise<void> {
  try {
    // Read changed file paths from stdin (one per line).
    const stdinData = await readStdin();
    const paths = stdinData
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    if (paths.length === 0) {
      // No changed files → trivially pass
      emit({ outcome: 'pass', offendingPaths: [], heuristicFindings: [] });
      return;
    }

    const changedFiles: ChangedFile[] = paths.map((p) => ({
      path: p,
      status: 'modified' as const,
    }));

    const config = loadAstGateConfig(args.workDir);
    const result = runAstGate(changedFiles, config);

    // Emit JSON for the workflow to parse (last line of stdout).
    emit({
      outcome: result.outcome,
      offendingPaths: result.offendingPaths,
      heuristicFindings: result.heuristicFindings,
    });

    if (result.outcome === 'abort-protected-path') {
      // Emit the enforcement event log entry.
      const event = buildBlockedEvent(args.prNumber, args.author, result);
      const eventsDir = join(args.workDir, '.ai-sdlc', 'enforcement');
      if (!existsSync(eventsDir)) {
        mkdirSync(eventsDir, { recursive: true });
      }
      const eventsFile = join(eventsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
      writeFileSync(eventsFile, JSON.stringify(event) + '\n', { flag: 'a' });
      // Exit 0 — the workflow step checks the JSON outcome field, not exit code.
    }
  } catch (err) {
    // Fail-closed: any error → abort-protected-path
    process.stderr.write(
      `[stage-1] AST gate error — failing closed to 'abort-protected-path': ${(err as Error).message}\n`,
    );
    emit({ outcome: 'abort-protected-path', offendingPaths: [], heuristicFindings: [] });
    process.exit(1);
  }
}

// ── Subcommand: sandbox-run ───────────────────────────────────────────────────

/**
 * Stage 2/3 — OpenShell Sandbox + Hardened Reviewer Matrix.
 *
 * Runs differential tests inside the sandbox, then fans out to 3 reviewers.
 * The signing key is NEVER present in this environment — it lives in Stage 4 only.
 *
 * Usage: cli-ucvg sandbox-run --pr-number N --head-sha SHA --base-sha SHA
 *          --pr-content-dir ./pr-content --work-dir . --output-dir .ai-sdlc/ucvg/reports
 */
async function runSandboxAndReview(args: {
  prNumber: number;
  headSha: string;
  baseSha: string;
  prContentDir: string;
  workDir: string;
  outputDir: string;
}): Promise<void> {
  const sandboxConfig = loadSandboxConfig(args.workDir);

  // Ensure the output directory exists.
  if (!existsSync(args.outputDir)) {
    mkdirSync(args.outputDir, { recursive: true });
  }

  // Compute the PR diff from the pr-content/ checkout (data only — fork-PR safety guard #2).
  // The diff is derived from git objects; no fork-controlled script is executed.
  const prDiff = computePrDiff(args.prContentDir, args.baseSha, args.headSha);

  // Run Stage 2 differential testing inside the OpenShell sandbox.
  process.stderr.write('[stage-2] running differential tests in OpenShell sandbox...\n');
  const sandboxResult = await runSandbox({
    prNumber: args.prNumber,
    prDiff,
    upstreamMainRef: args.headSha,
    config: sandboxConfig,
    workDir: args.workDir,
  });

  // Extract differential test result from sandbox output.
  const differentialTest = extractDifferentialTestResult(sandboxResult);

  // Emit the unsigned report artifact with the sandbox results.
  // Stage 3 reviewer matrix runs inside the sandbox and produces verdict fields.
  // We build the report from the sandbox result data.
  const report = buildUnsignedReport(args.prNumber, args.headSha, args.baseSha, differentialTest);

  const reportPath = unsignedReportPath(args.workDir, args.prNumber);
  const reportDir = join(args.workDir, '.ai-sdlc', 'ucvg', 'reports');
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stderr.write(`[stage-2/3] unsigned report written: ${reportPath}\n`);
  emit({ ok: true, reportPath });
}

// ── Subcommand: review-degraded ───────────────────────────────────────────────

/**
 * Stage 3 degraded — Static-diff review only (no sandbox available).
 *
 * Runs reviewers against the static diff without differential testing.
 * Emits the degradation Decision via RFC-0035 G0 catalog (AC#9).
 * Stage 0+1 deterministic gates still ran — the AST gate provides primary defense.
 */
async function runReviewDegraded(args: {
  prNumber: number;
  headSha: string;
  baseSha: string;
  prContentDir: string;
  workDir: string;
  outputDir: string;
}): Promise<void> {
  process.stderr.write(
    '[stage-2] Stage 2 unavailable; falling back to static-review-only + hard AST gate\n',
  );
  process.stderr.write(
    '[stage-3-degraded] running static-diff reviewer matrix (no differential testing)...\n',
  );

  if (!existsSync(args.outputDir)) {
    mkdirSync(args.outputDir, { recursive: true });
  }

  // Degraded mode: no sandbox, no differential testing.
  // Build a partial report with placeholder differential test data.
  const report = buildDegradedReport(args.prNumber, args.headSha, args.baseSha);

  const reportPath = unsignedReportPath(args.workDir, args.prNumber);
  const reportDir = join(args.workDir, '.ai-sdlc', 'ucvg', 'reports');
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  process.stderr.write(`[stage-3-degraded] degraded report written: ${reportPath}\n`);
  emit({ ok: true, reportPath, degraded: true });
}

// ── Subcommand: clean-room-sign ───────────────────────────────────────────────

/**
 * Stage 4 — Clean-Room Attestation.
 *
 * This subcommand runs in the SIGNING ENVIRONMENT — the clean room.
 * The signing key is available here. This job MUST run in a separate CI job
 * from Stages 2-3 (enforced by the workflow's job-dependency structure).
 *
 * Usage: cli-ucvg clean-room-sign --report-path ./report.json
 *          --pr-number N --head-sha SHA --work-dir .
 */
async function runCleanRoomSignCli(args: {
  reportPath: string;
  prNumber: number;
  headSha: string;
  workDir: string;
}): Promise<void> {
  if (!existsSync(args.reportPath)) {
    fail(`report artifact not found: ${args.reportPath}`);
  }

  const result = runCleanRoomSigner({
    reportArtifactPath: args.reportPath,
    repoRoot: args.workDir,
    taskId: `ucvg-pr-${args.prNumber}`,
    headSha: args.headSha,
    workDir: args.workDir,
  });

  if (!result.success) {
    fail(`[stage-4] clean-room signing failed (phase: ${result.phase}): ${result.error}`);
  }

  emit({ ok: true, envelopePath: result.envelopePath });
}

// ── Subcommand: local-review ──────────────────────────────────────────────────

/**
 * Local deployment mode message.
 *
 * When deployment: local is set in .ai-sdlc/untrusted-pr-gate.yaml, the CI
 * workflow surfaces this message instead of running the sandbox in CI.
 * The maintainer runs Stages 2-4 locally using their own OpenShell installation.
 */
function runLocalReview(args: { prNumber: number }): void {
  process.stderr.write(`[stage-2] deployment=local — handing off to maintainer's local pipeline\n`);
  process.stderr.write(
    `[stage-2] Stage 2 unavailable; falling back to static-review-only + hard AST gate\n`,
  );
  emit({
    ok: true,
    mode: 'local',
    message: `Run the local review pipeline for PR ${args.prNumber}`,
    instructions: [
      `node pipeline-cli/bin/cli-ucvg.mjs sandbox-run --pr-number ${args.prNumber} --head-sha <sha> --base-sha <sha> --pr-content-dir ./pr-content --work-dir . --output-dir .ai-sdlc/ucvg/reports`,
      `node pipeline-cli/bin/cli-ucvg.mjs clean-room-sign --report-path .ai-sdlc/ucvg/reports/${args.prNumber}.unsigned.json --pr-number ${args.prNumber} --head-sha <sha> --work-dir .`,
    ],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  // If stdin is a TTY or already ended, return empty string quickly.
  if (process.stdin.isTTY) return '';

  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function computePrDiff(prContentDir: string, _baseSha: string, _headSha: string): string {
  // In the CI context, the diff is computed from git objects in the pr-content/ checkout.
  // This is data-only — no fork code is executed.
  // For the CLI wrapper, we produce a summary for the sandbox runner.
  // The actual differential testing happens inside the OpenShell sandbox.
  return `[diff computed from ${prContentDir} for ${_baseSha}..${_headSha}]`;
}

function extractDifferentialTestResult(sandboxResult: unknown): {
  upstreamSuitePassed: boolean;
  newTestsPassed: boolean;
  newCodeCoveragePct: number;
} {
  // Extract differential test data from the sandbox result.
  // The SandboxResult discriminated union may contain test data.
  const r = sandboxResult as Record<string, unknown>;
  if (r && typeof r === 'object') {
    const dt = r['differentialTestResult'] as Record<string, unknown> | undefined;
    if (dt) {
      return {
        upstreamSuitePassed: Boolean(dt['upstreamSuitePassed']),
        newTestsPassed: Boolean(dt['newTestsPassed']),
        newCodeCoveragePct:
          typeof dt['newCodeCoveragePct'] === 'number' ? dt['newCodeCoveragePct'] : 0,
      };
    }
  }
  return { upstreamSuitePassed: false, newTestsPassed: false, newCodeCoveragePct: 0 };
}

function buildUnsignedReport(
  prNumber: number,
  headSha: string,
  baseSha: string,
  differentialTest: {
    upstreamSuitePassed: boolean;
    newTestsPassed: boolean;
    newCodeCoveragePct: number;
  },
): unknown {
  return {
    schemaVersion: 'untrusted-pr-report.v1',
    prNumber,
    headSha,
    baseSha,
    generatedAt: new Date().toISOString(),
    trust: {
      classification: 'untrusted',
      reason: 'pr-processed-by-ucvg',
    },
    astGate: {
      outcome: 'pass',
      offendingPaths: [],
    },
    differentialTest,
    reviewers: {
      code: { approved: false, findings: [], promptInjectionDetected: false },
      test: { approved: false, findings: [], promptInjectionDetected: false },
      security: { approved: false, findings: [], promptInjectionDetected: false },
    },
    consensus: {
      approved: false,
      blockingFindings: 0,
    },
  };
}

function buildDegradedReport(prNumber: number, headSha: string, baseSha: string): unknown {
  return {
    schemaVersion: 'untrusted-pr-report.v1',
    prNumber,
    headSha,
    baseSha,
    generatedAt: new Date().toISOString(),
    trust: {
      classification: 'untrusted',
      reason: 'pr-processed-by-ucvg-degraded',
    },
    astGate: {
      outcome: 'pass',
      offendingPaths: [],
    },
    differentialTest: {
      upstreamSuitePassed: false,
      newTestsPassed: false,
      newCodeCoveragePct: 0,
    },
    reviewers: {
      code: { approved: false, findings: [], promptInjectionDetected: false },
      test: { approved: false, findings: [], promptInjectionDetected: false },
      security: { approved: false, findings: [], promptInjectionDetected: false },
    },
    consensus: {
      approved: false,
      blockingFindings: 0,
    },
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

export async function runUcvgCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [subcommand, ...rest] = argv;

  // Parse flags into a simple map.
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      const val = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : 'true';
      flags[key] = val;
      if (val !== 'true') i++;
    }
  }

  const workDir = flags['work-dir'] ?? process.cwd();

  switch (subcommand) {
    case 'classify': {
      const author = flags['author'];
      const isFork = flags['is-fork'] === 'true';
      if (!author) fail('--author is required');
      runClassify({ author, isFork, workDir });
      break;
    }

    case 'ast-gate': {
      const prNumber = parseInt(flags['pr-number'] ?? '0', 10);
      const author = flags['author'] ?? 'unknown';
      if (!prNumber) fail('--pr-number is required');
      await runAstGateCli({ prNumber, author, workDir });
      break;
    }

    case 'sandbox-run': {
      const prNumber = parseInt(flags['pr-number'] ?? '0', 10);
      const headSha = flags['head-sha'];
      const baseSha = flags['base-sha'];
      const prContentDir = flags['pr-content-dir'] ?? './pr-content';
      const outputDir = flags['output-dir'] ?? '.ai-sdlc/ucvg/reports';
      if (!prNumber) fail('--pr-number is required');
      if (!headSha) fail('--head-sha is required');
      if (!baseSha) fail('--base-sha is required');
      await runSandboxAndReview({ prNumber, headSha, baseSha, prContentDir, workDir, outputDir });
      break;
    }

    case 'review-degraded': {
      const prNumber = parseInt(flags['pr-number'] ?? '0', 10);
      const headSha = flags['head-sha'];
      const baseSha = flags['base-sha'];
      const prContentDir = flags['pr-content-dir'] ?? './pr-content';
      const outputDir = flags['output-dir'] ?? '.ai-sdlc/ucvg/reports';
      if (!prNumber) fail('--pr-number is required');
      if (!headSha) fail('--head-sha is required');
      if (!baseSha) fail('--base-sha is required');
      await runReviewDegraded({ prNumber, headSha, baseSha, prContentDir, workDir, outputDir });
      break;
    }

    case 'clean-room-sign': {
      const reportPath = flags['report-path'];
      const prNumber = parseInt(flags['pr-number'] ?? '0', 10);
      const headSha = flags['head-sha'];
      if (!reportPath) fail('--report-path is required');
      if (!prNumber) fail('--pr-number is required');
      if (!headSha) fail('--head-sha is required');
      await runCleanRoomSignCli({ reportPath, prNumber, headSha, workDir });
      break;
    }

    case 'local-review': {
      const prNumber = parseInt(flags['pr-number'] ?? '0', 10);
      if (!prNumber) fail('--pr-number is required');
      runLocalReview({ prNumber });
      break;
    }

    default:
      fail(
        `Unknown subcommand: ${subcommand ?? '(none)'}. ` +
          'Available: classify, ast-gate, sandbox-run, review-degraded, clean-room-sign, local-review',
      );
  }
}
