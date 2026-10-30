/**
 * `cli-context` — RFC-0053 knowledge layer tooling.
 *
 * Subcommands:
 *   ingest-sections — write each `##` section of a markdown file as a knowledge entry
 *                     (trunk, source, decay) under the tracked root (AISDLC-782).
 *   validate        — validate entries in both knowledge roots and the ontology.
 *                     Exit 1 on any error; `--strict` also fails on classification
 *                     warnings (likely mis-scoped entries).
 *   ingest-memory / mark-recalled — auto-memory trunk ingest and harness-recall ledger marks (AISDLC-783).
 *   promote <id> --proof <kind:value> [--to canonical --by human] — verifier promotion (AISDLC-776).
 *   confirm / correct / supersede / coverage — human surface (AISDLC-786).
 *   audit / refute / reobserve — knowledge log listing, refutation, 30 percent re-observation.
 *   check-pr-body   — fail when a PR body (`--body-file <path>` or stdin) cites a
 *                     protected entry id or the protected root path.
 *   index           — rebuild the retrieval index from the entries on disk.
 *   query <text>    — ranked entry ids, contentHash and citations within `--budget`/`--min-score`;
 *                     `--session <id>` omits entries already loaded in that session.
 *   session-reset / session-compact — clear / PreCompact handling of the session load ledger (AISDLC-780).
 *   check-scope     — fail when a protected entry is in the configured tracked root, or the
 *                     configured protected root is tracked / not git-ignored. With `--rev`, also
 *                     scans every commit in the pushed range, not only HEAD/the index.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import process from 'node:process';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { now } from '../clock.js';
import { loadKnowledgeConfig } from '../knowledge/config.js';
import { checkKnowledgeScope, checkKnowledgeScopeRange } from '../knowledge/scope-check.js';
import { INGEST_SOURCES, ingestSource, type IngestSource } from '../knowledge/ingest-sources.js';
import { ingestMemoryForProject } from '../knowledge/ingest-memory.js';
import { resolveMemoryDir } from '../memory-dream/resolve-dir.js';
import { sectionsToEntries } from '../knowledge/ingest-sections.js';
import { auditLines, readKnowledgeLog } from '../knowledge/log.js';
import { loadOntology } from '../knowledge/ontology.js';
import {
  buildDashboard,
  confirmEntry,
  correctEntry,
  renderDashboard,
  supersedeEntry,
} from '../knowledge/human.js';
import { promoteEntry, reobserveEntry, refuteEntry, type Role } from '../knowledge/promote.js';
import {
  compactSession,
  queryIndex,
  rebuildIndex,
  recordHarnessRecall,
  resetSession,
} from '../knowledge/retrieval/service.js';
import { findProtectedCitations, readEntries, validateKnowledge } from '../knowledge/store.js';

function knowledgeCtx(projectDir: string) {
  const config = loadKnowledgeConfig(projectDir);
  const trackedAbs = isAbsolute(config.trackedRoot)
    ? config.trackedRoot
    : join(projectDir, config.trackedRoot);
  return {
    trackedAbs,
    verify: { projectDir, config, ontology: loadOntology(trackedAbs).ontology },
  };
}

/**
 * Role is derived from a signal an agent cannot set: a human is an interactive
 * terminal on both stdin and stdout with no active-task env. Agent sessions run
 * with piped stdio and AI_SDLC_ACTIVE_TASK_ID, so they always resolve to 'agent'.
 */
export function resolveRole(
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = process.stdin.isTTY === true && process.stdout.isTTY === true,
): Role {
  return tty && !env.AI_SDLC_ACTIVE_TASK_ID ? 'human' : 'agent';
}

