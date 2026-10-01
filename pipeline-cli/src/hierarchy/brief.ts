/**
 * `cli-hierarchy brief`: generate a dispatch brief from task metadata.
 *
 * The planner hands work to the dispatch session as a brief: waves derived from
 * task dependencies, sequence groups derived from overlapping references, the
 * tasks that must not be dispatched, and the trust-sensitive ones. The output is
 * Markdown with prose the planner edits plus a YAML block the board ingests
 * (see brief-format.ts).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildDependencyGraph, type DependencyNode } from '../deps/dependency-graph.js';
import { parseSimpleYaml } from '../steps/01-validate.js';
import { renderBriefBlock, type BriefEntry } from './brief-format.js';
import { readRosterChecked } from './roster.js';
import type { HierarchyDeps, RosterEntry } from './types.js';
import { isValidTaskId } from './validate.js';

/** Metadata of one open task, as far as a brief needs it. */
export interface BriefTask {
  id: string;
  title: string;
  priority: string;
  dependencies: string[];
  references: string[];
  dispatchable: boolean;
}

/** One sequence group and its members. */
export interface SequenceGroup {
  name: string;
  /** The shared file the group is named after. */
  file: string;
  tasks: string[];
}

/** The computed plan a brief is rendered from. */
export interface BriefPlan {
  /** Dispatchable tasks, ordered by wave then id. */
  entries: BriefEntry[];
  /** Every task in the set (dispatchable or not), by id. */
  tasks: Map<string, BriefTask>;
  groups: SequenceGroup[];
  /** Tasks that must not be dispatched. */
  doNotDispatch: string[];
  /** Tasks whose references touch hooks, workflows, governance or the execute command. */
  trustSensitive: { task: string; paths: string[] }[];
  /** Unfinished prerequisites outside the dispatched set, per task. */
  external: { task: string; prerequisite: string; reason: string }[];
  /** Secondary overlaps not covered by the single group a task carries. */
  secondaryOverlaps: { task: string; file: string }[];
}

const FIXED_GROUPS: { match: (file: string) => boolean; name: string }[] = [
  { match: (f) => path.posix.basename(f) === 'generated-schemas.ts', name: 'schema-regen' },
  {
    match: (f) => f === 'reference/src/index.ts' || f.endsWith('/reference/src/index.ts'),
    name: 'root-barrel',
  },
  { match: (f) => path.posix.basename(f) === 'events.ts', name: 'events' },
];

