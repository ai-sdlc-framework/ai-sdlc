/**
 * `cli-estimate-classes` subcommand router — RFC-0016 Phase 6 (AISDLC-284).
 *
 * Subcommands:
 *  - `review` — list pending class proposals from
 *               `.ai-sdlc/estimate-classes-proposed.jsonl` and display
 *               auto-promotable clusters (AC #4).
 *  - `promote` — auto-promote clusters with ≥N proposals to
 *                `.ai-sdlc/estimate-classes.yaml` (AC #5). Also available
 *                as `review --auto-promote`.
 *  - `list` — list the current class ontology from
 *             `.ai-sdlc/estimate-classes.yaml` (starter classes + promoted).
 *
 * Behind feature flag `AI_SDLC_ESTIMATION_CALIBRATION=experimental` —
 * degrades open (prints disabled message + exits 0) when the flag is off.
 *
 * @module cli/estimate-classes
 */

import { join } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  ESTIMATION_FLAG,
  estimationDisabledMessage,
  isEstimationEnabled,
} from '../estimation/feature-flag.js';
import {
  autoPromote,
  listPendingProposals,
  readClassesYaml,
  STARTER_CLASSES,
  type ProposalCluster,
} from '../estimation/class-proposals.js';

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

// ── Table renderers ───────────────────────────────────────────────────────

function renderProposalClusters(clusters: ProposalCluster[], autoPromoteThreshold: number): string {
  if (clusters.length === 0) {
    return 'No pending class proposals.\n';
  }

  const lines: string[] = [];
  lines.push(`Pending class proposals  (auto-promote threshold: ≥${autoPromoteThreshold})`);
  lines.push('='.repeat(60));
  lines.push('');

  for (const cluster of clusters) {
    const badge = cluster.autoPromotable ? ' [AUTO-PROMOTABLE ✓]' : '';
    lines.push(
      `Class: ${cluster.canonicalName}${badge}  (${cluster.count} proposal${cluster.count !== 1 ? 's' : ''})`,
    );
    lines.push(`  Definition: ${cluster.structure.definition}`);
    if (cluster.structure.exemplars.length > 0) {
      lines.push(`  Exemplars:`);
      for (const ex of cluster.structure.exemplars.slice(0, 2)) {
        lines.push(`    - ${ex}`);
      }
    }
    if (cluster.structure.synonyms.length > 0) {
      lines.push(`  Synonyms: ${cluster.structure.synonyms.join(', ')}`);
    }
    lines.push(`  Proposals (newest first):`);
    for (const p of cluster.proposals.slice(0, 3)) {
      lines.push(`    [${p.ts.slice(0, 10)}] ${p.taskId}  confidence=${p.confidence.toFixed(2)}`);
      if (p.rationale) lines.push(`      "${p.rationale}"`);
    }
    if (cluster.proposals.length > 3) {
      lines.push(`    … and ${cluster.proposals.length - 3} more`);
    }
    lines.push('');
  }

  const autoCount = clusters.filter((c) => c.autoPromotable).length;
  lines.push(
    `${clusters.length} cluster(s) pending.  ${autoCount} auto-promotable (≥${autoPromoteThreshold} proposals).`,
  );
  lines.push('Run `cli-estimate-classes promote` to apply auto-promotable clusters.');

  return lines.join('\n') + '\n';
}

