/**
 * `cli-hierarchy terminals --vscode`: generate a VS Code `tasks.json` that opens
 * one dedicated terminal per roster agent, each running `node <cli-hierarchy.mjs>
 * attach <name>` (the absolute bin path, so no `PATH` install is needed). An opt-in convenience: the tmux layout is the contract and nothing
 * else in the tool depends on VS Code.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';

import { readRosterChecked, ROSTER_FILENAME } from './roster.js';
import type { HierarchyDeps } from './types.js';
import { assertSessionName } from './validate.js';

/** Label of the compound task that opens every agent terminal. */
export const OPEN_ALL_LABEL = 'hierarchy: open all agents';

/** Options for `terminals --vscode`. */
export interface TerminalsOptions {
  /** Directory that receives `tasks.json`; default `<cwd>/.vscode`. */
  out?: string;
  /** Replace an existing `tasks.json`. */
  force: boolean;
  /** Print the JSON instead of writing a file. */
  print: boolean;
}

/** Result of `terminals`. */
export interface TerminalsResult {
  /** The generated `tasks.json` content. */
  json: string;
  /** Path written, absent with `print`. */
  file?: string;
}

const PRESENTATION = {
  reveal: 'always',
  panel: 'dedicated',
  showReuseMessage: false,
  echo: false,
  clear: true,
  focus: false,
} as const;

/**
 * Build the `tasks.json` document for these agent names (already validated).
 * `binPath` is the absolute path of `cli-hierarchy.mjs`; `rosterFile` is recorded in
 * the `ai-sdlc` marker that tells `up` the file is ours to regenerate.
 */
export function buildVscodeTasks(
  names: readonly string[],
  binPath: string,
  rosterFile: string,
): Record<string, unknown> {
  const tasks: Record<string, unknown>[] = names.map((name) => ({
    label: name,
    type: 'shell',
    command: 'node',
    args: [binPath, 'attach', name],
    isBackground: true,
    presentation: { ...PRESENTATION },
    problemMatcher: [],
  }));
  tasks.push({
    label: OPEN_ALL_LABEL,
    dependsOn: [...names],
    dependsOrder: 'parallel',
    problemMatcher: [],
  });
  return { version: '2.0.0', 'ai-sdlc': { generated: true, roster: rosterFile }, tasks };
}

/** Absolute path of the running `cli-hierarchy.mjs` (`process.argv[1]`) unless injected. */
export function resolveBinPath(deps: HierarchyDeps): string {
  return path.resolve(deps.binPath ?? process.argv[1] ?? '');
}

function tasksDocument(deps: HierarchyDeps): { json: string } | undefined {
  const { roster, rejected } = readRosterChecked(deps.boardDir);
  for (const r of rejected) deps.log(`warning: ${r}; not touched`);
  if (roster.sessions.length === 0) return undefined;
  const names = roster.sessions.map((e) => e.tmuxWindow);
  for (const n of names) assertSessionName(n);
  const rosterFile = path.join(deps.boardDir, ROSTER_FILENAME);
  const doc = buildVscodeTasks(names, resolveBinPath(deps), rosterFile);
  return { json: JSON.stringify(doc, null, 2) + '\n' };
}

/** True when the file carries the top-level `ai-sdlc.generated` marker. */
function carriesMarker(file: string): boolean {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf-8')) as { 'ai-sdlc'?: { generated?: unknown } };
    return doc?.['ai-sdlc']?.generated === true;
  } catch {
    return false;
  }
}

function writeAtomic(dir: string, target: string, json: string): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, json, { encoding: 'utf-8', flag: 'wx' });
  renameSync(tmp, target);
}

function lstatOrUndefined(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch {
    return undefined;
  }
}

/** Who owns `<cwd>/.vscode/tasks.json`: absent, ours (marker present) or foreign. */
export function inspectVscodeTasks(deps: HierarchyDeps): 'absent' | 'ours' | 'foreign' {
  const target = path.join(deps.cwd, '.vscode', 'tasks.json');
  const st = lstatOrUndefined(target);
  if (!st) return 'absent';
  return st.isFile() && carriesMarker(target) ? 'ours' : 'foreign';
}

/** What `syncVscodeTasks` did. */
export type VscodeSyncStatus = 'written' | 'unchanged' | 'foreign' | 'skipped';

/**
 * Regenerate `<cwd>/.vscode/tasks.json` from the roster when the file is absent or carries
 * our marker. A file without the marker is never touched. Used by `up`.
 */
export function syncVscodeTasks(deps: HierarchyDeps): VscodeSyncStatus {
  const built = tasksDocument(deps);
  if (!built) return 'skipped';
  const dir = path.join(deps.cwd, '.vscode');
  const target = path.join(dir, 'tasks.json');
  const owner = inspectVscodeTasks(deps);
  if (owner === 'foreign') return 'foreign';
  if (owner === 'ours' && readFileSync(target, 'utf-8') === built.json) return 'unchanged';
  writeAtomic(dir, target, built.json);
  return 'written';
}

/**
 * Generate the VS Code tasks file from the checked roster.
 * @throws on an empty roster, or when `tasks.json` exists and `force` is not set or
 *   the existing path is not a regular file.
 */
export function hierarchyTerminals(opts: TerminalsOptions, deps: HierarchyDeps): TerminalsResult {
  const built = tasksDocument(deps);
  if (!built) {
    throw new Error('no sessions in the roster; start the agents with cli-hierarchy up first');
  }
  const { json } = built;

  if (opts.print) {
    deps.log(json.trimEnd());
    return { json };
  }

  const dir = path.resolve(deps.cwd, opts.out ?? '.vscode');
  const target = path.join(dir, 'tasks.json');
  const existing = lstatOrUndefined(target);
  if (existing) {
    if (!existing.isFile()) {
      throw new Error(
        `${target} is not a regular file (symlink or directory); refusing to replace it`,
      );
    }
    if (!opts.force) {
      throw new Error(
        `${target} already exists; pass --force to replace it or --print to merge by hand`,
      );
    }
  }
  writeAtomic(dir, target, json);
  deps.log(`wrote ${target}`);
  return { json, file: target };
}
