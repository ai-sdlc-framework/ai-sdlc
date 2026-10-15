import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  defaultDeps,
  fileDecision,
  fileRebase,
  fileTask,
  parseLogStrict,
  runFileCli,
  taskIdOf,
  type FileDeps,
} from './file.js';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const ev = (decisionId: string, type: string, extra: object = {}) =>
  JSON.stringify({ eventVersion: 'v1', type, ts: 't', decisionId, ...extra });

describe('cli-file', () => {
  let root: string;
  let remote: string;
  let repo: string;
  let ghCalls: string[][];
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
    drift = null;
    dor = null;
    deps = {
      exec(cmd, args, cwd) {
        if (cmd === 'gh') {
          ghCalls.push(args);
          return { status: 0, stdout: 'https://github.com/o/r/pull/1\n', stderr: '' };
        }
        const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
        return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
      },
      drift: () => drift,
      dor: () => dor,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

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
    expect(sh(remote, 'branch', '--list')).not.toContain('file-aisdlc-900');
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

  it('rebase rebuilds a conflicting branch on a new branch without force push', () => {
    // Filing branch appends DEC-0002 on top of the original log.
    const d = deps;
    writeFileSync(
      join(repo, EVENT_LOG_REL),
      [
        ev('DEC-0001', 'decision-opened'),
        ev('DEC-0002', 'decision-opened', { options: [{ id: 'a' }] }),
      ].join('\n') + '\n',
    );
    // Local log has both; filing only DEC-0002 appends its lines on origin/main.
    const first = fileDecision(repo, 'DEC-0002', { taskId: 'AISDLC-801', pr: true }, d);
    // main moves: another record lands, appended at the same spot (would conflict on merge).
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
    expect(r.branch).toBe('ai-sdlc/file-dec-0002-r2');
    const log = parseLogStrict(sh(remote, 'show', `${r.branch}:${EVENT_LOG_REL}`), 'x').events.map(
      (e) => e.decisionId,
    );
    expect(log).toEqual(['DEC-0001', 'DEC-0003', 'DEC-0002']);
    expect(ghCalls.map((c) => c[1])).toEqual(['create', 'comment']);
    // a second rebase picks the next free suffix
    const r3 = fileRebase(repo, 'DEC-0002', { pr: false }, d);
    expect(r3.branch).toBe('ai-sdlc/file-dec-0002-r3');
  });

  it('rebase carries non-log files and refuses a branch with no changes', () => {
    fileTask(repo, writeTask(), { pr: false }, deps);
    const r = fileRebase(repo, 'AISDLC-900', { pr: false }, deps);
    expect(r.branch).toBe('ai-sdlc/file-aisdlc-900-r2');
    expect(sh(remote, 'show', `${r.branch}:backlog/tasks/aisdlc-900 - thing.md`)).toContain('body');
    sh(repo, 'push', 'origin', 'origin/main:refs/heads/ai-sdlc/file-empty');
    expect(() => fileRebase(repo, 'empty', { pr: false }, deps)).toThrow(/no changes/);
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
    expect(() => fileTask(repo, '../elsewhere.md', { pr: false }, deps)).toThrow(/inside backlog/);
    expect(() => fileTask(repo, 'docs/x.md', { pr: false }, deps)).toThrow(/inside backlog/);
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
