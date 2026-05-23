/**
 * `cli-estimate` subcommand router — RFC-0016 Phase 1-6 (AISDLC-279..284).
 *
 * Subcommands:
 *  - `stage-a <task-id>`   — emit Stage A signals + candidate bucket.
 *  - `show <class>`        — per-class bias stats + Stage A/B accuracy (Phase 5).
 *  - `render-pr-comment`   — render the `<!-- ai-sdlc:estimate -->` comment body (Phase 5).
 *  - `digest`              — weekly calibration digest across all classes
 *                            including Stage-A-coverage rate (Phase 6 AC #2, #3).
 *
 * Output is JSON on stdout by default; pass `--format table` for a
 * human-readable column layout. Behind feature flag
 * `AI_SDLC_ESTIMATION_CALIBRATION=experimental` — when disabled the CLI
 * degrades open (prints the disabled message + exits 0) rather than
 * failing, so scripted callers that always pipe through `cli-estimate`
 * don't break when the flag is off.
 *
 * @module cli/estimate
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  ESTIMATION_FLAG,
  estimationDisabledMessage,
  isEstimationEnabled,
} from '../estimation/feature-flag.js';
import { captureEstimate } from '../estimation/log-writer.js';
import { runStageA } from '../estimation/stage-a.js';
import type { SignalOutput, StageAResult, TaskClass } from '../estimation/types.js';
import { TASK_CLASSES } from '../estimation/types.js';
import { computeBiasStats, computeStageAVsStageBAccuracy } from '../estimation/bias.js';
import { readEstimateLog } from '../estimation/log-writer.js';
import { listCalibrationFiles, queryHistoricalActuals } from '../estimation/calibration-writer.js';
import { renderEstimateComment } from '../estimation/pr-comment.js';
import { generateDigest, formatDigestText } from '../estimation/digest.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTaskFile, parseTaskFile } from '../steps/01-validate.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(JSON.stringify({ ok: false, reason }, null, 2) + '\n');
  process.exit(code);
}

/**
 * Render the §5.3 signal table to plain text. Same column-padding
 * idiom as `cli-deps` / `cli-dor-stats` — kept inline so we don't pull
 * in a table dependency for one CLI.
 */
function renderSignalTable(signals: readonly SignalOutput[]): string {
  const headers = ['#', 'signal', 'result', 'detail'];
  const rows: string[][] = signals.map((s) => {
    let result: string;
    let detail: string;
    switch (s.result.kind) {
      case 'bucket':
        result = s.result.bucket;
        detail = formatInputs(s.inputs);
        break;
      case 'range':
        result = `${s.result.low}-${s.result.high}`;
        detail = formatInputs(s.inputs);
        break;
      case 'bump':
        result = s.result.delta > 0 ? `+${s.result.delta} bump` : 'no bump';
        detail = formatInputs(s.inputs);
        break;
      case 'unknown':
        result = 'unknown';
        detail = s.result.reason;
        break;
    }
    return [String(s.id), s.name, result, detail];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const out: string[] = [fmt(headers), sep];
  for (const r of rows) out.push(fmt(r));
  return out.join('\n') + '\n';
}

function formatInputs(inputs: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(inputs)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      pairs.push(`${k}=${JSON.stringify(v)}`);
    } else {
      pairs.push(`${k}=${String(v)}`);
    }
  }
  return pairs.join(' ');
}

function renderResult(result: StageAResult): string {
  const lines: string[] = [];
  lines.push(`Task:        ${result.taskId}`);
  lines.push(`Class:       ${result.taskClass} (source: ${result.classSource})`);
  const bucketDisplay = result.candidateRange
    ? `${result.candidateRange.low}-${result.candidateRange.high}`
    : result.candidateBucket;
  lines.push(`Bucket:      ${bucketDisplay}`);
  lines.push(`Confidence:  ${result.confidence}`);
  lines.push(`Escalate:    ${result.escalateToStageB ? 'YES (Stage B)' : 'no'}`);
  lines.push(`Rationale:   ${result.rationale}`);
  lines.push('');
  lines.push(renderSignalTable(result.signals));
  return lines.join('\n');
}

