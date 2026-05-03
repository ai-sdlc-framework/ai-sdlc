/**
 * `cli-classify-budget` subcommand router (AISDLC-147 patch 2).
 *
 * Wraps the budget-exhaustion classifier from
 * `../classifier/budget-classifier.ts` so the `report` job in
 * `.github/workflows/ai-sdlc-review.yml` can decide whether to suppress
 * CHANGES_REQUESTED on a uniform Anthropic API budget-exhaustion failure.
 *
 * The workflow's bash glue captures per-reviewer stdout +
 * stderr at `/tmp/review-<type>.txt` + `/tmp/review-<type>-stderr.txt`. We
 * read those exact 6 paths and emit the aggregate decision as JSON on
 * stdout, suitable for the report job's github-script branch:
 *
 *     {
 *       "aggregate": "skip-with-budget-comment" | "proceed-as-normal",
 *       "budgetExhaustedCount": 0..3,
 *       "perReviewer": [
 *         {"type":"testing","classification":"ok"|"budget-exhausted"|"other-failure"},
 *         ...
 *       ]
 *     }
 *
 * Inputs (all required, positional CLI args via flags):
 *   --testing-stdout <path>  --testing-stderr <path>
 *   --critic-stdout  <path>  --critic-stderr  <path>
 *   --security-stdout <path> --security-stderr <path>
 *
 * Behaviour on missing input file: we treat absence as empty string —
 * matches the workflow's bash glue (`tail -1 ... 2>/dev/null || echo '{}'`)
 * which never errors on missing input. The classifier still classifies
 * empty-stdout + empty-stderr as `other-failure` so the report job's
 * existing CHANGES_REQUESTED safety net kicks in.
 *
 * Exit code: always 0 unless yargs itself rejects bad CLI shape. The
 * downstream github-script step branches on the JSON, not the exit code.
 *
 * @module cli/classify-budget
 */

import { readFileSync } from 'node:fs';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  classifyReviewerOutputs,
  type ReviewerRawOutput,
} from '../classifier/budget-classifier.js';

/**
 * Read a file's contents, returning the empty string when the file is
 * missing or unreadable. This mirrors the workflow's `2>/dev/null || echo`
 * tolerance — we never want this CLI to fail-loud, since failing-loud
 * would cascade into the report-job not running and the PR never getting
 * a `Post Review Results` status.
 */
function readSafe(path: string | undefined): string {
  if (!path) return '';
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Extract the LAST non-empty line of a file — matches the existing
 * `tail -1 /tmp/review-<type>.txt` shape that the report job already
 * consumes. The reviewer prints structured logs throughout but the
 * final line is the JSON verdict.
 */
function lastLine(text: string): string {
  if (!text) return '';
  const lines = text.split('\n').filter((l) => l.length > 0);
  return lines.length > 0 ? lines[lines.length - 1] : '';
}

/**
 * Public entry. Parses CLI flags, reads the 6 reviewer files, runs the
 * classifier, and prints the aggregate decision JSON to stdout. Always
 * exits 0 (the github-script branch consumes the JSON; non-zero would
 * mask the result).
 */
export async function runClassifyBudgetCli(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('cli-classify-budget')
    .usage(
      '$0 --<type>-stdout <path> --<type>-stderr <path>  (for type in testing|critic|security)',
    )
    .option('testing-stdout', { type: 'string', describe: 'Path to testing reviewer stdout' })
    .option('testing-stderr', { type: 'string', describe: 'Path to testing reviewer stderr' })
    .option('critic-stdout', { type: 'string', describe: 'Path to critic reviewer stdout' })
    .option('critic-stderr', { type: 'string', describe: 'Path to critic reviewer stderr' })
    .option('security-stdout', { type: 'string', describe: 'Path to security reviewer stdout' })
    .option('security-stderr', { type: 'string', describe: 'Path to security reviewer stderr' })
    .strict()
    .help()
    .parseAsync();

  const inputs: ReviewerRawOutput[] = [
    {
      type: 'testing',
      verdictLine: lastLine(readSafe(argv['testing-stdout'])),
      stderr: readSafe(argv['testing-stderr']),
    },
    {
      type: 'critic',
      verdictLine: lastLine(readSafe(argv['critic-stdout'])),
      stderr: readSafe(argv['critic-stderr']),
    },
    {
      type: 'security',
      verdictLine: lastLine(readSafe(argv['security-stdout'])),
      stderr: readSafe(argv['security-stderr']),
    },
  ];

  const result = classifyReviewerOutputs(inputs);
  process.stdout.write(JSON.stringify(result) + '\n');
}
