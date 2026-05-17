/**
 * `cli-estimate` subcommand router — RFC-0016 Phase 1-6 (AISDLC-279..284).
 *
 * Subcommands:
 *  - `stage-a <task-id>` — emit Stage A signals + candidate bucket.
 *  - `show <class>`       — per-class calibration stats + Stage-A-coverage
 *                           (RFC-0016 Phase 6, AC #3).
 *  - `digest`             — weekly calibration digest across all classes
 *                           (RFC-0016 Phase 6, AC #2).
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
import type { SignalOutput, StageAResult } from '../estimation/types.js';
import { TASK_CLASSES, type TaskClass } from '../estimation/types.js';
import { findTaskFile, parseTaskFile } from '../steps/01-validate.js';
import {
  generateDigest,
  formatDigestText,
  queryStageACoverage,
  formatCalibrationStateToken,
  calibrationState,
} from '../estimation/digest.js';
import { queryHistoricalActuals } from '../estimation/calibration-writer.js';
import { detectBiasDrift } from '../estimation/bias-drift.js';

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
      'Show per-class calibration stats + Stage-A-coverage (RFC-0016 Phase 6 AC #3).',
      (y) =>
        y
          .positional('class', {
            type: 'string',
            describe:
              'Task class to inspect (bug / feature / chore / uncategorized). Use "all" for a cross-class summary.',
            demandOption: true,
          })
          .option('artifacts-dir', {
            type: 'string',
            describe: 'Override $ARTIFACTS_DIR.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table' as const,
          })
          .option('check-drift', {
            type: 'boolean',
            default: false,
            describe:
              'Also run bias-drift detection for the class (emits EstimateBiasOverCorrected event when triggered).',
          }),
      (argv) => {
        if (!isEstimationEnabled()) {
          process.stderr.write(estimationDisabledMessage() + '\n');
          emit({ ok: false, disabled: true, flag: ESTIMATION_FLAG });
          return;
        }
        try {
          const artifactsDir = argv['artifacts-dir'] ? String(argv['artifacts-dir']) : undefined;
          const classArg = String(argv.class);
          const isAll = classArg === 'all';

          const targetClasses: TaskClass[] = isAll
            ? (TASK_CLASSES.filter((c) => c !== 'uncategorized') as TaskClass[])
            : (() => {
                if (!(TASK_CLASSES as readonly string[]).includes(classArg) && classArg !== 'all') {
                  fail(
                    `Unknown class "${classArg}". Valid values: ${TASK_CLASSES.join(', ')}, all`,
                  );
                }
                return [classArg as TaskClass];
              })();

          type ShowRow = {
            taskClass: TaskClass;
            n: number;
            meanBucketMiss: number;
            medianBucketMiss: number;
            stageACoverageRate: number;
            logRows: number;
            calibrationStateToken: string;
            driftCheck?: ReturnType<typeof detectBiasDrift>['checks'][0];
          };
          const rows: ShowRow[] = [];

          for (const taskClass of targetClasses) {
            const historical = queryHistoricalActuals({
              taskClass,
              artifactsDir,
            });
            const coverage = queryStageACoverage({ taskClass, artifactsDir });
            const n = historical.n;
            const state = calibrationState(n);
            const stateToken = formatCalibrationStateToken({
              state,
              n,
              meanMiss: historical.meanBucketMiss !== null ? historical.meanBucketMiss : undefined,
            });

            let driftCheck: ShowRow['driftCheck'];
            if (argv['check-drift']) {
              const driftResult = detectBiasDrift({ taskClass, artifactsDir });
              driftCheck = driftResult.checks.find((c) => c.taskClass === taskClass);
            }

            rows.push({
              taskClass,
              n,
              meanBucketMiss: historical.meanBucketMiss ?? 0,
              medianBucketMiss:
                historical.medianBucket !== null
                  ? ((): number => {
                      const BUCKET_IDX: Record<string, number> = {
                        XS: 0,
                        S: 1,
                        M: 2,
                        L: 3,
                        XL: 4,
                      };
                      return BUCKET_IDX[historical.medianBucket!] ?? 0;
                    })()
                  : 0,
              stageACoverageRate: coverage.coverageRate,
              logRows: coverage.totalLogRows,
              calibrationStateToken: stateToken,
              driftCheck,
            });
          }

          if (argv.format === 'json') {
            emit({ ok: true, rows });
          } else {
            const lines: string[] = [];
            for (const row of rows) {
              lines.push(`Class: ${row.taskClass}  ${row.calibrationStateToken}`);
              lines.push(`  Calibration records: ${row.n}`);
              if (row.n > 0) {
                const sign = row.meanBucketMiss >= 0 ? '+' : '';
                lines.push(`  Mean bucket miss:    ${sign}${row.meanBucketMiss.toFixed(2)}`);
              }
              lines.push(
                `  Stage-A coverage:    ${(row.stageACoverageRate * 100).toFixed(1)}% of ${row.logRows} estimates`,
              );
              if (row.driftCheck) {
                const dc = row.driftCheck;
                lines.push(
                  `  Drift:               ${dc.overCorrected ? 'OVER-CORRECTED (event emitted)' : 'none detected'}`,
                );
              }
              lines.push('');
            }
            emitText(lines.join('\n'));
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .command(
      'digest',
      'Generate the weekly calibration digest across all classes (RFC-0016 Phase 6 AC #2).',
      (y) =>
        y
          .option('artifacts-dir', {
            type: 'string',
            describe: 'Override $ARTIFACTS_DIR.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table' as const,
          }),
      (argv) => {
        if (!isEstimationEnabled()) {
          process.stderr.write(estimationDisabledMessage() + '\n');
          emit({ ok: false, disabled: true, flag: ESTIMATION_FLAG });
          return;
        }
        try {
          const artifactsDir = argv['artifacts-dir'] ? String(argv['artifacts-dir']) : undefined;
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
