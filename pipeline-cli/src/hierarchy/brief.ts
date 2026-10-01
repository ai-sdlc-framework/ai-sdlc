/**
 * `cli-hierarchy brief`: generate a dispatch brief from task metadata.
 *
 * The planner hands work to the dispatch session as a brief: waves derived from
 * task dependencies, sequence groups derived from overlapping references, the
 * tasks that must not be dispatched, and the trust-sensitive ones. The output is
 * Markdown with prose the planner edits plus a YAML block the board ingests
 * (see brief-format.ts).
 */

import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  lstatSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type Stats,
} from 'node:fs';
import path from 'node:path';

import { buildDependencyGraph, type DependencyNode } from '../deps/dependency-graph.js';
import { parseSimpleYaml } from '../steps/01-validate.js';
import { GROUP_PATTERN, renderBriefBlock, type BriefEntry } from './brief-format.js';
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

/**
 * Backlog priority word to the integer the dispatch manifest carries.
 * Lower runs earlier (claim order: wave, then priority, then enqueue time).
 * Any other value yields no priority.
 */
const PRIORITY_RANK: Readonly<Record<string, number>> = { high: 1, medium: 2, low: 3 };

/** Control, bidi-override and line-separator characters that must not reach the Markdown. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/** Collapse control characters to a space and neutralise backticks (inline text). */
function mdText(value: string): string {
  return value.replace(UNSAFE_TEXT, ' ').replace(/`/g, '\\`').trim();
}

/** Same as {@link mdText} for text inside a code span, where a backslash cannot escape. */
function mdCode(value: string): string {
  return value.replace(UNSAFE_TEXT, ' ').replace(/`/g, "'").trim();
}

function sanitizeGroupName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/-+\./g, '.')
    .replace(/[-._]+$/, '')
    .slice(0, 100);
}

function hashName(file: string): string {
  return `file-${createHash('sha1').update(file).digest('hex').slice(0, 8)}`;
}

/**
 * Names for shared files, keyed by full path. A name is the sanitized basename;
 * colliding basenames get the shortest path suffix that tells them apart
 * (`a/index.ts` and `b/index.ts` become `a-index.ts` and `b-index.ts`).
 * Every result satisfies GROUP_PATTERN and none equals a reserved name.
 */
function deriveGroupNames(
  files: readonly string[],
  reserved: ReadonlySet<string>,
): Map<string, string> {
  const segs = (f: string): string[] => f.split('/').filter(Boolean);
  const nameAt = (f: string, k: number): string => sanitizeGroupName(segs(f).slice(-k).join('-'));
  const result = new Map<string, string>();
  const sorted = [...new Set(files)].sort();
  const byBase = new Map<string, string[]>();
  for (const f of sorted) {
    const b = nameAt(f, 1);
    byBase.set(b, [...(byBase.get(b) ?? []), f]);
  }
  const used = new Set<string>(reserved);
  for (const group of byBase.values()) {
    let k = 1;
    const maxK = Math.max(...group.map((f) => segs(f).length));
    let names = group.map((f) => nameAt(f, k));
    while (k < maxK && new Set(names).size !== names.length) {
      k++;
      names = group.map((f) => nameAt(f, k));
    }
    group.forEach((f, i) => {
      let name = names[i]!;
      if (!name || !GROUP_PATTERN.test(name) || used.has(name)) {
        name = hashName(f);
      }
      used.add(name);
      result.set(f, name);
    });
  }
  return result;
}

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
  const reserved = new Set(FIXED_GROUPS.map((g) => g.name));
  const derivedNames = deriveGroupNames(
    [...tasksOfFile.entries()]
      .filter(([f, ts]) => ts.size >= 2 && !fixedGroupName(f))
      .map(([f]) => f),
    reserved,
  );
  const groupOfFile = (f: string): { name: string; rank: number } | undefined => {
    const fixed = fixedGroupName(f);
    if (fixed) return { name: fixed, rank: Number.MAX_SAFE_INTEGER };
    const n = tasksOfFile.get(f)?.size ?? 0;
    const name = derivedNames.get(f);
    return n >= 2 && name ? { name, rank: n } : undefined;
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
      const rank = PRIORITY_RANK[t.priority];
      if (rank !== undefined) entry.priority = rank;
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
    const rfc = selection.rfc.toUpperCase();
    if (!/^RFC-[0-9]{4}$/.test(rfc)) {
      throw new Error(`invalid --rfc '${selection.rfc}': expected RFC-NNNN`);
    }
    const prefix = `${rfc}-`;
    const tasks = openNodes.map(readFrontmatterMeta).filter((t) =>
      t.references.some((r) => {
        const base = path.posix.basename(normalizeRef(r));
        return base.toUpperCase() === `${rfc}.MD` || base.toUpperCase().startsWith(prefix);
      }),
    );
    if (tasks.length === 0) throw new Error(`no open task references ${rfc}`);
    return {
      tasks,
      warnings,
      isCompleted,
      slug: rfc.toLowerCase(),
      title: rfc,
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
  const t = (id: string): string => `${id}: ${mdText(plan.tasks.get(id)?.title ?? '')}`.trimEnd();
  const lines: string[] = [];
  lines.push(`# Dispatch brief: ${mdText(context.title)}`, '');
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
    const inWave = plan.entries.filter((x) => x.wave === w);
    for (const e of inWave) {
      const after = e.after.length ? ` (after ${e.after.join(', ')})` : '';
      const group = e.sequenceGroup ? ` [group: ${e.sequenceGroup}]` : '';
      lines.push(`- ${t(e.task)}${after}${group}`);
    }
    const ids = new Set(inWave.map((e) => e.task));
    const open = plan.external.filter((x) => ids.has(x.task));
    if (open.length > 0) {
      lines.push(
        '',
        'Not gated by the YAML: the prerequisites below are outside this brief, so the board will not hold these tasks back. Resolve them before dispatching this wave.',
      );
      for (const x of open) {
        lines.push(`- ${x.task} needs ${mdText(x.prerequisite)} (${x.reason})`);
      }
    }
    lines.push('');
  }

  lines.push('## Sequence groups', '');
  lines.push('At most one task of a group runs at a time.', '');
  if (plan.groups.length === 0) lines.push('None.');
  for (const g of plan.groups) {
    lines.push(`- \`${g.name}\` (${mdCode(g.file)}): ${g.tasks.join(', ')}`);
  }
  for (const s of plan.secondaryOverlaps) {
    lines.push(`- Also overlaps, review by hand: ${s.task} touches \`${mdCode(s.file)}\``);
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
  for (const s of plan.trustSensitive) {
    lines.push(`- ${t(s.task)}: ${s.paths.map(mdText).join(', ')}`);
  }
  lines.push('');

  lines.push('## External prerequisites', '');
  lines.push(
    'These are NOT gated by the YAML block. The operator must resolve them before dispatching the affected tasks.',
    '',
  );
  if (plan.external.length === 0) lines.push('None.');
  for (const x of plan.external) {
    lines.push(`- ${x.task} needs ${mdText(x.prerequisite)} (${x.reason})`);
  }
  lines.push('');

  lines.push('## Dispatch entries', '');
  lines.push(
    `The dispatch session reads this block. Remove an entry to hold a task back; keep \`after\`, \`sequenceGroup\` and \`wave\` consistent with the sections above.`,
    '',
    '`priority` is a whole number matching the dispatch manifest: 1 is high, 2 is medium, 3 is low. Within a wave the lower number is claimed first. It is left out when the task has no priority.',
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

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** True when `file` is `dir` or below it, by path. */
function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** True when the file's real parent directory is the real briefs directory (or below it). */
function realParentInside(dir: string, file: string): boolean {
  try {
    return isInside(
      realpathSync(dir),
      path.join(realpathSync(path.dirname(file)), path.basename(file)),
    );
  } catch {
    return false;
  }
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

  const briefsDir = path.join(deps.boardDir, 'briefs');
  const file = options.out
    ? path.resolve(deps.cwd, options.out)
    : path.join(briefsDir, `${selected.slug}.md`);
  if (!options.out && !isInside(briefsDir, file)) {
    throw new Error(`${file} is outside ${briefsDir}`);
  }
  if (!options.out && lstatOrNull(briefsDir)?.isSymbolicLink()) {
    throw new Error(`${briefsDir} is a symbolic link; refusing to write a brief through it`);
  }
  const existing = lstatOrNull(file);
  if (existing?.isSymbolicLink()) {
    throw new Error(`${file} is a symbolic link; refusing to use it`);
  }
  if (existing && !options.force) {
    if (!options.keepExisting)
      throw new Error(`${file} already exists; pass --force to replace it`);
    if (!existing.isFile() || !isInside(briefsDir, file) || !realParentInside(briefsDir, file)) {
      throw new Error(`${file} is not a regular file inside ${briefsDir}; refusing to announce it`);
    }
    return { file, plan, dispatch, reused: true };
  }
  mkdirSync(path.dirname(file), { recursive: true });
  // Exclusive create without --force (no check-then-write race); with --force, never
  // follow a link that appeared after the check.
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    (options.force ? fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0) : fsConstants.O_EXCL);
  const content = renderBrief(plan, {
    title: selected.title,
    generatedAt: deps.now().toISOString(),
    planner,
    dispatch,
  });
  let fd: number;
  try {
    fd = openSync(file, flags, 0o644);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(`${file} already exists; pass --force to replace it`, { cause: err });
    }
    if (code === 'ELOOP') {
      throw new Error(`${file} is a symbolic link; refusing to use it`, { cause: err });
    }
    throw err;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return { file, plan, dispatch, reused: false };
}
