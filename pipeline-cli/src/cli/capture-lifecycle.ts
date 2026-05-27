/**
 * `cli-capture-lifecycle` — RFC-0024 §15.1 lifecycle timer CLI (AISDLC-278).
 *
 * Orchestrates the §15.1 timebox + default-on-silence substrate. Meant to run
 * from an orchestrator-tick hook or a cron job (e.g. `0 * * * *`).
 *
 * Subcommands:
 *   tick                  — Run a full lifecycle tick (all OQ-1/2/5/6/9 checks).
 *   reactivate <id>       — Re-activate an archived capture (§15.1 reversibility).
 *   list-archived         — List captures in backlog/captures/archived/.
 *   show-config           — Print the resolved lifecycle config (defaults + overrides).
 *
 * Feature flag: `AI_SDLC_EMERGENT_CAPTURE`. When unset, exits with "not enabled".
 *
 * @module cli/capture-lifecycle
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  loadCaptureLifecycleConfig,
  runLifecycleTick,
  reactivateCapture,
  loadArchivedCaptures,
  resolveArchivedDir,
  checkRateCeiling,
  LIFECYCLE_DEFAULTS,
  type LifecycleTickResult,
} from '../capture/capture-lifecycle.js';
import { resolveRepoRoot } from '../capture/draft-capture.js';
import { loadConfiguredInvoker } from '../capture/invoker-loader.js';

// ── Feature flag ──────────────────────────────────────────────────────────────

const TRUTHY_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on', 'experimental']);

function isFeatureFlagEnabled(): boolean {
  const val = process.env.AI_SDLC_EMERGENT_CAPTURE ?? '';
  return TRUTHY_FLAG_VALUES.has(val.toLowerCase());
}

function requireFeatureFlag(): void {
  if (!isFeatureFlagEnabled()) {
    process.stderr.write(
      '[cli-capture-lifecycle] emergent capture is not enabled.\n' +
        'Set AI_SDLC_EMERGENT_CAPTURE=experimental to enable.\n' +
        'See spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md §14 for details.\n',
    );
    process.exit(1);
  }
}

// ── Output helpers ────────────────────────────────────────────────────────────

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

// ── Tick result renderer ──────────────────────────────────────────────────────

/**
 * Render a `LifecycleTickResult` as a human-readable summary.
 * Exported for testing.
 */
export function renderTickResult(result: LifecycleTickResult): string {
  const lines: string[] = ['[cli-capture-lifecycle] tick complete\n'];

  if (result.submittedDrafts.length > 0) {
    lines.push(`  ✓ OQ-1 auto-submitted ${result.submittedDrafts.length} draft(s):`);
    for (const id of result.submittedDrafts) {
      lines.push(`    ${id}`);
    }
  } else {
    lines.push('  OQ-1 drafts: none expired');
  }

  const classified = result.pendingTriageAutoClassified.classified.filter((c) => c.applied);
  const classifySkipped = result.pendingTriageAutoClassified.classified.filter((c) => !c.applied);
  if (classified.length > 0) {
    lines.push(`  ✓ OQ-2 auto-classified triage for ${classified.length} capture(s):`);
    for (const c of classified) {
      lines.push(`    ${c.id}: ${c.reason}`);
    }
  }
  if (classifySkipped.length > 0) {
    lines.push(`  ⚠ OQ-2 ${classifySkipped.length} pending-triage capture(s) need attention:`);
    for (const c of classifySkipped) {
      lines.push(`    ${c.id}: ${c.reason}`);
    }
  }
  if (classified.length === 0 && classifySkipped.length === 0) {
    lines.push('  OQ-2 pending-triage: none expired');
  }

  const sevClassified = result.unknownSeverityAutoClassified.classified.filter((c) => c.applied);
  const sevSkipped = result.unknownSeverityAutoClassified.classified.filter((c) => !c.applied);
  if (sevClassified.length > 0) {
    lines.push(`  ✓ OQ-5 auto-classified severity for ${sevClassified.length} capture(s):`);
    for (const c of sevClassified) {
      lines.push(`    ${c.id}: ${c.reason}`);
    }
  }
  if (sevSkipped.length > 0) {
    lines.push(`  ⚠ OQ-5 ${sevSkipped.length} unknown-severity capture(s) need attention:`);
    for (const c of sevSkipped) {
      lines.push(`    ${c.id}: ${c.reason}`);
    }
  }
  if (sevClassified.length === 0 && sevSkipped.length === 0) {
    lines.push('  OQ-5 unknown-severity: none expired');
  }

  const freshActions = result.staleLadder.actions.filter((a) => !a.alreadyApplied);
  if (freshActions.length > 0) {
    lines.push(`  OQ-9 stale ladder — ${freshActions.length} action(s) fired:`);
    for (const a of freshActions) {
      lines.push(`    ${a.captureId}: ${a.action} (${a.ageDays}d old)`);
    }
  } else {
    lines.push('  OQ-9 stale ladder: no new actions');
  }
  if (result.staleLadder.archived.length > 0) {
    lines.push(
      `  ✓ Archived ${result.staleLadder.archived.length} capture(s) → backlog/captures/archived/`,
    );
  }

  if (result.rateCeilingViolations.length > 0) {
    lines.push(
      `  ⚠ OQ-6 rate ceiling exceeded for ${result.rateCeilingViolations.length} role(s):`,
    );
    for (const v of result.rateCeilingViolations) {
      lines.push(`    ${v.agentRole}: ${v.dailyCount} today (ceiling: ${v.ceiling})`);
    }
  } else {
    lines.push('  OQ-6 rate ceiling: within bounds');
  }

  return lines.join('\n');
}

