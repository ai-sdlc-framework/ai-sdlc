/**
 * `cli-usage route propose` (RFC-0050 B5): evaluate every routing-table cell
 * against the downshift bar and, when at least one candidate qualifies, file
 * ONE Decision listing every qualifying change.
 *
 * Silence means no change: nothing is filed when nothing qualifies, and
 * nothing is filed while an earlier proposal is still open. The table is never
 * edited here.
 *
 * Only counts, rates, ids, model names and evidence file references are
 * written. Every collaborator is injectable so tests never touch the home
 * directory, the clock or git.
 *
 * @module usage/route-commands
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readModelCalls, readPriceHistory, type ModelCallRecord } from '@ai-sdlc/reference';
import type { Argv } from 'yargs';
import { loadAllReviewLedgers } from '../attestation/reviews-ledger.js';
import {
  isDecisionCatalogEnabled,
  makeDecisionOpenedEvent,
  nextDecisionId,
  projectAll,
  appendDecisionEvent,
  withEventLogLock,
  type DecisionOption,
} from '../decisions/index.js';
import {
  DEFAULT_MARGIN_POINTS,
  evaluateCell,
  findNoLongerCheaper,
  type CandidateEvaluation,
  type CellEvaluation,
  type CellRef,
  type EvidenceScorecard,
  type StaleChange,
} from '../routing/evaluate-cell.js';
import { loadRoutingTable, type LoadTableOptions } from '../routing/load-table.js';
import type { RoutingTable } from '../routing/default-table.js';
import { repoNameFor } from './attribution.js';
import { REPLAY_TASK_ID } from './replay-run.js';
import { readReplayResults, replayRows, type ReplayRow } from './replay-report.js';
import { buildScorecard, deriveOutcomes, type Scorecard, type ScorecardRow } from './scorecard.js';
import {
  ASSIGNMENT_LOG_RELATIVE,
  evidenceFileName,
  loadContractRetries,
  loadTaskInfo,
  readAssignmentLog,
  writeEvidenceFiles,
} from './scorecard-sources.js';
import { deriveUnitWeights, type UnitWeights } from './units.js';
import { loadUsageConfig } from './usage-config.js';
import type { ScorecardDeps } from './scorecard-commands.js';
import type { UsageIo } from './commands.js';

/** Scope every proposal Decision carries; how an open proposal is found. */
export const ROUTING_PROPOSAL_SCOPE = 'routing:model-proposal';

/** Lifecycles in which a Decision no longer awaits an answer. */
const CLOSED_LIFECYCLES = new Set(['answered', 'superseded', 'archived']);

export interface RouteDeps extends ScorecardDeps {
  /** Replaces the table loader (tests). */
  loadTable?: (opts: LoadTableOptions) => ReturnType<typeof loadRoutingTable>;
  /** Directory holding the Decision Catalog (`<dir>/.ai-sdlc/_decisions`). Defaults to the repo root. */
  decisionsWorkDir?: string;
  /** Environment for the catalog flag (tests). */
  env?: NodeJS.ProcessEnv;
  /** Base-ref table reader (tests). */
  readBaseTable?: LoadTableOptions['readBaseTable'];
  /**
   * Counts of usage records that are not attributable to this repository
   * (recorded before repository identity existed, or with identity
   * unavailable). When absent the evidence is treated as not attributable and
   * nothing qualifies.
   */
  attributionCounts?: () => { legacyRecords: number; unavailableRecords: number };
}

export type ProposeOutcome = 'filed' | 'nothing-qualifies' | 'proposal-open' | 'catalog-disabled';

export interface ProposedChange {
  role: string;
  taskClass: string;
  from: string;
  to: string;
  comparison: CandidateEvaluation['comparison'];
  /** Evidence files, relative to the artifacts directory. */
  evidence: string[];
}