/** Resolve the artifacts directory for CLI subcommands. */
function resolveArtifactsDir(workDir: string): string {
  return process.env.ARTIFACTS_DIR ?? join(workDir, 'artifacts');
}

/**
 * Render the `show <class>` output as a human-readable table.
 * Same column-padding idiom as `cli-dor-stats` — no external table dep.
 */
function renderShowTable(output: {
  taskClass: TaskClass;
  bias: import('../estimation/bias.js').ClassBiasStats;
  accuracy: import('../estimation/bias.js').StageAccuracyStats;
  historicalActuals: import('../estimation/calibration-writer.js').HistoricalActualsResult;
}): string {
  const { taskClass, bias, accuracy, historicalActuals } = output;
  const lines: string[] = [];

  lines.push(`Class: ${taskClass}`);
  lines.push(`State: ${bias.stateToken}`);
  lines.push(`Samples: ${bias.n}`);
  lines.push('');

  // Bias section
  lines.push('Bias statistics:');
  lines.push(
    `  Mean bucket miss:   ${bias.meanBucketMiss != null ? formatMiss(bias.meanBucketMiss) : 'n/a (no calibration data)'}`,
  );
  lines.push(
    `  Median bucket miss: ${bias.medianBucketMiss != null ? formatMiss(bias.medianBucketMiss) : 'n/a'}`,
  );
  lines.push(`  Median actual:      ${historicalActuals.medianBucket ?? 'unknown (n<5)'}`);
  lines.push('');

  // Per-agent section
  if (bias.byAgent.length > 0) {
    lines.push('Per-agent stratification (Q2):');
    const headers = ['agent', 'n', 'mean miss', 'median miss', 'state'];
    const rows = bias.byAgent.map((a) => [
      a.predictedBy,
      String(a.n),
      a.meanBucketMiss != null ? formatMiss(a.meanBucketMiss) : 'n/a',
      a.medianBucketMiss != null ? formatMiss(a.medianBucketMiss) : 'n/a',
      a.stateToken,
    ]);
    lines.push(renderTable(headers, rows));
    lines.push('');
  }

  // Stage A vs Stage B section
  lines.push('Stage A vs Stage B accuracy:');
  lines.push(
    `  Stage A exact:      ${accuracy.stageAExactAccuracy != null ? pct(accuracy.stageAExactAccuracy) : 'n/a (no calibration pairs)'}`,
  );
  lines.push(
    `  Stage A within-1:   ${accuracy.stageAWithin1Accuracy != null ? pct(accuracy.stageAWithin1Accuracy) : 'n/a'}`,
  );
  lines.push(
    `  Stage B hit rate:   ${accuracy.stageBHitRate != null ? pct(accuracy.stageBHitRate) : 'n/a'} (${accuracy.stageBInvokedRows}/${accuracy.totalLogRows} estimates)`,
  );
  lines.push(
    `  Stage B improved:   ${accuracy.stageBImprovementRate != null ? pct(accuracy.stageBImprovementRate) : 'n/a (no Stage B pairs)'}`,
  );

  return lines.join('\n') + '\n';
}

function formatMiss(miss: number): string {
  const sign = miss >= 0 ? '+' : '';
  return `${sign}${miss.toFixed(2)}`;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const out: string[] = [`  ${fmt(headers)}`, `  ${sep}`];
  for (const r of rows) out.push(`  ${fmt(r)}`);
  return out.join('\n');
}