// ── CLI builder ───────────────────────────────────────────────────────────────

export function buildCaptureLifecycleCli(): Argv {
  return (
    yargs(hideBin(process.argv))
      .scriptName('cli-capture-lifecycle')
      .usage(
        'Usage: $0 <command> [options]\n\n' +
          'RFC-0024 §15.1 capture lifecycle timer CLI (AISDLC-278).\n' +
          'Run from orchestrator-tick or cron to fire capture lifecycle auto-actions.',
      )
      // ── tick ─────────────────────────────────────────────────────────────────
      .command(
        'tick',
        'Run a full §15.1 lifecycle tick (OQ-1/2/5/6/9 expiry checks).',
        (y) =>
          y
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'table',
              describe: 'Output format.',
            })
            .option('dry-run', {
              type: 'boolean',
              default: false,
              describe:
                'Print what would be done without making changes (currently shows config + staleness preview only; full dry-run not yet implemented).',
            }),
        async (argv) => {
          requireFeatureFlag();

          const repoRoot = resolveRepoRoot();
          const invoker = await loadConfiguredInvoker({ repoRoot });

          if (argv['dry-run']) {
            const config = loadCaptureLifecycleConfig(repoRoot);
            emitText('[cli-capture-lifecycle] dry-run — resolved config:');
            emit(config);
            return;
          }

          const result = await runLifecycleTick({
            repoRoot,
            invoker,
          });

          if (String(argv.format) === 'json') {
            emit(result);
          } else {
            emitText(renderTickResult(result));
          }
        },
      )
      // ── reactivate ────────────────────────────────────────────────────────────
      .command(
        'reactivate <id>',
        'Re-activate an archived capture (§15.1 OQ-9 reversibility). Moves back to backlog/captures/.',
        (y) =>
          y
            .positional('id', {
              type: 'string',
              demandOption: true,
              describe: 'Capture ID (e.g. cap_2026-05-24T00-00-00_abc123).',
            })
            .option('reason', {
              type: 'string',
              describe: 'Reason for re-activation (recorded in audit trail).',
            })
            .option('by', {
              type: 'string',
              describe: 'Who is re-activating. Defaults to git config user.email.',
            })
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'table',
            }),
        async (argv) => {
          requireFeatureFlag();

          const repoRoot = resolveRepoRoot();
          let by = argv.by as string | undefined;
          if (!by) {
            try {
              const { spawnSync } = await import('node:child_process');
              const r = spawnSync('git', ['config', 'user.email'], {
                encoding: 'utf8',
                stdio: 'pipe',
              });
              by = r.stdout?.trim() || process.env.USER || 'unknown';
            } catch {
              by = process.env.USER || 'unknown';
            }
          }

          const reactivated = reactivateCapture({
            captureId: String(argv.id),
            by,
            reason: argv.reason as string | undefined,
            repoRoot,
          });

          if (String(argv.format) === 'json') {
            emit(reactivated);
          } else {
            emitText(
              `✓ Re-activated ${reactivated.id}\n` +
                `  → backlog/captures/${reactivated.id}.md\n` +
                `  Finding: ${reactivated.finding}\n`,
            );
          }
        },
      )
      // ── list-archived ─────────────────────────────────────────────────────────
      .command(
        'list-archived',
        'List captures in backlog/captures/archived/.',
        (y) =>
          y.option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table',
          }),
        (argv) => {
          requireFeatureFlag();

          const repoRoot = resolveRepoRoot();
          const records = loadArchivedCaptures(repoRoot);

          if (String(argv.format) === 'json') {
            emit({ archived: records, count: records.length });
            return;
          }

          if (records.length === 0) {
            emitText('(no archived captures)');
            return;
          }

          emitText(`Archived captures (${records.length}):\n`);
          const dir = resolveArchivedDir(repoRoot);
          for (const r of records) {
            const archivedEntry = r.auditTrail.find((e) => e.action === 'archived');
            const archivedAt = archivedEntry ? String(archivedEntry.at).slice(0, 10) : '(unknown)';
            emitText(
              `  ${r.id.slice(0, 24)}  archived: ${archivedAt}  finding: ${
                r.finding.length > 50 ? r.finding.slice(0, 47) + '...' : r.finding
              }`,
            );
          }
          emitText(`\nDirectory: ${dir}`);
        },
      )
      // ── show-config ───────────────────────────────────────────────────────────
      .command(
        'show-config',
        'Print the resolved §15.1 lifecycle config (framework defaults + .ai-sdlc/capture-config.yaml overrides).',
        (y) =>
          y.option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table',
          }),
        (argv) => {
          const repoRoot = resolveRepoRoot();
          const config = loadCaptureLifecycleConfig(repoRoot);

          if (String(argv.format) === 'json') {
            emit({ config, defaults: LIFECYCLE_DEFAULTS });
            return;
          }

          emitText('[cli-capture-lifecycle] resolved lifecycle config:\n');
          emitText(`  draftAutoSubmitDays:   ${config.draftAutoSubmitDays}d`);
          emitText(`  pendingTriageDays:     ${config.pendingTriageDays}d`);
          emitText(`  unknownSeverityDays:   ${config.unknownSeverityDays}d`);
          emitText('  staleNotificationLadder:');
          emitText(`    tuiHighlightDays:    ${config.staleNotificationLadder.tuiHighlightDays}d`);
          emitText(`    slackDmDays:         ${config.staleNotificationLadder.slackDmDays}d`);
          emitText(`    emailDigestDays:     ${config.staleNotificationLadder.emailDigestDays}d`);
          emitText(`    autoArchiveDays:     ${config.staleNotificationLadder.autoArchiveDays}d`);
          emitText('  rateCeiling:');
          emitText(`    dailyCapPerAgentRole: ${config.rateCeiling.dailyCapPerAgentRole}`);
          const overrides = Object.entries(config.rateCeiling.perAgentRoleOverrides);
          if (overrides.length > 0) {
            emitText('    perAgentRoleOverrides:');
            for (const [role, cap] of overrides) {
              emitText(`      ${role}: ${cap}`);
            }
          }
        },
      )
      // ── volume-report (OQ-6 convenience command) ───────────────────────────────
      .command(
        'volume-report',
        "Report today's capture submission count per agent role (OQ-6 rate ceiling visibility).",
        (y) =>
          y.option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table',
          }),
        (argv) => {
          requireFeatureFlag();

          const repoRoot = resolveRepoRoot();
          const config = loadCaptureLifecycleConfig(repoRoot);
          const violations = checkRateCeiling({ config, repoRoot });

          if (String(argv.format) === 'json') {
            emit({ violations, ceiling: config.rateCeiling.dailyCapPerAgentRole });
            return;
          }

          if (violations.length === 0) {
            emitText('(no rate ceiling violations today)');
          } else {
            emitText('OQ-6 rate ceiling violations (today):\n');
            for (const v of violations) {
              emitText(
                `  ⚠ ${v.agentRole}: ${v.dailyCount} submissions today (ceiling: ${v.ceiling})`,
              );
            }
          }
        },
      )
      .demandCommand(
        1,
        'A subcommand is required. Run `cli-capture-lifecycle --help` for the list.',
      )
      .strict()
      .help()
      .alias('h', 'help')
      .version(false)
  );
}

export async function runCaptureLifecycleCli(): Promise<void> {
  await buildCaptureLifecycleCli().parseAsync();
}