export function buildContextCli(argv: string[] = hideBin(process.argv)): Argv {
  return yargs(argv)
    .scriptName('cli-context')
    .option('project-dir', { type: 'string', default: process.cwd() })
    .command(
      'validate',
      'Validate knowledge entries and the ontology',
      (y) => y.option('strict', { type: 'boolean', default: false }),
      (args) => {
        const report = validateKnowledge(String(args['project-dir']));
        for (const f of report.errors) process.stderr.write(`error: ${f.file}: ${f.message}\n`);
        for (const f of report.warnings) process.stderr.write(`warning: ${f.file}: ${f.message}\n`);
        process.stdout.write(
          `${report.entries} entries, ${report.errors.length} errors, ${report.warnings.length} warnings\n`,
        );
        if (report.errors.length > 0 || (args.strict && report.warnings.length > 0)) {
          process.exitCode = 1;
        }
      },
    )
    .command(
      'index',
      'Rebuild the retrieval index from the knowledge entries on disk',
      (y) => y,
      async (args) => {
        try {
          const n = await rebuildIndex(String(args['project-dir']));
          process.stdout.write(`indexed ${n} entries\n`);
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'query <text>',
      'Query the retrieval index',
      (y) =>
        y
          .positional('text', { type: 'string', demandOption: true })
          .option('budget', { type: 'number', describe: 'Max total tokens returned' })
          .option('min-score', { type: 'number', default: 0, describe: 'Relevance floor (0..1)' })
          .option('session', {
            type: 'string',
            describe: 'Skip entries already loaded in this session',
          })
          .option('moment', {
            type: 'string',
            describe: 'Injection moment recorded in the ledger',
          }),
      async (args) => {
        try {
          const hits = await queryIndex(String(args['project-dir']), {
            text: String(args.text),
            budget: args.budget,
            minScore: args['min-score'] as number,
            sessionId: args.session,
            moment: args.moment,
          });
          process.stdout.write(`${JSON.stringify({ results: hits }, null, 2)}\n`);
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'session-reset <session>',
      'Reset the session load ledger (/clear); pre-marked entries stay loaded',
      (y) => y.positional('session', { type: 'string', demandOption: true }),
      (args) => {
        try {
          resetSession(String(args['project-dir']), String(args.session));
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'session-compact <session>',
      'Rebuild the session load ledger from a compaction summary (PreCompact)',
      (y) =>
        y
          .positional('session', { type: 'string', demandOption: true })
          .option('summary-file', { type: 'string', describe: 'Defaults to stdin' }),
      (args) => {
        try {
          const summary = readFileSync((args['summary-file'] as string | undefined) ?? 0, 'utf-8');
          const r = compactSession(String(args['project-dir']), String(args.session), summary);
          process.stdout.write(`${r.kept} kept, ${r.dropped} eligible again\n`);
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'check-scope',
      'Fail when protected knowledge could enter the repository',
      (y) =>
        y.option('rev', {
          type: 'string',
          array: true,
          describe:
            'git rev-list argument selecting the pushed commits (repeatable, e.g. <sha> ^<remote-sha>); every commit is scanned, not just HEAD',
        }),
      (args) => {
        const projectDir = String(args['project-dir']);
        const config = loadKnowledgeConfig(projectDir);
        const violations = checkKnowledgeScope(projectDir, config);
        const revs = (args.rev as string[] | undefined) ?? [];
        if (revs.length > 0) violations.push(...checkKnowledgeScopeRange(projectDir, revs, config));
        for (const v of violations) process.stderr.write(`error: ${v}\n`);
        if (violations.length > 0) process.exitCode = 1;
      },
    )
    .command(
      'check-pr-body',
      'Fail when a PR body cites a protected knowledge entry',
      (y) => y.option('body-file', { type: 'string', describe: 'Defaults to stdin' }),
      (args) => {
        const projectDir = String(args['project-dir']);
        const bodyFile = args['body-file'] as string | undefined;
        const body = readFileSync(bodyFile ?? 0, 'utf-8');
        const cited = findProtectedCitations(projectDir, body, loadKnowledgeConfig(projectDir));
        if (cited.length > 0) {
          process.stderr.write(`error: PR body cites protected knowledge: ${cited.join(', ')}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'ingest-sections <file>',
      'Ingest the ## sections of a markdown file as knowledge entries',
      (y) =>
        y
          .positional('file', { type: 'string', demandOption: true })
          .option('heading', { type: 'string', array: true })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      (args) => {
        const projectDir = String(args['project-dir']);
        const config = loadKnowledgeConfig(projectDir);
        const trackedAbs = isAbsolute(config.trackedRoot)
          ? config.trackedRoot
          : join(projectDir, config.trackedRoot);
        const { ontology } = loadOntology(trackedAbs);
        const file = String(args.file);
        const entries = sectionsToEntries(readFileSync(join(projectDir, file), 'utf-8'), ontology, {
          source: file,
          observed: String(args.observed),
          headings: args.heading as string[] | undefined,
        });
        for (const e of entries) {
          const out = join(trackedAbs, e.path);
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, e.text);
        }
        process.stdout.write(`${entries.length} entries written\n`);
      },
    )
    .command(
      'ingest',
      'Ingest decisions, RFCs, reviews, orchestrator events or backlog tasks as knowledge entries',
      (y) =>
        y
          .option('source', { type: 'string', choices: INGEST_SOURCES, demandOption: true })
          .option('events-file', { type: 'string', describe: 'Orchestrator _events.jsonl path' })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      (args) => {
        const projectDir = String(args['project-dir']);
        const config = loadKnowledgeConfig(projectDir);
        const trackedRootAbs = isAbsolute(config.trackedRoot)
          ? config.trackedRoot
          : join(projectDir, config.trackedRoot);
        const r = ingestSource(args.source as IngestSource, {
          projectDir,
          trackedRootAbs,
          ontology: loadOntology(trackedRootAbs).ontology,
          observed: String(args.observed),
          eventsFile: args['events-file'] as string | undefined,
        });
        process.stdout.write(
          `${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged\n`,
        );
      },
    )
    .command(
      'ingest-memory',
      'Ingest the auto-memory folder as protected `memory` trunk entries (AISDLC-783)',
      (y) =>
        y
          .option('dir', { type: 'string', describe: 'Memory folder (default: resolved setting)' })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      (args) => {
        try {
          const projectDir = String(args['project-dir']);
          const memoryDir = (args.dir as string | undefined) ?? resolveMemoryDir({ projectDir });
          const r = ingestMemoryForProject(projectDir, memoryDir, String(args.observed));
          process.stdout.write(
            `${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged, ${r.superseded} superseded, ${r.skipped} skipped\n`,
          );
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'mark-recalled <session> [notes..]',
      'Mark memory notes the harness recall surfaced as loaded in the session ledger',
      (y) =>
        y
          .positional('session', { type: 'string', demandOption: true })
          .positional('notes', { type: 'string', array: true, default: [] })
          .option('dir', { type: 'string', describe: 'Memory folder (default: resolved setting)' }),
      (args) => {
        try {
          const projectDir = String(args['project-dir']);
          const memoryDir = (args.dir as string | undefined) ?? resolveMemoryDir({ projectDir });
          const n = recordHarnessRecall(
            projectDir,
            String(args.session),
            memoryDir,
            (args.notes as string[]).map(String),
          );
          process.stdout.write(`${n} marked loaded\n`);
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'promote <id>',
      'Promote an entry: specialist via a verified proof, canonical only by a human',
      (y) =>
        y
          .positional('id', { type: 'string', demandOption: true })
          .option('proof', {
            type: 'string',
            describe: '<kind>:<value> from the ontology vocabulary',
          })
          .option('to', {
            type: 'string',
            choices: ['specialist', 'canonical'],
            default: 'specialist',
          }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = promoteEntry(
          ctx.trackedAbs,
          String(args.id),
          {
            to: args.to as 'specialist' | 'canonical',
            proof: args.proof as string | undefined,
            by: resolveRole(),
          },
          ctx.verify,
        );
        process.stdout.write(`${r.ok ? 'promoted' : 'refused'}: ${r.reason}\n`);
        if (!r.ok) process.exitCode = 1;
      },
    )
    .command(
      'confirm <id>',
      'Confirm an entry: confidence moves 30 percent toward the value; authority is unchanged',
      (y) =>
        y
          .positional('id', { type: 'string', demandOption: true })
          .option('confidence', { type: 'number', default: 1 })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const next = confirmEntry(
          ctx.trackedAbs,
          String(args.id),
          Number(args.confidence),
          resolveRole(),
          String(args.observed),
        );
        if (next === null) {
          process.stderr.write(`error: entry '${String(args.id)}' not found\n`);
          process.exitCode = 1;
        } else process.stdout.write(`confidence ${next}\n`);
      },
    )
    .command(
      'correct <id>',
      'Correct an entry value in place',
      (y) =>
        y
          .positional('id', { type: 'string', demandOption: true })
          .option('value', { type: 'string', demandOption: true })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const ok = correctEntry(
          ctx.trackedAbs,
          String(args.id),
          String(args.value),
          resolveRole(),
          String(args.observed),
        );
        if (!ok) {
          process.stderr.write(`error: entry '${String(args.id)}' not found\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'supersede <old> <new>',
      'Link <new> as superseding <old>; the old entry is kept',
      (y) =>
        y
          .positional('old', { type: 'string', demandOption: true })
          .positional('new', { type: 'string', demandOption: true }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = supersedeEntry(ctx.trackedAbs, String(args.old), String(args.new), resolveRole());
        process.stdout.write(`${r.ok ? 'superseded' : 'refused'}: ${r.reason}\n`);
        if (!r.ok) process.exitCode = 1;
      },
    )
    .command(
      'coverage',
      'Print the coverage score, the tagged gap list and the staleness queue',
      (y) => y,
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const d = buildDashboard(readEntries(ctx.trackedAbs), ctx.verify.ontology.trunks);
        process.stdout.write(`${renderDashboard(d).join('\n')}\n`);
      },
    )
    .command(
      'audit',
      'List every promotion with its proof',
      (y) => y,
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const lines = auditLines(readKnowledgeLog(ctx.trackedAbs));
        process.stdout.write(lines.length > 0 ? `${lines.join('\n')}\n` : 'no promotions\n');
      },
    )
    .command(
      'refute <id>',
      'Refute an entry: drops it to inferred and logs the reason',
      (y) =>
        y
          .positional('id', { type: 'string', demandOption: true })
          .option('reason', { type: 'string', demandOption: true }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const ok = refuteEntry(ctx.trackedAbs, String(args.id), String(args.reason), resolveRole());
        if (!ok) {
          process.stderr.write(`error: entry '${String(args.id)}' not found\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'reobserve <id>',
      'Re-observe an entry: confidence moves 30 percent toward the new value',
      (y) =>
        y
          .positional('id', { type: 'string', demandOption: true })
          .option('confidence', { type: 'number', demandOption: true })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const next = reobserveEntry(
          ctx.trackedAbs,
          String(args.id),
          Number(args.confidence),
          String(args.observed),
        );
        if (next === null) {
          process.stderr.write(`error: entry '${String(args.id)}' not found\n`);
          process.exitCode = 1;
        } else process.stdout.write(`confidence ${next}\n`);
      },
    )
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .version(false);
}

export async function runContextCli(): Promise<void> {
  await buildContextCli().parseAsync();
}
