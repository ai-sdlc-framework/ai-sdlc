/**
 * Test helpers — fixture builders for backlog tasks + a temporary project root.
 *
 * Used by both unit and integration tests so they don't have to spin up a
 * real backlog repo on disk for each assertion.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface MakeTaskOptions {
  id: string;
  title: string;
  status?: string;
  acceptanceCriteria?: string[];
  acceptanceCriteriaChecked?: boolean[];
  permittedExternalPaths?: string[];
  description?: string;
  references?: string[];
  /**
   * Other task IDs this task depends on. Rendered as the `dependencies:` YAML
   * frontmatter list — same shape the dependency-graph builder reads.
   */
  dependencies?: string[];
  /**
   * If true, write the task into `backlog/completed/` instead of
   * `backlog/tasks/`. Used by dependency-graph tests to simulate the
   * frontier-readiness check (a dependency is "satisfied" when it lives in
   * completed/).
   */
  completed?: boolean;
}

/**
 * Create a temporary project root with a `backlog/tasks/` directory.
 * Returns the path; caller is responsible for `cleanupTmpProject`.
 */
export function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-cli-test-'));
  mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
  mkdirSync(join(dir, 'backlog', 'completed'), { recursive: true });
  mkdirSync(join(dir, '.ai-sdlc'), { recursive: true });
  return dir;
}

export function cleanupTmpProject(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore — the OS will clean up the tmp dir eventually.
  }
}

/**
 * Write a backlog task file matching the on-disk shape that
 * `parseTaskFile` reads. Returns the path to the file.
 */
export function writeTaskFile(workDir: string, opts: MakeTaskOptions): string {
  const fileName = `${opts.id.toLowerCase()} - ${slugify(opts.title)}.md`;
  const subdir = opts.completed ? 'completed' : 'tasks';
  const path = join(workDir, 'backlog', subdir, fileName);

  const acs = opts.acceptanceCriteria ?? ['First criterion', 'Second criterion'];
  const checked = opts.acceptanceCriteriaChecked ?? new Array(acs.length).fill(false);
  const status = opts.status ?? (opts.completed ? 'Done' : 'To Do');

  const fmLines: string[] = [`id: ${opts.id}`, `title: '${opts.title}'`, `status: ${status}`];
  if (opts.references && opts.references.length > 0) {
    fmLines.push('references:');
    for (const r of opts.references) fmLines.push(`  - ${r}`);
  }
  if (opts.permittedExternalPaths && opts.permittedExternalPaths.length > 0) {
    fmLines.push('permittedExternalPaths:');
    for (const p of opts.permittedExternalPaths) fmLines.push(`  - '${p}'`);
  }
  if (opts.dependencies && opts.dependencies.length > 0) {
    fmLines.push('dependencies:');
    for (const d of opts.dependencies) fmLines.push(`  - ${d}`);
  }

  const acLines = acs.map((ac, i) => `- [${checked[i] ? 'x' : ' '}] #${i + 1} ${ac}`).join('\n');

  const description = opts.description ?? `Test task ${opts.id}`;

  const body =
    `---\n${fmLines.join('\n')}\n---\n\n` +
    `## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\n${description}\n<!-- SECTION:DESCRIPTION:END -->\n\n` +
    `## Acceptance Criteria\n<!-- AC:BEGIN -->\n${acLines}\n<!-- AC:END -->\n`;

  writeFileSync(path, body, 'utf8');
  return path;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}