function normalizeRef(ref: string): string {
  return ref.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function isRfcOrBacklogRef(ref: string): boolean {
  return /(^|\/)spec\/rfcs\//.test(ref) || /^backlog\//.test(ref);
}

/** True when a reference touches hooks, workflows, governance or the execute command. */
export function isTrustSensitivePath(ref: string): boolean {
  const lower = normalizeRef(ref).toLowerCase();
  const base = path.posix.basename(lower);
  return (
    /(^|\/)hooks\//.test(lower) ||
    base.includes('hook') ||
    lower.includes('.github/workflows/') ||
    lower.includes('governance') ||
    base === 'execute.md'
  );
}

/** Name of the fixed group for a file, when it is a well-known shared surface. */
function fixedGroupName(file: string): string | undefined {
  return FIXED_GROUPS.find((g) => g.match(file))?.name;
}

/**
 * Compute waves, groups and flags for a set of tasks.
 * @param isCompleted tells whether a task outside the set is already finished.
 * @throws on a dependency cycle inside the dispatchable set.
 */
export function planBrief(
  tasks: readonly BriefTask[],
  isCompleted: (id: string) => boolean | undefined,
): BriefPlan {
  const byId = new Map(tasks.map((t) => [t.id.toLowerCase(), t]));
  const dispatchable = tasks.filter((t) => t.dispatchable);
  const dispatchableIds = new Set(dispatchable.map((t) => t.id.toLowerCase()));

  const external: BriefPlan['external'] = [];
  const afterOf = new Map<string, string[]>();
  for (const t of tasks) {
    const after: string[] = [];
    for (const dep of t.dependencies) {
      const key = dep.toLowerCase();
      const inSet = byId.get(key);
      if (inSet?.dispatchable) {
        after.push(inSet.id);
        continue;
      }
      if (inSet) {
        external.push({
          task: t.id,
          prerequisite: inSet.id,
          reason: 'not dispatched (operator-only); finish it first',
        });
        continue;
      }
      const done = isCompleted(dep);
      if (done === true) continue;
      external.push({
        task: t.id,
        prerequisite: dep,
        reason: done === undefined ? 'not found in the backlog' : 'not yet completed',
      });
    }
    afterOf.set(t.id.toLowerCase(), after);
  }

  // Waves: longest dependency chain within the dispatchable set.
  const wave = new Map<string, number>();
  const visiting = new Set<string>();
  const resolve = (key: string, trail: string[]): number => {
    const known = wave.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) {
      throw new Error(`dependency cycle among the selected tasks: ${[...trail, key].join(' -> ')}`);
    }
    visiting.add(key);
    let w = 1;
    for (const dep of afterOf.get(key) ?? []) {
      w = Math.max(w, resolve(dep.toLowerCase(), [...trail, key]) + 1);
    }
    visiting.delete(key);
    wave.set(key, w);
    return w;
  };
  for (const key of dispatchableIds) resolve(key, []);

  // Sequence groups from shared non-RFC references.
  const filesOf = new Map<string, Set<string>>();
  const tasksOfFile = new Map<string, Set<string>>();
  for (const t of dispatchable) {
    const files = new Set(t.references.map(normalizeRef).filter((r) => r && !isRfcOrBacklogRef(r)));
    filesOf.set(t.id, files);
    for (const f of files) {
      if (!tasksOfFile.has(f)) tasksOfFile.set(f, new Set());
      tasksOfFile.get(f)!.add(t.id);
    }
  }
  const groupOfFile = (f: string): { name: string; rank: number } | undefined => {
    const fixed = fixedGroupName(f);
    if (fixed) return { name: fixed, rank: Number.MAX_SAFE_INTEGER };
    const n = tasksOfFile.get(f)?.size ?? 0;
    return n >= 2 ? { name: path.posix.basename(f), rank: n } : undefined;
  };
  const groupMembers = new Map<string, SequenceGroup>();
  const groupOfTask = new Map<string, string>();
  const secondaryOverlaps: BriefPlan['secondaryOverlaps'] = [];
  for (const t of dispatchable) {
    const candidates = [...(filesOf.get(t.id) ?? [])]
      .map((f) => ({ file: f, group: groupOfFile(f) }))
      .filter((c): c is { file: string; group: { name: string; rank: number } } => !!c.group)
      .sort((a, b) => b.group.rank - a.group.rank || a.file.localeCompare(b.file));
    const [chosen, ...rest] = candidates;
    if (!chosen) continue;
    groupOfTask.set(t.id, chosen.group.name);
    const g = groupMembers.get(chosen.group.name) ?? {
      name: chosen.group.name,
      file: chosen.file,
      tasks: [],
    };
    g.tasks.push(t.id);
    groupMembers.set(chosen.group.name, g);
    for (const r of rest) secondaryOverlaps.push({ task: t.id, file: r.file });
  }

  const entries: BriefEntry[] = dispatchable
    .map((t) => {
      const entry: BriefEntry = {
        task: t.id,
        after: afterOf.get(t.id.toLowerCase()) ?? [],
        wave: wave.get(t.id.toLowerCase()) ?? 1,
      };
      const group = groupOfTask.get(t.id);
      if (group) entry.sequenceGroup = group;
      if (/^[a-z][a-z0-9-]{0,15}$/.test(t.priority)) entry.priority = t.priority;
      return entry;
    })
    .sort((a, b) => a.wave - b.wave || a.task.localeCompare(b.task, 'en', { numeric: true }));

  const trustSensitive = tasks
    .map((t) => ({
      task: t.id,
      paths: t.references.map(normalizeRef).filter(isTrustSensitivePath),
    }))
    .filter((t) => t.paths.length > 0);

  return {
    entries,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    groups: [...groupMembers.values()].sort((a, b) => a.name.localeCompare(b.name)),
    doNotDispatch: tasks.filter((t) => !t.dispatchable).map((t) => t.id),
    trustSensitive,
    external,
    secondaryOverlaps,
  };
}

function readFrontmatterMeta(node: DependencyNode): BriefTask {
  const raw = readFileSync(node.filePath, 'utf8');
  const fm = parseSimpleYaml(raw.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '');
  const refs = Array.isArray(fm.references) ? (fm.references as unknown[]).map(String) : [];
  const flag = fm.dispatchable;
  return {
    id: node.id,
    title: node.title,
    priority: node.priority,
    dependencies: node.dependencies,
    references: refs,
    dispatchable: !(flag === false || String(flag).toLowerCase() === 'false'),
  };
}

