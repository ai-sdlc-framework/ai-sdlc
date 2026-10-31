import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  packagesToCover,
  main,
  gitSafeEnv,
  GIT_REPO_ENV_VARS,
} from './pre-push-patch-coverage.mjs';
import { formatLineRanges } from './check-pr-patch-coverage.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkgs = {
  'pipeline-cli': { scripts: { 'test:coverage': 'x' } },
  'vscode-hierarchy': { scripts: { 'test:coverage': 'x' } },
  'no-cov': { scripts: {} },
};
const readPkg = (d) => pkgs[d] ?? null;

describe('packagesToCover', () => {
  it('maps code files to their package only', () => {
    assert.deepEqual(
      packagesToCover(['pipeline-cli/src/a.ts', 'pipeline-cli/src/b.ts', 'docs/x.md'], readPkg),
      ['pipeline-cli'],
    );
  });
  it('ignores test-only, docs-only and packages without coverage', () => {
    assert.deepEqual(packagesToCover(['pipeline-cli/src/a.test.ts', 'README.md'], readPkg), []);
    assert.deepEqual(packagesToCover(['no-cov/src/a.ts'], readPkg), []);
    assert.deepEqual(packagesToCover(['unknown/src/a.ts'], readPkg), []);
  });
  it('finds nested package dirs and multiple packages sorted', () => {
    assert.deepEqual(
      packagesToCover(['vscode-hierarchy/src/clock.ts', 'pipeline-cli/src/deep/x.ts'], readPkg),
      ['pipeline-cli', 'vscode-hierarchy'],
    );
  });
  it('default reader resolves real workspace packages', () => {
    assert.deepEqual(packagesToCover(['pipeline-cli/src/foo.ts']), ['pipeline-cli']);
    assert.deepEqual(packagesToCover(['vscode-hierarchy/src/clock.ts']), ['vscode-hierarchy']);
  });
});

describe('main', () => {
  const ok = { status: 0 };
  it('prints one skip line and runs nothing for non-code pushes', () => {
    const logs = [];
    const calls = [];
    const code = main({
      run: (...a) => (calls.push(a), ok),
      changed: () => ['docs/a.md', 'pipeline-cli/src/a.test.ts'],
      log: (m) => logs.push(m),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.equal(logs.length, 1);
  });
  it('runs coverage in the touched package only, then the gate', () => {
    const calls = [];
    const code = main({
      run: (cmd, args) => (calls.push([cmd, ...args]), ok),
      changed: () => ['pipeline-cli/src/a.ts'],
      log: () => {},
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 4), ['pnpm', '--filter', './pipeline-cli', 'test:coverage']);
    assert.match(calls[1][1], /check-pr-patch-coverage\.mjs$/);
    assert.ok(!calls[1].includes('--threshold'));
  });
  it('fails when coverage run fails or the gate fails', () => {
    assert.equal(
      main({ run: () => ({ status: 1 }), changed: () => ['pipeline-cli/src/a.ts'], log: () => {} }),
      1,
    );
    let n = 0;
    assert.equal(
      main({
        run: () => ({ status: n++ === 0 ? 0 : 1 }),
        changed: () => ['pipeline-cli/src/a.ts'],
        log: () => {},
      }),
      1,
    );
  });
  it('honours the skip env var', () => {
    process.env.AI_SDLC_SKIP_PATCH_COVERAGE_GATE = '1';
    try {
      assert.equal(main({ run: () => assert.fail('no run'), log: () => {} }), 0);
    } finally {
      delete process.env.AI_SDLC_SKIP_PATCH_COVERAGE_GATE;
    }
  });
  it('spawns every child with the git repository variables stripped (incident 2026-10-30)', () => {
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_PREFIX: process.env.GIT_PREFIX };
    process.env.GIT_DIR = '/elsewhere/.git/worktrees/x';
    process.env.GIT_PREFIX = '';
    const envs = [];
    try {
      main({
        run: (_cmd, _args, opts) => (envs.push(opts.env), ok),
        changed: () => ['pipeline-cli/src/a.ts'],
        log: () => {},
      });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    assert.equal(envs.length, 2);
    for (const env of envs) {
      assert.ok(env, 'an explicit env is passed');
      for (const k of GIT_REPO_ENV_VARS) assert.ok(!(k in env), `${k} must not be inherited`);
      assert.equal(env.PATH, process.env.PATH);
    }
  });
});

describe('gitSafeEnv', () => {
  it('removes every git repository variable and keeps the rest, without mutating the input', () => {
    const input = { PATH: '/bin', GIT_DIR: '/x/.git', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: '/x/i' };
    const out = gitSafeEnv(input);
    assert.deepEqual(out, { PATH: '/bin' });
    assert.equal(input.GIT_DIR, '/x/.git');
  });
  it('covers GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_COMMON_DIR and GIT_PREFIX', () => {
    for (const k of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_PREFIX',
    ]) {
      assert.ok(GIT_REPO_ENV_VARS.includes(k), k);
    }
  });
});

describe('.husky/pre-push', () => {
  const hook = readFileSync(join(REPO_ROOT, '.husky/pre-push'), 'utf-8');
  const lines = hook.split('\n');
  const unsetAt = lines.findIndex((l) => /^unset .*\bGIT_DIR\b/.test(l));

  it('unsets every git repository variable in GIT_REPO_ENV_VARS, before PUSH_STDIN is read', () => {
    assert.ok(unsetAt >= 0, 'an `unset ... GIT_DIR ...` line exists');
    for (const k of GIT_REPO_ENV_VARS) {
      assert.match(lines[unsetAt], new RegExp(`\\b${k}\\b`), `unset covers ${k}`);
    }
    // PUSH_STDIN= is the first statement of the gate chain and a stable anchor.
    const pushStdinAt = lines.findIndex((l) => /^PUSH_STDIN=/.test(l));
    assert.ok(pushStdinAt > unsetAt, 'the unset runs before the gate chain starts');
  });

  it('behaviourally: the hook preamble under sh drops the variables and keeps the rest', () => {
    const pushStdinAt = lines.findIndex((l) => /^PUSH_STDIN=/.test(l));
    const preamble = lines.slice(0, pushStdinAt).join('\n');
    const r = spawnSync('sh', ['-c', `${preamble}\nenv`], {
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH,
        GIT_DIR: '/elsewhere/.git/worktrees/x',
        GIT_PREFIX: '',
        GIT_WORK_TREE: '/elsewhere',
        GIT_INDEX_FILE: '/elsewhere/.git/index',
        GIT_AUTHOR_NAME: 'kept',
      },
    });
    assert.equal(r.status, 0, r.stderr);
    const keys = r.stdout.split('\n').map((l) => l.split('=')[0]);
    for (const k of GIT_REPO_ENV_VARS) assert.ok(!keys.includes(k), `${k} dropped`);
    assert.ok(keys.includes('GIT_AUTHOR_NAME'), 'unrelated GIT_* variables survive');
  });
});

