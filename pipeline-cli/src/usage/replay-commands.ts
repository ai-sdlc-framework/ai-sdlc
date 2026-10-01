/**
 * `cli-usage replay-corpus build` and `cli-usage replay` (RFC-0050 B4).
 *
 * Every collaborator is injectable so tests never touch the home directory,
 * the network, a real model or the caller's repository.
 *
 * @module usage/replay-commands
 */

import { isAbsolute, join, relative, resolve } from 'node:path';
import { readModelCalls, readPriceHistory, type ModelCallRecord } from '@ai-sdlc/reference';
import type { Argv } from 'yargs';
import { loadAllReviewLedgers } from '../attestation/reviews-ledger.js';
import { ShellClaudePSpawner } from '../runtime/shell-claude-p-spawner.js';
import type { Runner } from '../runtime/exec.js';
import { repoNameFor } from './attribution.js';
import {
  buildCorpus,
  readCorpus,
  renderCorpusSummary,
  writeCorpus,
  writeJsonAtomic,
  REPLAY_ROLES,
} from './replay-corpus.js';
import { cleanupActiveWorktreesSync, createGit, isSafeRef, type Git } from './replay-git.js';
import { estimateUnitsPerReview, renderDryRun } from './replay-report.js';
import {
  isOffPeakNow,
  nextOffPeakStart,
  parseOffPeakWindow,
  type OffPeakWindow,
} from './replay-schedule.js';
import {
  isValidModel,
  isValidRole,
  renderReplayResults,
  reviewerTypeFor,
  interleaveByLabel,
  runReplay,
  type SpawnerFactory,
} from './replay-run.js';
import { deriveUnitWeights } from './units.js';
import { loadUsageConfig } from './usage-config.js';
import type { UsageIo, UsageViewDeps } from './commands.js';

export interface ReplayDeps extends UsageViewDeps {
  /** Repository root holding `.ai-sdlc/reviews`. Defaults to `workDir` then cwd. */
  repoRoot?: string;
  /** Artifacts directory; the corpus and results files live under `replay/`. */
  artifactsDir?: string;
  /** Runs git (tests). */
  git?: Git;
  /** Runner behind the review-prompt builder (tests). */
  runner?: Runner;
  /** Creates the reviewer spawner for a model (tests inject a double). */
  createSpawner?: SpawnerFactory;
  /** Directory temporary worktrees are created under (tests). */
  tmpRoot?: string;
  /** Install SIGINT/SIGTERM handlers that remove temporary worktrees. Default true. */
  handleSignals?: boolean;
}

const DEFAULT_BASE_REF = 'origin/main';

function defaultSpawner(): SpawnerFactory {
  return ({ model, type }) => new ShellClaudePSpawner({ models: { [type]: model } });
}

function artifactsDirFor(deps: ReplayDeps, repoRoot: string): string {
  return deps.artifactsDir ?? process.env.ARTIFACTS_DIR ?? resolve(repoRoot, 'artifacts');
}

