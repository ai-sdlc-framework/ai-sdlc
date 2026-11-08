import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTaskOrigin } from './task-origin.js';
import { refineBacklogTask } from './ingress-claude.js';
import { readFileSync } from 'node:fs';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';
import type { DorConfig } from './dor-config.js';

let repo: string;
const git = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
    cwd: repo,
    stdio: 'ignore',
  });

const TRUSTED = '---\nid: T-1\ntitle: Trusted\n---\n## Description\n\nbody\n';
const config: DorConfig = {
  rubricVersion: 'v1',
  evaluationMode: 'warn-only',
  notifications: { authorChannel: true },
  staleness: { warnAfterDays: 14, closeAfterDays: 28, closedLabel: 'x' },
  autoPassRules: [],
  escalation: { maxRoundsBeforeHumanTriage: 3 },
  bypassRequiresRole: 'maintainer',
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'task-origin-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'backlog', 'tasks'), { recursive: true });
  writeFileSync(join(repo, 'backlog', 'tasks', 't-1 - trusted.md'), TRUSTED);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
});
afterEach(() => removeFixtureDir(repo));

describe('resolveTaskOrigin', () => {
  it('is base-ref for a file byte-identical on the base ref', () => {
    const f = join(repo, 'backlog', 'tasks', 't-1 - trusted.md');
    expect(resolveTaskOrigin(repo, f, TRUSTED)).toBe('base-ref');
  });

  it('is pr-tree for a file only in the PR tree', () => {
    const f = join(repo, 'backlog', 'tasks', 't-2 - new.md');
    writeFileSync(f, TRUSTED);
    expect(resolveTaskOrigin(repo, f, TRUSTED)).toBe('pr-tree');
  });

  it('is pr-tree for a base-ref file modified by the PR', () => {
    const f = join(repo, 'backlog', 'tasks', 't-1 - trusted.md');
    expect(resolveTaskOrigin(repo, f, TRUSTED + 'edit')).toBe('pr-tree');
  });

  it('fails closed outside the repo and without git', () => {
    expect(resolveTaskOrigin(repo, '/elsewhere/x.md', TRUSTED)).toBe('pr-tree');
    const plain = mkdtempSync(join(tmpdir(), 'task-origin-nogit-'));
    try {
      writeFileSync(join(plain, 'a.md'), 'x');
      expect(resolveTaskOrigin(plain, join(plain, 'a.md'), 'x')).toBe('pr-tree');
    } finally {
      removeFixtureDir(plain);
    }
  });
});

function lastEntry(artifactsDir: string): Record<string, unknown> {
  const out = execFileSync('find', [artifactsDir, '-name', '*.jsonl'], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => /calibration|dor/.test(l));
  const lines = out.flatMap((f) => readFileSync(f, 'utf8').trim().split('\n'));
  return JSON.parse(lines[lines.length - 1]!);
}

describe('refineBacklogTask origin entry points (AISDLC-636.1)', () => {
  it('base-ref file: permissiveAllowed true, recorded in the calibration log', async () => {
    const artifactsDir = join(repo, 'art');
    await refineBacklogTask('T-1', { workDir: repo, config, artifactsDir });
    expect(lastEntry(artifactsDir)).toMatchObject({
      taskOrigin: 'base-ref',
      permissiveAllowed: true,
    });
  });

  it('PR-tree-only file: permissiveAllowed false', async () => {
    const artifactsDir = join(repo, 'art');
    const f = join(repo, 'backlog', 'tasks', 't-9 - new.md');
    writeFileSync(f, TRUSTED.replace('T-1', 'T-9'));
    await refineBacklogTask('T-9', { workDir: repo, config, artifactsDir });
    expect(lastEntry(artifactsDir)).toMatchObject({
      taskOrigin: 'pr-tree',
      permissiveAllowed: false,
    });
  });

  it('import path: permissiveAllowed false even for a base-ref file', async () => {
    const artifactsDir = join(repo, 'art');
    await refineBacklogTask('T-1', { workDir: repo, config, artifactsDir, taskOrigin: 'import' });
    expect(lastEntry(artifactsDir)).toMatchObject({
      taskOrigin: 'import',
      permissiveAllowed: false,
    });
  });
});
