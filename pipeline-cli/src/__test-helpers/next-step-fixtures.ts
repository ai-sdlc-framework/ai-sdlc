/**
 * Fixtures for the `next-step` state-machine tests (AISDLC-762): a hermetic
 * `NextStepContext` (fake runner, temp dirs, captured logger) and a
 * ready-made `NextStepState`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextStepContext, NextStepState } from '../next-step/types.js';
import type { DeveloperReturn, PipelineLogger, TaskSpec } from '../types.js';
import { FakeRunner } from './fake-runner.js';
import { cleanupTmpProject, makeTmpProject } from './make-task.js';

export interface Harness {
  ctx: NextStepContext;
  runner: FakeRunner;
  root: string;
  logs: string[];
  /** Make `exists()` report these absolute paths as present (in addition to real files). */
  present: Set<string>;
  cleanup: () => void;
}

export function makeHarness(over: Partial<NextStepContext> = {}): Harness {
  const root = makeTmpProject();
  const runner = new FakeRunner();
  const logs: string[] = [];
  const present = new Set<string>();
  const logger: PipelineLogger = {
    info: (m) => logs.push(`info: ${m}`),
    warn: (m) => logs.push(`warn: ${m}`),
    error: (m) => logs.push(`error: ${m}`),
    progress: (s, m) => logs.push(`progress: ${s}: ${m}`),
  };
  // Outside the project root: the real state dir is TMPDIR, never the parent checkout.
  const runDir = `${root}-run`;
  const statePath = join(runDir, 'state.json');
  const ctx: NextStepContext = {
    workDir: root,
    runner: runner.toRunner(),
    env: {},
    homeDir: join(root, 'home'),
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    logger,
    cliBinDir: '/cli/bin',
    pluginScriptsDir: '/plugin/scripts',
    filesDir: join(runDir, 'files'),
    statePath,
    exists: (p) => present.has(p) || existsSync(p),
    ...over,
  };
  return {
    ctx,
    runner,
    root,
    logs,
    present,
    cleanup: () => {
      cleanupTmpProject(root);
      cleanupTmpProject(runDir);
    },
  };
}

export function makeTask(over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: 'AISDLC-900',
    title: 'Demo task',
    status: 'To Do',
    acceptanceCriteria: ['First', 'Second'],
    acceptanceCriteriaChecked: [false, false],
    description: 'desc',
    rawBody: '---\nid: AISDLC-900\n---\n',
    filePath: '',
    ...over,
  };
}

export const DEV_RETURN: DeveloperReturn = {
  summary: 'did the thing',
  filesChanged: ['src/a.ts'],
  commitSha: 'abc1234',
  verifications: { build: 'passed', test: 'passed', lint: 'passed', format: 'passed' },
  acceptanceCriteriaMet: [1, 2],
  notes: 'none',
};

export function makeState(root: string, over: Partial<NextStepState> = {}): NextStepState {
  const worktreePath = join(root, '.worktrees', 'aisdlc-900');
  mkdirSync(worktreePath, { recursive: true });
  return {
    schemaVersion: 1,
    taskId: 'AISDLC-900',
    taskIdLower: 'aisdlc-900',
    sourceKind: 'backlog',
    phase: 'awaiting-developer',
    workDir: root,
    branch: 'ai-sdlc/aisdlc-900-demo-task',
    worktreePath,
    task: makeTask(),
    fromStatus: 'To Do',
    iteration: 1,
    maxIterations: 2,
    developer: null,
    review: null,
    verdict: null,
    postRebaseReviewed: false,
    needsHumanAttention: false,
    classifierLine: '',
    reviewRound: 0,
    calls: 1,
    ...over,
  };
}

/** Write a minimal task file in `<dir>/backlog/tasks` and return its path. */
export function writeDemoTaskFile(dir: string): string {
  mkdirSync(join(dir, 'backlog', 'tasks'), { recursive: true });
  const file = join(dir, 'backlog', 'tasks', 'aisdlc-900 - demo-task.md');
  writeFileSync(
    file,
    `---\nid: AISDLC-900\ntitle: 'Demo task'\nstatus: In Progress\npermittedExternalPaths:\n  - '../x/'\n---\n\n## Description\n\nDemo.\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 First\n- [ ] #2 Second\n<!-- AC:END -->\n`,
    'utf8',
  );
  return file;
}