export interface ProposeResult {
  outcome: ProposeOutcome;
  dryRun: boolean;
  /** The Decision filed, or the open one that blocked filing. */
  decisionId?: string;
  changes: ProposedChange[];
  /** Cells whose recorded change is no longer cheaper (information only). */
  noLongerCheaper: StaleChange[];
  /** Candidates that did not qualify, with reasons. */
  notQualifying: Array<{ role: string; taskClass: string; model: string; reasons: string[] }>;
  warnings: string[];
}

export interface ProposeOptions {
  minTasks?: number;
  marginPoints?: number;
  since?: string;
  dryRun?: boolean;
}

function resolvePaths(deps: RouteDeps): { repoRoot: string; artifactsDir: string } {
  const repoRoot = resolve(deps.repoRoot ?? deps.workDir ?? process.cwd());
  const artifactsDir =
    deps.artifactsDir ?? process.env.ARTIFACTS_DIR ?? resolve(repoRoot, 'artifacts');
  return { repoRoot, artifactsDir };
}

/** Cells of a table, with the wildcard cell's excluded classes filled in. */
export function enumerateCells(table: RoutingTable): CellRef[] {
  const out: CellRef[] = [];
  for (const [role, byClass] of Object.entries(table.cells)) {
    const classes = Object.keys(byClass);
    for (const [taskClass, cell] of Object.entries(byClass)) {
      out.push({
        role,
        taskClass,
        model: cell.model,
        candidates: cell.candidates ?? [],
        ...(taskClass === '*' ? { excludeClasses: classes.filter((c) => c !== '*') } : {}),
      });
    }
  }
  return out;
}

