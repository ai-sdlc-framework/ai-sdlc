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
 *   eval            — score the golden set (recall at 5, MRR, nDCG); `--gate` applies the ranking
 *                     gate; `--set synthetic` reports without gating (AISDLC-778).
 *   mine / synthesize / citation-rate — evaluator-only quarantine feeds and the report-only
 *                     citation rate (AISDLC-778).
 *   check-scope     — fail when a protected entry is in the configured tracked root, or the
 *                     configured protected root is tracked / not git-ignored. With `--rev`, also
 *                     scans every commit in the pushed range, not only HEAD/the index. Paths a
 *                     backend declares in `localPaths()` get the protected-root rules (AISDLC-1433).
 *   check-backend   — report whether the configured backend module resolves, its factory opens,
 *                     and each declared local path is git-ignored (`--format json` for doctor).
 *   sync / status   — run the backend's optional `sync()` then rebuild the index, recording the
 *                     outcome in a stamp file; print `status()` merged with that stamp. One JSON
 *                     line each; `supported: false` on a backend without them (AISDLC-1459).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { now } from '../clock.js';
import { DEFAULT_KNOWLEDGE_BACKEND, loadKnowledgeConfig } from '../knowledge/config.js';
import {
  backendSelection,
  openKnowledgeStore,
  storeOntology,
  toEntries,
  type WriteResult,
} from '../knowledge/knowledge-store.js';
import {
  countIngestWrite,
  emptyIngestCounts,
  ingestEntry,
  type IngestWriteCounts,
} from '../knowledge/ingest-write.js';
import { captureFactForProject, exportableEntries } from '../knowledge/data-room.js';
import {
  checkKnowledgeBackend,
  checkKnowledgeScope,
  checkKnowledgeScopeRange,
} from '../knowledge/scope-check.js';
import { INGEST_SOURCES, ingestSource, type IngestSource } from '../knowledge/ingest-sources.js';
import { ingestMemoryForProject } from '../knowledge/ingest-memory.js';
import { resolveMemoryDir } from '../memory-dream/resolve-dir.js';
import { sectionsToEntries } from '../knowledge/ingest-sections.js';
import { auditLines, readKnowledgeLog } from '../knowledge/log.js';
import { citationRate, renderCitationRate, sessionIds } from '../knowledge/eval/citation.js';
import {
  BASELINE_PATH,
  evaluateGate,
  loadEvaluationConfig,
  readBaseline,
  writeBaseline,
} from '../knowledge/eval/gate.js';
import { type EvalQuestion, loadGolden, liveEntryIds, runEval } from '../knowledge/eval/golden.js';
import {
  generateSynthetic,
  mineQuestions,
  readSynthetic,
  writeSynthetic,
} from '../knowledge/eval/quarantine.js';
import {
  buildDashboard,
  confirmEntry,
  correctEntry,
  renderDashboard,
  supersedeEntry,
} from '../knowledge/human.js';
import {
  type Actor,
  promoteEntry,
  reobserveEntry,
  refuteEntry,
  type Role,
} from '../knowledge/promote.js';
import { resolveKnowledgePrincipal, systemPrincipalDeps } from '../knowledge/principal.js';
import {
  compactSession,
  queryIndex,
  rebuildIndex,
  recordHarnessRecall,
  resetSession,
} from '../knowledge/retrieval/service.js';
import { findProtectedCitations, validateKnowledge } from '../knowledge/store.js';
import { knowledgeSyncStatus, runKnowledgeSync } from '../knowledge/sync.js';