/** True when `path` is the repository's `.ai-sdlc` directory or inside it. */
function isUnderAiSdlc(path: string, repoRoot: string): boolean {
  const rel = relative(join(repoRoot, '.ai-sdlc'), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function fail(io: UsageIo, message: string): void {
  io.err(`${message}\n`);
  io.exit(1);
}

function runIdFor(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export function registerReplayCommands(y: Argv, deps: ReplayDeps, io: UsageIo): Argv {
  const repoRootOf = (): string => resolve(deps.repoRoot ?? deps.workDir ?? process.cwd());

  return y
    .command(
      'replay-corpus',
      'Build the corpus of reviewed commits that reviewer replay uses',
      (c) =>
        c
          .command(
            'build',
            'Label reviewed commits from the reviews ledger and write the corpus file',
            (b) =>
              b
                .option('base-ref', {
                  type: 'string',
                  default: DEFAULT_BASE_REF,
                  description: 'Ref each reviewed commit is diffed against (via its merge base)',
                })
                .option('out', {
                  type: 'string',
                  description: 'Corpus file (default: <artifacts>/replay/corpus.json)',
                }),
            async (argv) => {
              const repoRoot = repoRootOf();
              if (!isSafeRef(argv['base-ref'])) {
                fail(io, `Invalid --base-ref "${argv['base-ref']}".`);
                return;
              }
              const out = resolve(
                argv.out ?? join(artifactsDirFor(deps, repoRoot), 'replay', 'corpus.json'),
              );
              if (isUnderAiSdlc(out, repoRoot)) {
                fail(io, 'Refusing to write the corpus under .ai-sdlc; choose another --out.');
                return;
              }
              const corpus = await buildCorpus({
                records: loadAllReviewLedgers(repoRoot),
                git: deps.git ?? createGit(deps.runner),
                repoRoot,
                baseRef: argv['base-ref'],
                now: deps.now?.() ?? new Date(),
              });
              writeCorpus(out, corpus);
              io.out(renderCorpusSummary(corpus, out));
            },
          )
          .demandCommand(1, 'Specify a replay-corpus subcommand: build'),
      () => undefined,
    )
    .command(
      'replay',
      'Replay past reviewed commits against a candidate reviewer model and score the result',
      (c) =>
        c
          .option('role', {
            type: 'string',
            demandOption: true,
            choices: [...REPLAY_ROLES],
            description: 'Reviewer role to replay',
          })
          .option('model', {
            type: 'string',
            demandOption: true,
            description: 'Candidate model id',
          })
          .option('reference-model', {
            type: 'string',
            description: 'Also replay this reference model on the same items',
          })
          .option('max-items', {
            type: 'number',
            demandOption: true,
            description: 'Stop after this many corpus items',
          })
          .option('max-units', {
            type: 'number',
            demandOption: true,
            description: 'Stop once this many weighted units are spent',
          })
          .option('corpus', {
            type: 'string',
            description: 'Corpus file (default: <artifacts>/replay/corpus.json)',
          })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            description: 'List the items and an estimate; call no model',
          })
          .option('off-peak', {
            type: 'boolean',
            default: false,
            description: 'Run only inside an off-peak window (see --off-peak-window)',
          })
          .option('off-peak-window', {
            type: 'string',
            array: true,
            default: [] as string[],
            description: 'Off-peak window, TZ@HH-HH or TZ@HH-HH@Day,Day (repeatable)',
          }),
      async (argv) => {
        const repoRoot = repoRootOf();
        const role = argv.role;
        if (!isValidRole(role)) {
          fail(io, `Invalid --role "${role}".`);
          return;
        }
        const models = [argv.model, ...(argv['reference-model'] ? [argv['reference-model']] : [])];
        for (const m of models) {
          if (!isValidModel(m)) {
            fail(io, `Invalid model id "${m}".`);
            return;
          }
        }
        const maxItems = argv['max-items'];
        const maxUnits = argv['max-units'];
        if (!Number.isInteger(maxItems) || maxItems < 1) {
          fail(io, '--max-items must be a whole number of at least 1.');
          return;
        }
        if (!Number.isFinite(maxUnits) || maxUnits <= 0) {
          fail(io, '--max-units must be greater than 0.');
          return;
        }

        const now = deps.now?.() ?? new Date();
        const artifactsDir = artifactsDirFor(deps, repoRoot);
        if (isUnderAiSdlc(artifactsDir, repoRoot)) {
          fail(io, 'Refusing to use an artifacts directory under .ai-sdlc.');
          return;
        }

        const corpus = readCorpus(
          resolve(argv.corpus ?? join(artifactsDir, 'replay', 'corpus.json')),
        );
        if (typeof corpus === 'string') {
          fail(io, corpus);
          return;
        }
        const items = corpus.items.filter((i) => i.role === role);
        if (items.length === 0) {
          fail(io, `The corpus has no items for role ${role}.`);
          return;
        }

        const config = (deps.loadConfig ?? loadUsageConfig)({
          dir: deps.usageDir,
          workDir: deps.workDir,
          readBaseConfig: deps.readBaseConfig,
        });
        for (const w of config.warnings) io.err(`${w}\n`);
        const weights = deriveUnitWeights(
          deps.priceRows ?? readPriceHistory({ dir: deps.usageDir }),
          now.toISOString(),
          config.weights,
        );
        const repoName = repoNameFor(repoRootOf());
        const records: ModelCallRecord[] = [];
        for await (const r of readModelCalls(
          { scope: 'framework', repo: repoName },
          { dir: deps.usageDir },
        )) {
          records.push(r);
        }

        if (argv['dry-run']) {
          io.out(
            renderDryRun({
              items: interleaveByLabel(items),
              role,
              models,
              maxItems,
              maxUnits,
              estimate: estimateUnitsPerReview(records, role, weights),
            }),
          );
          return;
        }

        if (argv['off-peak']) {
          const windows: OffPeakWindow[] = [];
          for (const text of argv['off-peak-window'] as string[]) {
            const w = parseOffPeakWindow(text);
            if (typeof w === 'string') {
              fail(io, w);
              return;
            }
            windows.push(w);
          }
          if (windows.length === 0) {
            fail(io, '--off-peak needs at least one --off-peak-window, for example UTC@22-06.');
            return;
          }
          if (!isOffPeakNow(windows, now)) {
            const next = nextOffPeakStart(windows, now);
            io.out(
              `Deferred: outside the off-peak window. ${
                next
                  ? `The next window starts ${next.toISOString()}.`
                  : 'No window opens within a week.'
              } No model was called.\n`,
            );
            return;
          }
        }

        const runId = runIdFor(now);
        const controller = new AbortController();
        const onSignal = (signal: NodeJS.Signals): void => {
          controller.abort();
          cleanupActiveWorktreesSync();
          // The listener was registered with `once`, so re-raising uses the default action.
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
          process.kill(process.pid, signal);
        };
        const useSignals = deps.handleSignals !== false;
        if (useSignals) {
          process.once('SIGINT', onSignal);
          process.once('SIGTERM', onSignal);
        }
        try {
          const results = await runReplay({
            items,
            role,
            candidate: argv.model as string,
            ...(argv['reference-model'] ? { reference: argv['reference-model'] } : {}),
            maxItems,
            maxUnits,
            repoRoot,
            repoName,
            git: deps.git ?? createGit(deps.runner),
            createSpawner: deps.createSpawner ?? defaultSpawner(),
            weights,
            usage: { dir: deps.usageDir },
            now: deps.now ?? (() => new Date()),
            runId,
            tmpRoot: deps.tmpRoot,
            runner: deps.runner,
            signal: controller.signal,
            onProgress: (line) => io.err(`${line}\n`),
          });
          const resultsPath = join(artifactsDir, 'replay', `results-${role}-${runId}.json`);
          writeJsonAtomic(resultsPath, results);
          io.out(renderReplayResults(results));
          io.out(`Wrote ${resultsPath}\n`);
          io.out(`Reviewer type: ${reviewerTypeFor(role)}; usage recorded under task id replay.\n`);
        } finally {
          if (useSignals) {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
          }
          cleanupActiveWorktreesSync();
        }
      },
    );
}
