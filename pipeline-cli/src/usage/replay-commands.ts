/**
 * `cli-usage replay-corpus build` and `cli-usage replay` (RFC-0050 B4).
 *
 * Every collaborator is injectable so tests never touch the home directory,
 * the network, a real model or the caller's repository.
 *
 * @module usage/replay-commands
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readModelCalls, readPriceHistory, type ModelCallRecord } from '@ai-sdlc/reference';
import type { Argv } from 'yargs';
import { loadAllReviewLedgers } from '../attestation/reviews-ledger.js';
import { ShellClaudePSpawner, type ProcessSpawner } from '../runtime/shell-claude-p-spawner.js';
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
import {
  cleanupActiveWorktreesSync,
  createGit,
  isSafeRef,
  sweepStaleReplayHolders,
  type Git,
} from './replay-git.js';
import {
  checkSandboxSupport,
  killTrackedChildren,
  readClaudeHelp,
  SANDBOX_ARGS,
  SANDBOX_PERMISSION_MODE,
  trackedSpawner,
} from './replay-sandbox.js';
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
  /** Install SIGINT/SIGTERM handlers that kill the session and remove the clone. Default true. */
  handleSignals?: boolean;
  /** Help text of the installed claude CLI, for the sandbox check (tests). */
  claudeHelp?: () => Promise<string>;
  /** Process spawner behind the default reviewer spawner (tests). */
  processSpawn?: ProcessSpawner;
}

const DEFAULT_BASE_REF = 'origin/main';

/**
 * The production reviewer spawner. It is sandboxed: read-only tools, no MCP, no
 * project settings, no bypassPermissions (see replay-sandbox.ts).
 */
function sandboxedSpawner(processSpawn?: ProcessSpawner): SpawnerFactory {
  return ({ model, type }) =>
    new ShellClaudePSpawner({
      models: { [type]: model },
      permissionMode: SANDBOX_PERMISSION_MODE,
      extraArgs: SANDBOX_ARGS,
      spawn: trackedSpawner(processSpawn),
    });
}

const REPLAY_HELP = [
  'Cost: a replay spends real model usage. It refuses to run without --confirm-spend and prints',
  'the capped unit cost (items x mean units per review on record, bounded by --max-units) first.',
  '--dry-run needs no flag and calls no model.',
  '',
  'Sandbox: each review runs `claude -p` with read-only tools only (Read, Grep, Glob), no MCP,',
  'only user-level settings, no slash commands, no session transcript, permission mode dontAsk',
  'and prompts denied. It never uses bypassPermissions. If the installed claude lacks any of',
  'these flags the command refuses to run. The commit is checked out in a throwaway local clone',
  '(its own .git, no remote, hooks off, LFS and user git config off), never a linked worktree.',
  'Only the diff comes from the replayed commit, and it is marked untrusted in the prompt; the',
  'review policy and task spec come from your current checkout.',
  'Residual risk: the session is a model reading untrusted code with read-only tools. A',
  'malicious diff could still try to mislead the verdict or ask the model to echo file contents',
  'it can read inside the clone; CLAUDE.md loading is disabled by environment variable only.',
  '',
  'Labels: known-defect means a reviewer role recorded a critical or major finding on that',
  'commit and a later iteration of the same task was approved by every recorded reviewer with',
  'no critical or major finding. This is an inference from the ledger, not proof the finding',
  'was a real defect or that the later change fixed it. clean means approved on the first pass.',
].join('\n');

const CORPUS_HELP = [
  'Labels: known-defect means a reviewer role recorded a critical or major finding on that',
  'commit and a later iteration of the same task was approved by every recorded reviewer with',
  'no critical or major finding. This is an inference from the ledger, not proof the finding',
  'was a real defect or that the later change fixed it. clean means approved on the first pass',
  'with no critical or major finding. Commits already on the base ref (empty diff) are skipped.',
  'The corpus is built from this checkout only.',
].join('\n');

function artifactsDirFor(deps: ReplayDeps, repoRoot: string): string {
  return deps.artifactsDir ?? process.env.ARTIFACTS_DIR ?? resolve(repoRoot, 'artifacts');
}

/** Real path of the deepest existing ancestor of `path`, with the missing tail re-appended. */
function realDeepest(path: string): string {
  const full = resolve(path);
  let cur = full;
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...[...tail].reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return full;
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * True when `path` is the repository's `.ai-sdlc` directory or inside it,
 * compared by real path (so a symlinked parent does not hide it) and without
 * regard to case on case-insensitive file systems.
 */
export function isUnderAiSdlc(
  path: string,
  repoRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const fold = (p: string): string =>
    platform === 'darwin' || platform === 'win32' ? p.toLowerCase() : p;
  const rel = relative(fold(realDeepest(join(repoRoot, '.ai-sdlc'))), fold(realDeepest(path)));
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
                .epilog(CORPUS_HELP)
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
          })
          .option('confirm-spend', {
            type: 'boolean',
            default: false,
            description: 'Authorize the printed capped unit cost; required for a real run',
          })
          .epilog(REPLAY_HELP),
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

        // Cost gate: say what a run is allowed to spend, then refuse without an explicit flag.
        const shown = Math.min(maxItems, items.length);
        const mean = estimateUnitsPerReview(records, role, weights).meanUnitsPerReview;
        const estimated = mean === null ? null : mean * shown * models.length;
        const cap = estimated === null ? maxUnits : Math.min(maxUnits, estimated);
        const costLine =
          estimated === null
            ? `Spend cap: up to ${maxUnits.toLocaleString('en-US')} units (--max-units); no reviewer ` +
              `usage is on record, so there is no estimate. ${shown} item(s) x ${models.length} model(s).\n`
            : `Spend cap: about ${Math.round(cap).toLocaleString('en-US')} units ` +
              `(${shown} item(s) x ${models.length} model(s) x mean ${Math.round(mean as number).toLocaleString('en-US')} ` +
              `units per review, bounded by --max-units ${maxUnits.toLocaleString('en-US')}).\n`;
        io.out(costLine);
        if (!argv['confirm-spend']) {
          fail(io, 'Refusing to spend model usage without --confirm-spend. No model was called.');
          return;
        }

        // Fail closed: the production spawner needs every sandbox flag the CLI must support.
        const injected = deps.createSpawner;
        if (!injected) {
          const refusal = checkSandboxSupport(
            await (deps.claudeHelp ?? (() => readClaudeHelp(deps.runner)))(),
          );
          if (refusal) {
            fail(io, refusal);
            return;
          }
        }
        sweepStaleReplayHolders();

        const runId = runIdFor(now);
        const controller = new AbortController();
        const onSignal = (signal: NodeJS.Signals): void => {
          controller.abort();
          killTrackedChildren();
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
            createSpawner: injected ?? sandboxedSpawner(deps.processSpawn),
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
        } catch (err) {
          fail(io, `The replay could not complete: ${(err as Error).message}`);
        } finally {
          if (useSignals) {
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
          }
          killTrackedChildren();
          cleanupActiveWorktreesSync();
        }
      },
    );
}