function knowledgeCtx(projectDir: string) {
  const config = loadKnowledgeConfig(projectDir);
  const trackedAbs = isAbsolute(config.trackedRoot)
    ? config.trackedRoot
    : join(projectDir, config.trackedRoot);
  const store = openKnowledgeStore(
    { ...backendSelection(config), trackedRoot: trackedAbs },
    projectDir,
  );
  return {
    trackedAbs,
    verify: { projectDir, config, ontology: storeOntology(store, trackedAbs).ontology },
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

/** The role and audit principal for knowledge-log events written by this process. */
export function resolveActor(projectDir: string, env: NodeJS.ProcessEnv = process.env): Actor {
  const by = resolveRole(env);
  return {
    by,
    principal: resolveKnowledgePrincipal(env, systemPrincipalDeps(by, projectDir, env)),
  };
}

/**
 * Print a store write result (AISDLC-1456): `applied: <what>`, `proposed: queued as a
 * proposal`, or `rejected: <reason>` on stderr with exit code 1. A proposal is never reported
 * as done.
 */
export function reportWrite(
  r: { status: WriteResult['status']; reason?: string },
  applied: string,
): void {
  if (r.status === 'applied') {
    process.stdout.write(`applied: ${applied}\n`);
  } else if (r.status === 'proposed') {
    process.stdout.write(`proposed: queued as a proposal${r.reason ? ` (${r.reason})` : ''}\n`);
  } else {
    process.stderr.write(`rejected: ${r.reason ?? 'no reason given'}\n`);
    process.exitCode = 1;
  }
}

/** One line for an ingest run; rejected writes make the command exit 1. */
function reportIngest<T extends IngestWriteCounts>(r: T, keys: (keyof T & string)[]): void {
  const parts = keys.map((k) => `${String(r[k])} ${k}`);
  if (r.proposed > 0) parts.push(`${r.proposed} queued as a proposal`);
  if (r.rejected > 0) parts.push(`${r.rejected} rejected`);
  process.stdout.write(`${parts.join(', ')}\n`);
  if (r.rejected > 0) process.exitCode = 1;
}

export function buildContextCli(argv: string[] = hideBin(process.argv)): Argv {
  return yargs(argv)
    .scriptName('cli-context')
    .option('project-dir', { type: 'string', default: process.cwd() })
    .middleware((args) => {
      // DEC-0427: a configured non-files backend must resolve before any subcommand runs;
      // KnowledgeBackendError propagates and the command exits non-zero (fail closed).
      // check-backend reports that failure itself (AISDLC-1433).
      if (args._[0] === 'check-backend') return;
      const projectDir = String(args['project-dir']);
      const config = loadKnowledgeConfig(projectDir);
      if (config.backend !== DEFAULT_KNOWLEDGE_BACKEND) openKnowledgeStore(config, projectDir);
    })
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
      'sync',
      "Run the knowledge backend's sync, rebuild the index and record the outcome",
      (y) => y,
      async (args) => {
        const r = await runKnowledgeSync(String(args['project-dir']));
        process.stdout.write(`${JSON.stringify(r)}\n`);
        if (!r.ok) process.exitCode = 1;
      },
    )
    .command(
      'status',
      'Print the knowledge backend sync status: queued, rejected, last sync time and error',
      (y) => y,
      async (args) => {
        try {
          const r = await knowledgeSyncStatus(String(args['project-dir']));
          process.stdout.write(`${JSON.stringify(r)}\n`);
        } catch (err) {
          process.stdout.write(
            `${JSON.stringify({ ok: false, supported: true, error: (err as Error).message })}\n`,
          );
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
      'eval',
      'Score the golden set: recall at 5, MRR, nDCG; --gate enforces the ranking gate',
      (y) =>
        y
          .option('set', { type: 'string', choices: ['golden', 'synthetic'], default: 'golden' })
          .option('gate', { type: 'boolean', default: false })
          .option('update-baseline', {
            type: 'string',
            describe: 'Store the golden recall at 5 as the baseline for this release label',
          }),
      async (args) => {
        try {
          const projectDir = String(args['project-dir']);
          const synthetic = args.set === 'synthetic';
          const questions: EvalQuestion[] = synthetic
            ? readSynthetic(projectDir).map((q) => ({
                id: q.key,
                question: q.question,
                relevant: new Map([[q.entryId, 1]]),
              }))
            : loadGolden(projectDir);
          const rank = async (text: string): Promise<string[]> =>
            (await queryIndex(projectDir, { text, limit: 10 })).map((h) => h.id);
          const report = await runEval(questions, liveEntryIds(projectDir), rank);
          process.stdout.write(
            `${JSON.stringify(
              {
                set: args.set,
                scored: report.scored,
                retired: report.retired,
                recallAt5: report.recallAt5,
                mrr: report.mrr,
                ndcgAt5: report.ndcgAt5,
              },
              null,
              2,
            )}\n`,
          );
          if (synthetic) return; // report only, never gates
          if (args['update-baseline']) {
            writeBaseline(projectDir, {
              release: String(args['update-baseline']),
              recallAt5: report.recallAt5,
            });
            process.stdout.write(`baseline written to ${BASELINE_PATH}\n`);
          }
          if (args.gate) {
            if (report.scored === 0) {
              process.stdout.write('warning: no scoreable golden questions; gate skipped\n');
              return;
            }
            const gate = evaluateGate(
              report.recallAt5,
              loadEvaluationConfig(projectDir),
              readBaseline(projectDir),
            );
            for (const f of gate.failures) process.stderr.write(`error: ${f}\n`);
            if (!gate.ok) process.exitCode = 1;
          }
        } catch (err) {
          process.stderr.write(`error: ${(err as Error).message}\n`);
          process.exitCode = 1;
        }
      },
    )
    .command(
      'mine [transcripts..]',
      'Mine scrubbed, de-duplicated questions from transcripts into the evaluator-only quarantine',
      (y) => y.positional('transcripts', { type: 'string', array: true, default: [] }),
      (args) => {
        const files = (args.transcripts as string[]).map(String);
        const r = mineQuestions(
          String(args['project-dir']),
          files.map((f) => readFileSync(f, 'utf-8')),
        );
        process.stdout.write(`${r.written} written, ${r.duplicates} duplicates\n`);
      },
    )
    .command(
      'synthesize',
      'Generate one synthetic question per entry into the evaluator-only quarantine',
      (y) => y,
      (args) => {
        const projectDir = String(args['project-dir']);
        const { verify } = knowledgeCtx(projectDir);
        const store = openKnowledgeStore(verify.config, projectDir);
        const n = writeSynthetic(projectDir, generateSynthetic(toEntries(store.list('all'))));
        process.stdout.write(`${n} synthetic questions written\n`);
      },
    )
    .command(
      'citation-rate',
      'Report the share of injected entries later cited (report only, never gates)',
      (y) =>
        y
          .option('text-file', {
            type: 'string',
            describe: 'Session output text; defaults to stdin',
          })
          .option('session', { type: 'string', array: true, describe: 'Defaults to all ledgers' }),
      (args) => {
        const projectDir = String(args['project-dir']);
        const text = readFileSync((args['text-file'] as string | undefined) ?? 0, 'utf-8');
        const sessions = (args.session as string[] | undefined) ?? sessionIds(projectDir);
        process.stdout.write(`${renderCitationRate(citationRate(projectDir, sessions, text))}\n`);
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
      'check-backend',
      'Report whether the knowledge backend resolves, opens, and its local paths are git-ignored',
      (y) => y.option('format', { type: 'string', choices: ['text', 'json'], default: 'text' }),
      (args) => {
        const report = checkKnowledgeBackend(String(args['project-dir']));
        const bad = report.localPaths.filter((p) => p.inRepo && !p.ignored);
        if (args.format === 'json') {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          process.stdout.write(
            `backend ${report.backend}: ${report.opened ? 'opens' : 'does not open'}, ${
              report.localPaths.length
            } local path(s)\n`,
          );
          if (report.error) process.stderr.write(`error: ${report.error}\n`);
          for (const p of bad) process.stderr.write(`error: ${p.path} is not git-ignored\n`);
        }
        if (!report.opened || report.error !== null || bad.length > 0) process.exitCode = 1;
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
      async (args) => {
        const projectDir = String(args['project-dir']);
        const config = loadKnowledgeConfig(projectDir);
        const trackedAbs = isAbsolute(config.trackedRoot)
          ? config.trackedRoot
          : join(projectDir, config.trackedRoot);
        const store = openKnowledgeStore(
          { ...backendSelection(config), trackedRoot: trackedAbs },
          projectDir,
        );
        const { ontology } = storeOntology(store, trackedAbs);
        const file = String(args.file);
        const entries = sectionsToEntries(readFileSync(join(projectDir, file), 'utf-8'), ontology, {
          source: file,
          observed: String(args.observed),
          headings: args.heading as string[] | undefined,
        });
        const { principal } = resolveActor(projectDir);
        const counts = emptyIngestCounts();
        const report = (line: string): boolean => process.stderr.write(`${line}\n`);
        for (const e of entries) {
          const exists =
            store.get(String(e.fields.id), { scope: 'tracked', path: e.path }) !== null;
          const r = await ingestEntry(
            store,
            { fields: e.fields, body: e.body },
            { scope: 'tracked', path: e.path, principal, exists },
          );
          countIngestWrite(counts, r, report);
        }
        reportIngest(counts, ['created', 'updated']);
      },
    )
    .command(
      'ingest',
      'Ingest decisions, RFCs, reviews, orchestrator events, backlog tasks or a generated JSON file as knowledge entries',
      (y) =>
        y
          .option('source', { type: 'string', choices: INGEST_SOURCES, demandOption: true })
          .option('events-file', { type: 'string', describe: 'Orchestrator _events.jsonl path' })
          .option('file', {
            type: 'string',
            describe:
              'JSON array of {id, trunk, type, value, source, proof} records for --source generated (required there). Reads a file you name; outside the enterprise gate',
          })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      async (args) => {
        const projectDir = String(args['project-dir']);
        const config = loadKnowledgeConfig(projectDir);
        const trackedRootAbs = isAbsolute(config.trackedRoot)
          ? config.trackedRoot
          : join(projectDir, config.trackedRoot);
        const store = openKnowledgeStore(
          { ...backendSelection(config), trackedRoot: trackedRootAbs },
          projectDir,
        );
        const r = await ingestSource(args.source as IngestSource, {
          ...backendSelection(config),
          projectDir,
          trackedRootAbs,
          ontology: storeOntology(store, trackedRootAbs).ontology,
          observed: String(args.observed),
          eventsFile: args['events-file'] as string | undefined,
          generatedFile: args.file as string | undefined,
          allowlistedCommands: config.allowlistedCommands,
          actor: resolveActor(projectDir),
        });
        reportIngest(r, ['created', 'updated', 'unchanged']);
      },
    )
    .command(
      'ingest-memory',
      'Ingest the auto-memory folder as protected `memory` trunk entries (AISDLC-783)',
      (y) =>
        y
          .option('dir', { type: 'string', describe: 'Memory folder (default: resolved setting)' })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      async (args) => {
        try {
          const projectDir = String(args['project-dir']);
          const memoryDir = (args.dir as string | undefined) ?? resolveMemoryDir({ projectDir });
          const r = await ingestMemoryForProject(
            projectDir,
            memoryDir,
            String(args.observed),
            resolveActor(projectDir).principal,
          );
          reportIngest(r, ['created', 'updated', 'unchanged', 'superseded', 'skipped']);
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
      async (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = await promoteEntry(
          ctx.verify.config,
          ctx.trackedAbs,
          String(args.id),
          {
            to: args.to as 'specialist' | 'canonical',
            proof: args.proof as string | undefined,
            ...resolveActor(String(args['project-dir'])),
          },
          ctx.verify,
        );
        reportWrite(r, r.reason);
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
      async (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = await confirmEntry(
          ctx.verify.config,
          ctx.trackedAbs,
          String(args.id),
          Number(args.confidence),
          resolveActor(String(args['project-dir'])),
          String(args.observed),
          ctx.verify.projectDir,
        );
        reportWrite(r, `confidence ${String(r.confidence)}`);
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
      async (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = await correctEntry(
          ctx.verify.config,
          ctx.trackedAbs,
          String(args.id),
          String(args.value),
          resolveActor(String(args['project-dir'])),
          String(args.observed),
          ctx.verify.projectDir,
        );
        reportWrite(r, `corrected ${String(args.id)}`);
      },
    )
    .command(
      'supersede <old> <new>',
      'Create <new> from <old> with a new value, superseding <old>; the old entry is kept and marked superseded',
      (y) =>
        y
          .positional('old', { type: 'string', demandOption: true })
          .positional('new', { type: 'string', demandOption: true })
          .option('value', { type: 'string', demandOption: true })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      async (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = await supersedeEntry(
          ctx.verify.config,
          ctx.trackedAbs,
          String(args.old),
          String(args.new),
          String(args.value),
          resolveActor(String(args['project-dir'])),
          String(args.observed),
          ctx.verify.projectDir,
        );
        reportWrite(r, `${String(args.new)} supersedes ${String(args.old)}`);
      },
    )
    .command(
      'coverage',
      'Print the coverage score, the tagged gap list and the staleness queue',
      (y) => y,
      (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const d = buildDashboard(
          toEntries(
            openKnowledgeStore(
              { ...backendSelection(ctx.verify.config), trackedRoot: ctx.trackedAbs },
              ctx.verify.projectDir,
            ).list('tracked'),
          ),
          ctx.verify.ontology.trunks,
        );
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
      async (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = await refuteEntry(
          ctx.verify.config,
          ctx.trackedAbs,
          String(args.id),
          String(args.reason),
          resolveActor(String(args['project-dir'])),
          ctx.verify.projectDir,
        );
        reportWrite(r, `refuted ${String(args.id)}`);
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
      async (args) => {
        const ctx = knowledgeCtx(String(args['project-dir']));
        const r = await reobserveEntry(
          ctx.verify.config,
          ctx.trackedAbs,
          String(args.id),
          Number(args.confidence),
          resolveActor(String(args['project-dir'])),
          String(args.observed),
          ctx.verify.projectDir,
        );
        reportWrite(r, `confidence ${String(r.confidence)}`);
      },
    )
    .command(
      'capture <id>',
      'Capture a fact from a data-room document as a protected entry with a citation',
      (y) =>
        y
          .positional('id', { type: 'string', demandOption: true })
          .option('value', { type: 'string', demandOption: true })
          .option('source-doc', { type: 'string', demandOption: true })
          .option('observed', { type: 'string', default: now().toISOString().slice(0, 10) }),
      async (args) => {
        const projectDir = String(args['project-dir']);
        const r = await captureFactForProject(projectDir, {
          id: String(args.id),
          value: String(args.value),
          sourceDoc: String(args['source-doc']),
          observed: String(args.observed),
          principal: resolveActor(projectDir).principal,
        });
        reportWrite(r, `captured ${r.file}`);
      },
    )
    .command(
      'export',
      'Print entries safe to share: the protected partition is excluded by scope',
      (y) => y,
      (args) => {
        const projectDir = String(args['project-dir']);
        const config = loadKnowledgeConfig(projectDir);
        const store = openKnowledgeStore(
          { ...backendSelection(config), trackedRoot: config.trackedRoot },
          projectDir,
        );
        const shared = exportableEntries(toEntries(store.list('tracked')));
        process.stdout.write(`${JSON.stringify(shared, null, 2)}\n`);
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
