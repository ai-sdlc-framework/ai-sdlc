/**
 * `cli-import-spec` — RFC-0036 Phase 4/5 spec-kit import CLI.
 *
 * Usage: `cli-import-spec --from <path> [options]`
 *
 * Reads spec-kit `tasks.md`, runs the RFC-0011 DoR Gate against each
 * generated task (Phase 5, AISDLC-330), and produces one backlog task
 * per upstream task entry that passes — each carrying a `specRef:`
 * back-reference to the upstream artifact. Failure modes (missing
 * tasks.md, unknown schema, DoR-failed tasks under strict mode) route
 * through the Decision Catalog per OQ-1 / OQ-11 / OQ-10.
 *
 * @module cli/import-spec
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { importSpec, type ImportSpecResult } from '../import-spec/import.js';
import type { DorStrictness } from '../import-spec/config.js';
import { describeFailedGates } from '../import-spec/dor-at-import.js';

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function fail(reason: string, code = 1): never {
  process.stderr.write(`[cli-import-spec] error: ${reason}\n`);
  process.exit(code);
}

/**
 * Render the import outcome as human-readable text. The default output
 * mode (mirrors `cli-decisions` convention). When DoR strictness is
 * active and one or more tasks were refused, the renderer surfaces the
 * upstream clarification tasks the operator should triage.
 */
export function renderTextOutcome(result: ImportSpecResult): string {
  const lines: string[] = [];
  const o = result.outcome;
  if (o.kind === 'imported') {
    lines.push(
      `Imported ${o.writtenTasks.length} task(s) from ${o.tasksMdPath} (feature: ${o.featureId}, rubric: ${o.strictness})`,
    );
    for (const t of o.writtenTasks) {
      lines.push(`  - ${t.id} (upstream ${t.upstreamTaskId}) → ${t.filePath}`);
    }

    // Per-task DoR summary — warnings under --rubric warn and
    // analyze-auto-resolved Decisions are visible here so the operator
    // sees them without combing the calibration log.
    const warned = o.perTaskDor.filter((p) => p.outcome.kind === 'admitted-with-warnings');
    if (warned.length > 0) {
      lines.push('');
      lines.push(`Admitted with warnings (${warned.length}):`);
      for (const p of warned) {
        if (p.outcome.kind !== 'admitted-with-warnings') continue; // type narrow
        lines.push(
          `  - ${p.upstreamTaskId}: failing ${describeFailedGates(p.outcome.failedGates)}`,
        );
      }
    }

    const autoResolved = o.perTaskDor
      .map((p) => p.outcome.autoResolvedDecisionIds)
      .reduce((a, b) => a + b.length, 0);
    if (autoResolved > 0) {
      lines.push('');
      lines.push(`Auto-resolved by analyze metadata: ${autoResolved} decision(s) (OQ-7)`);
    }

    if (o.refusedTasks.length > 0) {
      lines.push('');
      lines.push(`Refused (strict DoR, OQ-3 + OQ-10): ${o.refusedTasks.length} upstream task(s)`);
      for (const r of o.refusedTasks) {
        if (r.outcome.kind !== 'refused-strict') continue; // type narrow
        lines.push(
          `  - ${r.upstreamTaskId}: failing ${describeFailedGates(r.outcome.failedGates)}`,
        );
        if (r.outcome.decisionId) lines.push(`      Decision: ${r.outcome.decisionId}`);
        if (r.outcome.clarificationTaskFile)
          lines.push(`      Clarification task: ${r.outcome.clarificationTaskFile}`);
      }
    }
  } else if (o.kind === 'incomplete-spec') {
    lines.push(`incomplete-spec-detected (${o.reason})`);
    if (o.decision.decisionId) lines.push(`  Decision: ${o.decision.decisionId}`);
    if (o.decision.clarificationTaskFile)
      lines.push(`  Clarification task: ${o.decision.clarificationTaskFile}`);
  } else {
    lines.push(`upstream-schema-unknown (${o.tasksMdPath})`);
    if (o.decision.decisionId) lines.push(`  Decision: ${o.decision.decisionId}`);
    if (o.decision.clarificationTaskFile)
      lines.push(`  Clarification task: ${o.decision.clarificationTaskFile}`);
  }
  return lines.join('\n') + '\n';
}

export function buildImportSpecCli(): Argv {
  return yargs(hideBin(process.argv))
    .scriptName('cli-import-spec')
    .usage(
      'Usage: $0 --from <path> [options]\n\n' +
        'RFC-0036 Phase 4-5 spec-kit import. Reads spec-kit `tasks.md` and writes\n' +
        'one backlog task per upstream task entry with `specRef:` back-references.\n' +
        'Phase 5 (AISDLC-330) wires the DoR Gate at import time:\n' +
        '  - strict (default): failing tasks REFUSE import; clarification task\n' +
        '    emitted back to spec-kit per OQ-10.\n' +
        '  - warn (--rubric warn): failing tasks admit with warnings surfaced.\n' +
        '  - .specify/analyze.json auto-resolves matching gates via the Decision\n' +
        '    Catalog per OQ-7 — only NEW gaps reach the operator.\n\n' +
        'No drift / reconcile yet — that ships in Phase 6 (AISDLC-331).',
    )
    .option('from', {
      type: 'string',
      describe:
        'Path to the spec-kit feature directory (containing `tasks.md`) or the `tasks.md` file directly.',
      demandOption: true,
    })
    .option('work-dir', {
      alias: 'w',
      type: 'string',
      describe: 'Project root for backlog writes + decision events. Defaults to cwd.',
      default: process.cwd(),
    })
    .option('rubric', {
      type: 'string',
      choices: ['strict', 'warn'] as const,
      describe:
        'DoR strictness at import (OQ-3). strict = refuse on DoR failure (default); ' +
        'warn = admit task and surface warnings.',
    })
    .option('analyze-metadata', {
      type: 'string',
      describe:
        'Override path to spec-kit analyze.json (OQ-7). Relative to --work-dir. ' +
        'Defaults to .specify/analyze.json.',
    })
    .option('format', {
      type: 'string',
      choices: ['text', 'json'] as const,
      default: 'text' as const,
      describe: 'Output mode.',
    })
    .help()
    .strict();
}

export async function runImportSpecCli(): Promise<void> {
  const argv = await buildImportSpecCli().parseAsync();
  const from = String(argv.from);
  const workDir = String(argv['work-dir']);
  const strictness = argv.rubric as DorStrictness | undefined;
  const analyzeMetadataPath = argv['analyze-metadata'] as string | undefined;

  if (!from.trim()) fail('--from is required');

  let result: ImportSpecResult;
  try {
    const opts: Parameters<typeof importSpec>[0] = { from, workDir };
    if (strictness !== undefined) opts.strictness = strictness;
    if (analyzeMetadataPath !== undefined) opts.analyzeMetadataPath = analyzeMetadataPath;
    result = await importSpec(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(msg);
  }

  if (String(argv.format) === 'json') {
    emit({ ok: true, ...result });
  } else {
    emitText(renderTextOutcome(result));
  }

  // Exit code conventions:
  //   - imported (no refusals): 0
  //   - imported with refusals: 0 — Decisions + clarification tasks were
  //     emitted; the operator's normal triage picks them up. Callers
  //     wanting to gate CI on strict-mode refusals can use `--format json`
  //     and inspect `outcome.refusedTasks.length`.
  //   - incomplete-spec / unknown-schema: 0 (non-blocking per G0).
}
