/**
 * Resource-safety tests for `scripts/check-coverage.sh` (AISDLC-681):
 * process-group reaping, wall-clock timeout, worker ceiling, repo-wide lock.
 *
 * Hermetic: a tiny fixture dir plus a fake `pnpm` on PATH. No real vitest, no
 * real workspace. Every process the tests start is killed in `finally`
 * (script process group + any recorded fake-worker pids).
 *
 * Run with: node --test scripts/check-coverage-resources.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'check-coverage.sh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

function readPids(dir) {
  const f = join(dir, 'worker.pids');
  return existsSync(f) ? readFileSync(f, 'utf-8').split('\n').filter(Boolean).map(Number) : [];
}

describe('check-coverage.sh — resource safety (AISDLC-681)', () => {
  let tmp;
  let bin;
  let lockDir;
  const spawned = []; // child handles to clean up

  const baseEnv = (extra = {}) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (k.startsWith('AI_SDLC_') || k.startsWith('GIT_')) delete env[k];
    }
    return {
      ...env,
      AI_SDLC_WORKSPACE_ROOT: tmp,
      AI_SDLC_COVERAGE_LOCK_DIR: lockDir,
      AI_SDLC_COVERAGE_LOCK_POLL_SEC: '1',
      FAKE_DIR: tmp,
      PATH: `${bin}:${process.env.PATH}`,
      ...extra,
    };
  };

  /** Fake pnpm: records argv, optionally runs a sleeping fake worker for test:coverage. */
  function writeFakePnpm() {
    const script = `#!/usr/bin/env bash
CMD_STR="$*"
if [[ "$CMD_STR" == *"list"*"--json"* ]]; then echo '[]'; exit 0; fi
if [[ "$CMD_STR" == *"test:coverage"* ]]; then
  echo "$CMD_STR" >> "$FAKE_DIR/coverage.args"
  echo "start $$ $(date +%s)" >> "$FAKE_DIR/events.log"
  if [ -n "\${FAKE_COVERAGE_SLEEP:-}" ]; then
    node -e 'require("fs").appendFileSync(process.env.FAKE_DIR+"/worker.pids", process.pid+"\\n"); setInterval(()=>{},1000)' fake-vitest-worker &
    sleep "$FAKE_COVERAGE_SLEEP"
  fi
  echo "end $$ $(date +%s)" >> "$FAKE_DIR/events.log"
  exit 0
fi
exit 0
`;
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'pnpm'), script);
    chmodSync(join(bin, 'pnpm'), 0o755);
  }

  function start(extraEnv = {}) {
    const child = spawn('bash', [SCRIPT], {
      cwd: tmp,
      env: baseEnv(extraEnv),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const done = new Promise((res) => child.on('close', (code, sig) => res({ code, sig })));
    const h = { child, done, output: () => out };
    spawned.push(h);
    return h;
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ai-sdlc-cov-res-')));
    bin = join(tmp, '.fake-bin');
    lockDir = join(tmp, 'main', '.ai-sdlc', 'runtime');
    chmodSync(SCRIPT, 0o755);
    writeFakePnpm();
  });

  afterEach(() => {
    for (const { child } of spawned.splice(0)) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    for (const pid of readPids(tmp)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('passes --maxWorkers=min(4, ncpu/2) to the coverage run by default', async () => {
    const r = await start().done;
    assert.equal(r.code, 0);
    const expected = Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
    const args = readFileSync(join(tmp, 'coverage.args'), 'utf-8');
    assert.match(args, new RegExp(`--maxWorkers=${expected}\\b`));
  });

  it('AI_SDLC_COVERAGE_MAX_WORKERS overrides the ceiling', async () => {
    const r = await start({ AI_SDLC_COVERAGE_MAX_WORKERS: '3' }).done;
    assert.equal(r.code, 0);
    assert.match(readFileSync(join(tmp, 'coverage.args'), 'utf-8'), /--maxWorkers=3\b/);
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    it(`${sig} to the gate leaves no worker alive after 5s`, async () => {
      const h = start({ FAKE_COVERAGE_SLEEP: '120' });
      assert.ok(await waitFor(() => readPids(tmp).length > 0, 15000), 'worker never started');
      const pids = readPids(tmp);
      assert.ok(pids.every(alive), 'workers should be alive before the signal');
      process.kill(h.child.pid, sig);
      assert.ok(
        await waitFor(() => pids.every((p) => !alive(p)), 5000),
        `workers survived ${sig}: ${pids.filter(alive)}`,
      );
      await h.done;
      assert.ok(!existsSync(join(lockDir, 'coverage-gate.lock')), 'lock must be released');
    });
  }

  it('a run exceeding the timeout is killed as a group and fails naming the timeout', async () => {
    const t0 = Date.now();
    const h = start({ FAKE_COVERAGE_SLEEP: '120', AI_SDLC_COVERAGE_TIMEOUT_SEC: '2' });
    const r = await h.done;
    assert.notEqual(r.code, 0);
    assert.match(h.output(), /TIMEOUT after 2s/);
    assert.match(h.output(), /AI_SDLC_COVERAGE_TIMEOUT_SEC/);
    assert.ok(Date.now() - t0 < 20000);
    const pids = readPids(tmp);
    assert.ok(await waitFor(() => pids.every((p) => !alive(p)), 5000), 'worker survived timeout');
  });

  it('two concurrent runs serialise on the lock and the waiter names the holder', async () => {
    const a = start({ FAKE_COVERAGE_SLEEP: '3' });
    assert.ok(await waitFor(() => existsSync(join(tmp, 'events.log')), 15000));
    const b = start();
    const [ra, rb] = await Promise.all([a.done, b.done]);
    assert.equal(ra.code, 0);
    assert.equal(rb.code, 0);
    assert.match(b.output(), /waiting for coverage-gate lock held by pid \d+/);
    const events = readFileSync(join(tmp, 'events.log'), 'utf-8').trim().split('\n');
    assert.deepEqual(
      events.map((e) => e.split(' ')[0]),
      ['start', 'end', 'start', 'end'],
      'gate runs must not interleave',
    );
  });

  it('reclaims a stale lock (dead holder)', async () => {
    const lock = join(lockDir, 'coverage-gate.lock');
    mkdirSync(lock, { recursive: true });
    const host = spawnSync('hostname', { encoding: 'utf-8' }).stdout.trim();
    writeFileSync(join(lock, 'owner'), `999999\t${host}\t/elsewhere\t1\n`);
    const h = start();
    const r = await h.done;
    assert.equal(r.code, 0, h.output());
    assert.match(h.output(), /reclaiming stale lock/);
  });

  it('reclaims a lock older than the timeout even when the holder pid is alive', async () => {
    const lock = join(lockDir, 'coverage-gate.lock');
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'owner'), `${process.pid}\tother-host\t/elsewhere\t1\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const h = start({ AI_SDLC_COVERAGE_TIMEOUT_SEC: '5' });
    const r = await h.done;
    assert.equal(r.code, 0, h.output());
    assert.match(h.output(), /reclaiming stale lock/);
  });

  it('refuses a symlinked lock path', async () => {
    mkdirSync(lockDir, { recursive: true });
    const target = join(tmp, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, join(lockDir, 'coverage-gate.lock'));
    const h = start();
    const r = await h.done;
    assert.notEqual(r.code, 0);
    assert.match(h.output(), /is a symlink/);
    assert.ok(existsSync(target), 'symlink target must be untouched');
  });
});
