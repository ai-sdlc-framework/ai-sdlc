/**
 * Unit tests for the own-branch force-with-lease guard.
 * Run with: node --test ai-sdlc-plugin/hooks/lib/lease-push-guard.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateLeasePush,
  isProtectedBranch,
  hasForcePushOption,
} = require('./lease-push-guard.js');

const OWN = 'ai-sdlc/aisdlc-1-thing';
const ctx = (over = {}) => ({
  ownRef: `refs/heads/${OWN}`,
  taskId: 'aisdlc-1',
  worktreeName: 'aisdlc-1',
  refAliasState: () => 'clear',
  protectedBranches: ['release/*', 'prod'],
  remotes: ['origin', 'fork'],
  aliasLookup: (n) => (n === 'fpush' ? 'push --force' : null),
  ...over,
});
const verdict = (cmd, over) => evaluateLeasePush(cmd, ctx(over)).decision;

describe('evaluateLeasePush — allowed shapes', () => {
  for (const cmd of [
    `git push --force-with-lease origin ${OWN}`,
    `git push origin --force-with-lease ${OWN}`,
    `git push --force-with-lease=${OWN} origin ${OWN}`,
    `git push --force-with-lease=${OWN}:0123abcd origin ${OWN}`,
    `git push --force-with-lease=refs/heads/${OWN} origin ${OWN}`,
    `git push --force-with-lease --force-if-includes origin ${OWN}`,
    `git push -u --force-with-lease origin ${OWN}`,
    `git push --force-with-lease origin HEAD:refs/heads/${OWN}`,
    `git push --force-with-lease origin ${OWN}:refs/heads/${OWN}`,
    `git push --force-with-lease origin refs/heads/${OWN}:refs/heads/${OWN}`,
    `git push --force-with-lease origin refs/heads/${OWN}`,
    `git push --force-with-lease fork ${OWN}`,
    `  git push --force-with-lease origin ${OWN}  `,
  ]) {
    it(`allows: ${cmd.trim()}`, () => assert.equal(verdict(cmd), 'allow'));
  }
});

describe('evaluateLeasePush — denied', () => {
  const denied = [
    ['lease to other branch', 'git push --force-with-lease origin other'],
    ['refspec local:other', `git push --force-with-lease origin ${OWN}:other`],
    ['HEAD:other', 'git push --force-with-lease origin HEAD:other'],
    ['source other', `git push --force-with-lease origin other:${OWN}`],
    ['multi refspec w/ other', `git push --force-with-lease origin ${OWN} other`],
    ['HEAD:main', 'git push --force-with-lease origin HEAD:main'],
    ['refs/heads/main', 'git push --force-with-lease origin refs/heads/main'],
    ['main', 'git push --force-with-lease origin main'],
    ['master', 'git push --force-with-lease origin master'],
    ['delete :main', 'git push --force-with-lease origin :main'],
    ['delete :own', `git push --force-with-lease origin :${OWN}`],
    ['--delete', `git push --force-with-lease --delete origin ${OWN}`],
    ['-d', `git push --force-with-lease -d origin ${OWN}`],
    ['--mirror', 'git push --force-with-lease --mirror origin'],
    ['--all', 'git push --force-with-lease --all origin'],
    ['--tags', 'git push --force-with-lease --tags origin'],
    ['plain --force', `git push --force origin ${OWN}`],
    ['-f', `git push -f origin ${OWN}`],
    ['clustered -uf', `git push -uf origin ${OWN}`],
    ['+refspec', `git push origin +${OWN}`],
    ['+refspec w/ lease', `git push --force-with-lease origin +${OWN}`],
    ['--force-if-includes alone', `git push --force-if-includes origin ${OWN}`],
    ['abbreviated option', `git push --force-w origin ${OWN}`],
    ['abbrev --forc', `git push --forc origin ${OWN}`],
    ['no refspec', 'git push --force-with-lease origin'],
    ['no remote', 'git push --force-with-lease'],
    ['raw URL remote', `git push --force-with-lease https://evil.example/r.git ${OWN}`],
    ['unconfigured remote name', `git push --force-with-lease evil ${OWN}`],
    ['lease value other ref', `git push --force-with-lease=main:0123abcd origin ${OWN}`],
    ['lease value malformed', `git push --force-with-lease=a:b origin ${OWN}`],
    ['--no-verify', `git push --no-verify --force-with-lease origin ${OWN}`],
    ['unknown flag', `git push --force-with-lease --receive-pack=x origin ${OWN}`],
    ['chained &&', `git push --force-with-lease origin ${OWN} && echo hi`],
    ['chained ;', `git push --force-with-lease origin ${OWN}; rm -rf x`],
    ['chained ||', `git push --force-with-lease origin ${OWN} || true`],
    ['pipe', `git push --force-with-lease origin ${OWN} | cat`],
    ['newline', `git push --force-with-lease origin ${OWN}\nrm x`],
    ['subshell', `(git push --force-with-lease origin ${OWN})`],
    ['command subst', `echo $(git push --force-with-lease origin other)`],
    ['backticks', 'echo `git push --force-with-lease origin other`'],
    ['cd then push', `cd /elsewhere && git push --force-with-lease origin ${OWN}`],
    ['git -C', `git -C /elsewhere push --force-with-lease origin ${OWN}`],
    ['--git-dir', `git --git-dir=/x/.git push --force-with-lease origin ${OWN}`],
    ['GIT_DIR prefix', `GIT_DIR=/x/.git git push --force-with-lease origin ${OWN}`],
    ['env wrapper', `env git push --force-with-lease origin ${OWN}`],
    ['command wrapper', `command git push --force-with-lease origin ${OWN}`],
    ['absolute git path', `/usr/bin/git push --force-with-lease origin ${OWN}`],
    ['-c alias override', `git -c alias.p=push p --force-with-lease origin ${OWN}`],
    ['configured alias', 'git fpush origin whatever'],
    ['quoted flag', `git push '--force-with-lease' origin ${OWN}`],
    ['quoted ref', `git push --force-with-lease origin "${OWN}"`],
    ['escaped flag', `git push --force\\-with-lease origin ${OWN}`],
    ['variable flag', `git push $FLAG origin ${OWN}`],
    ['variable ref', `git push --force-with-lease origin $B`],
    ['glob', 'git push --force-with-lease origin *'],
    ['brace', 'git push --force-with-lease origin {a,b}'],
    ['redirect', `git push --force-with-lease origin ${OWN} > /dev/null`],
    ['push option f', `git push -o x -f origin ${OWN}`],
  ];
  for (const [name, cmd] of denied) {
    it(`denies: ${name}`, () => assert.equal(verdict(cmd), 'deny', cmd));
  }

  it('denies when own branch is main/master/protected', () => {
    for (const b of ['main', 'master', 'release/1.0', 'prod']) {
      assert.equal(
        verdict(`git push --force-with-lease origin ${b}`, { ownRef: `refs/heads/${b}` }),
        'deny',
        b,
      );
    }
  });

  it('denies when own branch is unknown or detached or odd', () => {
    assert.equal(verdict(`git push --force-with-lease origin ${OWN}`, { ownRef: null }), 'deny');
    assert.equal(
      verdict(`git push --force-with-lease origin x`, { ownRef: 'refs/heads/x y' }),
      'deny',
    );
  });

  it('denies when remotes unknown (git remote failed)', () => {
    assert.equal(
      verdict(`git push --force-with-lease origin ${OWN}`, { remotes: undefined }),
      'deny',
    );
    assert.equal(verdict(`git push --force-with-lease origin ${OWN}`, { remotes: [] }), 'deny');
  });

  it('deny reason is informative', () => {
    const r = evaluateLeasePush('git push -f origin x', ctx());
    assert.equal(r.decision, 'deny');
    assert.match(r.reason, /own-branch|own branch/);
  });
});

describe('evaluateLeasePush — not force-ish (unchanged behavior)', () => {
  for (const cmd of [
    'git push origin feature',
    'git push',
    'git status',
    'git commit -m "docs: mention git push -f in text"',
    'echo "git push --force origin main"',
    'git log --format=%H',
    'gh pr view 1',
    'echo hi',
    'ls',
    'FOO=bar ls',
    '',
    '   ',
  ]) {
    it(`none: ${JSON.stringify(cmd)}`, () => assert.equal(verdict(cmd), 'none'));
  }

  it('non-string input is none', () => {
    assert.equal(evaluateLeasePush(undefined, ctx()).decision, 'none');
  });

  it('works without an aliasLookup', () => {
    assert.equal(
      evaluateLeasePush('git push origin f', { ownRef: `refs/heads/${OWN}` }).decision,
      'none',
    );
  });
});

describe('isProtectedBranch', () => {
  it('always protects main/master, honors policy list and prefix globs', () => {
    assert.ok(isProtectedBranch('main', []));
    assert.ok(isProtectedBranch('refs/heads/master', undefined));
    assert.ok(isProtectedBranch('release/2', ['release/*']));
    assert.ok(isProtectedBranch('prod', ['prod']));
    assert.ok(!isProtectedBranch('prod2', ['prod']));
    assert.ok(!isProtectedBranch('feature', ['release/*']));
  });
});

describe('evaluateLeasePush - git short-name resolution bypass', () => {
  const withOwn = (name, cmd) =>
    evaluateLeasePush(cmd, ctx({ ownRef: `refs/heads/${name}` })).decision;

  it('denies ambiguous own-branch names that git could resolve to another ref', () => {
    for (const name of [
      'heads/develop',
      'heads/main',
      'refs/heads/main',
      'tags/x',
      'remotes/origin/main',
    ]) {
      assert.equal(withOwn(name, `git push --force-with-lease origin HEAD:${name}`), 'deny', name);
      assert.equal(
        withOwn(name, `git push --force-with-lease origin ${name}:${name}`),
        'deny',
        name,
      );
    }
  });

  it('denies a non-refs/heads own ref (tag, detached, remote-tracking)', () => {
    for (const ref of ['refs/tags/x', 'refs/remotes/origin/main', 'main', 'HEAD', '']) {
      assert.equal(
        evaluateLeasePush(`git push --force-with-lease origin ${OWN}`, ctx({ ownRef: ref }))
          .decision,
        'deny',
        ref,
      );
    }
  });

  it('denies destinations spelled in a namespace-qualified way', () => {
    for (const dst of [
      'heads/main',
      'heads/develop',
      'tags/x',
      'remotes/origin/main',
      'refs/tags/x',
    ]) {
      assert.equal(verdict(`git push --force-with-lease origin HEAD:${dst}`), 'deny', dst);
      assert.equal(verdict(`git push --force-with-lease origin ${OWN}:${dst}`), 'deny', dst);
    }
    assert.equal(verdict(`git push --force-with-lease origin HEAD:heads/${OWN}`), 'deny');
  });

  it('denies malformed own branch names', () => {
    for (const name of ['a//b', 'a..b', '/a', 'a/']) {
      assert.equal(withOwn(name, `git push --force-with-lease origin ${name}`), 'deny', name);
    }
  });

  it('protected names compare case-insensitively', () => {
    assert.equal(withOwn('Main', 'git push --force-with-lease origin Main'), 'deny');
    assert.equal(withOwn('PROD', 'git push --force-with-lease origin PROD'), 'deny');
    assert.ok(isProtectedBranch('Release/1', []));
  });
});

describe('evaluateLeasePush - option abbreviations and parser agreement', () => {
  for (const flag of [
    '--mir',
    '--mirror',
    '--m',
    '--de',
    '--del',
    '--pru',
    '--al',
    '--all',
    '--for',
    '--forc',
    '--fo',
  ]) {
    it(`denies abbreviated force-class option ${flag}`, () => {
      assert.equal(verdict(`git push ${flag} origin ${OWN}`), 'deny');
      assert.equal(verdict(`git push --force-with-lease ${flag} origin ${OWN}`), 'deny');
    });
  }

  it('a benign --follow-tags push is not force-ish (unchanged); with a lease it is denied (documented)', () => {
    assert.equal(verdict(`git push --follow-tags origin ${OWN}`), 'none');
    assert.equal(verdict(`git push --force-with-lease --follow-tags origin ${OWN}`), 'deny');
  });

  it('rejects NBSP / unicode / control separators so parser and shell cannot disagree', () => {
    assert.equal(verdict(`git push --force-with-lease origin\u00a0${OWN}`), 'deny');
    // NBSP glued into the subcommand word: git itself rejects it as an unknown command.
    assert.equal(verdict(`git push\u00a0--force-with-lease origin ${OWN}`), 'none');
    assert.equal(verdict(`git push --force-with-lease origin ${OWN}\u2003`), 'deny');
    assert.equal(verdict(`git push --force-with-lease origin ${OWN}\x0b`), 'deny');
  });

  it('tab-separated plain ASCII still parses like the shell would', () => {
    assert.equal(verdict(`git\tpush\t--force-with-lease\torigin\t${OWN}`), 'allow');
  });

  it('env-injected git config (GIT_CONFIG_COUNT and friends) is denied', () => {
    for (const pre of [
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=push\\ -f git x origin main',
      'GIT_CONFIG_PARAMETERS=x git x',
    ]) {
      assert.equal(verdict(pre), 'deny', pre);
    }
    assert.equal(verdict('GIT_CONFIG_GLOBAL=/dev/null git status'), 'none');
  });

  it('shell wrappers (documented, unchanged from before this feature)', () => {
    // bash -c / sh -c payloads are not parsed: same as the legacy blockedActions behavior.
    assert.equal(verdict("bash -c 'git push --force-with-lease origin main'"), 'none');
    assert.equal(verdict("sh -c 'git push -f origin main'"), 'none');
    // xargs is a recognised wrapper: the push is seen and denied.
    assert.equal(verdict('xargs git push --force-with-lease origin main'), 'deny');
  });
});

describe('evaluateLeasePush - short destination / alias hardening', () => {
  const dec = (cmd, over) => evaluateLeasePush(cmd, ctx(over)).decision;

  it('colon form requires the fully-qualified destination', () => {
    assert.equal(dec(`git push --force-with-lease origin HEAD:${OWN}`), 'deny');
    assert.equal(dec(`git push --force-with-lease origin ${OWN}:${OWN}`), 'deny');
    assert.equal(dec(`git push --force-with-lease origin HEAD:refs/heads/${OWN}`), 'allow');
    for (const dst of [
      'v1.2.3',
      'notes/commits',
      'refs/notes/commits',
      'meta/config',
      'refs/meta/config',
      'refs/tags/v1',
    ]) {
      assert.equal(dec(`git push --force-with-lease origin HEAD:${dst}`), 'deny', dst);
    }
  });

  it('bare no-colon form is allowed only for the own branch', () => {
    assert.equal(dec(`git push --force-with-lease origin ${OWN}`), 'allow');
    assert.equal(dec(`git push --force-with-lease origin refs/heads/${OWN}`), 'allow');
    assert.equal(dec('git push --force-with-lease origin ai-sdlc/aisdlc-1-other'), 'deny');
  });

  it('denies when another local ref answers to the name, or when that cannot be checked', () => {
    assert.equal(
      dec(`git push --force-with-lease origin ${OWN}`, { refAliasState: () => 'collides' }),
      'deny',
    );
    assert.equal(
      dec(`git push --force-with-lease origin ${OWN}`, { refAliasState: () => 'error' }),
      'deny',
    );
    assert.equal(
      dec(`git push --force-with-lease origin HEAD:refs/heads/${OWN}`, {
        refAliasState: () => 'collides',
      }),
      'deny',
    );
    assert.equal(
      dec(`git push --force-with-lease origin ${OWN}`, { refAliasState: undefined }),
      'deny',
    );
  });

  it('own branch names that are pseudo refs or start with a dash are refused', () => {
    for (const name of ['HEAD', 'ORIG_HEAD', '-x']) {
      assert.equal(
        dec(`git push --force-with-lease origin ${name}`, { ownRef: `refs/heads/${name}` }),
        'deny',
        name,
      );
    }
  });
});

describe('evaluateLeasePush - task branch binding', () => {
  const dec = (over) =>
    evaluateLeasePush(`git push --force-with-lease origin ${OWN}`, ctx(over)).decision;

  it('allows when .active-task, directory name and branch prefix agree', () => {
    assert.equal(dec({}), 'allow');
  });

  it('denies without a valid task id (operator session / absent / malformed sentinel)', () => {
    assert.equal(dec({ taskId: null }), 'deny');
    assert.equal(dec({ taskId: undefined }), 'deny');
    assert.equal(dec({ taskId: '' }), 'deny');
  });

  it('denies when the worktree directory name disagrees (rewritten sentinel)', () => {
    assert.equal(dec({ taskId: 'aisdlc-700' }), 'deny');
    assert.equal(dec({ worktreeName: 'aisdlc-700' }), 'deny');
    assert.equal(dec({ worktreeName: null }), 'deny');
  });

  it('denies a branch that does not carry the task prefix', () => {
    for (const b of [
      'feat/x',
      'ai-sdlc/aisdlc-2-x',
      'ai-sdlc/aisdlc-10-x',
      'ai-sdlc/aisdlc-1',
      'xai-sdlc/aisdlc-1-x',
    ]) {
      assert.equal(
        evaluateLeasePush(
          `git push --force-with-lease origin ${b}`,
          ctx({ ownRef: `refs/heads/${b}` }),
        ).decision,
        'deny',
        b,
      );
    }
  });

  it('supports sub-task ids', () => {
    const b = 'ai-sdlc/aisdlc-100.5-x';
    assert.equal(
      evaluateLeasePush(
        `git push --force-with-lease origin ${b}`,
        ctx({ ownRef: `refs/heads/${b}`, taskId: 'aisdlc-100.5', worktreeName: 'aisdlc-100.5' }),
      ).decision,
      'allow',
    );
  });
});

describe('isProtectedBranch - defaults', () => {
  it('protects main, master and the default deploy/release branches', () => {
    for (const b of [
      'main',
      'master',
      'release-please--branches--main',
      'release-please--branches--x',
      'gh-pages',
      'production',
      'prod',
      'release/1.0',
      'releases/2.0',
      'release/a/b',
      'Main',
      'GH-PAGES',
    ]) {
      assert.ok(isProtectedBranch(b, []), b);
      assert.ok(isProtectedBranch(`refs/heads/${b}`, []), `refs/heads/${b}`);
    }
  });

  it('does not over-match task branches or lookalikes', () => {
    for (const b of [
      'ai-sdlc/aisdlc-1-x',
      'releasex',
      'release',
      'mainline',
      'prod2',
      'my-prod',
      'pre-production',
    ]) {
      assert.ok(!isProtectedBranch(b, []), b);
    }
  });

  it('merges policy entries with the defaults, with wildcard support', () => {
    assert.ok(isProtectedBranch('develop', ['develop']));
    assert.ok(isProtectedBranch('hotfix/9', ['hotfix/*']));
    assert.ok(isProtectedBranch('main', ['develop']));
    assert.ok(!isProtectedBranch('feature/x', ['hotfix/*']));
  });

  it('fails closed on an odd pattern (matches everything)', () => {
    assert.ok(isProtectedBranch('anything', ['we ird$']));
  });
});

describe('hasForcePushOption (default `never` policy)', () => {
  const f = (c) => hasForcePushOption(c);
  it('detects force shapes the anchored globs miss', () => {
    for (const c of [
      'git push origin --force main',
      'git push origin -f HEAD:main',
      'git push origin main --force-with-lease',
      'git push origin +main',
      'git push -uf origin x',
      'git push --forc origin x',
      'git push origin x --force-if-includes',
    ]) {
      assert.ok(f(c), c);
    }
  });

  it('leaves ordinary pushes and unrelated commands alone', () => {
    for (const c of [
      'git push origin main',
      'git push --follow-tags origin x',
      'git push -u origin x',
      'git push --fo origin x',
      'git commit -m "fix -f flag" ',
      'git log --force',
      'echo git push -f',
      'echo hi',
      'ls',
      undefined,
    ]) {
      assert.ok(!f(c), String(c));
    }
  });
});
