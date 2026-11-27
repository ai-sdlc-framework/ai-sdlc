/**
 * AISDLC-1460: session-start knowledge sync (DEC-0444 option a).
 * Run with: node --test ai-sdlc-plugin/hooks/lib/knowledge-sync.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK_SH = join(here, '..', 'context-surface.sh');
const require = createRequire(import.meta.url);
const {
  knowledgeSessionSync,
  parseKnowledgeSettings,
  formatStatus,
  LAUNCH_STAMP,
} = require('./knowledge-sync.js');
const { sessionStart } = require('./context-surface.js');

const CLI = { cmd: 'cli-context', pre: [] };
const STATUS = {
  ok: true,
  supported: true,
  queued: 2,
  rejected: 1,
  lastSyncAt: '2026-11-27T10:00:00.000Z',
};

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'knowledge-sync-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

function project(contextYaml) {
  const p = mkdtempSync(join(dir, 'proj-'));
  if (contextYaml !== undefined) {
    mkdirSync(join(p, '.ai-sdlc'));
    writeFileSync(join(p, '.ai-sdlc', 'context.yaml'), contextYaml);
  }
  return p;
}

function fakes(statusOut = STATUS, { statusRes } = {}) {
  const calls = { spawn: [], spawnSync: [] };
  return {
    calls,
    deps: {
      spawn(cmd, args, opts) {
        calls.spawn.push({ cmd, args, opts });
        return { on() {}, unref() {} };
      },
      spawnSync(cmd, args, opts) {
        calls.spawnSync.push({ cmd, args, opts });
        return statusRes || { status: 0, stdout: `${JSON.stringify(statusOut)}\n` };
      },
    },
  };
}

const REMOTE = 'knowledge:\n  backend: remote\n  backendModule: "@example/knowledge-remote"\n';

describe('parseKnowledgeSettings', () => {
  it('defaults to files and 15 minutes', () => {
    assert.deepEqual(parseKnowledgeSettings(''), { backend: 'files', syncIntervalMinutes: 15 });
  });
  it('reads backend and syncIntervalMinutes from the knowledge block only', () => {
    const s = parseKnowledgeSettings(
      'other:\n  backend: nope\nknowledge:\n  # comment\n  backend: "remote" # trailing\n  syncIntervalMinutes: 5\n  remote:\n    backend: nested\n',
    );
    assert.deepEqual(s, { backend: 'remote', syncIntervalMinutes: 5 });
  });
  it('ignores an invalid interval', () => {
    assert.equal(
      parseKnowledgeSettings('knowledge:\n  syncIntervalMinutes: soon\n').syncIntervalMinutes,
      15,
    );
    assert.equal(
      parseKnowledgeSettings('knowledge:\n  syncIntervalMinutes: -1\n').syncIntervalMinutes,
      15,
    );
  });
});

describe('knowledgeSessionSync', () => {
  it('non-files backend: one detached sync, then debounced inside the interval (AC1)', () => {
    const p = project(REMOTE);
    const f = fakes();
    knowledgeSessionSync(p, CLI, f.deps);
    assert.equal(f.calls.spawn.length, 1);
    const { args, opts } = f.calls.spawn[0];
    assert.deepEqual(args, ['sync', '--project-dir', p]);
    assert.equal(opts.detached, true);
    assert.equal(opts.stdio, 'ignore');
    assert.ok(existsSync(join(p, LAUNCH_STAMP)));
    knowledgeSessionSync(p, CLI, f.deps);
    assert.equal(f.calls.spawn.length, 1, 'second start inside the interval does not spawn');
    assert.equal(f.calls.spawnSync.length, 2, 'status is still read on every start');
  });

  it('launches again once the interval has passed (AC1)', () => {
    const p = project('knowledge:\n  backend: remote\n  syncIntervalMinutes: 1\n');
    const f = fakes();
    knowledgeSessionSync(p, CLI, f.deps);
    const old = new Date(Date.now() - 2 * 60_000);
    utimesSync(join(p, LAUNCH_STAMP), old, old);
    knowledgeSessionSync(p, CLI, f.deps);
    assert.equal(f.calls.spawn.length, 2);
  });

  it('line shows queued, rejected and last sync time; error when present (AC2)', () => {
    const p = project(REMOTE);
    assert.equal(
      knowledgeSessionSync(p, CLI, fakes().deps),
      'knowledge sync: queued 2, rejected 1, last sync 2026-11-27T10:00:00.000Z',
    );
    const withError = knowledgeSessionSync(p, CLI, fakes({ ...STATUS, lastError: 'boom' }).deps);
    assert.equal(
      withError,
      'knowledge sync: queued 2, rejected 1, last sync 2026-11-27T10:00:00.000Z, last error: boom',
    );
    assert.equal(
      formatStatus({ queued: 0, rejected: 0 }),
      'knowledge sync: queued 0, rejected 0, last sync never',
    );
  });

  it('files backend (default or explicit): no spawn, no output (AC3)', () => {
    for (const yaml of [undefined, 'knowledge:\n  backend: files\n']) {
      const p = project(yaml);
      const f = fakes();
      assert.equal(knowledgeSessionSync(p, CLI, f.deps), null);
      assert.equal(f.calls.spawn.length + f.calls.spawnSync.length, 0);
      assert.equal(existsSync(join(p, LAUNCH_STAMP)), false);
    }
  });

  it('a backend without status support prints nothing', () => {
    const p = project(REMOTE);
    assert.equal(knowledgeSessionSync(p, CLI, fakes({ ok: true, supported: false }).deps), null);
  });

  it('failing status or spawn: one line, never throws (AC4)', () => {
    const p = project(REMOTE);
    const failing = fakes(null, { statusRes: { status: 1, stdout: '', stderr: 'x' } });
    assert.equal(knowledgeSessionSync(p, CLI, failing.deps), 'knowledge sync: status unavailable');
    const garbage = fakes(null, { statusRes: { status: 0, stdout: 'not json' } });
    assert.equal(knowledgeSessionSync(p, CLI, garbage.deps), 'knowledge sync: status unavailable');
    const throwing = {
      spawn() {
        throw new Error('spawn failed');
      },
      spawnSync() {
        throw new Error('nope');
      },
    };
    rmSync(join(p, LAUNCH_STAMP), { force: true });
    assert.equal(knowledgeSessionSync(p, CLI, throwing), 'knowledge sync: status unavailable');
  });
});

describe('sessionStart hook output', () => {
  it('adds the line as systemMessage alongside the retrieval slice', () => {
    const p = project(REMOTE);
    const deps = {
      spawn: () => ({ on() {}, unref() {} }),
      spawnSync: (cmd, args) =>
        args[0] === 'query'
          ? { status: 0, stdout: JSON.stringify({ results: [{ id: 'DEC-1', score: 1 }] }) }
          : { status: 0, stdout: JSON.stringify(STATUS) },
    };
    const env = { AI_SDLC_CONTEXT_ROLE: 'planner', AI_SDLC_CONTEXT_CLI: 'cli-context' };
    const out = sessionStart({ session_id: 's' }, env, p, deps);
    assert.match(out.systemMessage, /^knowledge sync: queued 2/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  });

  it('files backend leaves the hook output unchanged', () => {
    const p = project();
    const deps = { spawnSync: () => ({ status: 0, stdout: '{"results":[]}' }) };
    const env = { AI_SDLC_CONTEXT_ROLE: 'planner', AI_SDLC_CONTEXT_CLI: 'cli-context' };
    assert.equal(sessionStart({}, env, p, deps), null);
  });

  it('end to end: detached sync runs, status line printed, failing CLI still exits 0', async () => {
    const p = project(REMOTE);
    const log = join(p, 'args.log');
    const stub = join(dir, `stub-${Date.now()}.sh`);
    writeFileSync(
      stub,
      `#!/bin/bash\necho "$1" >> "${log}"\nif [ "$1" = status ]; then echo '${JSON.stringify(STATUS)}'; else echo '{"results":[]}'; fi\n`,
    );
    chmodSync(stub, 0o755);
    const env = {
      ...process.env,
      AI_SDLC_CONTEXT_ROLE: 'planner',
      CLAUDE_PROJECT_DIR: p,
      AI_SDLC_CONTEXT_CLI: stub,
    };
    delete env.AI_SDLC_ACTIVE_TASK_ID;
    const res = spawnSync('bash', [HOOK_SH, 'sessionStart'], {
      input: '{}',
      encoding: 'utf-8',
      env,
    });
    assert.equal(res.status, 0);
    assert.match(JSON.parse(res.stdout).systemMessage, /queued 2, rejected 1/);
    for (let i = 0; i < 50 && !readFileSync(log, 'utf-8').includes('sync'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(readFileSync(log, 'utf-8'), /^sync$/m);

    const bad = join(dir, `bad-${Date.now()}.sh`);
    writeFileSync(bad, '#!/bin/bash\necho broken >&2\nexit 3\n');
    chmodSync(bad, 0o755);
    const p2 = project(REMOTE);
    const res2 = spawnSync('bash', [HOOK_SH, 'sessionStart'], {
      input: '{}',
      encoding: 'utf-8',
      env: { ...env, CLAUDE_PROJECT_DIR: p2, AI_SDLC_CONTEXT_CLI: bad },
    });
    assert.equal(res2.status, 0);
    assert.equal(JSON.parse(res2.stdout).systemMessage, 'knowledge sync: status unavailable');
  });
});
