/**
 * `cli-usage route apply` (RFC-0050 B5): turn an approved proposal Decision
 * into a routing-table pull request.
 *
 * This is the only path that changes the routing table, so nothing in the
 * Decision is trusted. The command re-checks who opened and answered it,
 * re-reads the evidence files against their recorded digests, re-derives the
 * evidence for this repository and refuses when the change no longer
 * qualifies. Every check runs before the first write; a refusal changes
 * nothing. The edit happens in a fresh worktree on a new branch cut from the
 * base ref, so the base branch and the caller's checkout are never written.
 *
 * Only counts, rates, ids, model names and evidence file references flow
 * through here.
 *
 * @module usage/route-apply
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { now as clockNow } from '../clock.js';
import { dirname, join, resolve, sep } from 'node:path';
import type { Argv } from 'yargs';
import * as yaml from '../util/yaml.js';
import {
  isDecisionCatalogEnabled,
  projectAll,
  type Decision,
  type OperatorAnsweredEvent,
} from '../decisions/index.js';
import { evaluateCell, type CellRef, type EvidenceScorecard } from '../routing/evaluate-cell.js';
import { MODEL_ROUTING_PATH, loadRoutingTable, parseRoutingTable } from '../routing/load-table.js';
import type { RoutingTable } from '../routing/default-table.js';
import { DEFAULT_MARGIN_POINTS } from '../routing/evaluate-cell.js';
import {
  familyOf,
  foldScorecard,
  foldWeights,
  isAliasTable,
  isFamilyAlias,
} from './route-alias.js';
import {
  ROUTING_PROPOSAL_SCOPE,
  collect,
  digestFile,
  enumerateCells,
  isSafeReference,
  parseProposalBlock,
  type RouteDeps,
} from './route-commands.js';
import { isValidModel } from './replay-run.js';
import { repoIdFor } from './repo-id.js';
import type { UsageIo } from './commands.js';

const DECISION_ID = /^DEC-\d{4,}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const OPTION_SUBSET = /^approve-(\d+(?:-\d+)*)$/;
const EVIDENCE_PREFIXES = ['_routing/evidence/', 'replay/results-'];
const EVIDENCE_DIR = '.ai-sdlc/routing-evidence';

/** Runs `git` or `gh` and returns stdout; throws on a non-zero exit. */
export type CommandRunner = (cmd: 'git' | 'gh', args: string[], cwd: string) => string;

export interface ApplyDeps extends RouteDeps {
  /** Replaces the command runner (tests). */
  exec?: CommandRunner;
}

export interface ApplyOptions {
  decisionId: string;
  /** Write the versioned id and add it to `strength`, instead of the family alias. */
  pin?: boolean;
  /** Base ref the branch is cut from. Default `origin/main`. */
  baseRef?: string;
}

export interface AppliedChange {
  role: string;
  taskClass: string;
  from: string;
  to: string;
  /** Other ids whose evidence was counted as the same model. */
  mergedModels: string[];
}

export type ApplyResult =
  | {
      outcome: 'applied';
      decisionId: string;
      branch: string;
      prUrl: string;
      applied: AppliedChange[];
      declined: Array<{ role: string; taskClass: string }>;
    }
  | { outcome: 'refused'; reason: string };

interface ParsedChange {
  role: string;
  taskClass: string;
  from: string;
  to: string;
  evidence: string[];
  digests: Record<string, string>;
  mergedModels: string[];
  comparison: unknown;
}

const refuse = (reason: string): ApplyResult => ({ outcome: 'refused', reason });

