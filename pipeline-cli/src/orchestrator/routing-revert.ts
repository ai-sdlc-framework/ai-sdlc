/**
 * Automatic routing revert for the orchestrator tick (RFC-0050 B5).
 *
 * Each tick: drop overrides whose table cell has changed, then judge every cell
 * that an applied proposal changed. A cell whose new model approves first-pass
 * work more than the margin below the rate in the evidence that justified the
 * change, over enough tasks since the change, goes back to its previous
 * model through an override. That is the only direction an automatic move
 * goes: toward a stronger model. Each revert emits `ModelRoutingOverrideApplied`
 * and files one informational Decision.
 *
 * Never throws: a failure here must not disturb the tick. Only counts, rates,
 * ids, model names and evidence file references are read or written.
 *
 * @module orchestrator/routing-revert
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  appendDecisionEvent,
  isDecisionCatalogEnabled,
  makeDecisionOpenedEvent,
  nextDecisionId,
  withEventLogLock,
  type DecisionOption,
} from '../decisions/index.js';
import { now as clockNow } from '../clock.js';
import type { RoutingCell } from '../routing/default-table.js';
import {
  aggregate,
  rowsFor,
  type CellRef,
  type EvidenceScorecard,
} from '../routing/evaluate-cell.js';
import { loadRoutingTable } from '../routing/load-table.js';
import {
  dropStaleOverrides,
  readOverrideEntries,
  writeOverride,
  type RoutingOverride,
} from '../routing/overrides.js';
import { evaluateReverts, type RevertCandidate, type RevertEvaluation } from '../routing/revert.js';
import { sanitizeLabel } from '../usage/sanitize-label.js';
import {
  collect,
  isSafeReference,
  type Collected,
  type RouteDeps,
} from '../usage/route-commands.js';
import type { OrchestratorEvent } from './events.js';

/** Scope every revert Decision carries. */
export const ROUTING_REVERT_SCOPE = 'routing:model-revert';

const ACKNOWLEDGE: DecisionOption[] = [
  {
    id: 'acknowledge',
    description: 'Noted; the override stays until the routing table cell changes',
  },
];

export interface AppliedRevert {
  evaluation: RevertEvaluation;
  override: RoutingOverride;
  decisionId?: string;
}

export interface RoutingRevertResult {
  /** Overrides dropped because their table cell changed. */
  dropped: RoutingOverride[];
  evaluations: RevertEvaluation[];
  applied: AppliedRevert[];
}