/** What to select tasks by. Exactly one of `tasks` and `rfc`. */
export interface BriefSelection {
  /** Comma-separated task ids. */
  tasks?: string;
  /** RFC identifier such as `RFC-0051`. */
  rfc?: string;
}

/** Selected tasks plus the context needed to plan them. */
export interface SelectedTasks {
  tasks: BriefTask[];
  warnings: string[];
  isCompleted: (id: string) => boolean | undefined;
  slug: string;
  title: string;
}

/**
 * Select the open tasks for a brief from the backlog under `workDir`.
 * @throws on a malformed selection, an unknown task id, or an empty result.
 */
export function selectTasks(workDir: string, selection: BriefSelection): SelectedTasks {
  if (!!selection.tasks === !!selection.rfc) {
    throw new Error('give exactly one of --tasks <id,...> or --rfc <RFC-NNNN>');
  }
  const warnings: string[] = [];
  const graph = buildDependencyGraph({ workDir }, (w) => warnings.push(w));
  const isCompleted = (id: string): boolean | undefined => {
    const node = graph.nodes.get(id.toLowerCase());
    return node ? node.status === 'completed' : undefined;
  };
  const openNodes = graph.openIds.map((k) => graph.nodes.get(k)!).filter(Boolean);

  if (selection.rfc !== undefined) {
    if (!/^RFC-[0-9]{4}$/.test(selection.rfc)) {
      throw new Error(`invalid --rfc '${selection.rfc}': expected RFC-NNNN`);
    }
    const prefix = `${selection.rfc}-`;
    const tasks = openNodes.map(readFrontmatterMeta).filter((t) =>
      t.references.some((r) => {
        const base = path.posix.basename(normalizeRef(r));
        return base === `${selection.rfc}.md` || base.startsWith(prefix);
      }),
    );
    if (tasks.length === 0) throw new Error(`no open task references ${selection.rfc}`);
    return {
      tasks,
      warnings,
      isCompleted,
      slug: selection.rfc.toLowerCase(),
      title: selection.rfc,
    };
  }

  const ids = (selection.tasks ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) throw new Error('--tasks needs at least one task id');
  const tasks: BriefTask[] = [];
  for (const id of ids) {
    if (!isValidTaskId(id.toUpperCase())) throw new Error(`invalid task id '${id}'`);
    const node = graph.nodes.get(id.toLowerCase());
    if (!node) throw new Error(`task '${id}' was not found in the backlog`);
    if (node.status === 'completed') {
      warnings.push(`${node.id} is already completed; left out of the brief`);
      continue;
    }
    if (!tasks.some((t) => t.id === node.id)) tasks.push(readFrontmatterMeta(node));
  }
  if (tasks.length === 0) throw new Error('every selected task is already completed');
  const first = tasks[0]!.id.toLowerCase();
  const slug = tasks.length > 1 ? `tasks-${first}-plus-${tasks.length - 1}` : `tasks-${first}`;
  return { tasks, warnings, isCompleted, slug, title: tasks.map((t) => t.id).join(', ') };
}

function sessionLine(label: string, entry: RosterEntry | undefined, hint: string): string {
  return entry
    ? `- ${label}: \`${entry.name}\` (tmux window \`${entry.tmuxWindow}\`)`
    : `- ${label}: not in the roster (${hint})`;
}