const defaultExec: CommandRunner = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Who opened and answered the Decision, from the event log only. */
function checkProvenance(d: Decision, decisionId: string): string | undefined {
  if (d.metadata.scope !== ROUTING_PROPOSAL_SCOPE) return `${decisionId} is not a routing proposal`;
  const opened = d.decisionLog.find((e) => e.type === 'decision-opened');
  if (
    !opened ||
    opened.by !== 'framework:route-propose' ||
    d.metadata.source !== 'framework-calibration'
  ) {
    return `${decisionId} was not filed by the routing proposal command`;
  }
  const bad = d.decisionLog.find((e) => e.type === 'overridden' || e.type === 'auto-expired');
  if (bad) return `${decisionId} was not answered by the operator`;
  const answers = d.decisionLog.filter((e) => e.type === 'operator-answered');
  const last = answers[answers.length - 1] as OperatorAnsweredEvent | undefined;
  if (d.status.lifecycle !== 'answered' || !last) return `${decisionId} has not been answered`;
  const by = last.by ?? '';
  if (/^(framework|auto)/i.test(by) || d.status.answeredBy !== (last.by ?? null)) {
    return `${decisionId} answer was not recorded by the operator`;
  }
  if (d.status.answeredOptionId !== last.chosenOptionId || last.ts < opened.ts) {
    return `${decisionId} answer does not match the recorded answer event`;
  }
  if (!d.spec.options.some((o) => o.id === last.chosenOptionId)) {
    return `${decisionId} answer is not one of the declared options`;
  }
  return undefined;
}

/** Which change numbers (1-based) the answer approves, or a refusal reason. */
function approvedIndexes(optionId: string, count: number): number[] | string {
  if (optionId === 'decline') return 'the proposal was declined';
  if (optionId === 'approve-all') return Array.from({ length: count }, (_, i) => i + 1);
  const m = OPTION_SUBSET.exec(optionId);
  if (!m) return `answer "${optionId}" does not approve any change`;
  const idx = [...new Set((m[1] as string).split('-').map(Number))];
  if (idx.some((i) => i < 1 || i > count)) return 'answer names a change that does not exist';
  return idx.sort((a, b) => a - b);
}

function parseChange(raw: unknown): ParsedChange | string {
  if (!isRecord(raw)) return 'a change is malformed';
  const { role, taskClass, from, to, evidence, evidenceDigests, mergedModels, comparison } = raw;
  if (typeof role !== 'string' || !NAME.test(role))
    return 'a role name is outside the allowed grammar';
  if (typeof taskClass !== 'string' || !(taskClass === '*' || NAME.test(taskClass))) {
    return 'a task class is outside the allowed grammar';
  }
  for (const m of [from, to]) {
    if (!isValidModel(m)) return 'a model name is outside the allowed grammar';
  }
  const merged = Array.isArray(mergedModels) ? mergedModels : [];
  if (!merged.every((m) => isValidModel(m))) return 'a model name is outside the allowed grammar';
  if (isRecord(comparison) && comparison.kind === 'reviewer') {
    if (typeof comparison.runId !== 'string' || !RUN_ID.test(comparison.runId)) {
      return 'a run id is outside the allowed grammar';
    }
  }
  if (!Array.isArray(evidence) || evidence.length === 0) return 'a change cites no evidence file';
  const digests = isRecord(evidenceDigests) ? evidenceDigests : {};
  for (const ref of evidence) {
    if (
      typeof ref !== 'string' ||
      !isSafeReference(ref) ||
      !ref.endsWith('.json') ||
      !EVIDENCE_PREFIXES.some((p) => ref.startsWith(p))
    ) {
      return 'an evidence reference is not acceptable';
    }
    if (typeof digests[ref] !== 'string' || !HEX64.test(digests[ref] as string)) {
      return 'an evidence file has no recorded digest';
    }
  }
  return {
    role,
    taskClass,
    from: from as string,
    to: to as string,
    evidence: evidence as string[],
    digests: digests as Record<string, string>,
    mergedModels: merged as string[],
    comparison,
  };
}

