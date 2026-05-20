/**
 * `cli-quality` — operator-facing CLI for the RFC-0025 quality monitoring
 * surface. Phase 6 / AISDLC-307.
 *
 * Subcommands:
 *   report-upstream <bug-id>   — render a pre-filled GitHub issue for an
 *                                upstream framework-bug capture (OQ-5).
 *
 * Sister CLI to `cli-quality-corpus` (which aggregates the capture corpus
 * into self-improvement metrics).
 *
 * OQ-5 design (resolved 2026-05-15): pre-generated issue body, no
 * telemetry pipeline. The operator reviews + submits manually via the
 * browser; the framework's only role is rendering + URL construction.
 *
 * Usage:
 *   $ cli-quality report-upstream framework-bug-framework-contract-violated-20260516T1200
 *   $ cli-quality report-upstream <bug-id> --repo-url https://github.com/org/repo
 *   $ cli-quality report-upstream <bug-id> --print     # don't open browser; print to stdout
 *   $ cli-quality report-upstream <bug-id> --format json
 *
 * Resolution order for `repoUrl`:
 *   1. `--repo-url` CLI flag
 *   2. `quality.upstream-reporting.repoUrl` in `.ai-sdlc/quality-monitoring.yaml`
 *   3. Hard error (operator instructed to set one or pass the flag)
 *
 * @module cli/quality
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { loadQualityMonitoringConfig } from '../tui/analytics/quality-monitoring-config.js';
import {
  UpstreamReportError,
  buildUpstreamReport,
  openInBrowser,
} from '../tui/analytics/upstream-reporter.js';

// ── Output helpers ────────────────────────────────────────────────────

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

// ── report-upstream handler (pure for tests) ─────────────────────────

export interface ReportUpstreamArgs {
  bugId: string;
  repoUrl?: string;
  workDir?: string;
  artifactsDir?: string;
  templatePath?: string;
  /** Skip browser open; render-only. */
  print?: boolean;
  format?: 'json' | 'text';
}

export interface ReportUpstreamResult {
  captureId: string;
  url: string;
  title: string;
  body: string;
  browserOpened: boolean;
}

/**
 * Pure entry point for `cli-quality report-upstream`. The CLI router
 * thin-wraps this — tests should drive this directly with a workdir +
 * artifacts dir.
 *
 * Resolves `repoUrl` from (1) the explicit arg, (2) `quality-monitoring.yaml`,
 * (3) hard error. Always renders the issue body; browser-open is gated by
 * `print` (when true, skip the open).
 */
export function runReportUpstream(args: ReportUpstreamArgs): ReportUpstreamResult {
  let repoUrl = args.repoUrl;
  let templatePath = args.templatePath;
  if (!repoUrl || !templatePath) {
    // Load adopter config to fill defaults
    const cfg = loadQualityMonitoringConfig({ workDir: args.workDir });
    if (!repoUrl) repoUrl = cfg.upstreamReporting.repoUrl;
    if (!templatePath) templatePath = cfg.upstreamReporting.prefilledIssueTemplate;
  }

  if (!repoUrl) {
    throw new UpstreamReportError(
      'repoUrl is required. Set `quality.upstream-reporting.repoUrl` in `.ai-sdlc/quality-monitoring.yaml` ' +
        "or pass --repo-url 'https://github.com/<org>/<repo>'.",
    );
  }

  const report = buildUpstreamReport(args.bugId, {
    repoUrl,
    workDir: args.workDir,
    artifactsDir: args.artifactsDir,
    templatePath,
  });

  let browserOpened = false;
  if (!args.print) {
    browserOpened = openInBrowser(report.url);
  }

  return { ...report, browserOpened };
}

// ── CLI router ────────────────────────────────────────────────────────

export function buildQualityCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-quality')
    .usage('Usage: $0 <command> [options]')
    .command(
      'report-upstream <bug-id>',
      'Render a pre-filled GitHub issue for an upstream framework-bug capture (RFC-0025 §13 OQ-5).',
      (y) =>
        y
          .positional('bug-id', {
            type: 'string',
            demandOption: true,
            describe:
              'Capture id (e.g. `framework-bug-framework-contract-violated-20260516T1200`). ' +
              'Use `cli-quality-corpus aggregate --format table` to list available captures.',
          })
          .option('repo-url', {
            type: 'string',
            describe:
              'Upstream repo URL (e.g. https://github.com/ai-sdlc-framework/ai-sdlc). ' +
              'Falls back to `quality.upstream-reporting.repoUrl` in `.ai-sdlc/quality-monitoring.yaml`.',
          })
          .option('work-dir', {
            type: 'string',
            describe: 'Project root used to locate the config + template. Defaults to cwd.',
          })
          .option('artifacts-dir', {
            type: 'string',
            describe:
              'Override the $ARTIFACTS_DIR path. Defaults to the ARTIFACTS_DIR env var or `./artifacts`.',
          })
          .option('template', {
            type: 'string',
            describe:
              'Override the issue body template path. Falls back to the config + then to the built-in template.',
          })
          .option('print', {
            type: 'boolean',
            default: false,
            describe: "Don't open the browser; print the URL + body to stdout only.",
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'text' as const,
            describe: "Output format for --print mode: 'json' or 'text' (default).",
          }),
      (argv) => {
        let result: ReportUpstreamResult;
        try {
          result = runReportUpstream({
            bugId: String(argv['bug-id']),
            repoUrl: argv['repo-url'] as string | undefined,
            workDir: argv['work-dir'] as string | undefined,
            artifactsDir: argv['artifacts-dir'] as string | undefined,
            templatePath: argv.template as string | undefined,
            print: Boolean(argv.print),
            format: argv.format as 'json' | 'text',
          });
        } catch (err) {
          if (err instanceof UpstreamReportError) {
            process.stderr.write(`[cli-quality] ${err.message}\n`);
            process.exit(1);
          }
          throw err;
        }

        if (argv.format === 'json') {
          emit(result);
          return;
        }

        // Text mode — operator-friendly
        emitText(`Capture: ${result.captureId}`);
        emitText(`Title:   ${result.title}`);
        emitText('');
        emitText(`URL:`);
        emitText(`  ${result.url}`);
        emitText('');
        if (argv.print) {
          emitText('---- BODY ----');
          emitText(result.body);
          emitText('---- END ----');
        } else if (result.browserOpened) {
          emitText('(opened in browser; review + submit manually — no telemetry was sent)');
        } else {
          emitText('(browser open failed; copy the URL above and paste into your browser)');
        }
      },
    )
    .demandCommand(1, 'A subcommand is required (currently: report-upstream). Run with --help.')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runQualityCli(): Promise<void> {
  await buildQualityCli().parseAsync();
}
