/**
 * `cli-usage scorecard` (RFC-0050 B1): quality and cost per role, model and
 * task class. Every collaborator is injectable so tests never touch the home
 * directory, the clock or git.
 *
 * @module usage/scorecard-commands
 */

import { resolve } from 'node:path';
import { readModelCalls, readPriceHistory, type ModelCallRecord } from '@ai-sdlc/reference';
import type { Argv } from 'yargs';
import { loadAllReviewLedgers } from '../attestation/reviews-ledger.js';
import { repoNameFor } from './attribution.js';
import {
  buildScorecard,
  deriveOutcomes,
  renderScorecardCsv,
  renderScorecardJson,
  renderScorecardText,
} from './scorecard.js';
import {
  ASSIGNMENT_LOG_RELATIVE,
  loadContractRetries,
  loadTaskInfo,
  readAssignmentLog,
  writeEvidenceFiles,
} from './scorecard-sources.js';
import { REPLAY_TASK_ID } from './replay-run.js';
import { readReplayResults, renderReplayRows, replayRows } from './replay-report.js';
import { deriveUnitWeights, describeWeights } from './units.js';
import { loadUsageConfig } from './usage-config.js';
import type { UsageIo, UsageViewDeps } from './commands.js';

export interface ScorecardDeps extends UsageViewDeps {
  /** Repository root holding `.ai-sdlc/reviews` and `backlog`. Defaults to `workDir` then cwd. */
  repoRoot?: string;
  /** Artifacts directory for estimates, events and the assignment log. */
  artifactsDir?: string;
  /** Assignment log path override. */
  assignmentLogPath?: string;
}

export function registerScorecardCommands(y: Argv, deps: ScorecardDeps, io: UsageIo): Argv {
  return y.command(
    'scorecard',
    'Quality and cost per role, model and task class, from reviews and usage',
    (c) =>
      c
        .option('role', {
          type: 'string',
          description:
            'Only this role, for example developer (the no-outcome total is counted after this filter)',
        })
        .option('since', { type: 'string', description: 'Include calls at or after this ISO date' })
        .option('format', {
          type: 'string',
          choices: ['text', 'json', 'csv'] as const,
          default: 'text',
        })
        .option('replay-results', {
          type: 'string',
          array: true,
          default: [] as string[],
          description: 'Reviewer replay results file to add reviewer rows from (repeatable)',
        })
        .option('write-evidence', {
          type: 'string',
          description: 'Write one JSON evidence file per cell into this directory',
        }),
    async (argv) => {
      const now = deps.now?.() ?? new Date();
      const replayFiles = readReplayResults(
        (argv['replay-results'] as string[]).map((p) => resolve(p)),
      );
      if (typeof replayFiles === 'string') {
        io.err(`${replayFiles}\n`);
        io.exit(1);
        return;
      }
      const replay = replayRows(replayFiles);
      let from: Date | undefined;
      if (argv.since !== undefined) {
        from = new Date(argv.since);
        if (Number.isNaN(from.getTime())) {
          io.err(`Invalid --since value "${argv.since}"; use an ISO date or timestamp.\n`);
          io.exit(1);
          return;
        }
      }
      const repoRoot = resolve(deps.repoRoot ?? deps.workDir ?? process.cwd());
      const repo = repoNameFor(repoRoot);
      const artifactsDir =
        deps.artifactsDir ?? process.env.ARTIFACTS_DIR ?? resolve(repoRoot, 'artifacts');

      const config = (deps.loadConfig ?? loadUsageConfig)({
        dir: deps.usageDir,
        workDir: deps.workDir,
        readBaseConfig: deps.readBaseConfig,
      });
      for (const w of config.warnings) io.err(`${w}\n`);
      const priceRows = deps.priceRows ?? readPriceHistory({ dir: deps.usageDir });
      const weights = deriveUnitWeights(priceRows, now.toISOString(), config.weights);

      // Framework scope of this repository only: no `other` scope data, and no
      // task ids from other repositories joined against this one's reviews.
      const records: ModelCallRecord[] = [];
      for await (const r of readModelCalls(
        { scope: 'framework', repo, ...(from ? { from } : {}) },
        { dir: deps.usageDir },
      )) {
        // Replay calls carry the `replay` task id and are not real task cost.
        if (r.taskId && r.taskId !== REPLAY_TASK_ID) records.push(r);
      }

      const outcomes = deriveOutcomes(
        loadAllReviewLedgers(repoRoot),
        loadContractRetries(artifactsDir),
      );
      const taskInfo = loadTaskInfo(new Set(records.map((r) => r.taskId as string)), {
        repoRoot,
        artifactsDir,
      });
      const assignments = readAssignmentLog(
        deps.assignmentLogPath ?? resolve(artifactsDir, ASSIGNMENT_LOG_RELATIVE),
      );
      const card = {
        ...buildScorecard({
          records,
          outcomes,
          taskInfo,
          assignments,
          weights,
          minTasks: config.scorecardMinTasks,
          ...(argv.role ? { role: argv.role } : {}),
        }),
        unitsNote: describeWeights(weights),
      };

      if (argv.format === 'json') {
        const json = JSON.parse(renderScorecardJson(card)) as Record<string, unknown>;
        io.out(`${JSON.stringify(replay.length ? { ...json, replay } : json, null, 2)}\n`);
      } else if (argv.format === 'csv') {
        io.out(renderScorecardCsv(card));
        io.err(`${card.unitsNote}\n`);
      } else {
        io.out(renderScorecardText(card));
        io.out(renderReplayRows(replay));
      }

      if (argv['write-evidence']) {
        const paths = writeEvidenceFiles(resolve(argv['write-evidence']), card, {
          repo,
          generatedAt: now.toISOString(),
        });
        io.err(`Wrote ${paths.length} evidence file(s) to ${resolve(argv['write-evidence'])}.\n`);
      }
    },
  );
}
