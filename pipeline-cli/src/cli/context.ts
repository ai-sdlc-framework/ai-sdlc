/**
 * `cli-context` — RFC-0053 knowledge layer tooling.
 *
 * Subcommands:
 *   ingest-sections — write each `##` section of a markdown file as a knowledge entry
 *                     (trunk, source, decay) under the tracked root (AISDLC-782).
 *   validate        — validate entries in both knowledge roots and the ontology.
 *                     Exit 1 on any error; `--strict` also fails on classification
 *                     warnings (likely mis-scoped entries).
 *   promote <id> --proof <kind:value> [--to canonical --by human] — verifier promotion (AISDLC-776).
 *   audit / refute / reobserve — knowledge log listing, refutation, 30 percent re-observation.
 *   check-pr-body   — fail when a PR body (`--body-file <path>` or stdin) cites a
 *                     protected entry id or the protected root path.
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
import { sectionsToEntries } from '../knowledge/ingest-sections.js';
import { auditLines, readKnowledgeLog } from '../knowledge/log.js';
import { loadOntology } from '../knowledge/ontology.js';
import { promoteEntry, reobserveEntry, refuteEntry, type Role } from '../knowledge/promote.js';
import { findProtectedCitations, validateKnowledge } from '../knowledge/store.js';

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
          })
          .option('by', { type: 'string', choices: ['agent', 'human'], default: 'agent' }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = promoteEntry(
          ctx.trackedAbs,
          String(args.id),
          {
            to: args.to as 'specialist' | 'canonical',
            proof: args.proof as string | undefined,
            by: args.by as Role,
          },
          ctx.verify,
        );
        process.stdout.write(`${r.ok ? 'promoted' : 'refused'}: ${r.reason}\n`);
        if (!r.ok) process.exitCode = 1;
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
          .option('reason', { type: 'string', demandOption: true })
          .option('by', { type: 'string', choices: ['agent', 'human'], default: 'agent' }),
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const ok = refuteEntry(
          ctx.trackedAbs,
          String(args.id),
          String(args.reason),
          args.by as Role,
        );
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