export function buildEstimateCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-estimate')
    .usage('Usage: $0 <command> [options]')
    .command(
      'stage-a <task-id>',
      'Run Stage A deterministic signal collection for one task.',
      (y) =>
        y
          .positional('task-id', {
            type: 'string',
            describe: 'Backlog task ID (e.g. AISDLC-279). Case-insensitive.',
            demandOption: true,
          })
          .option('workdir', {
            type: 'string',
            default: process.cwd(),
            describe: 'Project root containing backlog/ + codecov.yml.',
          })
          .option('loc', {
            type: 'number',
            describe: 'Optional planning LOC estimate (overrides signal #3 unknown).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          })
          .option('capture', {
            type: 'boolean',
            default: true,
            describe:
              'Append the verdict to $ARTIFACTS_DIR/_estimates/log.jsonl (RFC-0016 Phase 2). Use --no-capture to preview without writing.',
          }),
      (argv) => {
        if (!isEstimationEnabled()) {
          // Degrade-open per AC #5: print the disabled notice on
          // stderr (so JSON consumers still see a clean stdout) and
          // exit 0. Callers reading the flag check it themselves.
          process.stderr.write(estimationDisabledMessage() + '\n');
          emit({
            ok: false,
            disabled: true,
            flag: ESTIMATION_FLAG,
            message: estimationDisabledMessage(),
          });
          return;
        }

        try {
          const workDir = String(argv.workdir);
          const taskId = String(argv['task-id']);
          const result = runStageA({
            taskId,
            workDir,
            ...(argv.loc !== undefined ? { loc: Number(argv.loc) } : {}),
          });
          // RFC-0016 Phase 2 capture (AC #1) — append to log.jsonl
          // unless explicitly opted out with --no-capture. Best-effort:
          // a write failure is surfaced on stderr but doesn't fail the
          // verdict emission.
          if (argv.capture) {
            const taskFilePath = findTaskFile(taskId, workDir);
            if (taskFilePath) {
              const task = parseTaskFile(taskFilePath);
              try {
                captureEstimate({
                  stageA: result,
                  taskTitle: task.title,
                  taskDescription: task.description ?? '',
                });
              } catch (err) {
                process.stderr.write(
                  `[estimate-log] capture failed: ${
                    err instanceof Error ? err.message : String(err)
                  }\n`,
                );
              }
            }
          }
          if (argv.format === 'json') {
            emit(result);
          } else {
            emitText(renderResult(result));
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .command(
      'show <class>',
      'Show per-class bias statistics + Stage A vs Stage B accuracy (Phase 5).',
      (y) =>
        y
          .positional('class', {
            type: 'string',
            describe: `Task class (${TASK_CLASSES.filter((c) => c !== 'uncategorized').join(' | ')}).`,
            demandOption: true,
          })
          .option('workdir', {
            type: 'string',
            default: process.cwd(),
            describe: 'Project root (passed to resolveArtifactsDir).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      (argv) => {
        if (!isEstimationEnabled()) {
          process.stderr.write(estimationDisabledMessage() + '\n');
          emit({
            ok: false,
            disabled: true,
            flag: ESTIMATION_FLAG,
            message: estimationDisabledMessage(),
          });
          return;
        }

        const rawClass = String(argv['class']);
        if (!TASK_CLASSES.includes(rawClass as TaskClass)) {
          fail(
            `unknown class '${rawClass}'. Valid classes: ${TASK_CLASSES.filter((c) => c !== 'uncategorized').join(', ')}`,
          );
        }
        const taskClass = rawClass as TaskClass;

        try {
          const artifactsDir = resolveArtifactsDir(String(argv.workdir));
          const biasStats = computeBiasStats({ taskClass, artifactsDir });

          // Stage A vs Stage B accuracy: join log rows for this class with
          // calibration records.
          const allLogRows = readEstimateLog({ artifactsDir });
          const classLogRows = allLogRows.filter((r) => r.class === taskClass);

          // Read calibration records from monthly files.
          const calibrationFiles = listCalibrationFiles(artifactsDir);
          const calibrationRecords: import('../estimation/calibration-writer.js').CalibrationRecord[] =
            [];
          for (const filePath of calibrationFiles) {
            let raw: string;
            try {
              raw = readFileSync(filePath, 'utf8');
            } catch {
              continue;
            }
            for (const line of raw.split('\n')) {
              if (!line.trim()) continue;
              try {
                const r = JSON.parse(
                  line,
                ) as import('../estimation/calibration-writer.js').CalibrationRecord;
                if (r && typeof r === 'object' && r.class === taskClass) {
                  calibrationRecords.push(r);
                }
              } catch {
                // skip malformed lines
              }
            }
          }

          const accuracy = computeStageAVsStageBAccuracy(classLogRows, calibrationRecords);

          // Historical actuals (signal #2 query)
          const historicalActuals = queryHistoricalActuals({ taskClass, artifactsDir });

          const output = {
            taskClass,
            bias: biasStats,
            accuracy,
            historicalActuals,
          };

          if (argv.format === 'json') {
            emit(output);
          } else {
            emitText(renderShowTable(output));
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .command(
      'render-pr-comment',
      'Render the <!-- ai-sdlc:estimate --> bot comment body for a task (Phase 5).',
      (y) =>
        y
          .option('task-id', {
            type: 'string',
            describe: 'Backlog task ID (e.g. AISDLC-283). Case-insensitive.',
            demandOption: true,
          })
          .option('workdir', {
            type: 'string',
            default: process.cwd(),
            describe: 'Project root containing backlog/ + .ai-sdlc/.',
          })
          .option('estimate-variance', {
            type: 'number',
            default: 0,
            describe: 'RFC §8.4 ensemble variance (0 for single-run estimates).',
          })
          .option('actual-bucket', {
            type: 'string',
            describe: 'Actual bucket (XS/S/M/L/XL) — appended post-merge by the actuals collector.',
          }),
      (argv) => {
        if (!isEstimationEnabled()) {
          process.stderr.write(estimationDisabledMessage() + '\n');
          emit({
            ok: false,
            disabled: true,
            flag: ESTIMATION_FLAG,
            message: estimationDisabledMessage(),
          });
          return;
        }

        try {
          const workDir = String(argv.workdir);
          const taskId = String(argv['task-id']);
          const artifactsDir = resolveArtifactsDir(workDir);

          // Run Stage A to get signals + class.
          const stageAResult = runStageA({ taskId, workDir });

          // Look up calibration state for the task class.
          const historicalActuals = queryHistoricalActuals({
            taskClass: stageAResult.taskClass,
            artifactsDir,
          });

          const result = renderEstimateComment({
            stageAResult,
            calibrationN: historicalActuals.n,
            meanBucketMiss: historicalActuals.meanBucketMiss,
            estimateVariance: argv['estimate-variance'],
            ...(argv['actual-bucket']
              ? {
                  actualBucket: argv['actual-bucket'] as import('../estimation/types.js').Bucket,
                }
              : {}),
          });

          // Output raw comment body to stdout — workflow captures it.
          emitText(result.body);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .command(
      'digest',
      'Generate weekly calibration digest with Stage-A-coverage metrics (Phase 6).',
      (y) =>
        y
          .option('workdir', {
            type: 'string',
            default: process.cwd(),
            describe: 'Project root (passed to resolveArtifactsDir).',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      (argv) => {
        if (!isEstimationEnabled()) {
          process.stderr.write(estimationDisabledMessage() + '\n');
          emit({
            ok: false,
            disabled: true,
            flag: ESTIMATION_FLAG,
            message: estimationDisabledMessage(),
          });
          return;
        }

        try {
          const artifactsDir = resolveArtifactsDir(String(argv.workdir));
          const digest = generateDigest({ artifactsDir });

          if (argv.format === 'json') {
            emit(digest);
          } else {
            emitText(formatDigestText(digest));
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .demandCommand(
      1,
      'A subcommand is required (try `stage-a <task-id>`, `show <class>`, or `digest`).',
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runEstimateCli(): Promise<void> {
  await buildEstimateCli().parseAsync();
}
