/**
 * `cli-estimate` subcommand router — RFC-0016 Phase 1 (AISDLC-279).
 *
 * Subcommands:
 *  - `stage-a <task-id>` — emit Stage A signals + candidate bucket.
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
import { runStageA } from '../estimation/stage-a.js';
import type { SignalOutput, StageAResult } from '../estimation/types.js';

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
          const result = runStageA({
            taskId: String(argv['task-id']),
            workDir: String(argv.workdir),
            ...(argv.loc !== undefined ? { loc: Number(argv.loc) } : {}),
          });
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
    .demandCommand(1, 'A subcommand is required (try `stage-a <task-id>`).')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runEstimateCli(): Promise<void> {
  await buildEstimateCli().parseAsync();
}
