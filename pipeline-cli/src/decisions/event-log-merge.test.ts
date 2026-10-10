/**
 * AISDLC-719 — two pull requests that each record a decision must merge without
 * a text conflict. Real git repos in mkdtemp directories; `gh` is injected (no network).
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendDecisionEvent,
  eventFileName,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
  migrateLegacyEventLog,
  readDecisionEvents,
  resolveEventLogPath,
  resolveEventsDir,
} from './event-log.js';
import { defaultRunner, nextDecisionIdDurable, type GitRunner } from './remote-persist.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();

const gitStatus = (cwd: string, ...args: string[]): number => {
  try {
    git(cwd, ...args);
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
};

const ev = (id: string, iso: string, summary = `s ${id}`) =>
  makeDecisionOpenedEvent({
    decisionId: id,
    source: 'ad-hoc',
    scope: 't',
    summary,
    reversible: true,
    options: [{ id: 'a', description: 'a' }],
    now: new Date(iso),
  });

let root: string;
const mkRepo = (name: string): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.invalid');
  git(dir, 'config', 'user.name', 't');
  mkdirSync(join(dir, '.ai-sdlc', '_decisions'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'x');
  return dir;
};
const commitAll = (dir: string, msg: string): void => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', msg);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dec-merge-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build a repo with a base commit and branches a/b each adding one decision via the writer. */
function twoBranchRepo(name: string): string {
  const dir = mkRepo(name);
  appendDecisionEvent(ev('DEC-0001', '2026-01-01T00:00:00.000Z'), { workDir: dir });
  commitAll(dir, 'base');
  git(dir, 'checkout', '-b', 'a');
  appendDecisionEvent(ev('DEC-0002', '2026-01-02T00:00:00.000Z'), { workDir: dir });
  commitAll(dir, 'a');
  git(dir, 'checkout', 'main');
  git(dir, 'checkout', '-b', 'b');
  appendDecisionEvent(ev('DEC-0003', '2026-01-03T00:00:00.000Z'), { workDir: dir });
  commitAll(dir, 'b');
  return dir;
}

describe('per-event files merge cleanly (AISDLC-719 AC5)', () => {
  it.each([
    ['a', 'b'],
    ['b', 'a'],
  ])('merging %s then %s has no conflict and keeps both decisions', (first, second) => {
    const dir = twoBranchRepo(`order-${first}${second}`);
    git(dir, 'checkout', first);
    expect(gitStatus(dir, 'merge', '--no-edit', second)).toBe(0);
    const ids = readDecisionEvents({ workDir: dir }).events.map((e) => e.decisionId);
    // Deterministic total order (timestamp-sorted file names), independent of merge order.
    expect(ids).toEqual(['DEC-0001', 'DEC-0002', 'DEC-0003']);
  });

  it('control: the legacy single events.jsonl append on two branches conflicts', () => {
    const dir = mkRepo('legacy');
    const file = resolveEventLogPath(dir);
    writeFileSync(file, JSON.stringify(ev('DEC-0001', '2026-01-01T00:00:00.000Z')) + '\n');
    commitAll(dir, 'base');
    git(dir, 'checkout', '-b', 'a');
    appendFileSync(file, JSON.stringify(ev('DEC-0002', '2026-01-02T00:00:00.000Z')) + '\n');
    commitAll(dir, 'a');
    git(dir, 'checkout', 'main');
    git(dir, 'checkout', '-b', 'b');
    appendFileSync(file, JSON.stringify(ev('DEC-0003', '2026-01-03T00:00:00.000Z')) + '\n');
    commitAll(dir, 'b');
    expect(gitStatus(dir, 'merge', '--no-edit', 'a')).not.toBe(0);
  });
});

describe('reading both layouts together', () => {
  it('returns legacy events then per-event files, deduped', () => {
    const dir = mkRepo('both');
    writeFileSync(
      resolveEventLogPath(dir),
      JSON.stringify(ev('DEC-0001', '2026-01-01T00:00:00.000Z')) + '\n',
    );
    const e2 = ev('DEC-0002', '2026-01-02T00:00:00.000Z');
    appendDecisionEvent(e2, { workDir: dir });
    // Same event also present in the legacy file: must be counted once.
    appendFileSync(resolveEventLogPath(dir), JSON.stringify(e2) + '\n');
    const ids = readDecisionEvents({ workDir: dir }).events.map((e) => e.decisionId);
    expect(ids).toEqual(['DEC-0001', 'DEC-0002']);
  });
});