function renderClassList(
  classes: Record<
    string,
    { definition: string; exemplars: string[]; anti_patterns: string[]; synonyms: string[] }
  >,
): string {
  const names = Object.keys(classes);
  if (names.length === 0) {
    return 'No classes defined.\n';
  }

  const lines: string[] = [];
  lines.push(`Task-class ontology  (${names.length} class${names.length !== 1 ? 'es' : ''})`);
  lines.push('='.repeat(50));
  lines.push('');

  const starters = new Set(Object.keys(STARTER_CLASSES));
  for (const name of names) {
    const s = classes[name]!;
    const tag = starters.has(name) ? ' [starter]' : ' [promoted]';
    lines.push(`${name}${tag}`);
    lines.push(`  ${s.definition}`);
    if (s.synonyms.length > 0) {
      lines.push(`  Synonyms: ${s.synonyms.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

// ── CLI builder ───────────────────────────────────────────────────────────

export function buildEstimateClassesCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-estimate-classes')
    .usage('Usage: $0 <command> [options]')
    .command(
      'review',
      'List pending class proposals. Shows auto-promotable clusters.',
      (y) =>
        y
          .option('workdir', {
            type: 'string',
            default: process.cwd(),
            describe: 'Project root containing .ai-sdlc/.',
          })
          .option('threshold', {
            type: 'number',
            default: 3,
            describe: 'Minimum proposal count for auto-promotion.',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table' as const,
          })
          .option('auto-promote', {
            type: 'boolean',
            default: false,
            describe: 'Immediately promote all auto-promotable clusters.',
          }),
      (argv) => {
        if (!isEstimationEnabled()) {
          process.stderr.write(estimationDisabledMessage() + '\n');
          emit({ ok: false, disabled: true, flag: ESTIMATION_FLAG });
          return;
        }
        try {
          const aiSdlcDir = join(String(argv.workdir), '.ai-sdlc');
          const threshold = Number(argv.threshold);

          // Optionally auto-promote first.
          let promotionResult: ReturnType<typeof autoPromote> | null = null;
          if (argv['auto-promote']) {
            promotionResult = autoPromote({ aiSdlcDir, autoPromoteThreshold: threshold });
          }

          const clusters = listPendingProposals({
            aiSdlcDir,
            autoPromoteThreshold: threshold,
          });

          if (argv.format === 'json') {
            emit({
              ok: true,
              clusters,
              promotion: promotionResult,
            });
          } else {
            if (promotionResult && promotionResult.promotedCount > 0) {
              emitText(
                `Auto-promoted ${promotionResult.promotedCount} class(es): ${promotionResult.promotedClasses.join(', ')}\n`,
              );
            }
            emitText(renderProposalClusters(clusters, threshold));
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .command(
      'promote',
      'Auto-promote clusters with ≥N proposals to estimate-classes.yaml.',
      (y) =>
        y
          .option('workdir', {
            type: 'string',
            default: process.cwd(),
            describe: 'Project root containing .ai-sdlc/.',
          })
          .option('threshold', {
            type: 'number',
            default: 3,
            describe: 'Minimum proposal count for auto-promotion.',
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
          const aiSdlcDir = join(String(argv.workdir), '.ai-sdlc');
          const threshold = Number(argv.threshold);
          const result = autoPromote({
            aiSdlcDir,
            autoPromoteThreshold: threshold,
          });

          if (argv.format === 'json') {
            emit({ ok: true, ...result });
          } else {
            if (result.promotedCount > 0) {
              emitText(
                `Promoted ${result.promotedCount} class(es): ${result.promotedClasses.join(', ')}\n`,
              );
              emitText(`Updated: .ai-sdlc/estimate-classes.yaml\n`);
            } else {
              emitText('No clusters met the auto-promote threshold. Nothing promoted.\n');
            }
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .command(
      'list',
      'List the current class ontology (starter + promoted classes).',
      (y) =>
        y
          .option('workdir', {
            type: 'string',
            default: process.cwd(),
            describe: 'Project root containing .ai-sdlc/.',
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
          const aiSdlcDir = join(String(argv.workdir), '.ai-sdlc');
          const classes = readClassesYaml(aiSdlcDir);

          if (argv.format === 'json') {
            emit({ ok: true, classes });
          } else {
            emitText(renderClassList(classes));
          }
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    )
    .demandCommand(1, 'A subcommand is required (try `review`, `promote`, or `list`).')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

export async function runEstimateClassesCli(): Promise<void> {
  await buildEstimateClassesCli().parseAsync();
}
