/**
 * `cli-context` — RFC-0053 knowledge layer tooling.
 *
 * Subcommands:
 *   ingest-sections — write each `##` section of a markdown file as a knowledge entry
 *                     (trunk, source, decay) under the tracked root (AISDLC-782).
 *   validate        — validate entries in both knowledge roots and the ontology.
 *                     Exit 1 on any error; `--strict` also fails on classification
 *                     warnings (likely mis-scoped entries).
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
import { sectionsToEntries } from '../knowledge/ingest-sections.js';
import { loadOntology } from '../knowledge/ontology.js';
import { findProtectedCitations, validateKnowledge } from '../knowledge/store.js';

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
    .demandCommand(1, 'A subcommand is required. Run with --help for the list.')
    .strict()
    .help()
    .version(false);
}

export async function runContextCli(): Promise<void> {
  await buildContextCli().parseAsync();
}
