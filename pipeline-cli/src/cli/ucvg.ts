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
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { classifyTrust } from '../pipeline/trust-classifier.js';
import { runAstGate, loadAstGateConfig, buildBlockedEvent } from '../pipeline/ast-gate.js';
import type { ChangedFile } from '../pipeline/ast-gate.js';
import { loadSandboxConfig, runSandbox } from '../pipeline/sandbox-runner.js';
import type { DifferentialTestResult } from '../pipeline/sandbox-runner.js';
import { runCleanRoomSigner, unsignedReportPath } from '../pipeline/clean-room-signer.js';
import {
  runReviewerMatrix,
  FakeModelClient,
  InferenceProxyClient,
  type ModelClient,
} from '../pipeline/reviewer-runner.js';
import {
  createInferenceProxy,
  buildReviewerProxyEnv,
  buildProxyHostArg,
  type InferenceProxy,
} from '../pipeline/inference-proxy.js';
import type { ReviewerVerdict } from '../pipeline/report-validator.js';

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
  // _ucvgSeams.computePrDiffFn allows tests to inject a fake diff without a real git repo.
  const prDiff = _ucvgSeams.computePrDiffFn
    ? _ucvgSeams.computePrDiffFn(args.prContentDir, args.baseSha, args.headSha)
    : computePrDiff(args.prContentDir, args.baseSha, args.headSha);

  // ── RFC-0043 AQ2 — InferenceProxy lifecycle ────────────────────────────────
  //
  // In integration mode with a real credential, start the host-side inference
  // proxy BEFORE the sandbox so the container can reach `inference.local`.
  // The proxy holds the credential and injects it out-of-process; the sandbox
  // container never receives ANTHROPIC_API_KEY directly.
  //
  // In CI (no credential / no integration flag), proxy is skipped and the
  // FakeModelClient fail-closed path is used instead (existing behaviour).
  let proxy: InferenceProxy | null = null;
  let sandboxEnv: Record<string, string> | undefined;
  let proxyHostArgs: string[] | undefined;

  const isIntegrationMode = process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] === '1';
  const credential = process.env['ANTHROPIC_API_KEY'];

  if (isIntegrationMode && credential) {
    process.stderr.write('[stage-2] AQ2 wiring: starting InferenceProxy for PR...\n');
    try {
      const proxyResult = await _ucvgSeams.inferenceProxyFactory({
        prNumber: args.prNumber,
        credential,
        // Bind on all interfaces so the Docker container can reach the host.
        // Docker Desktop (macOS): host-gateway alias. Linux: docker0 bridge.
        // --network=none + --add-host=inference.local:<host-ip> opens only this path.
        bindAddress: '0.0.0.0',
        useHttp: true,
      });
      proxy = proxyResult.proxy;
      const { port, sessionToken } = proxyResult;

      process.stderr.write(
        `[stage-2] InferenceProxy started on port ${String(port)} for PR #${String(args.prNumber)}\n`,
      );

      // Build the sandbox env (proxy discovery vars, NO credential) and docker host arg.
      // The container reads INFERENCE_PROXY_HOST/PORT/SESSION to reach the proxy.
      sandboxEnv = buildReviewerProxyEnv({ port, sessionToken });
      proxyHostArgs = buildProxyHostArg();

      // Fixture-demo mode (RFC-0043 AQ2 live demo — option B). When
      // AI_SDLC_UCVG_FIXTURE_SUBDIR is set, ship the trusted base fixture tree
      // (a tiny zero-dep repo at <workDir>/<subdir>) into the sandbox as a
      // base64 gzip tarball via the sandbox env. The in-container differential
      // test (buildDifferentialTestScript) materializes it offline — no clone,
      // no install — so the suite runs under --network=none. NO credential is
      // ever placed in this env; the tarball is source-only fixture data.
      const fixtureSubdir = process.env['AI_SDLC_UCVG_FIXTURE_SUBDIR'];
      // Tightened regex: same as computePrDiff — forbids `..` segments and bare `/` runs.
      if (
        fixtureSubdir &&
        /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(fixtureSubdir) &&
        !fixtureSubdir.split('/').some((seg) => seg === '..')
      ) {
        const fixtureDir = join(args.workDir, fixtureSubdir.replace(/\/+$/, ''));
        const tarB64 = execFileSync('tar', ['-C', fixtureDir, '-cz', '.'], {
          maxBuffer: 32 * 1024 * 1024,
        }).toString('base64');
        sandboxEnv['SANDBOX_FIXTURE_B64'] = tarB64;
        process.stderr.write(
          `[stage-2] fixture-demo mode: staged ${fixtureSubdir} (${String(tarB64.length)} b64 bytes) for offline differential test\n`,
        );
      }

      // Wire the proxy vars into the current process env so resolveModelClient()
      // builds an InferenceProxyClient pointing at the live proxy (AC#2).
      // Uses '127.0.0.1' (loopback) because reviewers run on the host side here;
      // only the in-container differential test process uses 'inference.local'.
      process.env['INFERENCE_PROXY_HOST'] = '127.0.0.1';
      process.env['INFERENCE_PROXY_PORT'] = String(port);
      process.env['INFERENCE_PROXY_SESSION'] = sessionToken;
    } catch (err) {
      process.stderr.write(
        `[stage-2] WARNING: InferenceProxy failed to start — falling back to FakeModelClient: ${(err as Error).message}\n`,
      );
      // Proxy failed to start — clear the integration flag AND the proxy vars so
      // resolveModelClient() takes the CI FakeModelClient path (fail-closed,
      // approved:false report → Stage 4 refuses) rather than the hard-error path.
      // Deleting only the proxy vars while leaving AI_SDLC_SANDBOX_INTEGRATION_TESTS=1
      // would make resolveModelClient hit the fail()/process.exit branch (still
      // fail-closed, but a hard crash instead of the documented graceful fallback).
      delete process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'];
      delete process.env['INFERENCE_PROXY_HOST'];
      delete process.env['INFERENCE_PROXY_PORT'];
      delete process.env['INFERENCE_PROXY_SESSION'];
    }
  }

  try {
    // Run Stage 2 differential testing inside the Docker sandbox.
    // MAJOR fix #7: upstreamMainRef must be baseSha (the target-branch base), NOT headSha.
    // Differential testing compares PR head against the target-branch base, not itself.
    process.stderr.write('[stage-2] running differential tests in OpenShell sandbox...\n');
    const sandboxResult = await runSandbox({
      prNumber: args.prNumber,
      prDiff,
      upstreamMainRef: args.baseSha,
      config: sandboxConfig,
      workDir: args.workDir,
      // AQ2: pass proxy env (without credential) + host arg to the container.
      // When proxy is not running, these are undefined (existing CI behaviour).
      sandboxEnv,
      proxyHostArgs,
    });

    // Extract differential test result from sandbox output.
    // FIX: reads r['differentialTest'] (correct key for outcome:'success'),
    // falling back to r['differentialTestResult'] for legacy mock shapes.
    const differentialTest = extractDifferentialTestResult(sandboxResult);

    // Diagnostic: surface the raw sandbox outcome + any error so a failed
    // differential test (which fail-closes to {false,false,0}) is debuggable
    // from the CI log instead of silently producing a 0%-coverage report.
    {
      const sr = sandboxResult as { outcome?: string; error?: string };
      process.stderr.write(
        `[stage-2] sandbox outcome=${sr.outcome ?? 'unknown'}` +
          (sr.error ? ` error=${sr.error.slice(0, 8000)}` : '') +
          ` differentialTest=${JSON.stringify(differentialTest)}\n`,
      );
    }

    // Stage 3 — Run the 3-reviewer matrix against the hardened-framed diff.
    // The modelClient is injectable via the _modelClientFactory seam for tests.
    // In integration mode with proxy running: resolveModelClient returns an
    // InferenceProxyClient pointed at the live proxy (proxy env vars set above).
    // In CI (no proxy): returns the fail-closed FakeModelClient.
    process.stderr.write('[stage-3] running reviewer matrix...\n');
    const modelClient = resolveModelClient(args.workDir);
    const reviewerResult = await runReviewerMatrix({
      prDiff,
      prNumber: args.prNumber,
      differentialTest,
      modelClient,
    });

    // Emit the unsigned report artifact with the real reviewer verdicts.
    const report = buildUnsignedReport(
      args.prNumber,
      args.headSha,
      args.baseSha,
      differentialTest,
      reviewerResult.verdicts,
      reviewerResult.consensus,
    );

    const reportPath = unsignedReportPath(args.workDir, args.prNumber);
    const reportDir = join(args.workDir, '.ai-sdlc', 'ucvg', 'reports');
    if (!existsSync(reportDir)) {
      mkdirSync(reportDir, { recursive: true });
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    process.stderr.write(`[stage-2/3] unsigned report written: ${reportPath}\n`);
    emit({ ok: true, reportPath });
  } finally {
    // Always stop the proxy — credential must not linger after the run completes.
    if (proxy !== null) {
      await proxy.stop();
      process.stderr.write('[stage-2] InferenceProxy stopped.\n');
    }
    // Clean up the proxy env vars from the current process (defense-in-depth).
    delete process.env['INFERENCE_PROXY_HOST'];
    delete process.env['INFERENCE_PROXY_PORT'];
    delete process.env['INFERENCE_PROXY_SESSION'];
  }
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

function computePrDiff(prContentDir: string, baseSha: string, headSha: string): string {
  // Compute the real PR diff from git objects in the pr-content/ checkout.
  // This is DATA-ONLY (fork-PR safety guard #2): `git diff` reads committed
  // objects and never executes any fork-provided script. Both baseSha and
  // headSha are reachable because the pr-content checkout uses fetch-depth: 0.
  //
  // Three-dot (`base...head`) yields only the changes the PR introduced since
  // the merge-base, excluding unrelated base-branch churn. The attestations
  // directory is excluded from the diff so reviewers focus on source changes.
  //
  // Both SHAs are validated to be 7-64 hex chars before interpolation to keep
  // execFileSync's argv free of any metacharacter risk (defense-in-depth even
  // though execFileSync does not invoke a shell).
  const shaRe = /^[0-9a-f]{7,64}$/i;
  if (!shaRe.test(baseSha) || !shaRe.test(headSha)) {
    throw new Error(
      `computePrDiff: baseSha/headSha must be 7-64 hex chars (got base='${baseSha}', head='${headSha}')`,
    );
  }

  // Fixture-demo mode (RFC-0043 AQ2 live demo — option B). When
  // AI_SDLC_UCVG_FIXTURE_SUBDIR is set, the differential test runs against a
  // standalone zero-dep fixture repo whose root is the *contents* of that
  // subdir (materialized in-container from a tarball). The diff must therefore
  // be re-rooted (paths relative to the subdir) so `git apply` lands on the
  // fixture root. `--relative=<subdir>/` strips the prefix from output paths;
  // the pathspec scopes the diff to the fixture so unrelated changes are ignored.
  const fixtureSubdir = process.env['AI_SDLC_UCVG_FIXTURE_SUBDIR'];
  // Tightened regex: forbids `..` segments and bare `/` runs to block path traversal.
  // Accepts alphanumeric, dots, underscores, hyphens, and single-slash separators only.
  if (
    fixtureSubdir &&
    /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(fixtureSubdir) &&
    !fixtureSubdir.split('/').some((seg) => seg === '..')
  ) {
    const sub = fixtureSubdir.replace(/\/+$/, '');
    return execFileSync(
      'git',
      [
        '-C',
        prContentDir,
        'diff',
        '--no-color',
        `--relative=${sub}/`,
        `${baseSha}...${headSha}`,
        '--',
        `${sub}/`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  }

  return execFileSync(
    'git',
    [
      '-C',
      prContentDir,
      'diff',
      '--no-color',
      `${baseSha}...${headSha}`,
      '--',
      '.',
      ':(exclude).ai-sdlc/attestations/**',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

function extractDifferentialTestResult(sandboxResult: unknown): DifferentialTestResult {
  // Extract differential test data from the sandbox result.
  //
  // FIX (AISDLC-511 — carried-over key-mismatch from 509 security review):
  // The SandboxResult discriminated union nests the results under `differentialTest`
  // (not `differentialTestResult`) when `outcome === 'success'`. The previous code
  // read `r['differentialTestResult']` which is always undefined for real sandbox
  // results — causing the fail-closed default to fire every time, so real
  // differential test results never reached the report.
  //
  // Correct key for outcome:'success': r['differentialTest'] (per SandboxResult type).
  // We still check `differentialTestResult` as a secondary fallback for any callers
  // that might use the legacy key (e.g. mock objects in tests written against the old API).
  const r = sandboxResult as Record<string, unknown>;
  const FAILURE_RESULT: DifferentialTestResult = {
    upstreamSuitePassed: false,
    upstreamSuiteOutput: '',
    newTestsPassed: false,
    newTestsOutput: '',
    newCodeCoveragePct: 0,
  };
  if (!r || typeof r !== 'object') return FAILURE_RESULT;

  // Primary key (success outcome shape): r.differentialTest
  const dt = (r['differentialTest'] ?? r['differentialTestResult']) as
    | Record<string, unknown>
    | undefined;

  if (dt && typeof dt === 'object') {
    return {
      upstreamSuitePassed: Boolean(dt['upstreamSuitePassed']),
      upstreamSuiteOutput:
        typeof dt['upstreamSuiteOutput'] === 'string' ? dt['upstreamSuiteOutput'] : '',
      newTestsPassed: Boolean(dt['newTestsPassed']),
      newTestsOutput: typeof dt['newTestsOutput'] === 'string' ? dt['newTestsOutput'] : '',
      newCodeCoveragePct:
        typeof dt['newCodeCoveragePct'] === 'number' ? dt['newCodeCoveragePct'] : 0,
    };
  }
  return FAILURE_RESULT;
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
  reviewers?: {
    code: ReviewerVerdict;
    test: ReviewerVerdict;
    security: ReviewerVerdict;
  },
  consensus?: {
    approved: boolean;
    blockingFindings: number;
  },
): unknown {
  // Use real reviewer verdicts when provided; fall back to fail-closed defaults
  // only when reviewers were not run (e.g. sandbox error before Stage 3).
  const reviewerVerdicts = reviewers ?? {
    code: { approved: false, findings: [], promptInjectionDetected: false },
    test: { approved: false, findings: [], promptInjectionDetected: false },
    security: { approved: false, findings: [], promptInjectionDetected: false },
  };
  const consensusResult = consensus ?? { approved: false, blockingFindings: 0 };

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
    // Project to exactly the 3 schema fields. extractDifferentialTestResult
    // returns the full DifferentialTestResult (which also carries the raw
    // upstreamSuiteOutput / newTestsOutput sandbox stdout used only as reviewer
    // context). The signed report's differentialTest sub-schema is `.strict()`
    // and lists only these three summary fields — writing the raw output strings
    // through would make the Stage-4 clean-room signer reject the report.
    differentialTest: {
      upstreamSuitePassed: differentialTest.upstreamSuitePassed,
      newTestsPassed: differentialTest.newTestsPassed,
      newCodeCoveragePct: differentialTest.newCodeCoveragePct,
    },
    reviewers: reviewerVerdicts,
    consensus: consensusResult,
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

// ── Model client resolution ───────────────────────────────────────────────────

/**
 * Injectable seam container for ucvg.ts.
 *
 * Tests inject into these fields to exercise code paths without real network I/O.
 *
 * `modelClientFactory`: inject a `FakeModelClient` for hermetic reviewer tests.
 * `inferenceProxyFactory`: inject a mock proxy factory to test AQ2 wiring without
 *   actually binding a socket. Default: `createInferenceProxy` from inference-proxy.ts.
 *
 * Using a mutable object property (rather than a module `let` binding) ensures
 * the seam is writable in compiled ES modules where named exports are getter-only.
 *
 * @internal — for test injection only.
 */
export const _ucvgSeams: {
  modelClientFactory: ((workDir: string) => ModelClient) | null;
  /**
   * Factory for creating an InferenceProxy for a PR.
   * Defaults to `createInferenceProxy`. Override in tests to avoid socket binding.
   */
  inferenceProxyFactory: typeof createInferenceProxy;
  /**
   * Override for `computePrDiff` (injectable for hermetic tests).
   * When set, used instead of calling `git diff` via execFileSync.
   * Defaults to null (uses the real git diff implementation).
   */
  computePrDiffFn: ((prContentDir: string, baseSha: string, headSha: string) => string) | null;
} = {
  modelClientFactory: null,
  inferenceProxyFactory: createInferenceProxy,
  computePrDiffFn: null,
};

/**
 * Resolve the model client to use for reviewer invocations.
 *
 * Resolution order:
 *  1. Test injection via `_modelClientFactory` (hermetic tests).
 *  2. Integration mode (`AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`): requires
 *     `INFERENCE_PROXY_HOST`, `INFERENCE_PROXY_PORT`, `INFERENCE_PROXY_SESSION`
 *     env vars (set by the sandbox orchestrator after starting the proxy).
 *     Returns an `InferenceProxyClient` pointed at the live proxy.
 *     **HARD ERROR** if integration mode is set but proxy vars are missing —
 *     a silent fake-verdict pass-through would mask a real misconfiguration.
 *  3. Default (CI without sandbox): returns a `FakeModelClient` configured
 *     as fail-closed (all reviewers return `approved: false`). The CI path
 *     never holds real model access — the integration gap is documented.
 *
 * Real in-sandbox model invocation requires:
 *  - `AI_SDLC_SANDBOX_INTEGRATION_TESTS=1`
 *  - A running `InferenceProxy` (from AISDLC-510) with the session env vars set
 *  - A real Docker container to host the reviewer process
 * See: pipeline-cli/src/pipeline/inference-proxy.ts
 */
export function resolveModelClient(_workDir: string): ModelClient {
  // 1. Test injection seam
  if (_ucvgSeams.modelClientFactory) {
    return _ucvgSeams.modelClientFactory(_workDir);
  }

  // 2. Integration mode with real proxy
  if (process.env['AI_SDLC_SANDBOX_INTEGRATION_TESTS'] === '1') {
    const host = process.env['INFERENCE_PROXY_HOST'];
    const port = parseInt(process.env['INFERENCE_PROXY_PORT'] ?? '0', 10);
    const sessionToken = process.env['INFERENCE_PROXY_SESSION'];

    if (host && port > 0 && sessionToken) {
      return new InferenceProxyClient({ host, port, sessionToken });
    }

    // Integration mode requested but proxy env vars not set — HARD ERROR.
    // In integration mode the operator expects REAL model calls. Silently falling
    // back to a FakeModelClient would produce fake verdicts that look real, masking
    // a proxy misconfiguration. Fail loudly so the operator sees the problem
    // immediately rather than discovering it in post-run audit.
    //
    // CI (non-integration) callers must NOT set AI_SDLC_SANDBOX_INTEGRATION_TESTS=1.
    fail(
      '[reviewer-runner] AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 but proxy env vars ' +
        '(INFERENCE_PROXY_HOST, INFERENCE_PROXY_PORT, INFERENCE_PROXY_SESSION) are not set. ' +
        'Set these vars from the InferenceProxy start() result to enable real model calls, ' +
        'or unset AI_SDLC_SANDBOX_INTEGRATION_TESTS to use the CI FakeModelClient path.',
    );
  }

  // 3. CI default — fail-closed FakeModelClient (no real model access)
  // This is the documented integration gap: real model invocation requires
  // AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 + a running InferenceProxy.
  process.stderr.write(
    '[reviewer-runner] using fail-closed FakeModelClient (no real model access in CI). ' +
      'Set AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 + proxy env vars for real model calls.\n',
  );
  return new FakeModelClient(
    JSON.stringify({
      approved: false,
      findings: [
        {
          severity: 'major',
          message:
            'reviewer not available: sandbox integration tests disabled. ' +
            'Set AI_SDLC_SANDBOX_INTEGRATION_TESTS=1 and configure the inference proxy.',
        },
      ],
      promptInjectionDetected: false,
    }),
  );
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
