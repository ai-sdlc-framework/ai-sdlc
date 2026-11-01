import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { load as yamlLoad } from 'js-yaml';

import {
  loadPrLifecycleConfig,
  PR_LIFECYCLE_DEFAULTS,
  PR_LIFECYCLE_KEY_READERS,
} from './pr-lifecycle-config.js';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
  });
};

/** A repo whose `origin/main` ref holds `body` as `.ai-sdlc/pr-lifecycle.yaml` (no file when undefined). */
function repoWithBase(body: string | undefined): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'prlc-'));
  git(d, 'init', '-q', '-b', 'main');
  mkdirSync(path.join(d, '.ai-sdlc'));
  writeFileSync(path.join(d, '.ai-sdlc', 'keep'), 'x');
  if (body !== undefined) writeFileSync(path.join(d, '.ai-sdlc', 'pr-lifecycle.yaml'), body);
  git(d, 'add', '-A');
  git(d, 'commit', '-q', '-m', 'base');
  git(d, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return d;
}

describe('loadPrLifecycleConfig', () => {
  const dirs: string[] = [];
  const project = (body?: string): string => {
    const d = repoWithBase(body);
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('defaults when the file or key is missing or invalid', () => {
    expect(loadPrLifecycleConfig(project()).maxSameHeadActions).toBe(1);
    expect(loadPrLifecycleConfig(project('spec: {}\n')).maxSameHeadActions).toBe(1);
    expect(
      loadPrLifecycleConfig(project('spec:\n  loopGuard:\n    maxSameHeadActions: 0\n'))
        .maxSameHeadActions,
    ).toBe(1);
    expect(loadPrLifecycleConfig(project(': : [')).maxSameHeadActions).toBe(1);
  });

  it('reads loopGuard.maxSameHeadActions', () => {
    const d = project('spec:\n  loopGuard:\n    maxSameHeadActions: 3\n');
    expect(loadPrLifecycleConfig(d).maxSameHeadActions).toBe(3);
  });

  it('ignores a working-tree edit: the base branch is the only source (AISDLC-994)', () => {
    const d = project('spec:\n  loopGuard:\n    maxSameHeadActions: 3\n');
    writeFileSync(
      path.join(d, '.ai-sdlc', 'pr-lifecycle.yaml'),
      'spec:\n  loopGuard:\n    maxSameHeadActions: 99\n',
    );
    expect(loadPrLifecycleConfig(d).maxSameHeadActions).toBe(3);
  });

  it('defaults when the base ref cannot be resolved', () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'prlc-'));
    dirs.push(d);
    mkdirSync(path.join(d, '.ai-sdlc'));
    writeFileSync(
      path.join(d, '.ai-sdlc', 'pr-lifecycle.yaml'),
      'spec:\n  loopGuard:\n    maxSameHeadActions: 9\n',
    );
    expect(loadPrLifecycleConfig(d).maxSameHeadActions).toBe(1);
  });
});

describe('pr-lifecycle.yaml operational keys', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  it('every key under spec has a registered reader', () => {
    const doc = yamlLoad(
      readFileSync(path.join(repoRoot, '.ai-sdlc', 'pr-lifecycle.yaml'), 'utf-8'),
    ) as { spec: Record<string, unknown> };
    const unread = Object.keys(doc.spec).filter((k) => !(k in PR_LIFECYCLE_KEY_READERS));
    expect(unread).toEqual([]);
    for (const trust of ['docsOnlyPaths', 'releaseBranchPrefix', 'taskIdPattern']) {
      expect(doc.spec).not.toHaveProperty(trust);
    }
  });

  it('the shipped yaml loads to the code defaults', () => {
    expect(loadPrLifecycleConfig(repoRoot)).toEqual(PR_LIFECYCLE_DEFAULTS);
  });

  it('reads overrides and ignores invalid values', () => {
    const d = repoWithBase(
      'spec:\n  webhook: {port: 9000, debounceMs: -1}\n  stall: {staleMs: 5}\n  reconcile: {timerOpenMs: 7}\n',
    );
    const c = loadPrLifecycleConfig(d);
    rmSync(d, { recursive: true, force: true });
    expect(c.webhook).toEqual({ port: 9000, debounceMs: PR_LIFECYCLE_DEFAULTS.webhook.debounceMs });
    expect(c.stall).toEqual({ staleMs: 5, graceMs: PR_LIFECYCLE_DEFAULTS.stall.graceMs });
    expect(c.reconcile.timerOpenMs).toBe(7);
    for (const r of Object.values(PR_LIFECYCLE_KEY_READERS)) r(c);
  });

  it('reads hierarchy.worktrees windows with defaults (AISDLC-1108)', () => {
    const read = (yaml: string) => {
      const d = repoWithBase(yaml);
      try {
        return loadPrLifecycleConfig(d).hierarchy.worktrees;
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    };
    expect(read('spec: {}\n')).toMatchObject({ sweepEveryTicks: 1, ceiling: 40 });
    expect(
      read(
        'spec:\n  hierarchy:\n    worktrees: {sweepEveryTicks: 3, ceiling: 10, noPrGraceMs: 5}\n',
      ),
    ).toMatchObject({ sweepEveryTicks: 3, ceiling: 10, noPrGraceMs: 5 });
  });

  it('reads hierarchy.resourceGate, defaulting to false and accepting only true (AISDLC-1104)', () => {
    const read = (yaml: string): boolean => {
      const d = repoWithBase(yaml);
      const c = loadPrLifecycleConfig(d);
      rmSync(d, { recursive: true, force: true });
      return c.hierarchy.resourceGate;
    };
    expect(read('spec: {}\n')).toBe(false);
    expect(read('spec:\n  hierarchy: {resourceGate: true}\n')).toBe(true);
    expect(read('spec:\n  hierarchy: {resourceGate: "yes"}\n')).toBe(false);
  });
});
