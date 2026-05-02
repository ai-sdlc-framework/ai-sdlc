/**
 * `cli-dor-digest` — emit the weekly DoR digest (RFC-0011 Phase 5) as
 * Slack Block Kit JSON on stdout.
 *
 * Contract: this CLI does NOT POST to Slack. It writes JSON suitable
 * for piping to `curl -X POST -H 'Content-Type: application/json' --data
 * @- $SLACK_WEBHOOK_URL`. The operator wires curl + cron; we own the
 * payload shape.
 *
 *   $ cli-dor-digest --since-days 7 | curl -X POST --data @- "$SLACK_WEBHOOK_URL"
 *
 * Flags:
 *   --log <path>          calibration log file (default resolveCalibrationLogPath())
 *   --since-days <int>    window length in days (default: 7)
 *   --markdown            render as markdown instead of Slack Block Kit
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { buildWeeklyDigest, renderMarkdownDigest } from '../dor/slack-digest.js';

function emit(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text);
  if (!text.endsWith('\n')) process.stdout.write('\n');
}

export function buildDorDigestCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-dor-digest')
    .usage('Usage: $0 [options]')
    .option('log', {
      type: 'string',
      describe: 'Calibration log path. Defaults to $ARTIFACTS_DIR/_dor/calibration.jsonl.',
    })
    .option('since-days', {
      type: 'number',
      default: 7,
      describe: 'Window length in days.',
    })
    .option('markdown', {
      type: 'boolean',
      default: false,
      describe: 'Emit as a markdown dashboard dump instead of Slack Block Kit JSON.',
    })
    .command(
      '$0',
      'Emit the weekly DoR digest as Slack Block Kit JSON (or markdown).',
      (y) => y,
      async (argv) => {
        const logPath = argv.log as string | undefined;
        const sinceDays = argv['since-days'] as number;
        const markdown = argv.markdown as boolean;
        const opts: Parameters<typeof buildWeeklyDigest>[0] = { sinceDays };
        if (logPath !== undefined) opts.logPath = logPath;
        if (markdown) {
          emitText(renderMarkdownDigest(opts));
        } else {
          emit(buildWeeklyDigest(opts));
        }
      },
    )
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runDorDigestCli(): Promise<void> {
  await buildDorDigestCli().parseAsync();
}
