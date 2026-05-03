/**
 * `cli-deps` subcommand router.
 *
 * Exposes the dependency-graph queries as top-level subcommands so the
 * orchestrator (Tier 1, slash command body) and operators on the terminal
 * can call them without spinning up the full pipeline.
 *
 * Subcommands:
 *  - `frontier`            — list open tasks whose dependencies are all completed
 *  - `blockers <task-id>`  — list open tasks that gate the target (transitive)
 *  - `impact <task-id>`    — list open tasks that would unblock if target ships
 *  - `validate`            — detect cycles + dangling refs
 *  - `graph`               — emit mermaid or DOT
 *  - `preflight <task-id>` — refuse to start a task whose deps aren't all Done
 *
 * Output is JSON on stdout by default; pass `--format table` (where applicable)
 * for a human-readable column layout. Errors emit JSON on stderr + non-zero exit.
 *
 * @module cli/deps
 */

import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  blockers,
  buildDependencyGraph,
  type DependencyNode,
  frontier,
  type FrontierEntry,
  impact,
  preflight,
  renderGraph,
  validate,
} from '../deps/dependency-graph.js';
import {
  gcRollingSnapshots,
  inspectSnapshots,
  isCompositionEnabled,
  SNAPSHOT_TAGS,
  type SnapshotTag,
  writeSnapshot,
} from '../deps/snapshot.js';

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

/**
 * Print one-line warnings (e.g. stale-task notices from the dependency graph
 * builder) to stderr so they don't pollute machine-readable JSON on stdout but
 * still surface to the human operator.
 */
function warnToStderr(msg: string): void {
  process.stderr.write(`warning: ${msg}\n`);
}

/**
 * Render a small ASCII table for human-readable output. We intentionally avoid
 * a third-party table dependency — three columns and right-padding is enough
 * for the cli-deps surface.
 */
function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cells: string[]): string =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const out: string[] = [fmt(headers), sep];
  for (const r of rows) out.push(fmt(r));
  return out.join('\n') + '\n';
}

/**
 * Build the cli-deps yargs program. Exported so tests can drive the parser
 * without going through process.argv.
 */