function listReplayFiles(artifactsDir: string): string[] {
  const dir = join(artifactsDir, 'replay');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => /^results-.*\.json$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

interface Collected {
  card: Scorecard;
  weights: UnitWeights;
  minTasks: number;
  replay: ReplayRow[];
  replayFiles: Map<string, string>;
  warnings: string[];
  repo: string;
}

async function collect(deps: RouteDeps, opts: ProposeOptions, now: Date): Promise<Collected> {
  const { repoRoot, artifactsDir } = resolvePaths(deps);
  const warnings: string[] = [];
  const repo = repoNameFor(repoRoot);
  const config = (deps.loadConfig ?? loadUsageConfig)({
    dir: deps.usageDir,
    workDir: deps.workDir,
    readBaseConfig: deps.readBaseConfig,
  });
  warnings.push(...config.warnings);
  const priceRows = deps.priceRows ?? readPriceHistory({ dir: deps.usageDir });
  const weights = deriveUnitWeights(priceRows, now.toISOString(), config.weights);

  let from: Date | undefined;
  if (opts.since !== undefined) {
    from = new Date(opts.since);
    if (Number.isNaN(from.getTime())) throw new Error(`Invalid --since value "${opts.since}".`);
  }
  const records: ModelCallRecord[] = [];
  for await (const r of readModelCalls(
    { scope: 'framework', repo, ...(from ? { from } : {}) },
    { dir: deps.usageDir },
  )) {
    if (r.taskId && r.taskId !== REPLAY_TASK_ID) records.push(r);
  }
  const outcomes = deriveOutcomes(
    loadAllReviewLedgers(repoRoot),
    loadContractRetries(artifactsDir),
  );
  const taskInfo = loadTaskInfo(new Set(records.map((r) => r.taskId as string)), {
    repoRoot,
    artifactsDir,
  });
  const assignments = readAssignmentLog(
    deps.assignmentLogPath ?? resolve(artifactsDir, ASSIGNMENT_LOG_RELATIVE),
  );
  const minTasks = opts.minTasks ?? config.scorecardMinTasks;
  const card = buildScorecard({
    records,
    outcomes,
    taskInfo,
    assignments,
    weights,
    minTasks,
  });

  const files = listReplayFiles(artifactsDir);
  const parsed = readReplayResults(files);
  let replay: ReplayRow[] = [];
  const replayFiles = new Map<string, string>();
  if (typeof parsed === 'string') {
    warnings.push(`Replay results ignored: ${parsed}`);
  } else {
    replay = replayRows(parsed);
    parsed.forEach((p, i) => replayFiles.set(p.runId, relative(artifactsDir, files[i])));
  }
  return { card, weights, minTasks, replay, replayFiles, warnings, repo };
}

function findRow(card: Scorecard, cell: CellRef, model: string): ScorecardRow | undefined {
  const excluded = new Set(cell.excludeClasses ?? []);
  return card.rows.find(
    (r) =>
      r.role === cell.role &&
      r.model === model &&
      (cell.taskClass === '*' ? !excluded.has(r.taskClass) : r.taskClass === cell.taskClass),
  );
}

/** Find an open (unanswered) proposal Decision in the catalog. */
export function findOpenProposal(workDir: string): string | undefined {
  const { decisions } = projectAll({ workDir });
  for (const d of decisions.values()) {
    if (d.metadata.scope === ROUTING_PROPOSAL_SCOPE && !CLOSED_LIFECYCLES.has(d.status.lifecycle)) {
      return d.metadata.id;
    }
  }
  return undefined;
}

function pctText(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function describeChange(c: ProposedChange): string {
  const cmp = c.comparison;
  let detail = '';
  if (cmp?.kind === 'developer') {
    detail =
      `${c.to}: ${cmp.candidate.approved}/${cmp.candidate.tasks} first-pass approved ` +
      `(${pctText(cmp.candidate.rate)}); ${c.from}: ${cmp.current.approved}/${cmp.current.tasks} ` +
      `(${pctText(cmp.current.rate)}); ${cmp.pointsBelow.toFixed(1)} points below`;
  } else if (cmp?.kind === 'reviewer') {
    detail =
      `replay of ${cmp.items} item(s): recall ${pctText(cmp.candidate.recall)} vs ` +
      `${pctText(cmp.current.recall)}, false-block ${pctText(cmp.candidate.falseBlockRate)} vs ` +
      `${pctText(cmp.current.falseBlockRate)}`;
  }
  return `${c.role} / ${c.taskClass}: ${c.from} -> ${c.to}. ${detail}. Evidence: ${
    c.evidence.length ? c.evidence.join(', ') : 'none'
  }`;
}

function decisionBody(
  changes: readonly ProposedChange[],
  stale: readonly StaleChange[],
  margin: number,
  minTasks: number,
): string {
  const lines = [
    `Cheaper-model changes that cleared the bar (at least ${minTasks} compared tasks or replay items, ` +
      `no more than ${margin} points worse than the cell's current model, strictly cheaper at current prices).`,
    'Approving does not edit the routing table by itself. Declining or leaving this open changes nothing.',
    '',
    ...changes.map((c, i) => `${i + 1}. ${describeChange(c)}`),
  ];
  if (stale.length > 0) {
    lines.push(
      '',
      'For information only: a previously applied change is no longer cheaper at current prices.',
      ...stale.map((s) => `- ${s.role} / ${s.taskClass}: ${s.model} (was ${s.previousModel})`),
    );
  }
  const machine = {
    kind: 'model-routing-proposal',
    version: 1,
    changes: changes.map((c) => ({
      role: c.role,
      taskClass: c.taskClass,
      from: c.from,
      to: c.to,
      evidence: c.evidence,
      comparison: c.comparison,
    })),
  };
  lines.push('', '```json', JSON.stringify(machine, null, 2), '```');
  return lines.join('\n');
}

const PROPOSAL_OPTIONS: DecisionOption[] = [
  { id: 'approve-all', description: 'Approve every listed change' },
  { id: 'decline', description: 'Keep the routing table as it is' },
];

/** Evaluate every cell and, when warranted, file one proposal Decision. */
export async function runRoutePropose(
  deps: RouteDeps,
  opts: ProposeOptions = {},
): Promise<ProposeResult> {
  const now = deps.now?.() ?? new Date();
  const { repoRoot, artifactsDir } = resolvePaths(deps);
  const decisionsDir = deps.decisionsWorkDir ?? repoRoot;
  const margin = opts.marginPoints ?? DEFAULT_MARGIN_POINTS;
  const dryRun = opts.dryRun === true;
  const base: ProposeResult = {
    outcome: 'nothing-qualifies',
    dryRun,
    changes: [],
    noLongerCheaper: [],
    notQualifying: [],
    warnings: [],
  };

  const loaded = (deps.loadTable ?? loadRoutingTable)({
    workDir: repoRoot,
    readBaseTable: deps.readBaseTable,
  });
  if (loaded.source !== 'repo') {
    return { ...base, warnings: [`No usable routing table (${loaded.reason}).`] };
  }
  const table = loaded.table;
  const c = await collect(deps, opts, now);
  const cells = enumerateCells(table);
  const evidence: EvidenceScorecard = { ...c.card, ...(deps.attributionCounts?.() ?? {}) };

  const evaluations: CellEvaluation[] = cells.map((cell) =>
    evaluateCell(cell, evidence, {
      minTasks: c.minTasks,
      marginPoints: margin,
      weights: c.weights,
      replay: c.replay,
    }),
  );
  const noLongerCheaper = findNoLongerCheaper(
    cells.flatMap((cell) => {
      const t = table.cells[cell.role]?.[cell.taskClass];
      return t ? [{ ...cell, previousModel: t.previousModel, evidence: t.evidence }] : [];
    }),
    c.weights,
  );

  const notQualifying = evaluations.flatMap((e) =>
    e.candidates
      .filter((cand) => !cand.qualifies)
      .map((cand) => ({
        role: e.role,
        taskClass: e.taskClass,
        model: cand.model,
        reasons: cand.reasons,
      })),
  );
  const result: ProposeResult = {
    ...base,
    noLongerCheaper,
    notQualifying,
    warnings: c.warnings,
  };

  const qualifying = evaluations.filter((e) => e.proposed);
  if (qualifying.length === 0) return result;

  const changeCells: CellRef[] = [];
  const changes: ProposedChange[] = qualifying.map((e) => {
    const proposed = e.proposed as CandidateEvaluation;
    changeCells.push(
      cells.find((x) => x.role === e.role && x.taskClass === e.taskClass) as CellRef,
    );
    return {
      role: e.role,
      taskClass: e.taskClass,
      from: e.currentModel,
      to: proposed.model,
      comparison: proposed.comparison,
      evidence: [],
    };
  });
  result.changes = changes;

  if (dryRun) return { ...result, outcome: 'filed' };

  if (!isDecisionCatalogEnabled(deps.env ?? process.env)) {
    return {
      ...result,
      outcome: 'catalog-disabled',
      warnings: [...result.warnings, 'The Decision Catalog is switched off; nothing was filed.'],
    };
  }
  const open = findOpenProposal(decisionsDir);
  if (open) return { ...result, outcome: 'proposal-open', decisionId: open };

  // Write the evidence files the scorecard produces, then reference them.
  const evidenceDir = join(artifactsDir, '_routing', 'evidence', now.toISOString().slice(0, 10));
  const paths = writeEvidenceFiles(evidenceDir, c.card, {
    repo: c.repo,
    generatedAt: now.toISOString(),
  });
  const pathFor = (row: ScorecardRow | undefined): string | undefined => {
    if (!row) return undefined;
    const i = c.card.rows.indexOf(row);
    return i >= 0
      ? relative(artifactsDir, paths[i] ?? join(evidenceDir, evidenceFileName(row)))
      : undefined;
  };
  changes.forEach((ch, i) => {
    const cell = changeCells[i];
    const refs: string[] = [];
    if (ch.comparison?.kind === 'reviewer') {
      const f = c.replayFiles.get(ch.comparison.runId);
      if (f) refs.push(f);
    } else {
      for (const model of [ch.to, ch.from]) {
        const p = pathFor(findRow(c.card, cell, model));
        if (p) refs.push(p);
      }
    }
    ch.evidence = refs;
  });

  const decisionId = withEventLogLock({ workDir: decisionsDir }, () => {
    // Re-check under the lock so two concurrent runs cannot both file.
    const raced = findOpenProposal(decisionsDir);
    if (raced) return { id: raced, filed: false };
    const id = nextDecisionId({ workDir: decisionsDir });
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: id,
        source: 'framework-calibration',
        scope: ROUTING_PROPOSAL_SCOPE,
        summary: `Weekly model routing proposal: ${changes.length} cheaper-model change(s) qualify`,
        body: decisionBody(changes, noLongerCheaper, margin, c.minTasks),
        reversible: true,
        options: PROPOSAL_OPTIONS,
        by: 'framework:route-propose',
        now,
      }),
      { workDir: decisionsDir },
    );
    return { id, filed: true };
  });
  if (!decisionId.filed) {
    return { ...result, outcome: 'proposal-open', decisionId: decisionId.id };
  }
  return { ...result, outcome: 'filed', decisionId: decisionId.id };
}