/** Read an evidence file without following a symlink out of the artifacts directory. */
function evidenceDigest(artifactsDir: string, ref: string): string | undefined {
  const full = resolve(artifactsDir, ref);
  if (!full.startsWith(resolve(artifactsDir) + sep)) return undefined;
  try {
    if (!lstatSync(full).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return digestFile(full);
}

interface CellEdit {
  role: string;
  taskClass: string;
  model: string;
  previousModel: string;
  evidence: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Edit the table text in place so the diff is only the changed cell lines (and
 * the `strength` line for a pin). Comments and layout elsewhere survive.
 */
export function editTableText(
  text: string,
  edits: readonly CellEdit[],
  addToStrength: ReadonlyArray<{ id: string; after: string }>,
): string | { error: string } {
  const lines = text.split('\n');
  for (const e of edits) {
    const roleRe = new RegExp(`^(\\s*)${escapeRe(e.role)}:\\s*(#.*)?$`);
    const start = lines.findIndex((l) => roleRe.test(l));
    if (start < 0) return { error: `role ${e.role} is not a block in the routing table` };
    const roleIndent = (roleRe.exec(lines[start] as string) as RegExpExecArray)[1]?.length ?? 0;
    const cellRe = new RegExp(
      `^(\\s+)(['"]?)${escapeRe(e.taskClass)}\\2:\\s*\\{(.*)\\}\\s*(#.*)?$`,
    );
    let done = false;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() !== '' && !line.trim().startsWith('#')) {
        const indent = line.length - line.trimStart().length;
        if (indent <= roleIndent) break;
      }
      const m = cellRe.exec(line);
      if (!m) continue;
      let inner: unknown;
      try {
        inner = yaml.load(`{${m[3]}}`);
      } catch {
        return { error: `cell ${e.role} / ${e.taskClass} could not be read` };
      }
      const candidates = isRecord(inner) && Array.isArray(inner.candidates) ? inner.candidates : [];
      if (!candidates.every((c) => typeof c === 'string' && isValidModel(c))) {
        return { error: `cell ${e.role} / ${e.taskClass} has an unreadable candidate list` };
      }
      const key = m[2] ? `${m[2]}${e.taskClass}${m[2]}` : e.taskClass === '*' ? "'*'" : e.taskClass;
      const parts = [`model: ${e.model}`];
      if (candidates.length > 0) parts.push(`candidates: [${candidates.join(', ')}]`);
      parts.push(`evidence: '${e.evidence}'`, `previousModel: ${e.previousModel}`);
      lines[i] = `${m[1]}${key}: { ${parts.join(', ')} }${m[4] ? ` ${m[4]}` : ''}`;
      done = true;
      break;
    }
    if (!done) {
      return { error: `cell ${e.role} / ${e.taskClass} is not on a single flow-style line` };
    }
  }
  if (addToStrength.length > 0) {
    const sRe = /^(\s*strength:\s*)\[(.*)\](\s*#.*)?$/;
    const i = lines.findIndex((l) => sRe.test(l));
    if (i < 0) return { error: 'the strength list is not on a single flow-style line' };
    const m = sRe.exec(lines[i] as string) as RegExpExecArray;
    const items = (m[2] as string).split(',').map((s) => s.trim());
    for (const add of addToStrength) {
      if (items.includes(add.id)) continue;
      const at = items.indexOf(add.after);
      if (at < 0) return { error: `${add.after} is not in the strength list` };
      items.splice(at + 1, 0, add.id);
    }
    lines[i] = `${m[1]}[${items.join(', ')}]${m[3] ?? ''}`;
  }
  return lines.join('\n');
}

/** The model name a cell is written with, or a refusal reason. */
export function modelToWrite(
  change: { to: string; mergedModels: string[] },
  aliasTable: boolean,
  pin: boolean,
): { model: string; pinned: boolean } | string {
  if (!aliasTable) return { model: change.to, pinned: false };
  const family = familyOf(change.to);
  if (family === null) return `${change.to} maps to no known model family`;
  if (!pin) return { model: family, pinned: false };
  if (!isFamilyAlias(change.to)) return { model: change.to, pinned: true };
  const versioned = change.mergedModels.filter((m) => familyOf(m) === family);
  if (versioned.length === 1) return { model: versioned[0] as string, pinned: true };
  return `--pin needs exactly one versioned id for ${family} in the evidence; found ${versioned.length}`;
}

function prBody(
  decisionId: string,
  applied: Array<ParsedChange & { written: string }>,
  declined: ParsedChange[],
): string {
  const pct = (r: number): string => `${(r * 100).toFixed(1)}%`;
  const detail = (c: ParsedChange): string => {
    const cmp = c.comparison as Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (cmp?.kind === 'developer') {
      return (
        `${cmp.candidate.approved}/${cmp.candidate.tasks} first-pass approved (${pct(cmp.candidate.rate)}) ` +
        `vs ${cmp.current.approved}/${cmp.current.tasks} (${pct(cmp.current.rate)})`
      );
    }
    if (cmp?.kind === 'reviewer') {
      return (
        `replay of ${cmp.items} item(s): recall ${pct(cmp.candidate.recall)} vs ${pct(cmp.current.recall)}, ` +
        `false-block ${pct(cmp.candidate.falseBlockRate)} vs ${pct(cmp.current.falseBlockRate)}`
      );
    }
    return 'no comparison recorded';
  };
  const lines = [
    `Applies the answered routing proposal ${decisionId}. Only the listed table cells, their evidence references and the evidence files change.`,
    '',
    '## Changes',
    ...applied.map(
      (c) =>
        `- ${c.role} / ${c.taskClass}: ${c.from} -> ${c.written}. ${detail(c)}.` +
        (c.mergedModels.length > 0
          ? ` Ids counted as the same model: ${c.mergedModels.join(', ')}.`
          : ''),
    ),
  ];
  if (declined.length > 0) {
    lines.push(
      '',
      '## Not approved (information only)',
      ...declined.map((c) => `- ${c.role} / ${c.taskClass}: ${c.from} -> ${c.to}`),
    );
  }
  lines.push('', 'Revert: each cell records its previous model in `previousModel`.');
  return lines.join('\n');
}

/** Apply an approved proposal Decision as a pull request. */
export async function runRouteApply(deps: ApplyDeps, opts: ApplyOptions): Promise<ApplyResult> {
  const now = deps.now?.() ?? clockNow();
  const repoRoot = resolve(deps.repoRoot ?? deps.workDir ?? process.cwd());
  const exec = deps.exec ?? defaultExec;
  const decisionsDir = deps.decisionsWorkDir ?? repoRoot;
  const id = opts.decisionId;
  if (!DECISION_ID.test(id)) return refuse(`invalid decision id "${id}"; expected DEC-NNNN`);
  if (!isDecisionCatalogEnabled(deps.env ?? process.env)) {
    return refuse('the Decision Catalog is switched off');
  }

  const decision = projectAll({ workDir: decisionsDir }).decisions.get(id);
  if (!decision) return refuse(`decision not found: ${id}`);
  const provenance = checkProvenance(decision, id);
  if (provenance) return refuse(provenance);

  const block = parseProposalBlock(decision.spec.body ?? '');
  if (!block || block.kind !== 'model-routing-proposal' || !Array.isArray(block.changes)) {
    return refuse(`${id} is not a routing proposal`);
  }
  const parsed: ParsedChange[] = [];
  for (const raw of block.changes) {
    const c = parseChange(raw);
    if (typeof c === 'string') return refuse(c);
    parsed.push(c);
  }
  const chosen = (decision.status.answeredOptionId ?? '') as string;
  const indexes = approvedIndexes(chosen, parsed.length);
  if (typeof indexes === 'string') return refuse(indexes);
  const approved = indexes.map((i) => parsed[i - 1] as ParsedChange);
  const declined = parsed.filter((_, i) => !indexes.includes(i + 1));

  // Evidence: bound to the repository and to the recorded digests.
  const repoId = repoIdFor(repoRoot);
  if (repoId === undefined || block.repoId !== repoId) {
    return refuse('the proposal was not resolved for this repository');
  }
  const artifactsDir = resolve(
    deps.artifactsDir ?? process.env.ARTIFACTS_DIR ?? join(repoRoot, '.ai-sdlc', 'artifacts'),
  );
  for (const c of approved) {
    for (const ref of c.evidence) {
      if (evidenceDigest(artifactsDir, ref) !== c.digests[ref]) {
        return refuse(`evidence file ${ref} does not match its recorded digest`);
      }
    }
  }

  // The table comes from the base ref only.
  const baseRef = opts.baseRef ?? 'origin/main';
  const loaded = (deps.loadTable ?? loadRoutingTable)({
    workDir: repoRoot,
    baseRef,
    readBaseTable: deps.readBaseTable,
  });
  if (loaded.source !== 'repo') return refuse(`no usable routing table (${loaded.reason})`);
  const table: RoutingTable = loaded.table;
  const aliasTable = isAliasTable(table);

  // Re-derive: the change must still qualify for this repository.
  const c = await collect(deps, {}, now);
  if (c.repoId !== repoId) return refuse('the repository identity changed');
  const evidence: EvidenceScorecard = foldScorecard(
    { ...c.card, legacyRecords: c.legacyRecords, unavailableRecords: c.unavailableRecords },
    aliasTable,
  );
  const cells = enumerateCells(table);
  const edits: Array<CellEdit & { change: ParsedChange; written: string }> = [];
  const strengthAdds: Array<{ id: string; after: string }> = [];
  const seen = new Set<string>();
  for (const ch of approved) {
    const key = `${ch.role}\u0000${ch.taskClass}`;
    if (seen.has(key)) return refuse('a cell is listed twice');
    seen.add(key);
    const cell = cells.find((x) => x.role === ch.role && x.taskClass === ch.taskClass) as
      CellRef | undefined;
    if (!cell || cell.model !== ch.from) {
      return refuse(`${ch.role} / ${ch.taskClass} no longer uses ${ch.from}`);
    }
    const target = modelToWrite(ch, aliasTable, opts.pin === true);
    if (typeof target === 'string') return refuse(target);
    if (target.pinned) {
      const family = familyOf(target.model) as string;
      if (!table.strength.includes(family)) return refuse(`${family} is not in the strength list`);
      strengthAdds.push({ id: target.model, after: family });
    } else if (!table.strength.includes(target.model)) {
      return refuse(`${target.model} is not in the strength list`);
    }
    const evaluation = evaluateCell(cell, evidence, {
      minTasks: c.minTasks,
      marginPoints: DEFAULT_MARGIN_POINTS,
      weights: foldWeights(c.weights, aliasTable),
      replay: c.replay,
    });
    const proposed = evaluation.proposed?.model;
    const same =
      proposed !== undefined &&
      (aliasTable ? familyOf(proposed) === familyOf(ch.to) : proposed === ch.to);
    if (!same) return refuse(`${ch.role} / ${ch.taskClass} no longer qualifies for ${ch.to}`);

    const ref = ch.evidence[0] as string;
    edits.push({
      role: ch.role,
      taskClass: ch.taskClass,
      model: target.model,
      previousModel: ch.from,
      evidence: `${EVIDENCE_DIR}/${id}/${ref.replace(/\//g, '__')}`,
      change: ch,
      written: target.model,
    });
  }

  // Edit the base table text and check only the intended cells moved.
  const baseText = (deps.readBaseTable ?? ((w, r) => readBase(exec, w, r)))(repoRoot, baseRef);
  if (baseText === null) return refuse('the routing table could not be read from the base ref');
  const edited = editTableText(baseText, edits, strengthAdds);
  if (typeof edited !== 'string') return refuse(edited.error);
  const reparsed = parseRoutingTable(edited);
  if (!reparsed.ok) return refuse(`the edited routing table is not valid (${reparsed.reason})`);
  for (const cell of cells) {
    const e = edits.find((x) => x.role === cell.role && x.taskClass === cell.taskClass);
    const after = reparsed.table.cells[cell.role]?.[cell.taskClass];
    if (!after || (e ? after.model !== e.model : after.model !== cell.model)) {
      return refuse('the edit changed a cell it should not have');
    }
  }

  // Everything checked: now touch git. A dirty checkout is refused first.
  if (exec('git', ['status', '--porcelain'], repoRoot).trim() !== '') {
    return refuse('the working tree has uncommitted changes');
  }
  const branch = `routing/${id.toLowerCase()}`;
  const tmp = mkdtempSync(join(tmpdir(), 'route-apply-'));
  const wt = join(tmp, 'wt');
  try {
    exec('git', ['worktree', 'add', '-b', branch, wt, baseRef], repoRoot);
    const tablePath = join(wt, MODEL_ROUTING_PATH);
    mkdirSync(dirname(tablePath), { recursive: true });
    writeFileSync(tablePath, edited);
    const files = [MODEL_ROUTING_PATH];
    for (const ch of approved) {
      for (const ref of ch.evidence) {
        const rel = `${EVIDENCE_DIR}/${id}/${ref.replace(/\//g, '__')}`;
        mkdirSync(join(wt, EVIDENCE_DIR, id), { recursive: true });
        copyFileSync(resolve(artifactsDir, ref), join(wt, rel));
        files.push(rel);
      }
    }
    exec('git', ['add', '--', ...files], wt);
    exec(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-m',
        `chore(routing): apply approved model routing proposal ${id}`,
      ],
      wt,
    );
    exec('git', ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], wt);
    const body = prBody(
      id,
      edits.map((e) => ({ ...e.change, written: e.written })),
      declined,
    );
    const prUrl = exec(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--title',
        `chore(routing): apply model routing proposal ${id}`,
        '--body',
        body,
      ],
      wt,
    ).trim();
    return {
      outcome: 'applied',
      decisionId: id,
      branch,
      prUrl,
      applied: edits.map((e) => ({
        role: e.role,
        taskClass: e.taskClass,
        from: e.previousModel,
        to: e.written,
        mergedModels: e.change.mergedModels,
      })),
      declined: declined.map((d) => ({ role: d.role, taskClass: d.taskClass })),
    };
  } finally {
    try {
      exec('git', ['worktree', 'remove', '--force', wt], repoRoot);
    } catch {
      // the temporary directory is removed below either way
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readBase(exec: CommandRunner, workDir: string, ref: string): string | null {
  try {
    return exec('git', ['show', `${ref}:${MODEL_ROUTING_PATH}`], workDir);
  } catch {
    return null;
  }
}

export function renderApplyText(r: ApplyResult): string {
  if (r.outcome === 'refused') return `Refused: ${r.reason}\n`;
  const lines = [`Opened ${r.prUrl} on branch ${r.branch}.`];
  for (const a of r.applied) lines.push(`  ${a.role} / ${a.taskClass}: ${a.from} -> ${a.to}`);
  for (const d of r.declined) lines.push(`  not approved: ${d.role} / ${d.taskClass}`);
  return `${lines.join('\n')}\n`;
}

export function registerRouteApplyCommand(y: Argv, deps: ApplyDeps, io: UsageIo): Argv {
  return y.command(
    'apply',
    'Apply an approved routing proposal Decision as a pull request',
    (c) =>
      c
        .option('decision', { type: 'string', demandOption: true, description: 'DEC-NNNN' })
        .option('pin', {
          type: 'boolean',
          default: false,
          description: 'Write the versioned id and add it to strength, not the family alias',
        })
        .option('json', { type: 'boolean', default: false }),
    async (argv) => {
      try {
        const result = await runRouteApply(deps, {
          decisionId: String(argv.decision),
          pin: argv.pin,
        });
        io.out(argv.json ? `${JSON.stringify(result, null, 2)}\n` : renderApplyText(result));
        if (result.outcome === 'refused') io.exit(1);
      } catch (err) {
        io.err(`${err instanceof Error ? err.message : String(err)}\n`);
        io.exit(1);
      }
    },
  );
}
