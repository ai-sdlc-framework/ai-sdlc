/**
 * `cli-memory-dream` (AISDLC-729): consolidate, prune and refine an agent
 * memory folder. `run` writes a new folder beside the input plus a report and
 * never touches the input; `apply` swaps it in (keeping previous versions);
 * `undo` swaps the previous version back.
 *
 * Prints counts and paths only, never note content.
 *
 * @module cli/memory-dream
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { applyDream, undoDream } from '../memory-dream/apply.js';
import { DEFAULT_BUDGETS, type Budgets } from '../memory-dream/build-output.js';
import { ClaudeSynthesizer } from '../memory-dream/claude-synthesizer.js';
import { projectSlug, resolveMemoryDir } from '../memory-dream/resolve-dir.js';
import { type RunResult, runDream } from '../memory-dream/run.js';
import type { Synthesizer } from '../memory-dream/synthesis.js';

export interface DreamCliIo {
  out: (line: string) => void;
  synthesizer: Synthesizer;
}

export interface RunArgs {
  dir?: string;
  projectDir?: string;
  instructions?: string;
  dryRun?: boolean;
  model?: string;
  indexMaxLines?: number;
  indexMaxBytes?: number;
  noteMaxBytes?: number;
  allowLowConfidence?: boolean;
  mineTranscripts?: string;
  addProposals?: boolean;
  format?: string;
}

export function budgetsFrom(a: RunArgs): Budgets {
  return {
    ...DEFAULT_BUDGETS,
    indexMaxLines: a.indexMaxLines ?? DEFAULT_BUDGETS.indexMaxLines,
    indexMaxBytes: a.indexMaxBytes ?? DEFAULT_BUDGETS.indexMaxBytes,
    noteMaxBytes: a.noteMaxBytes ?? DEFAULT_BUDGETS.noteMaxBytes,
  };
}

function memoryDirFor(a: { dir?: string; projectDir?: string }): string {
  const projectDir = resolve(a.projectDir ?? process.cwd());
  return a.dir ? resolve(a.dir) : resolveMemoryDir({ projectDir });
}

export function summaryLines(r: RunResult): string[] {
  const { report } = r;
  const m = report.mechanical;
  const L = [
    `memory-dream ${report.dryRun ? 'dry run' : 'run'}: ${report.synthesisInput.notes} notes, ${report.synthesisInput.bytes} bytes, about ${report.synthesisInput.estimatedInputTokens} input tokens (estimate)`,
    `mechanical: ${m.unindexed.length} unindexed, ${m.indexMissingFile.length} index entries for missing files, ${m.danglingLinks.length} dangling links (${m.repairableLinks.length} repairable), ${m.invalidFrontmatter.length} invalid frontmatter, ${m.longIndexLines.length} long index lines`,
  ];
  if (report.dryRun) {
    L.push(
      'dry run: the synthesis pass would read every note above; no model call, nothing written',
    );
  } else if (report.after && report.budgetsMet) {
    const a = report.after;
    const b = report.before;
    L.push(
      `notes ${b.notes} -> ${a.notes} (+${a.archivedNotes} archived), index ${b.indexLines} lines/${b.indexBytes} bytes -> ${a.indexLines} lines/${a.indexBytes} bytes, dangling links ${b.danglingLinks} -> ${a.danglingLinks}`,
      `budgets: index ${report.budgetsMet.index ? 'met' : 'NOT met'}, notes ${report.budgetsMet.notes ? 'met' : 'NOT met'}`,
    );
    const u = report.usage;
    if (u)
      L.push(
        `tokens (${u.model}, ${u.calls} call(s)): input ${u.inputTokens}, cache write ${u.cacheWrite5mTokens}, cache read ${u.cacheReadTokens}, output ${u.outputTokens}`,
      );
    L.push(`output (unapplied): ${r.outputDir}`, `report: ${r.reportPaths?.md}`);
  }
  for (const w of report.warnings) L.push(`warning: ${w}`);
  if (report.suggestion) L.push(`suggestion: ${report.suggestion}`);
  return L;
}

export async function cmdRun(a: RunArgs, io: DreamCliIo): Promise<RunResult> {
  const memoryDir = memoryDirFor(a);
  const projectDir = resolve(a.projectDir ?? process.cwd());
  const mineTranscriptsDir =
    a.mineTranscripts === undefined
      ? undefined
      : a.mineTranscripts || join(homedir(), '.claude', 'projects', projectSlug(projectDir));
  const result = await runDream({
    memoryDir,
    model: a.model ?? 'sonnet',
    instructions: a.instructions,
    dryRun: a.dryRun === true,
    budgets: budgetsFrom(a),
    allowLowConfidence: a.allowLowConfidence,
    mineTranscriptsDir,
    addProposals: a.addProposals,
    synthesizer: io.synthesizer,
  });
  if (a.format === 'json')
    io.out(JSON.stringify({ ...result.report, reportPaths: result.reportPaths }, null, 2));
  else for (const l of summaryLines(result)) io.out(l);
  return result;
}

export function cmdApply(a: { output: string; keep?: number }, io: Pick<DreamCliIo, 'out'>): void {
  const r = applyDream({ outputDir: resolve(a.output), keep: a.keep });
  io.out(`applied: ${r.liveDir} now holds the dream output`);
  io.out(`previous version kept at ${r.previousVersion} (undo with: memory-dream undo)`);
  io.out(
    r.carriedOver.length > 0
      ? `carried over ${r.carriedOver.length} note(s) added or changed since the run started: ${r.carriedOver.join(', ')}`
      : 'no notes were added or changed since the run started',
  );
  if (r.pruned.length > 0) io.out(`pruned ${r.pruned.length} older version(s)`);
}

export function cmdUndo(
  a: { dir?: string; projectDir?: string },
  io: Pick<DreamCliIo, 'out'>,
): void {
  const r = undoDream({ liveDir: memoryDirFor(a) });
  io.out(`restored ${r.liveDir} from ${r.restoredFrom}`);
  io.out(`the folder you undid is kept at ${r.currentSavedAs}`);
}

export async function runMemoryDreamCli(): Promise<void> {
  const out = (l: string): void => void process.stdout.write(`${l}\n`);
  await yargs(hideBin(process.argv))
    .scriptName('cli-memory-dream')
    .usage('$0 <command> [options]')
    .command(
      'run',
      'Consolidate the memory folder into a new folder beside it (input never modified)',
      (y) =>
        y
          .option('dir', {
            type: 'string',
            description: 'Memory folder (default: autoMemoryDirectory, else harness default)',
          })
          .option('project-dir', {
            type: 'string',
            description: 'Project root used to resolve settings (default: cwd)',
          })
          .option('instructions', {
            type: 'string',
            description: 'Steer focus and what to preserve',
          })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            description: 'Mechanical pass only; no model call, no writes',
          })
          .option('model', { type: 'string', default: 'sonnet' })
          .option('index-max-lines', { type: 'number' })
          .option('index-max-bytes', { type: 'number' })
          .option('note-max-bytes', { type: 'number' })
          .option('allow-low-confidence', {
            type: 'boolean',
            default: false,
            description: 'Apply merges the model marked low confidence',
          })
          .option('mine-transcripts', {
            type: 'string',
            description: 'Opt in to transcript mining (optional folder); proposals only',
          })
          .option('add-proposals', {
            type: 'boolean',
            default: false,
            description: 'Add mined proposals to the output (explicit)',
          })
          .option('format', { type: 'string', choices: ['text', 'json'], default: 'text' }),
      async (argv) => {
        await cmdRun(argv as unknown as RunArgs, { out, synthesizer: new ClaudeSynthesizer() });
      },
    )
    .command(
      'apply <output>',
      'Swap a reviewed dream output in for the live folder, keeping previous versions',
      (y) =>
        y.positional('output', { type: 'string', demandOption: true }).option('keep', {
          type: 'number',
          default: 3,
          description: 'Previous versions to keep (minimum 3)',
        }),
      (argv) => cmdApply({ output: argv.output as string, keep: argv.keep }, { out }),
    )
    .command(
      'undo',
      'Restore the most recent previous version',
      (y) => y.option('dir', { type: 'string' }).option('project-dir', { type: 'string' }),
      (argv) => cmdUndo(argv as { dir?: string; projectDir?: string }, { out }),
    )
    .demandCommand(1)
    .strict()
    .help()
    .parseAsync();
}
