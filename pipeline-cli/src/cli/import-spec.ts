/**
 * `cli-import-spec` — RFC-0036 Phase 4 (AISDLC-329) spec-kit import CLI.
 *
 * Usage: `cli-import-spec --from <path> [options]`
 *
 * Reads spec-kit `tasks.md` and produces one backlog task per upstream
 * task entry, each carrying a `specRef:` back-reference to the upstream
 * artifact. Failure modes (missing tasks.md, unknown schema) route through
 * the Decision Catalog per OQ-1 + OQ-11. Phase 4 stops here — DoR at
 * import is Phase 5 (AISDLC-330); reconcile is Phase 6 (AISDLC-331).
 *
 * @module cli/import-spec
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import { importSpec, type ImportSpecResult } from '../import-spec/import.js';

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
 * mode (mirrors `cli-decisions` convention).
 */
export function renderTextOutcome(result: ImportSpecResult): string {
  const lines: string[] = [];
  const o = result.outcome;
  if (o.kind === 'imported') {
    lines.push(
      `Imported ${o.writtenTasks.length} task(s) from ${o.tasksMdPath} (feature: ${o.featureId})`,
    );
    for (const t of o.writtenTasks) {
      lines.push(`  - ${t.id} (upstream ${t.upstreamTaskId}) → ${t.filePath}`);
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
        'RFC-0036 Phase 4 (AISDLC-329) spec-kit import. Reads spec-kit `tasks.md` and\n' +
        'writes one backlog task per upstream task entry with `specRef:` back-references.\n\n' +
        'No drift / reconcile yet — that ships in Phase 6 (AISDLC-331).\n' +
        'No DoR at import yet — that ships in Phase 5 (AISDLC-330).',
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
  if (!from.trim()) fail('--from is required');

  let result: ImportSpecResult;
  try {
    result = importSpec({ from, workDir });
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
  //   - imported: 0
  //   - incomplete-spec / unknown-schema: 0 (non-blocking per G0; Decision
  //     was emitted; operator triages via the clarification task). The
  //     caller wanting to gate on success/failure can use `--format json`
  //     and inspect `outcome.kind`.
}
