import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  packagesToCover,
  main,
  resolveBoardDir,
  gitSafeEnv,
  sessionScrubbedEnv,
  GIT_REPO_ENV_VARS,
  reuseMismatch,
  COVERAGE_WINDOW_MS,
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
  it('prints one skip line and runs nothing for non-code pushes', async () => {
    const logs = [];
    const calls = [];
    const code = await main({
      boardDir: null,
      reuseFacts: () => null,
      run: (...a) => (calls.push(a), ok),
      changed: () => ['docs/a.md', 'pipeline-cli/src/a.test.ts'],
      log: (m) => logs.push(m),
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.equal(logs.length, 1);
  });
  it('runs coverage in the touched package only, then the gate', async () => {
    const calls = [];
    const code = await main({
      boardDir: null,
      reuseFacts: () => null,
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
  it('fails when coverage run fails or the gate fails', async () => {
    assert.equal(
      await main({
        boardDir: null,
        reuseFacts: () => null,
        run: () => ({ status: 1 }),
        changed: () => ['pipeline-cli/src/a.ts'],
        log: () => {},
      }),
      1,
    );
    let n = 0;
    assert.equal(
      await main({
        boardDir: null,
        reuseFacts: () => null,
        run: () => ({ status: n++ === 0 ? 0 : 1 }),
        changed: () => ['pipeline-cli/src/a.ts'],
        log: () => {},
      }),
      1,
    );
  });
  it('honours the skip env var', async () => {
    process.env.AI_SDLC_SKIP_PATCH_COVERAGE_GATE = '1';
    try {
      assert.equal(
        await main({
          boardDir: null,
          reuseFacts: () => null,
          run: () => assert.fail('no run'),
          log: () => {},
        }),
        0,
      );
    } finally {
      delete process.env.AI_SDLC_SKIP_PATCH_COVERAGE_GATE;
    }
  });
  it('spawns every child with the git repository variables stripped (incident 2026-10-30)', async () => {
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_PREFIX: process.env.GIT_PREFIX };
    process.env.GIT_DIR = '/elsewhere/.git/worktrees/x';
    process.env.GIT_PREFIX = '';
    const envs = [];
    try {
      await main({
        boardDir: null,
        reuseFacts: () => null,
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

describe('main verify slot (AISDLC-1186)', () => {
  const ok = { status: 0 };
  const changed = () => ['pipeline-cli/src/a.ts'];
  function fakeSlots(events, workers = 3) {
    return async () => ({
      VERIFY_WORKERS_SHARED: 2,
      acquireVerifySlot: async (dir) => {
        events.push(`acquire:${dir}`);
        return { workers, release: () => events.push('release') };
      },
    });
  }
  it('holds a slot for the whole run and gives each child its worker cap', async () => {
    const events = [];
    const envs = [];
    const code = await main({
      boardDir: '/board',
      reuseFacts: () => null,
      loadSlots: fakeSlots(events),
      run: (_c, _a, o) => (events.push('run'), envs.push(o.env), ok),
      changed,
      log: () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(events, ['acquire:/board', 'run', 'run', 'release']);
    for (const e of envs) assert.equal(e.AI_SDLC_VITEST_MAX_WORKERS, '3');
  });
  it('releases after a failing package', async () => {
    const events = [];
    const code = await main({
      boardDir: '/b',
      reuseFacts: () => null,
      loadSlots: fakeSlots(events),
      run: () => ({ status: 1 }),
      changed,
      log: () => {},
    });
    assert.equal(code, 1);
    assert.equal(events.at(-1), 'release');
  });
  it('releases after a failing patch gate', async () => {
    const events = [];
    let n = 0;
    const code = await main({
      boardDir: '/b',
      reuseFacts: () => null,
      loadSlots: fakeSlots(events),
      run: () => ({ status: n++ === 0 ? 0 : 1 }),
      changed,
      log: () => {},
    });
    assert.equal(code, 1);
    assert.equal(events.at(-1), 'release');
  });
  it('releases on SIGTERM and SIGINT before exiting', async () => {
    for (const [sig, exit] of [
      ['SIGTERM', 143],
      ['SIGINT', 130],
    ]) {
      const events = [];
      const realExit = process.exit;
      process.exit = (c) => events.push(`exit:${c}`);
      try {
        await main({
          boardDir: '/b',
          reuseFacts: () => null,
          loadSlots: fakeSlots(events),
          run: () => {
            process.emit(sig);
            return ok;
          },
          changed,
          log: () => {},
        });
      } finally {
        process.exit = realExit;
      }
      assert.ok(events.indexOf('release') < events.indexOf(`exit:${exit}`), sig);
      assert.equal(events.filter((e) => e === 'release').length, 1);
    }
  });
  it('runs unslotted with one line when there is no board directory', async () => {
    const logs = [];
    const envs = [];
    await main({
      boardDir: null,
      reuseFacts: () => null,
      run: (_c, _a, o) => (envs.push(o.env), ok),
      changed,
      log: (m) => logs.push(m),
    });
    assert.equal(logs.filter((l) => /unslotted/.test(l)).length, 1);
    assert.equal(envs.length, 2);
  });
  it('runs unslotted with one line when the module cannot load', async () => {
    const logs = [];
    const code = await main({
      boardDir: '/b',
      reuseFacts: () => null,
      loadSlots: async () => {
        throw new Error('nope');
      },
      run: () => ok,
      changed,
      log: (m) => logs.push(m),
    });
    assert.equal(code, 0);
    assert.equal(logs.filter((l) => /unslotted/.test(l)).length, 1);
  });
  it('runs unslotted when acquiring throws for another reason', async () => {
    const logs = [];
    const code = await main({
      boardDir: '/b',
      reuseFacts: () => null,
      loadSlots: async () => ({
        acquireVerifySlot: async () => {
          throw new Error('mkdir failed');
        },
      }),
      run: () => ok,
      changed,
      log: (m) => logs.push(m),
    });
    assert.equal(code, 0);
    assert.equal(logs.filter((l) => /unslotted/.test(l)).length, 1);
  });
  it('falls back to the shared worker count after the bounded wait', async () => {
    let t = 0;
    const envs = [];
    const logs = [];
    const slow = async () => ({
      VERIFY_WORKERS_SHARED: 2,
      acquireVerifySlot: async (_d, deps) => {
        for (;;) await deps.sleep(500);
      },
    });
    const code = await main({
      boardDir: '/b',
      reuseFacts: () => null,
      loadSlots: slow,
      now: () => t,
      sleep: async (ms) => {
        t += ms * 100;
      },
      waitMs: 1000,
      run: (_c, _a, o) => (envs.push(o.env), ok),
      changed,
      log: (m) => logs.push(m),
    });
    assert.equal(code, 0);
    assert.ok(t >= 1000);
    assert.equal(logs.filter((l) => /unslotted/.test(l)).length, 1);
    for (const e of envs) assert.equal(e.AI_SDLC_VITEST_MAX_WORKERS, '2');
  });
  it('resolveBoardDir honours the env var and existence', () => {
    assert.equal(
      resolveBoardDir({ AI_SDLC_DISPATCH_BOARD_DIR: '/x' }, () => true),
      '/x',
    );
    assert.equal(
      resolveBoardDir({ AI_SDLC_DISPATCH_BOARD_DIR: '/x' }, () => false),
      null,
    );
    assert.match(
      resolveBoardDir({}, () => true),
      /\.ai-sdlc.dispatch$/,
    );
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

describe('sessionScrubbedEnv', () => {
  it('drops executor session keys and keeps unrelated variables', () => {
    const input = {
      PATH: '/bin',
      HOME: '/h',
      AI_SDLC_SKIP_X: '1',
      AI_SDLC_EXECUTOR_TASK: 'AISDLC-1',
      AI_SDLC_HIERARCHY_BOARD: '/b',
      GIT_DIR: '/x/.git',
    };
    const out = sessionScrubbedEnv(input);
    assert.deepEqual(out, { PATH: '/bin', HOME: '/h', AI_SDLC_SKIP_X: '1' });
    assert.equal(input.AI_SDLC_EXECUTOR_TASK, 'AISDLC-1');
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

describe('verify-record reuse (AISDLC-1187, DEC-0371)', () => {
  const ok = { status: 0 };
  const finished = Date.parse('2026-11-04T12:00:00.000Z');
  const goodFacts = () => ({
    tree: 'T',
    baseSha: 'B',
    dirty: false,
    records: [
      {
        ok: true,
        clean: true,
        treeSha: 'T',
        baseSha: 'B',
        finishedAt: new Date(finished).toISOString(),
      },
    ],
    coverageMtimeMs: { 'pipeline-cli': finished - 1000 },
  });
  const pk = ['pipeline-cli'];
  const run = async (reuseFacts, status = 0) => {
    const calls = [];
    const code = await main({
      boardDir: null,
      reuseFacts,
      run: (cmd, args) => (calls.push([cmd, ...args]), { status: calls.length === 1 ? status : 0 }),
      changed: () => ['pipeline-cli/src/a.ts'],
      log: () => {},
    });
    return { code, calls };
  };

  it('on an exact match runs no test:coverage and the gate once', async () => {
    const { code, calls } = await run(goodFacts);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.match(calls[0][1], /check-pr-patch-coverage\.mjs$/);
  });
  it('a failing recomputed gate fails the push', async () => {
    const { code, calls } = await run(goodFacts, 1);
    assert.equal(code, 1);
    assert.equal(calls.length, 1);
  });

  const cases = {
    'tree differs': (f) => ((f.tree = 'X'), f),
    'record not ok': (f) => ((f.records[0].ok = false), f),
    'record not clean': (f) => ((f.records[0].clean = false), f),
    'base sha moved': (f) => ((f.baseSha = 'B2'), f),
    'record has no base sha': (f) => (delete f.records[0].baseSha, f),
    'worktree dirty now': (f) => ((f.dirty = true), f),
    'coverage file missing': (f) => ((f.coverageMtimeMs['pipeline-cli'] = null), f),
    'coverage file too old': (f) => (
      (f.coverageMtimeMs['pipeline-cli'] = finished - COVERAGE_WINDOW_MS - 1),
      f
    ),
    'coverage file after the run': (f) => (
      (f.coverageMtimeMs['pipeline-cli'] = finished + 3600e3),
      f
    ),
    'bad finish time': (f) => ((f.records[0].finishedAt = 'nope'), f),
    'unknown tree': (f) => ((f.tree = ''), f),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    it(`runs as today when ${name}`, async () => {
      const { calls } = await run(() => mutate(goodFacts()));
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].slice(0, 4), [
        'pnpm',
        '--filter',
        './pipeline-cli',
        'test:coverage',
      ]);
    });
  }
  it('runs as today with no record or no facts', () => {
    assert.ok(reuseMismatch({ ...goodFacts(), records: [] }, pk));
    assert.ok(reuseMismatch(null, pk));
    assert.equal(reuseMismatch(goodFacts(), pk), null);
  });
  it('picks the latest record for the tree', () => {
    const f = goodFacts();
    f.records.push({ ...f.records[0], ok: false, finishedAt: '2026-11-04T12:30:00.000Z' });
    assert.ok(reuseMismatch(f, pk));
  });
  it('gatherReuseFacts never throws and reports live git facts', async () => {
    const { gatherReuseFacts } = await import('./pre-push-patch-coverage.mjs');
    const f = gatherReuseFacts(['pipeline-cli']);
    assert.ok(f.tree);
    assert.ok(Array.isArray(f.records));
    assert.ok('pipeline-cli' in f.coverageMtimeMs);
  });
});
