import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDecisionEvent,
  makeDecisionOpenedEvent,
  makeOperatorAnsweredEvent,
} from '../decisions/event-log.js';
import {
  EVENT_LOG_REL,
  FileRefusal,
  assertAscii,
  driftRefusal,
  defaultDeps,
  fileDecision,
  fileRebase,
  fileTask,
  removeSourceCopy,
  buildPrCreateArgs,
  closeTask,
  parseLogStrict,
  replayCommand,
  runFileCli,
  taskIdOf,
  type FileDeps,
} from './file.js';
import { setClock } from '../clock.js';
import { recordFiling, type PacingDeps } from './file-pacing.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const ev = (decisionId: string, type: string, extra: object = {}) =>
  JSON.stringify({ eventVersion: 'v1', type, ts: 't', decisionId, ...extra });

describe('cli-file', () => {
  let root: string;
  let remote: string;
  let repo: string;
  let ghCalls: string[][];
  let armCalls: string[][];
  let drift: string | null;
  let dor: string | null;
  let deps: FileDeps;

  const commitMain = (file: string, content: string) => {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), content);
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-m', 'x');
    sh(repo, 'push', 'origin', 'HEAD:refs/heads/main');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cli-file-'));
    remote = join(root, 'remote.git');
    repo = join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', remote, repo], { stdio: 'pipe' });
    sh(repo, 'config', 'user.email', 't@t');
    sh(repo, 'config', 'user.name', 't');
    sh(repo, 'checkout', '-b', 'main');
    commitMain(EVENT_LOG_REL, ev('DEC-0001', 'decision-opened') + '\n');
    ghCalls = [];
    armCalls = [];
    drift = null;
    dor = null;
    deps = {
      exec(cmd, args, cwd) {
        if (cmd === process.execPath) {
          armCalls.push(args);
          return { status: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'gh') {
          ghCalls.push(args);
          if (args[1] === 'list') {
            return {
              status: 0,
              stdout: JSON.stringify([{ number: 1, url: 'https://github.com/o/r/pull/1' }]),
              stderr: '',
            };
          }
          return { status: 0, stdout: 'https://github.com/o/r/pull/1\n', stderr: '' };
        }
        const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
        return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      drift: () => drift,
      dor: () => dor,
    };
  });

  afterEach(() => removeFixtureDir(root));

  const writeTask = (name = 'aisdlc-900 - thing.md') => {
    mkdirSync(join(repo, 'backlog/tasks'), { recursive: true });
    const p = join('backlog/tasks', name);
    writeFileSync(join(repo, p), '---\nid: AISDLC-900\n---\nbody\n');
    return p;
  };

  it('AISDLC-860: refuses an id already on origin/main in any case, tasks or completed', () => {
    commitMain('backlog/completed/AISDLC-900 - old.md', '---\nid: AISDLC-900\n---\n');
    const p = writeTask();
    expect(() => fileTask(repo, p, { pr: true }, deps)).toThrow(/already exists on origin\/main/);
    expect(ghCalls).toHaveLength(0);
  });

  it('AISDLC-860: refuses a filename differing only in case', () => {
    commitMain('backlog/tasks/AISDLC-900 - THING.md', '---\nid: AISDLC-900\n---\n');
    const p = writeTask('aisdlc-900 - thing.md');
    expect(() => fileTask(repo, p, { pr: true }, deps)).toThrow(FileRefusal);
  });

  describe('AISDLC-921 --update', () => {
    it('without --update an existing id is still refused', () => {
      commitMain('backlog/tasks/aisdlc-900 - thing.md', '---\nid: AISDLC-900\n---\nold\n');
      expect(() => fileTask(repo, writeTask(), { pr: true }, deps)).toThrow(
        /already exists on origin\/main/,
      );
    });

    it('with --update an id not on main is refused', () => {
      expect(() => fileTask(repo, writeTask(), { pr: true, update: true }, deps)).toThrow(
        /--update needs task id AISDLC-900 to exist/,
      );
      expect(ghCalls).toHaveLength(0);
    });

    it('with --update an existing id is edited on a branch from main and a PR opens', () => {
      commitMain('backlog/tasks/aisdlc-900 - thing.md', '---\nid: AISDLC-900\n---\nold\n');
      const p = writeTask();
      const r = fileTask(repo, p, { pr: true, brief: false, update: true }, deps);
      expect(r.branch).toBe('ai-sdlc/update-aisdlc-900');
      expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
      expect(sh(remote, 'show', `${r.branch}:backlog/tasks/aisdlc-900 - thing.md`)).toContain(
        'body',
      );
      expect(sh(remote, 'log', '-1', '--format=%s', r.branch)).toBe(
        'chore(docs): update backlog task AISDLC-900 (AISDLC-900)',
      );
    });

    it('with --update the drift and DoR checks still run', () => {
      commitMain('backlog/tasks/aisdlc-900 - thing.md', '---\nid: AISDLC-900\n---\nold\n');
      const p = writeTask();
      drift = 'backlog-drift: bad ref';
      expect(() => fileTask(repo, p, { pr: true, update: true }, deps)).toThrow(/backlog-drift/);
      drift = null;
      dor = 'dor: not ready';
      expect(() => fileTask(repo, p, { pr: true, update: true }, deps)).toThrow(FileRefusal);
    });
  });

  it('files a task: branch fast-forward pushed and PR opened', () => {
    const p = writeTask();
    const r = fileTask(repo, p, { pr: true }, deps);
    expect(r.branch).toBe('ai-sdlc/file-aisdlc-900');
    expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(sh(remote, 'log', '-1', '--format=%s', r.branch)).toBe(
      'chore(docs): file backlog task AISDLC-900 (AISDLC-900)',
    );
    const title = ghCalls[0][ghCalls[0].indexOf('--title') + 1];
    expect(title.endsWith('(AISDLC-900)')).toBe(true);
    expect(ghCalls[0]).not.toContain('--draft');
  });

  describe('AISDLC-950 post-push cleanup of the source copy', () => {
    it('removes an untracked source identical to the committed copy', () => {
      const p = writeTask();
      fileTask(repo, p, { pr: true, brief: false }, deps);
      expect(existsSync(join(repo, p))).toBe(false);
    });

    it('keeps a tracked source and says why', () => {
      const p = writeTask();
      sh(repo, 'add', '--', p);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(removeSourceCopy(deps, repo, join(repo, p), p, 'main')).toBe(false);
      expect(existsSync(join(repo, p))).toBe(true);
      expect(String(err.mock.calls[0][0])).toContain('tracked');
      err.mockRestore();
    });

    it('keeps a source that differs from the committed copy', () => {
      const p = writeTask();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const diverging: FileDeps = {
        ...deps,
        exec(cmd, args, cwd) {
          if (cmd === 'git' && args[0] === 'show')
            return { status: 0, stdout: 'other', stderr: '' };
          return deps.exec(cmd, args, cwd);
        },
      };
      expect(removeSourceCopy(diverging, repo, join(repo, p), p, 'main')).toBe(false);
      expect(existsSync(join(repo, p))).toBe(true);
      expect(String(err.mock.calls[0][0])).toContain('differs');
      err.mockRestore();
    });

    it('keeps a source the branch cannot supply', () => {
      const p = writeTask();
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(removeSourceCopy(deps, repo, join(repo, p), p, 'no-such-branch')).toBe(false);
      expect(String(err.mock.calls[0][0])).toContain('cannot read');
      err.mockRestore();
    });

    it('returns false when the source is already gone', () => {
      expect(removeSourceCopy(deps, repo, join(repo, 'backlog/tasks/gone.md'), 'x', 'main')).toBe(
        false,
      );
    });
  });

  it('AISDLC-878: the gh pr create argv never contains --draft', () => {
    const args = buildPrCreateArgs({ branch: 'ai-sdlc/file-x', subject: 's', prBody: 'b' });
    expect(args.slice(0, 2)).toEqual(['pr', 'create']);
    expect(args).not.toContain('--draft');
    expect(args.join(' ')).not.toMatch(/draft/i);
  });

  describe('auto-brief (AISDLC-930)', () => {
    const briefPath = () => join(repo, '.ai-sdlc/dispatch/briefs/tasks-aisdlc-900.md');
    const writeFm = (extra: string) => {
      mkdirSync(join(repo, 'backlog/tasks'), { recursive: true });
      const p = 'backlog/tasks/aisdlc-900 - thing.md';
      writeFileSync(join(repo, p), `---\nid: AISDLC-900\npriority: low\n${extra}---\nbody\n`);
      return p;
    };

    it('writes a one-entry brief with --pr', () => {
      fileTask(repo, writeFm(''), { pr: true }, deps);
      const text = readFileSync(briefPath(), 'utf8');
      expect(text).toContain('task: AISDLC-900');
      expect(text).toContain('wave: 1');
      expect(text).toContain('priority: 3');
    });

    it('--fixes-pr writes fixesPr and the PR head branch into the entry (AISDLC-1054)', () => {
      const withView: FileDeps = {
        ...deps,
        exec(cmd, args, cwd) {
          if (cmd === 'gh' && args[1] === 'view') {
            return { status: 0, stdout: '{"headRefName":"feat/the-pr"}', stderr: '' };
          }
          return deps.exec(cmd, args, cwd);
        },
      };
      fileTask(repo, writeFm(''), { pr: true, fixesPr: 1907 }, withView);
      const text = readFileSync(briefPath(), 'utf8');
      expect(text).toContain('fixesPr: 1907');
      expect(text).toContain('prHeadRef: feat/the-pr');
    });

    it('--fixes-pr refuses when the PR head branch cannot be read', () => {
      const noView: FileDeps = {
        ...deps,
        exec(cmd, args, cwd) {
          if (cmd === 'gh' && args[1] === 'view') return { status: 1, stdout: '', stderr: 'no' };
          return deps.exec(cmd, args, cwd);
        },
      };
      expect(() => fileTask(repo, writeFm(''), { pr: true, fixesPr: 5 }, noView)).toThrow(
        /could not read the head branch of PR #5/,
      );
    });

    const viewDeps = (out: string): FileDeps => ({
      ...deps,
      exec(cmd, args, cwd) {
        if (cmd === 'gh' && args[1] === 'view') return { status: 0, stdout: out, stderr: '' };
        return deps.exec(cmd, args, cwd);
      },
    });

    it('--fixes-pr refuses a fork PR (AISDLC-1070)', () => {
      const d = viewDeps('{"headRefName":"f","isCrossRepository":true}');
      expect(() => fileTask(repo, writeFm(''), { pr: true, fixesPr: 5 }, d)).toThrow(
        /another repository/,
      );
    });

    it('--fixes-pr refuses a protected head branch (AISDLC-1070)', () => {
      const d = viewDeps('{"headRefName":"main"}');
      expect(() => fileTask(repo, writeFm(''), { pr: true, fixesPr: 5 }, d)).toThrow(
        /is protected/,
      );
    });

    it('--no-brief and a plain (no --pr) filing write none', () => {
      fileTask(repo, writeFm(''), { pr: true, brief: false }, deps);
      expect(existsSync(briefPath())).toBe(false);
    });

    it('writes none without --pr', () => {
      fileTask(repo, writeFm(''), { pr: false }, deps);
      expect(existsSync(briefPath())).toBe(false);
    });

    it('writes none for dispatchable: false or blocked.reason', () => {
      fileTask(repo, writeFm('dispatchable: false\n'), { pr: true }, deps);
      expect(existsSync(briefPath())).toBe(false);
      sh(remote, 'branch', '-D', 'ai-sdlc/file-aisdlc-900');
      fileTask(repo, writeFm('blocked:\n  reason: hold\n'), { pr: true }, deps);
      expect(existsSync(briefPath())).toBe(false);
    });
  });

  describe('local filing branch cleanup (AISDLC-1221)', () => {
    it('removes worktree and branch after push and gh pr create', () => {
      const calls: string[] = [];
      const rec: FileDeps = {
        ...deps,
        exec(cmd, args, cwd) {
          calls.push(`${cmd} ${args.join(' ')}`);
          return deps.exec(cmd, args, cwd);
        },
      };
      const r = fileTask(repo, writeTask(), { pr: true }, rec);
      expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
      const idx = (needle: string) => calls.findIndex((c) => c.startsWith(needle));
      expect(idx('git worktree remove')).toBeGreaterThan(idx('gh pr create'));
      expect(idx('git branch -D')).toBeGreaterThan(idx('git worktree remove'));
      expect(idx('gh pr create')).toBeGreaterThan(idx('git push'));
      expect(sh(repo, 'branch', '--list', 'ai-sdlc/file-aisdlc-900')).toBe('');
      expect(existsSync(join(repo, '.worktrees/file-aisdlc-900'))).toBe(false);
      expect(sh(remote, 'branch', '--list', 'ai-sdlc/file-aisdlc-900')).toContain(
        'ai-sdlc/file-aisdlc-900',
      );
    });

    it('keeps the branch with one warning when the remote sha differs', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const diverged: FileDeps = {
        ...deps,
        exec(cmd, args, cwd) {
          if (cmd === 'git' && args[0] === 'ls-remote')
            return { status: 0, stdout: 'deadbeef\trefs/heads/x\n', stderr: '' };
          return deps.exec(cmd, args, cwd);
        },
      };
      fileTask(repo, writeTask(), { pr: true }, diverged);
      expect(sh(repo, 'branch', '--list', 'ai-sdlc/file-aisdlc-900')).toContain('file-aisdlc-900');
      const warnings = err.mock.calls.filter((c) => String(c[0]).includes('differs'));
      expect(warnings).toHaveLength(1);
      err.mockRestore();
    });

    it('a second filing for the same id is not refused', () => {
      fileTask(repo, writeTask(), { pr: true }, deps);
      sh(remote, 'branch', '-D', 'ai-sdlc/file-aisdlc-900');
      expect(() => fileTask(repo, writeTask(), { pr: true }, deps)).not.toThrow();
      expect(sh(repo, 'branch', '--list', 'ai-sdlc/file-aisdlc-900')).toBe('');
    });
  });

  it('files without a PR when --pr is absent', () => {
    const r = fileTask(repo, writeTask(), { pr: false }, deps);
    expect(r.prUrl).toBeNull();
    expect(ghCalls).toHaveLength(0);
  });

  it('refuses non-ASCII filenames, drift and DoR findings before committing', () => {
    expect(() => fileTask(repo, writeTask('aisdlc-901 - café.md'), { pr: true }, deps)).toThrow(
      /non-ASCII/,
    );
    const p = writeTask();
    drift = 'backlog-drift: missing file';
    expect(() => fileTask(repo, p, { pr: true }, deps)).toThrow(/backlog-drift/);
    drift = null;
    dor = 'DoR: not ready';
    expect(() => fileTask(repo, p, { pr: true }, deps)).toThrow(FileRefusal);
    dor = 'DoR: DoR upstream-OQ gate blocked: RFC-0061: 1 unresolved OQ(s): ### OQ-2';
    expect(() => fileTask(repo, p, { pr: true }, deps)).toThrow(/RFC-0061: 1 unresolved OQ/);
    expect(sh(remote, 'branch', '--list')).not.toContain('file-aisdlc-900');
  });

  it('AISDLC-931: files a task written outside the repo, parent tree untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scratch-'));
    const src = join(dir, 'aisdlc-931 - ext.md');
    writeFileSync(src, '---\nid: AISDLC-931\n---\nbody\n');
    const r = fileTask(repo, src, { pr: true }, deps);
    expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(sh(remote, 'show', `${r.branch}:backlog/tasks/aisdlc-931 - ext.md`)).toContain('body');
    expect(sh(repo, 'status', '--porcelain', '--', 'backlog')).toBe('');
    removeFixtureDir(dir);
  });

  it('AISDLC-931: refuses an external source whose basename exists on main, naming the path', () => {
    commitMain('backlog/completed/aisdlc-931 - ext.md', '---\nid: AISDLC-931\n---\n');
    const dir = mkdtempSync(join(tmpdir(), 'scratch-'));
    const src = join(dir, 'aisdlc-931 - ext.md');
    writeFileSync(src, '---\nid: AISDLC-931\n---\n');
    expect(() => fileTask(repo, src, { pr: true }, deps)).toThrow(
      /backlog\/completed\/aisdlc-931 - ext\.md/,
    );
    removeFixtureDir(dir);
  });

  it('AISDLC-931: refuses a non-.md source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scratch-'));
    const src = join(dir, 'aisdlc-931 - ext.txt');
    writeFileSync(src, 'x');
    expect(() => fileTask(repo, src, { pr: true }, deps)).toThrow(/\.md/);
    removeFixtureDir(dir);
  });

  it('AISDLC-931: still refuses a missing external source', () => {
    expect(() => fileTask(repo, '/nonexistent-dir/aisdlc-931 - x.md', { pr: false }, deps)).toThrow(
      /not found/,
    );
  });

  it('refuses a missing task file', () => {
    expect(() => fileTask(repo, 'backlog/tasks/aisdlc-5 - no.md', { pr: false }, deps)).toThrow(
      /not found/,
    );
  });

  it('files a decision with an answer appended', () => {
    const r = fileDecision(
      repo,
      'DEC-0002',
      { taskId: 'AISDLC-801', answer: 'a', rationale: 'why', pr: true },
      withOptions(),
    );
    expect(r.branch).toBe('ai-sdlc/file-dec-0002');
    const log = sh(remote, 'show', `${r.branch}:${EVENT_LOG_REL}`);
    expect(log).toContain('"operator-answered"');
    expect(log).toContain('"rationale":"why"');
    expect(ghCalls[0][ghCalls[0].indexOf('--title') + 1]).toMatch(/\(AISDLC-801\)$/);
  });

  describe('in-memory events (AISDLC-1161)', () => {
    const answered = (decisionId: string, opt: string) => ({
      eventVersion: 'v1',
      type: 'operator-answered',
      ts: 't',
      decisionId,
      chosenOptionId: opt,
      by: 'planner',
    });
    const opened = (extra: object = {}) => ev('DEC-0001', 'decision-opened', extra) + '\n';
    const file = (events: Array<Record<string, unknown>>, id = 'DEC-0001') =>
      fileDecision(repo, id, { taskId: 'X-1', pr: false, events }, deps);

    it('files an answer for a decision-opened only on origin/main; parent store untouched', () => {
      commitMain(EVENT_LOG_REL, opened({ options: [{ id: 'a' }] }));
      const r = file([answered('DEC-0001', 'a')]);
      expect(sh(remote, 'show', `${r.branch}:${EVENT_LOG_REL}`)).toContain('"operator-answered"');
      expect(sh(repo, 'status', '--porcelain', '--', '.ai-sdlc')).toBe('');
    });

    it('refuses an event for a different decision', () => {
      expect(() => file([answered('DEC-0002', 'a')])).toThrow(/in-memory event is for DEC-0002/);
    });

    it('refuses a pair already on origin/main', () => {
      commitMain(
        EVENT_LOG_REL,
        opened({ options: [{ id: 'a' }] }) + ev('DEC-0001', 'operator-answered') + '\n',
      );
      expect(() => file([answered('DEC-0001', 'a')])).toThrow(/duplicate/);
    });

    it('refuses an invalid option on an in-memory answer', () => {
      commitMain(EVENT_LOG_REL, opened({ options: [{ id: 'a' }] }));
      expect(() => file([answered('DEC-0001', 'zz')])).toThrow(/not an option/);
    });
  });

  describe('per-event store (AISDLC-852)', () => {
    const open = () =>
      makeDecisionOpenedEvent({
        decisionId: 'DEC-0001',
        source: 'ad-hoc',
        scope: 'test',
        summary: 's',
        options: [
          { id: 'opt-a', description: 'a' },
          { id: 'opt-b', description: 'b' },
        ],
      } as Parameters<typeof makeDecisionOpenedEvent>[0]);

    it('files from events/ only, writing one new per-event file (no legacy log)', () => {
      sh(repo, 'rm', '-q', EVENT_LOG_REL);
      sh(repo, 'commit', '-m', 'drop legacy');
      sh(repo, 'push', 'origin', 'HEAD:refs/heads/main');
      appendDecisionEvent(open(), { workDir: repo });
      const r = fileDecision(repo, 'DEC-0001', { taskId: 'X-1', answer: 'opt-a', pr: false }, deps);
      const files = sh(remote, 'ls-tree', '--name-only', `${r.branch}:.ai-sdlc/_decisions/events`)
        .split('\n')
        .filter((f) => f.includes('operator-answered'));
      expect(files).toHaveLength(1);
      expect(() => sh(remote, 'show', `${r.branch}:${EVENT_LOG_REL}`)).toThrow();
    });

    it('refuses a duplicate answer split across the two stores', () => {
      writeFileSync(join(repo, EVENT_LOG_REL), JSON.stringify(open()) + '\n');
      appendDecisionEvent(
        makeOperatorAnsweredEvent({
          decisionId: 'DEC-0001',
          chosenOptionId: 'opt-a',
          by: 'planner',
        } as Parameters<typeof makeOperatorAnsweredEvent>[0]),
        { workDir: repo },
      );
      expect(() =>
        fileDecision(repo, 'DEC-0001', { taskId: 'X-1', answer: 'opt-b', pr: false }, deps),
      ).toThrow(/duplicate \(decisionId, type\) pair DEC-0001 operator-answered/);
    });

    it('keeps appending to the legacy log when no events/ directory exists', () => {
      commitMain(EVENT_LOG_REL, JSON.stringify(open()) + '\n');
      const r = fileDecision(repo, 'DEC-0001', { taskId: 'X-1', answer: 'opt-a', pr: false }, deps);
      expect(sh(remote, 'show', `${r.branch}:${EVENT_LOG_REL}`)).toContain('"operator-answered"');
    });
  });

  function withOptions(): FileDeps {
    // local log carries the opened event with options; main (remote) has none of the answer
    writeFileSync(
      join(repo, EVENT_LOG_REL),
      [
        ev('DEC-0001', 'decision-opened'),
        ev('DEC-0002', 'decision-opened', { options: [{ id: 'a' }] }),
      ].join('\n') + '\n',
    );
    return deps;
  }

  it('refuses unknown option, duplicate answer, missing decision, and a corrupt log', () => {
    const d = withOptions();
    expect(() =>
      fileDecision(repo, 'DEC-0001', { taskId: 'T-1', answer: 'zz', pr: false }, d),
    ).toThrow(/not an option/);
    expect(() => fileDecision(repo, 'DEC-0009', { taskId: 'T-1', pr: false }, d)).toThrow(
      /no decision-opened/,
    );
    writeFileSync(
      join(repo, EVENT_LOG_REL),
      [
        ev('DEC-0001', 'decision-opened', { options: [{ id: 'a' }] }),
        ev('DEC-0001', 'operator-answered'),
      ].join('\n') + '\n',
    );
    expect(() =>
      fileDecision(repo, 'DEC-0001', { taskId: 'T-1', answer: 'a', pr: false }, d),
    ).toThrow(/duplicate/);
    writeFileSync(
      join(repo, EVENT_LOG_REL),
      [ev('DEC-0001', 'decision-opened'), ev('DEC-0001', 'decision-opened')].join('\n') + '\n',
    );
    expect(() => fileDecision(repo, 'DEC-0001', { taskId: 'T-1', pr: false }, d)).toThrow(
      /duplicate/,
    );
    writeFileSync(join(repo, EVENT_LOG_REL), '{not json\n');
    expect(() => fileDecision(repo, 'DEC-0001', { taskId: 'T-1', pr: false }, d)).toThrow(
      /not valid JSON/,
    );
    writeFileSync(join(repo, EVENT_LOG_REL), '[1]\n');
    expect(() => fileDecision(repo, 'DEC-0001', { taskId: 'T-1', pr: false }, d)).toThrow(
      /not a JSON object/,
    );
  });

  it('warns on a pair duplicated on origin/main and files; refuses to grow it (AISDLC-922)', () => {
    const open = (ts: string) => ev('DEC-0001', 'decision-opened', { ts, options: [{ id: 'a' }] });
    const dup = [open('t1'), open('t2')].join('\n') + '\n';
    commitMain(EVENT_LOG_REL, dup);
    const d = withOptions();
    writeFileSync(join(repo, EVENT_LOG_REL), dup);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = fileDecision(repo, 'DEC-0001', { taskId: 'T-1', answer: 'a', pr: false }, d);
      expect(r).toBeDefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/warning:.*DEC-0001 decision-opened/),
      );
      writeFileSync(join(repo, EVENT_LOG_REL), dup + open('t3') + '\n');
      expect(() => fileDecision(repo, 'DEC-0001', { taskId: 'T-1', pr: false }, d)).toThrow(
        /duplicate \(decisionId, type\) pair DEC-0001 decision-opened/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('rebase rebuilds a conflicting branch in place: same branch, same PR, re-armed (DEC-0088)', () => {
    const d = deps;
    writeFileSync(
      join(repo, EVENT_LOG_REL),
      [
        ev('DEC-0001', 'decision-opened'),
        ev('DEC-0002', 'decision-opened', { options: [{ id: 'a' }] }),
      ].join('\n') + '\n',
    );
    const first = fileDecision(repo, 'DEC-0002', { taskId: 'AISDLC-801', pr: true }, d);
    sh(repo, 'checkout', '-f', '--detach', 'origin/main');
    writeFileSync(
      join(repo, EVENT_LOG_REL),
      readFileSync(join(repo, EVENT_LOG_REL), 'utf8') + ev('DEC-0003', 'decision-opened') + '\n',
    );
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-m', 'main moves');
    sh(repo, 'push', 'origin', 'HEAD:refs/heads/main');
    ghCalls = [];
    const r = fileRebase(repo, 'DEC-0002', { pr: true }, d);
    expect(first.branch).toBe('ai-sdlc/file-dec-0002');
    expect(r.branch).toBe('ai-sdlc/file-dec-0002');
    expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(r.armed).toBe(true);
    const log = parseLogStrict(sh(remote, 'show', `${r.branch}:${EVENT_LOG_REL}`), 'x').events.map(
      (e) => e.decisionId,
    );
    expect(log).toEqual(['DEC-0001', 'DEC-0003', 'DEC-0002']);
    // no PR is created or closed, no comment; only the lookup of the existing PR
    expect(ghCalls.map((c) => c[1])).toEqual(['list']);
    expect(armCalls).toHaveLength(1);
    expect(armCalls[0].slice(1)).toEqual(['1', '--source-kind', 'docs', '--arm']);
    // the remote has no replacement branch
    expect(sh(remote, 'branch', '--list', 'ai-sdlc/file-dec-0002*')).not.toContain('-r2');
    // a second rebase works too (temporary local branch was cleaned up)
    expect(fileRebase(repo, 'DEC-0002', { pr: false }, d).branch).toBe('ai-sdlc/file-dec-0002');
  });

  it('rebase carries non-log files and refuses a branch with no changes', () => {
    fileTask(repo, writeTask(), { pr: false }, deps);
    const r = fileRebase(repo, 'AISDLC-900', { pr: false }, deps);
    expect(r.branch).toBe('ai-sdlc/file-aisdlc-900');
    expect(sh(remote, 'show', `${r.branch}:backlog/tasks/aisdlc-900 - thing.md`)).toContain('body');
    sh(repo, 'push', 'origin', 'origin/main:refs/heads/ai-sdlc/file-empty');
    expect(() => fileRebase(repo, 'empty', { pr: false }, deps)).toThrow(/no changes/);
  });

  describe('AISDLC-1045 corrected source', () => {
    const corrected = (id = 'AISDLC-900') => {
      const p = join(root, `${id.toLowerCase()} - thing.md`);
      writeFileSync(p, `---\nid: ${id}\n---\nfixed\n`);
      return p;
    };

    it('rebase --source replaces the branch copy and keeps the same branch and PR', () => {
      fileTask(repo, writeTask(), { pr: false }, deps);
      const r = fileRebase(repo, 'AISDLC-900', { pr: true, source: corrected() }, deps);
      expect(r.branch).toBe('ai-sdlc/file-aisdlc-900');
      expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
      const body = sh(remote, 'show', `${r.branch}:backlog/tasks/aisdlc-900 - thing.md`);
      expect(body).toContain('fixed');
      expect(body).not.toContain('body');
    });

    it('refuses a source whose id does not match, or that fails drift', () => {
      fileTask(repo, writeTask(), { pr: false }, deps);
      expect(() =>
        fileRebase(repo, 'AISDLC-900', { pr: false, source: corrected('AISDLC-901') }, deps),
      ).toThrow(/does not match/);
      drift = 'backlog-drift: bad ref';
      expect(() =>
        fileRebase(repo, 'AISDLC-900', { pr: false, source: corrected() }, deps),
      ).toThrow(/backlog-drift/);
    });

    it('--update on a task only on its filing branch delegates to the rebase', () => {
      fileTask(repo, writeTask(), { pr: false }, deps);
      const r = fileTask(repo, corrected(), { pr: false, update: true }, deps);
      expect(r.branch).toBe('ai-sdlc/file-aisdlc-900');
      expect(sh(remote, 'show', `${r.branch}:backlog/tasks/aisdlc-900 - thing.md`)).toContain(
        'fixed',
      );
    });

    it('--update on a task on main keeps the update branch', () => {
      fileTask(repo, writeTask(), { pr: false }, deps);
      commitMain('backlog/tasks/aisdlc-900 - thing.md', '---\nid: AISDLC-900\n---\nold\n');
      const r = fileTask(repo, corrected(), { pr: false, update: true }, deps);
      expect(r.branch).toBe('ai-sdlc/update-aisdlc-900');
    });
  });

  describe('AISDLC-1241 task --close', () => {
    const TASK = 'backlog/tasks/aisdlc-900 - thing.md';
    const seed = () =>
      commitMain(TASK, '---\nid: AISDLC-900\nstatus: To Do\ndispatchable: false\n---\nbody\n');
    const prList = (heads: string[]) => {
      const inner = deps.exec;
      deps = {
        ...deps,
        exec(cmd, args, cwd) {
          if (cmd === 'gh' && args[1] === 'list') {
            return {
              status: 0,
              stdout: JSON.stringify(heads.map((h, i) => ({ number: i + 7, headRefName: h }))),
              stderr: '',
            };
          }
          return inner(cmd, args, cwd);
        },
      };
    };
    const board = (sub: string) => {
      mkdirSync(join(repo, '.ai-sdlc/dispatch', sub), { recursive: true });
      writeFileSync(
        join(repo, '.ai-sdlc/dispatch', sub, 'AISDLC-900.dispatch.json'),
        '{"taskId":"AISDLC-900"}',
      );
    };

    it('moves the file to completed with status Done and a Closed section', () => {
      seed();
      const r = closeTask(
        repo,
        'aisdlc-900',
        { reason: 'superseded', supersededBy: 'AISDLC-901', pr: false },
        deps,
      );
      expect(r.branch).toBe('ai-sdlc/file-aisdlc-900');
      const names = sh(remote, 'diff', '--name-status', 'main', r.branch).split('\n');
      expect(names.map((l) => l.split('\t')[0]).sort()).toEqual(['A', 'D']);
      const moved = sh(remote, 'show', `${r.branch}:backlog/completed/aisdlc-900 - thing.md`);
      expect(moved).toContain('status: Done');
      expect(moved).toContain('## Closed');
      expect(moved).toContain('- Reason: superseded');
      expect(moved).toContain('- Superseded by: AISDLC-901');
    });

    it('with --pr opens and arms the filing PR', () => {
      seed();
      const r = closeTask(repo, 'AISDLC-900', { reason: 'withdrawn', pr: true }, deps);
      expect(r.prUrl).toBe('https://github.com/o/r/pull/1');
      expect(r.armed).toBe(true);
      expect(armCalls).toHaveLength(1);
    });

    it('adds a status line when the task has none', () => {
      commitMain(TASK, '---\nid: AISDLC-900\n---\nbody\n');
      const r = closeTask(repo, 'AISDLC-900', { reason: 'x', pr: false }, deps);
      expect(sh(remote, 'show', `${r.branch}:backlog/completed/aisdlc-900 - thing.md`)).toContain(
        'status: Done',
      );
    });

    it('refuses an empty reason', () => {
      seed();
      expect(() => closeTask(repo, 'AISDLC-900', { reason: '  ', pr: false }, deps)).toThrow(
        /--reason must not be empty/,
      );
    });

    it('refuses an open PR', () => {
      seed();
      prList(['ai-sdlc/aisdlc-900-thing']);
      expect(() => closeTask(repo, 'AISDLC-900', { reason: 'x', pr: false }, deps)).toThrow(
        /open PR \(#7\)/,
      );
    });

    it('refuses a live inflight claim', () => {
      seed();
      board('inflight');
      expect(() => closeTask(repo, 'AISDLC-900', { reason: 'x', pr: false }, deps)).toThrow(
        /live inflight claim/,
      );
    });

    it('refuses a queued manifest', () => {
      seed();
      board('queue');
      expect(() => closeTask(repo, 'AISDLC-900', { reason: 'x', pr: false }, deps)).toThrow(
        /queued manifest/,
      );
    });

    it('refuses an unknown, completed or malformed id and a bad superseding id', () => {
      expect(() => closeTask(repo, 'AISDLC-900', { reason: 'x', pr: false }, deps)).toThrow(
        /not found on origin\/main/,
      );
      commitMain('backlog/completed/aisdlc-901 - done.md', '---\nid: AISDLC-901\n---\n');
      expect(() => closeTask(repo, 'AISDLC-901', { reason: 'x', pr: false }, deps)).toThrow(
        /already completed/,
      );
      expect(() => closeTask(repo, 'nope', { reason: 'x', pr: false }, deps)).toThrow(
        /not a task id/,
      );
      expect(() =>
        closeTask(repo, 'AISDLC-900', { reason: 'x', supersededBy: 'zz', pr: false }, deps),
      ).toThrow(/--superseded-by/);
    });

    it('a failing drift check refuses and leaves no branch', () => {
      seed();
      drift = 'backlog-drift: bad ref';
      expect(() => closeTask(repo, 'AISDLC-900', { reason: 'x', pr: false }, deps)).toThrow(
        /backlog-drift/,
      );
    });

    it('the CLI routes --close and refuses a missing path', async () => {
      seed();
      const pacing: PacingDeps = { ...(await import('./file-pacing.js')).defaultPacingDeps };
      const cwd = process.cwd();
      process.chdir(repo);
      try {
        expect(
          await runFileCli(['task', '--close', 'AISDLC-900', '--reason', 'r'], deps, pacing),
        ).toBe(0);
        expect(await runFileCli(['task'], deps, pacing)).toBe(2);
        expect(await runFileCli(['task', '--close', 'AISDLC-900'], deps, pacing)).toBe(1);
      } finally {
        process.chdir(cwd);
      }
    });
  });

  it('answers a decision already opened on main, appending only the new event', () => {
    const opened = ev('DEC-0005', 'decision-opened', { options: [{ id: 'a' }] });
    commitMain(EVENT_LOG_REL, ev('DEC-0001', 'decision-opened') + '\n' + opened + '\n');
    const r = fileDecision(
      repo,
      'DEC-0005',
      { taskId: 'AISDLC-801', answer: 'a', pr: false },
      deps,
    );
    const log = sh(remote, 'show', `${r.branch}:${EVENT_LOG_REL}`).split('\n');
    expect(
      log.filter((l) => l.includes('"decision-opened"') && l.includes('DEC-0005')),
    ).toHaveLength(1);
    expect(log.filter((l) => l.includes('"operator-answered"'))).toHaveLength(1);
  });

  it('refuses task paths outside backlog/tasks and rebase of out-of-scope paths', () => {
    expect(() => fileTask(repo, '../elsewhere.md', { pr: false }, deps)).toThrow(/not found/);
    expect(() => fileTask(repo, 'docs/x.txt', { pr: false }, deps)).toThrow(/\.md/);
    sh(repo, 'checkout', '-b', 'tmp-wf');
    mkdirSync(join(repo, '.github/workflows'), { recursive: true });
    writeFileSync(join(repo, '.github/workflows/x.yml'), 'a');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-m', 'wf');
    sh(repo, 'push', 'origin', 'HEAD:refs/heads/ai-sdlc/file-wf');
    expect(() => fileRebase(repo, 'wf', { pr: false }, deps)).toThrow(/outside the filing scope/);
  });

  it('rebase ignores files the branch deleted', () => {
    commitMain('backlog/tasks/aisdlc-7 - gone.md', 'x');
    sh(repo, 'checkout', '-b', 'tmp-del');
    sh(repo, 'rm', '-q', 'backlog/tasks/aisdlc-7 - gone.md');
    mkdirSync(join(repo, 'backlog/tasks'), { recursive: true });
    writeFileSync(join(repo, 'backlog/tasks/aisdlc-8 - new.md'), 'n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-m', 'del');
    sh(repo, 'push', 'origin', 'HEAD:refs/heads/ai-sdlc/file-del');
    const r = fileRebase(repo, 'del', { pr: false }, deps);
    expect(sh(remote, 'show', `${r.branch}:backlog/tasks/aisdlc-8 - new.md`)).toBe('n');
  });

  it('cleans up the worktree and branch when publishing fails', () => {
    const failing: FileDeps = {
      ...deps,
      exec(cmd, args, cwd) {
        if (cmd === 'git' && args[0] === 'push') return { status: 1, stdout: '', stderr: 'boom' };
        return deps.exec(cmd, args, cwd);
      },
    };
    expect(() => fileTask(repo, writeTask(), { pr: false }, failing)).toThrow(/boom/);
    expect(sh(repo, 'branch', '--list', 'ai-sdlc/file-aisdlc-900')).toBe('');
    expect(() => fileTask(repo, writeTask(), { pr: false }, deps)).not.toThrow();
  });

  describe('AISDLC-1160 queued brief replays the real argv', () => {
    const T0 = new Date('2026-10-20T12:00:00Z');
    let restore: () => void;
    let pacing: PacingDeps;
    let cwd0: string;
    beforeEach(() => {
      commitMain(
        EVENT_LOG_REL,
        [
          ev('DEC-0001', 'decision-opened'),
          ev('DEC-0005', 'decision-opened', { options: [{ id: 'opt-a' }, { id: 'opt-b' }] }),
        ].join('\n') + '\n',
      );
      cwd0 = process.cwd();
      process.chdir(repo);
      restore = setClock(() => new Date(T0.getTime() + 60_000));
      pacing = { readRateLimit: () => null, sleep: async () => {}, log: () => {} };
      const prev = setClock(() => T0);
      recordFiling(repo);
      prev();
      restore();
      restore = setClock(() => new Date(T0.getTime() + 60_000));
    });
    afterEach(() => {
      restore();
      process.chdir(cwd0);
    });
    const briefRun = (id: string): string => {
      const f = join(repo, `.ai-sdlc/dispatch/queued-filings/filing-${id}.md`);
      const m = readFileSync(f, 'utf8').match(/^Run: `(.*)`$/m);
      return m![1];
    };
    const words = (line: string): string[] =>
      spawnSync('sh', ['-c', `printf '%s\\n' ${line}`], { encoding: 'utf8' })
        .stdout.split('\n')
        .slice(0, -1);

    it('decision: carries --answer and quoted --rationale, drops --queue; replay appends the answer', async () => {
      const argv = [
        'decision',
        'DEC-0005',
        '--task-id',
        'X-1',
        '--answer',
        'opt-a',
        '--rationale',
        'two words',
        '--pr',
        '--queue',
      ];
      expect(await runFileCli(argv, deps, pacing)).toBe(0);
      const line = briefRun('dec-0005');
      expect(line).toContain('--answer opt-a');
      expect(line).toContain("--rationale 'two words'");
      expect(line).not.toContain('--queue');
      restore();
      restore = setClock(() => new Date(T0.getTime() + 20 * 60_000));
      const replay = words(line);
      expect(replay[0]).toBe('cli-file');
      expect(await runFileCli(replay.slice(1), deps, pacing)).toBe(0);
      const branch = 'ai-sdlc/file-dec-0005';
      const log = sh(remote, 'show', `${branch}:${EVENT_LOG_REL}`);
      const answered = log.split('\n').filter((l) => l.includes('"operator-answered"'));
      expect(answered).toHaveLength(1);
      expect(answered[0]).toContain('"chosenOptionId":"opt-a"');
    });

    it('task: carries --no-brief, --fixes-pr and --update', async () => {
      const argv = [
        'task',
        'backlog/tasks/a.md',
        '--no-brief',
        '--fixes-pr',
        '12',
        '--update',
        '--pr',
        '--queue',
        '--spacing-minutes',
        '30',
      ];
      expect(await runFileCli(argv, deps, pacing)).toBe(0);
      expect(briefRun('a.md')).toBe(
        'cli-file task backlog/tasks/a.md --no-brief --fixes-pr 12 --update --pr',
      );
    });

    it('rebase: carries --source', async () => {
      const argv = ['rebase', 'aisdlc-9', '--source', '/tmp/my dir/x.md', '--pr', '--queue'];
      expect(await runFileCli(argv, deps, pacing)).toBe(0);
      expect(briefRun('aisdlc-9')).toBe(
        "cli-file rebase aisdlc-9 --source '/tmp/my dir/x.md' --pr",
      );
    });

    it('replayCommand strips pacing flags in every spelling and quotes quotes', () => {
      expect(
        replayCommand(['task', "it's", '--queue=true', '--spacing-minutes=3', '--no-queue']),
      ).toBe("cli-file task 'it'\\''s'");
    });
  });

  it('AISDLC-1160: drift runs against the scratchpad source, which refuses on a missing reference', () => {
    const scratch = join(root, 'scratch');
    mkdirSync(scratch);
    const src = join(scratch, 'aisdlc-901 - bad.md');
    writeFileSync(src, '---\nid: AISDLC-901\n---\nSee docs/missing-file.md\n');
    const seen: string[] = [];
    const driftDeps: FileDeps = {
      ...deps,
      drift(id, cwd) {
        const f = join(cwd, 'backlog/tasks/aisdlc-901 - bad.md');
        seen.push(cwd);
        if (!existsSync(f)) return null; // the parent does not contain the source: nothing to check
        const ref = /See (\S+)/.exec(readFileSync(f, 'utf8'))![1];
        return existsSync(join(cwd, ref)) ? null : `backlog-drift: ref-deleted ${ref}`;
      },
    };
    expect(() => fileTask(repo, src, { pr: true }, driftDeps)).toThrow(/ref-deleted/);
    expect(seen[0]).toContain('.worktrees/drift-aisdlc-901');
    expect(existsSync(join(repo, '.worktrees/drift-aisdlc-901'))).toBe(false);
    expect(ghCalls).toHaveLength(0);
  });

  it('helpers', () => {
    expect(() => assertAscii('abc')).not.toThrow();
    const p = join(root, 'weird.md');
    writeFileSync(p, 'id: AISDLC-5\n');
    expect(taskIdOf(p)).toBe('AISDLC-5');
    writeFileSync(p, 'nothing');
    expect(() => taskIdOf(p)).toThrow(/cannot derive/);
    expect(taskIdOf('/x/aisdlc-12.3 - a.md')).toBe('AISDLC-12.3');
    expect(defaultDeps.exec('node', ['-e', '1'], root).status).toBe(0);
  });

  it('default validators report failures', () => {
    expect(defaultDeps.dor(join(root, 'nope.md'), root)).toMatch(/^DoR:/);
    // non-git temp dir: backlog-drift cannot pass, so a failure string is returned
    const d = defaultDeps.drift('AISDLC-1', root);
    expect(d === null || d.startsWith('backlog-drift:')).toBe(true);
  });

  it('CLI maps refusals to exit 1 and errors to exit 2', async () => {
    const prev = process.cwd();
    process.chdir(repo);
    const quiet = (f: () => Promise<number>) => {
      const w = process.stderr.write.bind(process.stderr);
      process.stderr.write = (() => true) as typeof process.stderr.write;
      return f().finally(() => {
        process.stderr.write = w;
      });
    };
    try {
      expect(await quiet(() => runFileCli(['task', 'backlog/tasks/aisdlc-1 - café.md']))).toBe(1);
      expect(await quiet(() => runFileCli(['decision', 'DEC-0009', '--task-id', 'T-1']))).toBe(1);
      expect(await quiet(() => runFileCli(['rebase', 'nothere']))).toBe(2);
    } finally {
      process.chdir(prev);
    }
  });
});

describe('driftRefusal (AISDLC-1148)', () => {
  const r = (status: number, stdout: string) => ({ status, stdout, stderr: '' });
  it('ignores warnings and info even when the tool exits 1', () => {
    expect(
      driftRefusal(r(1, JSON.stringify([{ severity: 'warning' }, { severity: 'info' }]))),
    ).toBe(null);
  });
  it('refuses on an error-severity issue', () => {
    expect(
      driftRefusal(r(1, JSON.stringify([{ severity: 'error', message: 'dead ref' }]))),
    ).toMatch(/1 error-severity.*dead ref/);
  });
  it('falls back to the exit code when the report is unreadable', () => {
    expect(driftRefusal(r(0, 'not json'))).toBe(null);
    expect(driftRefusal(r(1, 'boom'))).toMatch(/^backlog-drift: boom/);
    expect(driftRefusal(r(1, '{}'))).toMatch(/^backlog-drift:/);
    expect(driftRefusal(r(0, '{}'))).toBe(null);
    expect(driftRefusal(r(0, '[null]'))).toBe(null);
  });
});