export function renderProposeText(r: ProposeResult): string {
  const lines: string[] = [];
  for (const w of r.warnings) lines.push(`Warning: ${w}`);
  switch (r.outcome) {
    case 'nothing-qualifies':
      lines.push('No candidate qualifies this week. Nothing was filed; the table is unchanged.');
      break;
    case 'proposal-open':
      lines.push(
        `A routing proposal (${r.decisionId}) is still open. Nothing new was filed; ` +
          `${r.changes.length} change(s) currently qualify. Silence leaves the table unchanged.`,
      );
      break;
    case 'catalog-disabled':
      lines.push(`${r.changes.length} change(s) qualify but the Decision Catalog is off.`);
      break;
    case 'filed':
      lines.push(
        r.dryRun
          ? `Dry run: would file one Decision listing ${r.changes.length} change(s). Nothing was written.`
          : `Filed ${r.decisionId} listing ${r.changes.length} change(s).`,
      );
      break;
  }
  r.changes.forEach((c, i) => lines.push(`  ${i + 1}. ${describeChange(c)}`));
  if (r.noLongerCheaper.length > 0) {
    lines.push('No longer cheaper at current prices (information only):');
    for (const s of r.noLongerCheaper) {
      lines.push(`  ${s.role} / ${s.taskClass}: ${s.model} (was ${s.previousModel})`);
    }
  }
  if (r.outcome === 'nothing-qualifies' && r.notQualifying.length > 0) {
    lines.push('Candidates that did not qualify:');
    for (const n of r.notQualifying) {
      lines.push(`  ${n.role} / ${n.taskClass} -> ${n.model}: ${n.reasons.join('; ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function registerRouteCommands(y: Argv, deps: RouteDeps, io: UsageIo): Argv {
  return y.command('route', 'Routing table change proposals', (r) =>
    r
      .command(
        'propose',
        'Evaluate every routing cell and file one Decision for the cheaper-model changes that qualify',
        (c) =>
          c
            .option('since', {
              type: 'string',
              description: 'Include calls at or after this ISO date',
            })
            .option('min-tasks', {
              type: 'number',
              description: 'Compared tasks or replay items a candidate needs (default: 30)',
            })
            .option('margin-points', {
              type: 'number',
              default: DEFAULT_MARGIN_POINTS,
              description: 'Allowed gap to the current model, in percentage points',
            })
            .option('json', { type: 'boolean', default: false })
            .option('dry-run', {
              type: 'boolean',
              default: false,
              description: 'Evaluate and print; file nothing and write no evidence',
            }),
        async (argv) => {
          try {
            const result = await runRoutePropose(deps, {
              since: argv.since,
              minTasks: argv['min-tasks'],
              marginPoints: argv['margin-points'],
              dryRun: argv['dry-run'],
            });
            io.out(argv.json ? `${JSON.stringify(result, null, 2)}\n` : renderProposeText(result));
          } catch (err) {
            io.err(`${err instanceof Error ? err.message : String(err)}\n`);
            io.exit(1);
          }
        },
      )
      .demandCommand(1, 'Specify a route subcommand: propose'),
  );
}