export interface RoutingRevertOptions {
  workDir: string;
  artifactsDir: string;
  now?: () => Date;
  /** Event sink; the tick's emitter. No event is written when unset. */
  emit?: (event: Omit<OrchestratorEvent, 'ts'>) => void;
  /** Extra collaborators for the evidence collection (tests). */
  deps?: Partial<RouteDeps>;
  /** Replaces the evidence collection (tests). */
  collectEvidence?: (deps: RouteDeps, opts: { since: string }, now: Date) => Promise<Collected>;
  /** Overrides the allowed gap in points. */
  marginPoints?: number;
  /** Warning sink; defaults to a no-op. */
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** A model name or id safe to put in Decision text: no controls, backticks or whitespace. */
export function escapeForDecision(value: unknown): string {
  return sanitizeLabel(value, 64).replace(/[^A-Za-z0-9._:@/+*-]/g, '?');
}

interface EvidenceBenchmark {
  rate: number;
  since: string;
  repoId: string | null;
}

/**
 * Read the first-pass approval rate and generation time from an evidence file.
 * The reference must be a safe relative path that resolves, symlinks included,
 * inside the artifacts directory, and the file must describe this very cell.
 */
export function readEvidenceBenchmark(
  artifactsDir: string,
  ref: string,
  cell: { role: string; taskClass: string; model: string },
): EvidenceBenchmark | undefined {
  try {
    if (!isSafeReference(ref)) return undefined;
    const root = realpathSync(artifactsDir);
    const real = realpathSync(resolve(artifactsDir, ref));
    if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
    const doc = JSON.parse(readFileSync(real, 'utf8')) as {
      schemaVersion?: unknown;
      repoId?: unknown;
      generatedAt?: unknown;
      cell?: { role?: unknown; model?: unknown; taskClass?: unknown };
      row?: { tasks?: unknown; approved?: unknown };
    };
    if (doc.schemaVersion !== 'v1') return undefined;
    if (doc.cell?.role !== cell.role || doc.cell?.model !== cell.model) return undefined;
    if (cell.taskClass !== '*' && doc.cell?.taskClass !== cell.taskClass) return undefined;
    const tasks = doc.row?.tasks;
    const approved = doc.row?.approved;
    if (typeof tasks !== 'number' || typeof approved !== 'number') return undefined;
    if (!Number.isInteger(tasks) || !Number.isInteger(approved)) return undefined;
    if (tasks <= 0 || approved < 0 || approved > tasks) return undefined;
    if (typeof doc.generatedAt !== 'string' || Number.isNaN(Date.parse(doc.generatedAt))) {
      return undefined;
    }
    return {
      rate: approved / tasks,
      since: doc.generatedAt,
      repoId: typeof doc.repoId === 'string' ? doc.repoId : null,
    };
  } catch {
    return undefined;
  }
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function decisionBody(e: RevertEvaluation): string {
  const role = escapeForDecision(e.role);
  const cls = escapeForDecision(e.taskClass);
  const model = escapeForDecision(e.model);
  const previous = escapeForDecision(e.previousModel);
  const machine = {
    kind: 'model-routing-override',
    version: 1,
    by: 'framework:route-revert',
    role,
    taskClass: cls,
    tableModel: model,
    model: previous,
    tasks: e.tasks,
    observedRate: e.observedRate ?? null,
    evidenceRate: e.evidenceRate,
  };
  return [
    `${role} / ${cls} went back from ${model} to ${previous} automatically.`,
    `Over ${e.tasks} task(s) since the change, ${model} approved ${pct(e.observedRate ?? 0)} ` +
      `of work first-pass, against ${pct(e.evidenceRate)} in the evidence that justified the change ` +
      `(${(e.pointsBelow ?? 0).toFixed(1)} points below).`,
    'For information only: nothing needs doing. The override lasts until the routing table cell changes, ' +
      'and an automatic override only ever moves a cell to a stronger model.',
    '',
    '```json',
    JSON.stringify(machine, null, 2),
    '```',
  ].join('\n');
}

function fileDecision(
  e: RevertEvaluation,
  decisionsDir: string,
  now: Date,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!isDecisionCatalogEnabled(env)) return undefined;
  return withEventLogLock({ workDir: decisionsDir }, () => {
    const id = nextDecisionId({ workDir: decisionsDir });
    appendDecisionEvent(
      makeDecisionOpenedEvent({
        decisionId: id,
        source: 'framework-calibration',
        scope: ROUTING_REVERT_SCOPE,
        summary:
          `Model routing: ${escapeForDecision(e.role)} / ${escapeForDecision(e.taskClass)} ` +
          `reverted to ${escapeForDecision(e.previousModel)}`,
        body: decisionBody(e),
        reversible: true,
        priority: 'low',
        options: ACKNOWLEDGE,
        by: 'framework:route-revert',
        now,
      }),
      { workDir: decisionsDir },
    );
    return id;
  });
}

/** Cells that an applied proposal changed and that can be reverted to a stronger model. */
function changedCells(
  strength: readonly string[],
  cells: Record<string, Record<string, RoutingCell>>,
): Array<{ cell: CellRef; ref: string; previousModel: string }> {
  const out: Array<{ cell: CellRef; ref: string; previousModel: string }> = [];
  for (const [role, byClass] of Object.entries(cells)) {
    const classes = Object.keys(byClass);
    for (const [taskClass, c] of Object.entries(byClass)) {
      if (!c.previousModel || !c.evidence) continue;
      const now = strength.indexOf(c.model);
      const before = strength.indexOf(c.previousModel);
      if (now < 0 || before <= now) continue;
      out.push({
        cell: {
          role,
          taskClass,
          model: c.model,
          candidates: [],
          ...(taskClass === '*' ? { excludeClasses: classes.filter((x) => x !== '*') } : {}),
        },
        ref: c.evidence,
        previousModel: c.previousModel,
      });
    }
  }
  return out;
}

export async function runRoutingReverts(
  opts: RoutingRevertOptions,
): Promise<RoutingRevertResult | 'skipped' | 'error'> {
  try {
    const now = (opts.now ?? clockNow)();
    const env = opts.env ?? process.env;
    const loaded = (opts.deps?.loadTable ?? loadRoutingTable)({
      workDir: opts.workDir,
      readBaseTable: opts.deps?.readBaseTable,
    });
    if (loaded.source !== 'repo') return 'skipped';
    const table = loaded.table;
    const result: RoutingRevertResult = { dropped: [], evaluations: [], applied: [] };

    result.dropped = dropStaleOverrides(opts.artifactsDir, table);

    const changed = changedCells(table.strength, table.cells);
    if (changed.length === 0) return result;

    const deps: RouteDeps = {
      repoRoot: opts.workDir,
      workDir: opts.workDir,
      artifactsDir: opts.artifactsDir,
      now: () => now,
      ...opts.deps,
    };
    const collectFn = opts.collectEvidence ?? collect;
    const decisionsDir = deps.decisionsWorkDir ?? opts.workDir;

    // One evidence collection per distinct start time (usually one).
    const bySince = new Map<
      string,
      Array<{ cell: CellRef; previousModel: string; rate: number; repoId: string | null }>
    >();
    for (const ch of changed) {
      const bench = readEvidenceBenchmark(opts.artifactsDir, ch.ref, ch.cell);
      if (!bench) continue;
      const list = bySince.get(bench.since) ?? [];
      list.push({
        cell: ch.cell,
        previousModel: ch.previousModel,
        rate: bench.rate,
        repoId: bench.repoId,
      });
      bySince.set(bench.since, list);
    }

    for (const [since, group] of bySince) {
      const c = await collectFn(deps, { since }, now);
      // Evidence must be attributable to this repository, as for a proposal.
      if (!c.repoId || c.legacyRecords !== 0 || c.unavailableRecords !== 0) continue;
      const scorecard: EvidenceScorecard = {
        ...c.card,
        legacyRecords: c.legacyRecords,
        unavailableRecords: c.unavailableRecords,
      };
      const candidates: RevertCandidate[] = [];
      for (const g of group) {
        if (g.repoId !== c.repoId) continue;
        const observed = aggregate(rowsFor(g.cell, scorecard, g.cell.model));
        if (observed.malformed) continue;
        candidates.push({
          role: g.cell.role,
          taskClass: g.cell.taskClass,
          model: g.cell.model,
          previousModel: g.previousModel,
          evidenceRate: g.rate,
          observed: { tasks: observed.tasks, approved: observed.approved },
        });
      }
      const evaluations = evaluateReverts(candidates, readOverrideEntries(opts.artifactsDir), {
        minTasks: c.minTasks,
        marginPoints: opts.marginPoints,
      });
      result.evaluations.push(...evaluations);
      for (const e of evaluations) {
        if (!e.revert) continue;
        const written = writeOverride(opts.artifactsDir, table, {
          role: e.role,
          taskClass: e.taskClass,
          model: e.previousModel,
        });
        if (!written.ok) {
          opts.warn?.(
            `[orchestrator] routing revert for ${escapeForDecision(e.role)} / ` +
              `${escapeForDecision(e.taskClass)} refused: ${written.reason}`,
          );
          continue;
        }
        let decisionId: string | undefined;
        try {
          decisionId = fileDecision(e, decisionsDir, now, env);
        } catch (err) {
          opts.warn?.(
            `[orchestrator] routing revert Decision not filed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        try {
          opts.emit?.({
            type: 'ModelRoutingOverrideApplied',
            role: e.role,
            taskClass: e.taskClass,
            model: e.previousModel,
            tableModel: e.model,
            tasks: e.tasks,
            observedRate: e.observedRate,
            evidenceRate: e.evidenceRate,
            ...(decisionId ? { decisionId } : {}),
          });
        } catch {
          // An event sink failure must not undo the override.
        }
        result.applied.push({
          evaluation: e,
          override: written.override,
          ...(decisionId ? { decisionId } : {}),
        });
      }
    }
    return result;
  } catch (err) {
    try {
      opts.warn?.(
        `[orchestrator] routing revert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } catch {
      // Reporting a failure must not itself fail the tick.
    }
    return 'error';
  }
}