export function buildDepsCli(): Argv {
  const cwdDefault = (): string => process.cwd();

  return yargs(hideBin(process.argv))
    .scriptName('cli-deps')
    .usage('Usage: $0 <command> [options]')
    .option('work-dir', {
      alias: 'w',
      describe: 'Project root (defaults to cwd).',
      type: 'string',
      default: cwdDefault(),
    })
    .command(
      'frontier',
      'List open tasks whose dependencies are all in backlog/completed/ (ready to dispatch).',
      (y) =>
        y.option('format', {
          type: 'string',
          choices: ['json', 'table'] as const,
          default: 'json' as const,
        }),
      async (argv) => {
        const g = buildDependencyGraph({ workDir: argv['work-dir'] as string }, warnToStderr);
        const f = frontier(g);
        if ((argv.format as string) === 'table') {
          const rows = f.map((e: FrontierEntry) => [
            e.id,
            e.title || '(no title)',
            e.dependencies.length === 0 ? '(none)' : e.dependencies.join(', '),
          ]);
          emitText(renderTable(['ID', 'Title', 'Dependencies (all completed)'], rows));
        } else {
          emit({ ok: true, frontier: f });
        }
      },
    )
    .command(
      'blockers <task-id>',
      'List open tasks gating the target (transitive dependency closure).',
      (y) =>
        y
          .positional('task-id', {
            describe: 'Backlog task ID (e.g. AISDLC-117)',
            type: 'string',
            demandOption: true,
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const g = buildDependencyGraph({ workDir: argv['work-dir'] as string }, warnToStderr);
        const target = String(argv['task-id']);
        if (!g.nodes.has(target.toLowerCase())) fail(`unknown task ${target}`);
        const list = blockers(g, target);
        if ((argv.format as string) === 'table') {
          const rows = list.map((n: DependencyNode) => [n.id, n.title || '(no title)', n.status]);
          emitText(renderTable(['ID', 'Title', 'Status'], rows));
        } else {
          emit({ ok: true, target, blockers: list.map(serialiseNode) });
        }
      },
    )
    .command(
      'impact <task-id>',
      'List open tasks that would unblock if the target closes (reverse closure).',
      (y) =>
        y.positional('task-id', { type: 'string', demandOption: true }).option('format', {
          type: 'string',
          choices: ['json', 'table'] as const,
          default: 'json' as const,
        }),
      async (argv) => {
        const g = buildDependencyGraph({ workDir: argv['work-dir'] as string }, warnToStderr);
        const target = String(argv['task-id']);
        if (!g.nodes.has(target.toLowerCase())) fail(`unknown task ${target}`);
        const list = impact(g, target);
        if ((argv.format as string) === 'table') {
          const rows = list.map((n) => [n.id, n.title || '(no title)', n.status]);
          emitText(renderTable(['ID', 'Title', 'Status'], rows));
        } else {
          emit({ ok: true, target, impact: list.map(serialiseNode) });
        }
      },
    )
    .command(
      'validate',
      'Detect cycles + dangling references in the dependency graph. Exit 0 if clean, 1 otherwise.',
      (y) => y,
      async (argv) => {
        const g = buildDependencyGraph({ workDir: argv['work-dir'] as string }, warnToStderr);
        const r = validate(g);
        emit({ ok: r.ok, cycles: r.cycles, dangling: r.dangling });
        if (!r.ok) process.exit(1);
      },
    )
    .command(
      'graph',
      'Emit the dependency graph in mermaid (default) or DOT format.',
      (y) =>
        y.option('format', {
          type: 'string',
          choices: ['mermaid', 'dot'] as const,
          default: 'mermaid' as const,
        }),
      async (argv) => {
        const g = buildDependencyGraph({ workDir: argv['work-dir'] as string }, warnToStderr);
        const out = renderGraph(g, argv.format as 'mermaid' | 'dot');
        process.stdout.write(out);
      },
    )
    .command(
      'preflight <task-id>',
      "Refuse to start a task whose dependencies aren't all Done. Exit 0 if ok, 1 otherwise.",
      (y) =>
        y.positional('task-id', {
          describe: 'Backlog task ID',
          type: 'string',
          demandOption: true,
        }),
      async (argv) => {
        const g = buildDependencyGraph({ workDir: argv['work-dir'] as string }, warnToStderr);
        const r = preflight(g, String(argv['task-id']));
        emit({
          ok: r.ok,
          reason: r.reason,
          blockers: r.blockers.map(serialiseNode),
          dangling: r.dangling,
        });
        if (!r.ok) process.exit(1);
      },
    )
    .command(
      'snapshot',
      'RFC-0014 Phase 1 — write a JSONL snapshot of the dependency graph to $ARTIFACTS_DIR/_deps/. No-op when AI_SDLC_DEPS_COMPOSITION is unset.',
      (y) =>
        y
          .option('tag', {
            type: 'string',
            describe: 'Event tag (rolling | dispatch | calibration | lifecycle-transition)',
            choices: SNAPSHOT_TAGS as unknown as readonly string[],
            default: 'rolling',
          })
          .option('artifacts-dir', {
            type: 'string',
            describe: 'Override $ARTIFACTS_DIR for this invocation',
          }),
      async (argv) => {
        const tag = argv.tag as SnapshotTag;
        const workDir = argv['work-dir'] as string;
        const artifactsDir = argv['artifacts-dir'] as string | undefined;
        if (!isCompositionEnabled()) {
          // Phase 1 is opt-in. Surface a clear noop message + the env var so the
          // operator can flip it on without re-reading the runbook.
          emit({
            ok: true,
            written: false,
            reason: 'AI_SDLC_DEPS_COMPOSITION is OFF — snapshot skipped (set to 1 to enable)',
            tag,
          });
          return;
        }
        const r = writeSnapshot(tag, { workDir, artifactsDir, onWarn: warnToStderr });
        emit({
          ok: true,
          written: r.written,
          path: r.path,
          tag: r.tag,
          recordCount: r.recordCount,
          bytes: r.bytes,
        });
      },
    )
    .command(
      'gc',
      'RFC-0014 Phase 1 — trim rolling-tagged snapshots older than --max-age-days (default 30). Event-tagged snapshots are preserved.',
      (y) =>
        y
          .option('max-age-days', {
            type: 'number',
            default: 30,
            describe: 'Age cutoff in days for rolling-tagged snapshots',
          })
          .option('artifacts-dir', {
            type: 'string',
            describe: 'Override $ARTIFACTS_DIR for this invocation',
          }),
      async (argv) => {
        const maxAgeDays = argv['max-age-days'] as number;
        const workDir = argv['work-dir'] as string;
        const artifactsDir = argv['artifacts-dir'] as string | undefined;
        const r = gcRollingSnapshots({
          workDir,
          artifactsDir,
          maxAgeDays,
          onWarn: warnToStderr,
        });
        emit({
          ok: true,
          trimmedCount: r.trimmed.length,
          keptCount: r.kept.length,
          bytesFreed: r.bytesFreed,
          trimmed: r.trimmed,
        });
      },
    )
    .command(
      'inspect',
      'RFC-0014 Phase 1 — list snapshots by tag, sorted by embedded ISO timestamp.',
      (y) =>
        y
          .option('tag', {
            type: 'string',
            describe: 'Filter by tag (omit for all)',
            choices: SNAPSHOT_TAGS as unknown as readonly string[],
          })
          .option('artifacts-dir', {
            type: 'string',
            describe: 'Override $ARTIFACTS_DIR for this invocation',
          })
          .option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json' as const,
          }),
      async (argv) => {
        const tag = argv.tag as SnapshotTag | undefined;
        const workDir = argv['work-dir'] as string;
        const artifactsDir = argv['artifacts-dir'] as string | undefined;
        const list = inspectSnapshots({ workDir, artifactsDir, tag });
        if ((argv.format as string) === 'table') {
          const rows = list.map((e) => [
            e.isoTimestamp,
            e.tag,
            String(e.recordCount),
            String(e.size),
          ]);
          emitText(renderTable(['Timestamp', 'Tag', 'Records', 'Bytes'], rows));
        } else {
          emit({ ok: true, snapshots: list });
        }
      },
    )
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .alias('h', 'help')
    .version(false);
}

function serialiseNode(n: DependencyNode): {
  id: string;
  title: string;
  status: string;
  dependencies: string[];
} {
  return { id: n.id, title: n.title, status: n.status, dependencies: n.dependencies };
}

/**
 * Run the cli-deps CLI. Used by the cli-deps bin shim and integration tests.
 */
export async function runDepsCli(): Promise<void> {
  await buildDepsCli().parseAsync();
}
