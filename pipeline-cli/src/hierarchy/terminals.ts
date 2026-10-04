/**
 * `cli-hierarchy terminals --vscode`: generate a VS Code `tasks.json` that opens
 * one dedicated terminal per roster agent, each running `cli-hierarchy attach
 * <name>`. An opt-in convenience: the tmux layout is the contract and nothing
 * else in the tool depends on VS Code.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';

import { readRosterChecked } from './roster.js';
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
  clear: false,
  focus: false,
} as const;

/** Build the `tasks.json` document for these agent names (already validated). */
export function buildVscodeTasks(names: readonly string[]): Record<string, unknown> {
  const tasks: Record<string, unknown>[] = names.map((name) => ({
    label: name,
    type: 'shell',
    command: `cli-hierarchy attach ${name}`,
    presentation: { ...PRESENTATION },
    problemMatcher: [],
  }));
  tasks.push({
    label: OPEN_ALL_LABEL,
    dependsOn: [...names],
    dependsOrder: 'parallel',
    problemMatcher: [],
  });
  return { version: '2.0.0', tasks };
}

/**
 * Generate the VS Code tasks file from the checked roster.
 * @throws on an empty roster, or when `tasks.json` exists and `force` is not set or
 *   the existing path is not a regular file.
 */
export function hierarchyTerminals(opts: TerminalsOptions, deps: HierarchyDeps): TerminalsResult {
  const { roster, rejected } = readRosterChecked(deps.boardDir);
  for (const r of rejected) deps.log(`warning: ${r}; not touched`);
  if (roster.sessions.length === 0) {
    throw new Error('no sessions in the roster; start the agents with cli-hierarchy up first');
  }
  const names = roster.sessions.map((e) => e.tmuxWindow);
  for (const n of names) assertSessionName(n);
  const json = JSON.stringify(buildVscodeTasks(names), null, 2) + '\n';

  if (opts.print) {
    deps.log(json.trimEnd());
    return { json };
  }

  const dir = path.resolve(deps.cwd, opts.out ?? '.vscode');
  const target = path.join(dir, 'tasks.json');
  let existing: Stats | undefined;
  try {
    existing = lstatSync(target);
  } catch {
    existing = undefined;
  }
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
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  writeFileSync(tmp, json, { encoding: 'utf-8', flag: 'wx' });
  renameSync(tmp, target);
  deps.log(`wrote ${target}`);
  return { json, file: target };
}