describe('vitest.git-env.setup.mjs', () => {
  const setupPath = join(REPO_ROOT, 'vitest.git-env.setup.mjs');

  it('is the first setup file of the shared vitest config', async () => {
    const { sharedTestConfig } = await import(
      pathToFileURL(join(REPO_ROOT, 'vitest.shared.mjs')).href
    );
    assert.ok(existsSync(setupPath), 'setup file exists');
    assert.match(sharedTestConfig.setupFiles[0], /vitest\.git-env\.setup\.mjs$/);
  });

  it('deletes exactly the GIT_REPO_ENV_VARS list from a worker and keeps the rest', () => {
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(setupPath).href,
        '-e',
        'console.log(Object.keys(process.env).join("\\n"))',
      ],
      {
        encoding: 'utf-8',
        env: {
          PATH: process.env.PATH,
          GIT_DIR: '/elsewhere/.git/worktrees/x',
          GIT_PREFIX: '',
          GIT_WORK_TREE: '/elsewhere',
          GIT_INDEX_FILE: '/elsewhere/.git/index',
          GIT_COMMON_DIR: '/elsewhere/.git',
          GIT_AUTHOR_NAME: 'kept',
        },
      },
    );
    assert.equal(r.status, 0, r.stderr);
    const keys = r.stdout.trim().split('\n');
    for (const k of GIT_REPO_ENV_VARS) assert.ok(!keys.includes(k), `${k} deleted`);
    assert.ok(keys.includes('GIT_AUTHOR_NAME'), 'GIT_AUTHOR_NAME kept');
    assert.ok(keys.includes('PATH'), 'PATH kept');
  });

  it('spells the same list as GIT_REPO_ENV_VARS (no drift between the three layers)', () => {
    const src = readFileSync(setupPath, 'utf-8');
    const listed = [...src.matchAll(/'(GIT_[A-Z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(listed.sort(), [...GIT_REPO_ENV_VARS].sort());
  });
});

describe('formatLineRanges', () => {
  it('collapses consecutive lines', () => {
    assert.equal(formatLineRanges([3, 4, 5, 9, 11, 12]), '3-5, 9, 11-12');
    assert.equal(formatLineRanges([]), '');
  });
});