describe('migrateLegacyEventLog', () => {
  const seed = (dir: string): void => {
    const lines = [
      ev('DEC-0001', '2026-03-01T00:00:00.000Z'),
      ev('DEC-0002', '2026-02-01T00:00:00.000Z'), // non-monotonic ts on purpose
      makeOperatorAnsweredEvent({
        decisionId: 'DEC-0001',
        chosenOptionId: 'a',
        now: new Date('2026-01-15T00:00:00.000Z'),
      }),
    ].map((e) => JSON.stringify(e));
    writeFileSync(resolveEventLogPath(dir), lines.join('\n') + '\n');
  };

  it('keeps ids, history and order; is idempotent; removes the legacy file', () => {
    const dir = mkRepo('migrate');
    seed(dir);
    const before = readDecisionEvents({ workDir: dir }).events;
    const r1 = migrateLegacyEventLog({ workDir: dir });
    expect(r1).toEqual({ migrated: 3, skipped: 0, removedLegacy: true });
    expect(existsSync(resolveEventLogPath(dir))).toBe(false);
    expect(readDecisionEvents({ workDir: dir }).events).toEqual(before);
    const names = readdirSync(resolveEventsDir(dir)).sort();
    expect(names).toHaveLength(3);

    const r2 = migrateLegacyEventLog({ workDir: dir });
    expect(r2).toEqual({ migrated: 0, skipped: 0, removedLegacy: false });
    expect(readdirSync(resolveEventsDir(dir)).sort()).toEqual(names);
  });

  it('keeps events.jsonl when a line could not be migrated', () => {
    const dir = mkRepo('migrate-bad');
    seed(dir);
    appendFileSync(resolveEventLogPath(dir), 'not json\n');
    const r = migrateLegacyEventLog({ workDir: dir });
    expect(r.migrated).toBe(3);
    expect(r.skipped).toBe(1);
    expect(r.removedLegacy).toBe(false);
    expect(existsSync(resolveEventLogPath(dir))).toBe(true);
    // Re-running neither duplicates nor loses anything.
    const again = migrateLegacyEventLog({ workDir: dir });
    expect(again.migrated).toBe(0);
    expect(readDecisionEvents({ workDir: dir }).events).toHaveLength(3);
  });
});

describe('open-PR id reservation', () => {
  it('nextDecisionIdDurable skips an id carried by an open PR per-event file', () => {
    const origin = join(root, 'origin.git');
    git(root, 'init', '--bare', '-b', 'main', origin);
    git(root, 'clone', origin, join(root, 'parent'));
    const parent = join(root, 'parent');
    git(parent, 'config', 'user.email', 't@t.invalid');
    git(parent, 'config', 'user.name', 't');
    writeFileSync(join(parent, 'README.md'), 'x');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'init');
    git(parent, 'push', '-u', 'origin', 'HEAD:main');
    appendDecisionEvent(ev('DEC-0001', '2026-01-01T00:00:00.000Z'), { workDir: parent });

    let prPaths = '';
    let cross = false;
    let ghStatus = 0;
    const prJson = (): string =>
      JSON.stringify([
        {
          isCrossRepository: cross,
          files: prPaths
            .split('\n')
            .filter(Boolean)
            .map((path) => ({ path })),
        },
      ]);
    const runner: GitRunner = (cmd, args, opts) => {
      if (cmd === 'gh') return { status: ghStatus, stdout: prJson(), stderr: '' };
      return defaultRunner(cmd, args, opts);
    };

    expect(nextDecisionIdDurable({ workDir: parent, runner })).toBe('DEC-0002');

    prPaths =
      '.ai-sdlc/_decisions/events/2026-01-05T00-00-00.000Z__DEC-0002__decision-opened__abcdef012345.json\n' +
      'unrelated/file.ts\n';
    expect(nextDecisionIdDurable({ workDir: parent, runner })).toBe('DEC-0003');

    // A cross-repo (fork) PR never reserves an id.
    cross = true;
    expect(nextDecisionIdDurable({ workDir: parent, runner })).toBe('DEC-0002');

    // An over-long digit id is ignored (no throw, no Infinity).
    cross = false;
    prPaths = `.ai-sdlc/_decisions/events/x__DEC-${'9'.repeat(400)}__y.json\n`;
    expect(nextDecisionIdDurable({ workDir: parent, runner })).toBe('DEC-0002');

    // A failing gh falls back to the empty set.
    prPaths = '.ai-sdlc/_decisions/events/x__DEC-0007__y.json\n';
    ghStatus = 1;
    expect(nextDecisionIdDurable({ workDir: parent, runner })).toBe('DEC-0002');
  });
});

describe('eventFileName ts hardening', () => {
  it('rejects a ts carrying path characters', () => {
    const good = ev('DEC-0001', '2026-01-01T00:00:00.000Z');
    expect(eventFileName(good)).toMatch(/^2026-01-01T00-00-00\.000Z__DEC-0001__/);
    for (const bad of ['../x', 'a/b', 'a\\b']) {
      expect(() => eventFileName({ ...good, ts: bad })).toThrow(/path characters/);
    }
  });
});