/** Render the brief Markdown. */
export function renderBrief(
  plan: BriefPlan,
  context: { title: string; generatedAt: string; planner?: RosterEntry; dispatch?: RosterEntry },
): string {
  const t = (id: string): string => `${id}: ${plan.tasks.get(id)?.title ?? ''}`.trimEnd();
  const lines: string[] = [];
  lines.push(`# Dispatch brief: ${context.title}`, '');
  lines.push(
    `Generated ${context.generatedAt}. Edit the prose and the YAML block, then hand it to dispatch.`,
    '',
  );
  lines.push(sessionLine('Planner session', context.planner, 'start it with `cli-hierarchy up`'));
  lines.push(
    sessionLine('Dispatch session', context.dispatch, 'start it with `cli-hierarchy up`'),
    '',
  );

  lines.push('## Summary', '');
  lines.push(
    `${plan.entries.length} task(s) to dispatch across ${Math.max(0, ...plan.entries.map((e) => e.wave))} wave(s); ` +
      `${plan.doNotDispatch.length} not to dispatch; ${plan.trustSensitive.length} trust-sensitive.`,
    '',
  );

  lines.push('## Waves', '');
  const waves = [...new Set(plan.entries.map((e) => e.wave))].sort((a, b) => a - b);
  if (waves.length === 0) lines.push('No dispatchable tasks.', '');
  for (const w of waves) {
    lines.push(`### Wave ${w}`, '');
    for (const e of plan.entries.filter((x) => x.wave === w)) {
      const after = e.after.length ? ` (after ${e.after.join(', ')})` : '';
      const group = e.sequenceGroup ? ` [group: ${e.sequenceGroup}]` : '';
      lines.push(`- ${t(e.task)}${after}${group}`);
    }
    lines.push('');
  }

  lines.push('## Sequence groups', '');
  lines.push('At most one task of a group runs at a time.', '');
  if (plan.groups.length === 0) lines.push('None.');
  for (const g of plan.groups) lines.push(`- \`${g.name}\` (${g.file}): ${g.tasks.join(', ')}`);
  for (const s of plan.secondaryOverlaps) {
    lines.push(`- Also overlaps, review by hand: ${s.task} touches \`${s.file}\``);
  }
  lines.push('');

  lines.push('## Do not dispatch', '');
  if (plan.doNotDispatch.length === 0) lines.push('None.');
  for (const id of plan.doNotDispatch) lines.push(`- ${t(id)}`);
  lines.push('');

  lines.push('## Trust-sensitive', '');
  lines.push(
    'These touch hooks, workflows, governance or the execute command. Review them by hand.',
    '',
  );
  if (plan.trustSensitive.length === 0) lines.push('None.');
  for (const s of plan.trustSensitive) lines.push(`- ${t(s.task)}: ${s.paths.join(', ')}`);
  lines.push('');

  lines.push('## External prerequisites', '');
  if (plan.external.length === 0) lines.push('None.');
  for (const x of plan.external) lines.push(`- ${x.task} needs ${x.prerequisite} (${x.reason})`);
  lines.push('');

  lines.push('## Dispatch entries', '');
  lines.push(
    `The dispatch session reads this block. Remove an entry to hold a task back; keep \`after\`, \`sequenceGroup\` and \`wave\` consistent with the sections above.`,
    '',
  );
  lines.push(renderBriefBlock(plan.entries), '');

  lines.push(
    '## Notes for dispatch',
    '',
    '(Write anything the dispatch session should know before it starts.)',
    '',
  );
  return lines.join('\n');
}

/** Options for {@link generateBrief}. */
export interface BriefOptions extends BriefSelection {
  /** Output file. Defaults to `<boardDir>/briefs/<slug>.md`. */
  out?: string;
  /** Replace an existing file. */
  force?: boolean;
  /**
   * The caller will notify dispatch. An existing file is then kept as it is
   * (the planner has edited it) instead of being an error.
   */
  keepExisting?: boolean;
}

/** Result of {@link generateBrief}. */
export interface BriefResult {
  file: string;
  plan: BriefPlan;
  dispatch?: RosterEntry;
  /** True when an existing file was left untouched. */
  reused: boolean;
}

/**
 * Generate and write a brief.
 * @throws when the selection is invalid or the output file already exists without `force`.
 */
export function generateBrief(options: BriefOptions, deps: HierarchyDeps): BriefResult {
  const selected = selectTasks(deps.cwd, options);
  for (const w of selected.warnings) deps.log(`warning: ${w}`);
  const plan = planBrief(selected.tasks, selected.isCompleted);

  const { roster, rejected } = readRosterChecked(deps.boardDir);
  for (const r of rejected) deps.log(`warning: ${r}`);
  const planner = roster.sessions.find((e) => e.role === 'planner');
  const dispatch = roster.sessions.find((e) => e.role === 'operator-dispatch');

  const file = options.out
    ? path.resolve(deps.cwd, options.out)
    : path.join(deps.boardDir, 'briefs', `${selected.slug}.md`);
  if (existsSync(file) && !options.force) {
    if (options.keepExisting) return { file, plan, dispatch, reused: true };
    throw new Error(`${file} already exists; pass --force to replace it`);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    renderBrief(plan, {
      title: selected.title,
      generatedAt: deps.now().toISOString(),
      planner,
      dispatch,
    }),
    'utf-8',
  );
  return { file, plan, dispatch, reused: false };
}
