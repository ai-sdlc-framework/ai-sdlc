/** RFC-0061 Phase 1: clean-replay carry-forward (AC-1..AC-5) against real temporary git repos. */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRunner, type Runner } from '../runtime/exec.js';
import {
  cleanReplayCarriesForward,
  findCarriedVerdict,
  GitTooOldError,
  parseGitVersion,
} from './clean-replay.js';

const gitVersion = parseGitVersion(execFileSync('git', ['--version']).toString()) ?? [0, 0];
const modernGit = gitVersion[0] > 2 || (gitVersion[0] === 2 && gitVersion[1] >= 40);

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'clean-replay-'));
  dirs.push(dir);
  const git = (...a: string[]) =>
    execFileSync('git', a, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  const write = (f: string, c: string) => writeFileSync(join(dir, f), c);
  const commit = (m: string) => {
    git('add', '-A');
    git('commit', '-q', '-m', m);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  write('a.txt', '1\n2\n3\n4\n5\n');
  write('b.txt', 'b\n');
  const base = commit('base');
  return { dir, git, write, commit, base };
}

describe('cleanReplayCarriesForward', () => {
  it.skipIf(!modernGit)('AC-1: message-only amend carries forward', async () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'pr');
    r.write('a.txt', '1\n2\nX\n4\n5\n');
    const head = r.commit('feat');
    r.git('commit', '-q', '--amend', '-m', 'reworded');
    const amended = r.git('rev-parse', 'HEAD');
    expect(amended).not.toBe(head);
    await expect(
      cleanReplayCarriesForward(
        defaultRunner,
        r.dir,
        { headSha: head, baseSha: r.base },
        { headSha: amended, baseSha: r.base },
      ),
    ).resolves.toBe(true);
  });

  it.skipIf(!modernGit)('AC-2: rebase onto unrelated main change carries forward', async () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'pr');
    r.write('a.txt', '1\n2\nX\n4\n5\n');
    const head = r.commit('feat');
    r.git('checkout', '-q', 'main');
    r.write('b.txt', 'changed\n');
    const newBase = r.commit('unrelated');
    r.git('checkout', '-q', 'pr');
    r.git('rebase', '-q', 'main');
    const rebased = r.git('rev-parse', 'HEAD');
    await expect(
      cleanReplayCarriesForward(
        defaultRunner,
        r.dir,
        { headSha: head, baseSha: r.base },
        { headSha: rebased, baseSha: newBase },
      ),
    ).resolves.toBe(true);
    await expect(
      findCarriedVerdict(defaultRunner, r.dir, { headSha: rebased, baseSha: newBase }, [
        { headSha: head, baseSha: r.base },
      ]),
    ).resolves.toEqual({ status: 'ok-carried', from: head });
  });

  it.skipIf(!modernGit)('AC-3: a rebase needing conflict resolution does not carry', async () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'pr');
    r.write('a.txt', '1\n2\nX\n4\n5\n');
    const head = r.commit('feat');
    r.git('checkout', '-q', 'main');
    r.write('a.txt', '1\n2\nY\n4\n5\n');
    const newBase = r.commit('conflicting');
    r.git('checkout', '-q', 'pr');
    // Resolve the conflict by taking the PR's side: the patch-id of the PR commit is unchanged.
    try {
      r.git('rebase', '-q', 'main');
    } catch {
      r.write('a.txt', '1\n2\nX\n4\n5\n');
      r.git('add', 'a.txt');
      execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], {
        cwd: r.dir,
        env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      });
    }
    const rebased = r.git('rev-parse', 'HEAD');
    await expect(
      cleanReplayCarriesForward(
        defaultRunner,
        r.dir,
        { headSha: head, baseSha: r.base },
        { headSha: rebased, baseSha: newBase },
      ),
    ).resolves.toBe(false);
    await expect(
      findCarriedVerdict(defaultRunner, r.dir, { headSha: rebased, baseSha: newBase }, [
        { headSha: head, baseSha: r.base },
      ]),
    ).resolves.toEqual({ status: 'replay-dirty' });
  });

  it.skipIf(!modernGit)('AC-4: a rebase with one extra edited line does not carry', async () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'pr');
    r.write('a.txt', '1\n2\nX\n4\n5\n');
    const head = r.commit('feat');
    r.git('checkout', '-q', 'main');
    r.write('b.txt', 'changed\n');
    const newBase = r.commit('unrelated');
    r.git('checkout', '-q', 'pr');
    r.git('rebase', '-q', 'main');
    r.write('a.txt', '1\n2\nX\n4\nextra\n');
    const edited = r.commit('sneaky');
    await expect(
      cleanReplayCarriesForward(
        defaultRunner,
        r.dir,
        { headSha: head, baseSha: r.base },
        { headSha: edited, baseSha: newBase },
      ),
    ).resolves.toBe(false);
  });

  it('AC-5: refuses with a named error on git older than 2.40', async () => {
    const old: Runner = async () => ({
      stdout: 'git version 2.39.5 (Apple Git-154)\n',
      stderr: '',
      code: 0,
    });
    const s = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
    const p = cleanReplayCarriesForward(old, '/x', s, s);
    await expect(p).rejects.toBeInstanceOf(GitTooOldError);
    await expect(p).rejects.toThrow(/requires git 2\.40/);
  });

  it('returns false when a tree cannot be resolved, and handles unparsable version', async () => {
    const fail: Runner = async (_c, args) =>
      args[0] === '--version'
        ? { stdout: 'git version 2.43.0', stderr: '', code: 0 }
        : { stdout: '', stderr: 'bad', code: 128 };
    const s = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
    await expect(cleanReplayCarriesForward(fail, '/x', s, s)).resolves.toBe(false);
    const junk: Runner = async () => ({ stdout: 'nonsense', stderr: '', code: 0 });
    await expect(cleanReplayCarriesForward(junk, '/x', s, s)).rejects.toBeInstanceOf(
      GitTooOldError,
    );
    expect(parseGitVersion('nonsense')).toBeNull();
  });

  it('skips the candidate itself among earlier records', async () => {
    const run: Runner = async (_c, args) =>
      args[0] === '--version'
        ? { stdout: 'git version 2.43.0', stderr: '', code: 0 }
        : { stdout: 't1\n', stderr: '', code: 0 };
    const s = { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
    await expect(findCarriedVerdict(run, '/x', s, [s])).resolves.toEqual({
      status: 'replay-dirty',
    });
  });

  describe('merge-tree path (fake runner, independent of local git version)', () => {
    const rev = { headSha: 'r'.repeat(40), baseSha: 'b'.repeat(40) };
    const cand = { headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40) };
    const fake =
      (mergeCode: number, mergeTree: string): Runner =>
      async (_c, args) => {
        if (args[0] === '--version') return { stdout: 'git version 2.43.0', stderr: '', code: 0 };
        if (args[0] === 'rev-parse')
          return { stdout: args[1].startsWith('r') ? 'T1\n' : 'T2\n', stderr: '', code: 0 };
        expect(args.slice(0, 3)).toEqual([
          'merge-tree',
          '--write-tree',
          `--merge-base=${rev.baseSha}`,
        ]);
        return { stdout: `${mergeTree}\n`, stderr: '', code: mergeCode };
      };

    it('carries when the clean replay tree equals the candidate tree', async () => {
      await expect(cleanReplayCarriesForward(fake(0, 'T2'), '/x', rev, cand)).resolves.toBe(true);
      await expect(findCarriedVerdict(fake(0, 'T2'), '/x', cand, [rev])).resolves.toEqual({
        status: 'ok-carried',
        from: rev.headSha,
      });
    });

    it('does not carry on conflict or a differing tree', async () => {
      await expect(cleanReplayCarriesForward(fake(1, 'T2'), '/x', rev, cand)).resolves.toBe(false);
      await expect(cleanReplayCarriesForward(fake(0, 'T9'), '/x', rev, cand)).resolves.toBe(false);
    });
  });
});
