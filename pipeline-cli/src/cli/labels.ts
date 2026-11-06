/**
 * `cli-labels`: implicit outcome labels and the task-class backfill
 * (RFC-0062 OQ-3, DEC-0387). Recording only.
 *
 * @module cli/labels
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { resolveArtifactsDir } from '../routing/artifacts-dir.js';
import { assignmentLogPath } from '../routing/assignment-log.js';
import { backfillTaskClass } from '../labels/backfill.js';
import { extractLabels, renderLabelsJsonl } from '../labels/extract.js';

export async function runLabelsCli(argv: string[] = hideBin(process.argv)): Promise<void> {
  await yargs(argv)
    .scriptName('cli-labels')
    .command(
      'extract',
      'Write one JSONL row per landed, abandoned or parked task with four implicit signals',
      (c) =>
        c
          .option('repo-root', { type: 'string', default: process.cwd() })
          .option('out', { type: 'string', description: 'Write here instead of stdout' }),
      (a) => {
        const text = renderLabelsJsonl(extractLabels(resolve(a['repo-root'])));
        if (a.out) writeFileSync(resolve(a.out), text);
        else process.stdout.write(text);
      },
    )
    .command(
      'backfill-class',
      'Fill taskClass on uncategorized assignment rows from the task file',
      (c) =>
        c
          .option('repo-root', { type: 'string', default: process.cwd() })
          .option('artifacts-dir', { type: 'string' })
          .option('dry-run', { type: 'boolean', default: false }),
      (a) => {
        const root = resolve(a['repo-root']);
        const log = assignmentLogPath(resolveArtifactsDir(root, a['artifacts-dir']));
        const r = backfillTaskClass(log, root, { dryRun: a['dry-run'] });
        process.stdout.write(
          `${a['dry-run'] ? 'Would rewrite' : 'Rewrote'} ${r.rewritten} of ${r.rows} assignment rows; ` +
            `${r.stillUncategorized} stay uncategorized.\n`,
        );
        for (const [why, n] of Object.entries(r.reasons)) process.stdout.write(`  ${n}: ${why}\n`);
      },
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
}
