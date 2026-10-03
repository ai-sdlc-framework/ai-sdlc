/**
 * AISDLC-681: vitest workers die with their parent, workspace-wide.
 *
 * Starts a real (tiny) vitest run through the shared preset (`vitest.shared.mjs`),
 * SIGKILLs the vitest main process mid-test, and asserts the pool worker is
 * gone within 5 seconds. Fixture lives in a tmp dir; the vitest binary is
 * borrowed from the orchestrator package (skipped when deps are not installed).
 *
 * Run with: node --test scripts/vitest-parent-death.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SHARED = join(REPO, 'vitest.shared.mjs');

let vitestBin;
try {
  const pkg = createRequire(join(REPO, 'orchestrator', 'package.json')).resolve(
    'vitest/package.json',
  );
  vitestBin = join(dirname(pkg), 'vitest.mjs');
} catch {
  vitestBin = undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

describe('shared vitest preset — resolveMaxWorkers', () => {
  it('defaults to min(4, ncpu/2), floors at 1, honours AI_SDLC_VITEST_MAX_WORKERS', async () => {
    const { resolveMaxWorkers } = await import(pathToFileURL(SHARED).href);
    assert.equal(resolveMaxWorkers({}, 16), 4);
    assert.equal(resolveMaxWorkers({}, 4), 2);
    assert.equal(resolveMaxWorkers({}, 1), 1);
    assert.equal(resolveMaxWorkers({ AI_SDLC_VITEST_MAX_WORKERS: '3' }, 16), 3);
    assert.equal(resolveMaxWorkers({ AI_SDLC_VITEST_MAX_WORKERS: 'abc' }, 16), 4);
    // The gate's own variable does not feed the preset.
    assert.equal(resolveMaxWorkers({ AI_SDLC_COVERAGE_MAX_WORKERS: '1' }, 16), 4);
  });
});

describe('parent-watch setup file', () => {
  it('exits an orphaned process within 6s of its parent dying', async () => {
    const setup = join(REPO, 'vitest.parent-watch.setup.mjs');
    // The shell backgrounds a node that loads the setup (while the shell is still
    // alive, so the watchdog records it as parent), prints the pid, then exits.
    const r = spawnSync(
      'bash',
      [
        '-c',
        'node --import "$1" -e "setInterval(()=>{},1000)" >/dev/null 2>&1 & pid=$!; sleep 1; echo $pid',
        'bash',
        pathToFileURL(setup).href,
      ],
      { encoding: 'utf-8' },
    );
    const pid = Number(r.stdout.trim());
    try {
      assert.ok(Number.isInteger(pid) && pid > 1);
      assert.ok(await waitFor(() => !alive(pid), 6000), 'orphan survived its parent');
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  });
});

describe('vitest worker dies with its parent (SIGKILL)', { skip: !vitestBin }, () => {
  let tmp;
  let main;
  const pidFile = () => join(tmp, 'worker.pid');

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ai-sdlc-vitest-parent-')));
    writeFileSync(
      join(tmp, 'vitest.config.mjs'),
      `import { sharedTestConfig } from ${JSON.stringify(SHARED)};
export default { test: { ...sharedTestConfig, globals: true, include: ['sleep.test.mjs'] } };
`,
    );
    writeFileSync(
      join(tmp, 'sleep.test.mjs'),
      `import { writeFileSync } from 'node:fs';
test('sleeps', async () => {
  writeFileSync(${JSON.stringify(join(tmp, 'worker.pid'))}, String(process.pid));
  await new Promise((r) => setTimeout(r, 120000));
}, 130000);
`,
    );
  });

  afterEach(() => {
    if (main) {
      try {
        process.kill(-main.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (existsSync(pidFile())) {
      try {
        process.kill(Number(readFileSync(pidFile(), 'utf-8')), 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  // AISDLC-685: vitest swaps process.exit inside workers for a throwing stub,
  // so the watchdog must SIGKILL itself. The test file keeps the worker BUSY
  // (CPU-bound chunks that yield to the event loop via setImmediate). It must
  // yield: a fully synchronous spin blocks the event loop, so no timer
  // (including the 2 s watchdog interval) could ever fire in that thread.
  it('kills a worker running a busy test file after the parent is SIGKILLed', async () => {
    writeFileSync(
      join(tmp, 'sleep.test.mjs'),
      `import { writeFileSync } from 'node:fs';
test('busy', async () => {
  writeFileSync(${JSON.stringify(join(tmp, 'worker.pid'))}, String(process.pid));
  const end = Date.now() + 120000;
  let x = 0;
  while (Date.now() < end) {
    const chunk = Date.now() + 50;
    while (Date.now() < chunk) x += Math.sqrt(x + 1);
    await new Promise((r) => setImmediate(r));
  }
}, 130000);
`,
    );
    main = spawn(
      process.execPath,
      [vitestBin, 'run', '--root', tmp, '--config', join(tmp, 'vitest.config.mjs')],
      {
        cwd: tmp,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, AI_SDLC_VITEST_MAX_WORKERS: '1' },
      },
    );
    assert.ok(await waitFor(() => existsSync(pidFile()), 60000), 'worker never started');
    const workerPid = Number(readFileSync(pidFile(), 'utf-8'));
    assert.ok(alive(workerPid));
    process.kill(main.pid, 'SIGKILL');
    assert.ok(await waitFor(() => !alive(workerPid), 5000), 'busy worker outlived its parent');
  });

  it('leaves no worker alive 5s after the parent is SIGKILLed', async () => {
    main = spawn(
      process.execPath,
      [vitestBin, 'run', '--root', tmp, '--config', join(tmp, 'vitest.config.mjs')],
      {
        cwd: tmp,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, AI_SDLC_VITEST_MAX_WORKERS: '1' },
      },
    );
    assert.ok(await waitFor(() => existsSync(pidFile()), 60000), 'worker never started');
    const workerPid = Number(readFileSync(pidFile(), 'utf-8'));
    assert.ok(alive(workerPid));
    process.kill(main.pid, 'SIGKILL');
    assert.ok(await waitFor(() => !alive(workerPid), 5000), 'worker outlived its SIGKILLed parent');
  });
});
