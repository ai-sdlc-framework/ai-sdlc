/**
 * AI-SDLC Deferred Coverage Check (asyncRewake Stop Hook)
 *
 * Runs the test suite with coverage after the agent stops.
 * If coverage is below the configured threshold, exits with code 2
 * which wakes the model via Claude Code's asyncRewake mechanism.
 *
 * Exit codes:
 *   0 = coverage OK, no coverage tool available, or skipped
 *   2 = coverage below threshold (blocking — wakes the model)
 */

const {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  openSync,
  writeSync,
  closeSync,
  statSync,
  rmdirSync,
  realpathSync,
} = require('fs');
const { join, dirname, resolve, sep } = require('path');
const { execSync, spawn } = require('child_process');
const { createHash } = require('crypto');
const { homedir, tmpdir } = require('os');

// ── Env skip (AISDLC-685) — before reading stdin or spawning anything ─

if (process.env.AI_SDLC_SKIP_DEFERRED_COVERAGE === '1') {
  process.exit(0);
}

// ── Read stdin ───────────────────────────────────────────────────────
// fd 0 (not /dev/stdin) so this also works on Linux when stdin is a pipe.

let input;
try {
  const raw = readFileSync(0, 'utf-8');
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// ── Find project root ────────────────────────────────────────────────

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  (() => {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    } catch {
      return process.cwd();
    }
  })();

// ── Helpers ──────────────────────────────────────────────────────────

function readPkg() {
  try {
    return JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function hasScript(name) {
  const pkg = readPkg();
  return !!(pkg.scripts && pkg.scripts[name]);
}

function hasDep(name) {
  const pkg = readPkg();
  return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function usesTaskRunner() {
  return existsSync(join(projectDir, 'turbo.json')) || existsSync(join(projectDir, 'nx.json'));
}

// ── Load coverage config (.ai-sdlc/coverage-config.yaml) ────────────

let coverageConfig = {};
try {
  const configPath = join(projectDir, '.ai-sdlc', 'coverage-config.yaml');
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    // Lightweight YAML parse for simple key: value and list fields
    const excludeMatch = raw.match(/excludeWorkspaces:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (excludeMatch) {
      coverageConfig.excludeWorkspaces = excludeMatch[1]
        .split('\n')
        .map((l) => l.replace(/^\s+-\s+/, '').trim())
        .filter(Boolean);
    }
    const timeoutMatch = raw.match(/maxDurationMs:\s*(\d+)/);
    if (timeoutMatch) {
      coverageConfig.maxDurationMs = parseInt(timeoutMatch[1], 10);
    }
  }
} catch {
  // Non-critical — use defaults
}

const maxDurationMs = coverageConfig.maxDurationMs || 120000;
const excludeWorkspaces = coverageConfig.excludeWorkspaces || [];

// ── Check if coverage provider is available ─────────────────────────

if (hasDep('vitest') && !hasDep('@vitest/coverage-v8') && !hasDep('@vitest/coverage-istanbul')) {
  // Coverage provider not installed — skip gracefully
  process.exit(0);
}

// ── Detect coverage command ─────────────────────────────────────────
// Priority: dedicated test:coverage > -- passthrough with turbo awareness.
// Only used when the dirty files belong to the root package of a
// single-package (non-workspace) repository.

function detectRootCoverageCmd() {
  let cmd;
  if (hasScript('test:coverage')) {
    // Dedicated script — works with any task runner
    if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
      cmd = 'pnpm test:coverage';
    } else if (existsSync(join(projectDir, 'yarn.lock'))) {
      cmd = 'yarn test:coverage';
    } else {
      cmd = 'npm run test:coverage';
    }
  } else if (usesTaskRunner()) {
    // Turbo/nx detected but no test:coverage script — skip rather than fail.
    // Can't safely pass --coverage through a task runner.
    return null;
  } else if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
    cmd = 'pnpm test -- --coverage';
  } else if (existsSync(join(projectDir, 'yarn.lock'))) {
    cmd = 'yarn test --coverage';
  } else if (existsSync(join(projectDir, 'package-lock.json'))) {
    cmd = 'npm test -- --coverage';
  } else {
    return null;
  }

  // Apply workspace exclusions
  if (excludeWorkspaces.length > 0 && cmd.startsWith('pnpm')) {
    const filters = excludeWorkspaces.map((ws) => `--filter '!${ws}'`).join(' ');
    cmd = cmd.replace('pnpm ', `pnpm ${filters} `);
  }
  return cmd;
}

function isWorkspaceRoot() {
  return existsSync(join(projectDir, 'pnpm-workspace.yaml')) || !!readPkg().workspaces;
}

// Nearest ancestor directory (below projectDir) whose package.json has a
// "name"; null => the file belongs to the root package (or no package).
const realProjectDir = (() => {
  try {
    return realpathSync(projectDir);
  } catch {
    return projectDir;
  }
})();

function packageForFile(absFile) {
  let dir = dirname(absFile);
  while (dir.startsWith(realProjectDir + sep)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
      if (pkg && typeof pkg.name === 'string' && pkg.name) {
        return {
          name: pkg.name,
          dir,
          hasCoverage: !!(pkg.scripts && pkg.scripts['test:coverage']),
        };
      }
    } catch {
      // no / unreadable package.json — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function pkgManager() {
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function shq(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

// Returns the coverage command, or null to skip (never workspace-wide).
function buildCoverageCmd(sourceFiles) {
  let top;
  try {
    top = realpathSync(
      execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', cwd: projectDir }).trim(),
    );
  } catch {
    return null;
  }
  const root = realProjectDir;
  const packages = new Map();
  let touchesRoot = false;
  for (const f of sourceFiles) {
    const abs = resolve(top, f);
    if (abs !== root && !abs.startsWith(root + sep)) continue; // outside project dir
    const pkg = packageForFile(abs);
    if (pkg) packages.set(pkg.name, pkg);
    else touchesRoot = true;
  }
  if (packages.size === 0 && !touchesRoot) return null;

  if (touchesRoot) {
    // Root package files. In a workspace root the root command is
    // workspace-wide, so refuse; in a single-package repo run it as today.
    if (isWorkspaceRoot()) return null;
    return detectRootCoverageCmd();
  }

  const names = [...packages.values()]
    .filter((p) => p.hasCoverage && !excludeWorkspaces.includes(p.name))
    .map((p) => p.name);
  if (names.length === 0) return null;
  const pm = pkgManager();
  if (pm === 'pnpm') {
    return `pnpm ${names.map((n) => `--filter ${shq(n)}`).join(' ')} test:coverage`;
  }
  if (pm === 'yarn') {
    return names.map((n) => `yarn workspace ${shq(n)} test:coverage`).join(' && ');
  }
  return `npm run test:coverage ${names.map((n) => `--workspace ${shq(n)}`).join(' ')}`;
}

// ── Check if any source code was modified ───────────────────────────
//
// Use `git status --porcelain` (uncommitted changes) instead of
// `git diff HEAD~1` (LAST commit's diff). Why: this hook fires on Stop
// to detect if THIS SESSION introduced an uncovered change. If we look at
// HEAD~1, we'd fire on every session inside this repo regardless of
// whether the model touched source — which produces false positives
// whenever Claude is doing non-code work (docs, planning, application
// materials, etc.) inside an unrelated cwd that happens to be a git repo
// with a recent code commit.
//
// `git status --porcelain` shows what's uncommitted right now — i.e. the
// concrete changes the model made (or chose not to make) this session.

let coverageCmd;
try {
  // `--untracked-files=all` expands untracked DIRECTORIES into the individual
  // files inside them. Without this flag, an untracked dir like `src/new/`
  // reports as a single entry `src/new/` and the `.ts` filter would miss
  // every new source file inside (code-reviewer-codex round-1 finding).
  const status = execSync('git status --porcelain --untracked-files=all 2>/dev/null || echo ""', {
    encoding: 'utf-8',
    cwd: projectDir,
  }).trim();

  if (!status) {
    process.exit(0);
  }

  // Parse `git status --porcelain` lines: `XY <path>` (3 leading chars =
  // status code + space). Renamed entries are `R  old -> new`; we want the
  // NEW path (post-rename) for the source-file check. Quoted paths
  // (`"path with space"`) are stripped of quotes.
  const sourceFiles = status
    .split('\n')
    .map((line) => {
      let path = line.slice(3).trim();
      // Rename: `old -> new` — pick the new path
      const arrowIdx = path.indexOf(' -> ');
      if (arrowIdx !== -1) {
        path = path.slice(arrowIdx + 4).trim();
      }
      // Strip surrounding quotes (porcelain v1 quotes paths with spaces/unicode)
      if (path.startsWith('"') && path.endsWith('"')) {
        path = path.slice(1, -1);
      }
      return path;
    })
    .filter(
      (f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'),
    );

  if (sourceFiles.length === 0) {
    process.exit(0);
  }
  coverageCmd = buildCoverageCmd(sourceFiles);
} catch {
  process.exit(0);
}
if (!coverageCmd) {
  process.exit(0); // mapping failed / nothing runnable — skip, never workspace-wide
}

// ── Loop-prevention sentinel ────────────────────────────────────────
//
// If a previous Stop-hook invocation already reported the SAME failure
// (same HEAD SHA + same failure summary), do NOT exit 2 again. Otherwise
// the asyncRewake fires forever: model wakes → cannot fix the failure
// (test is genuinely broken, wrong project, etc.) → ends turn → hook
// fires → exit 2 → wake → ... infinite loop.
//
// Sentinel layout:
//   ~/.claude/ai-sdlc/coverage-failure-<repo-hash>.json
//   {"head": "<sha>", "fingerprint": "<sha256(stderr+stdout-summary)>"}
//
// Per-repo (hash of projectDir) so multiple repos don't collide. Cleared
// on test success. Compared against on subsequent failures — match → exit 0.

const sentinelDir = join(homedir(), '.claude', 'ai-sdlc');
const repoHash = createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
const sentinelPath = join(sentinelDir, `coverage-failure-${repoHash}.json`);

function currentHead() {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      cwd: projectDir,
    }).trim();
  } catch {
    return '';
  }
}

function readSentinel() {
  try {
    return JSON.parse(readFileSync(sentinelPath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeSentinel(head, fingerprint) {
  try {
    if (!existsSync(sentinelDir)) {
      mkdirSync(sentinelDir, { recursive: true });
    }
    writeFileSync(sentinelPath, JSON.stringify({ head, fingerprint }), { mode: 0o600 });
  } catch {
    // Sentinel-write failure is non-fatal — worst case we re-fire once.
  }
}

function clearSentinel() {
  try {
    if (existsSync(sentinelPath)) {
      unlinkSync(sentinelPath);
    }
  } catch {
    // Non-fatal.
  }
}

function failureFingerprint(message) {
  return createHash('sha256').update(message).digest('hex').slice(0, 16);
}

// ── Single-flight lock (machine-wide) ───────────────────────────────
//
// One coverage run per machine at a time: several concurrent sessions each
// running vitest drove the machine to load 91 (AISDLC-685). The lockfile
// holds {pid, startedAt}; a live holder => exit 0 silently.

const LOCK_GRACE_MS = 30000;
const lockDir = process.env.AI_SDLC_COVERAGE_LOCK_DIR || tmpdir();
const lockPath = join(lockDir, 'ai-sdlc-deferred-coverage.lock');
const takeoverGuard = lockPath + '.takeover';

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!e && e.code === 'EPERM';
  }
}

function lockIsStale() {
  const info = readLock();
  if (!info || typeof info.pid !== 'number' || typeof info.startedAt !== 'number') {
    // Empty / partially written / corrupt: stale only once it has aged.
    try {
      return Date.now() - statSync(lockPath).mtimeMs > 10000;
    } catch {
      return true; // vanished
    }
  }
  if (!pidAlive(info.pid)) return true;
  // pid reuse guard: no coverage run legitimately lasts longer than this.
  return Date.now() - info.startedAt > maxDurationMs + LOCK_GRACE_MS;
}

function tryCreateLock() {
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  } finally {
    closeSync(fd);
  }
  return true;
}

function acquireLock() {
  try {
    mkdirSync(lockDir, { recursive: true });
    if (tryCreateLock()) return true;
    if (!lockIsStale()) return false;
    // Stale: take over under a mkdir guard so that of N hooks that all saw
    // the same stale lock exactly one removes + re-creates it.
    try {
      mkdirSync(takeoverGuard);
    } catch (e) {
      if (e && e.code === 'EEXIST') {
        try {
          if (Date.now() - statSync(takeoverGuard).mtimeMs > 10000) rmdirSync(takeoverGuard);
        } catch {
          // ignore
        }
      }
      return false;
    }
    try {
      if (!existsSync(lockPath) || lockIsStale()) {
        try {
          unlinkSync(lockPath);
        } catch {
          // already gone
        }
        return tryCreateLock();
      }
      return false;
    } finally {
      try {
        rmdirSync(takeoverGuard);
      } catch {
        // ignore
      }
    }
  } catch {
    return false; // cannot lock => do not run (safe default)
  }
}

function releaseLock() {
  try {
    const info = readLock();
    if (info && info.pid === process.pid) unlinkSync(lockPath);
  } catch {
    // non-fatal
  }
}

if (!acquireLock()) {
  process.exit(0);
}

// ── Process-group lifecycle ─────────────────────────────────────────

let child = null;

function killGroup() {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // group already gone
  }
}

function cleanup() {
  killGroup();
  releaseLock();
}

process.on('exit', cleanup);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => process.exit(0));
}
process.on('uncaughtException', (e) => {
  process.stderr.write(`AI-SDLC Coverage: hook error: ${e && e.stack}\n`);
  process.exit(0);
});

// ── Run coverage ─────────────────────────────────────────────────────

const MAX_BUF = 4 * 1024 * 1024;
function appendBounded(prev, chunk) {
  const next = prev + chunk.toString('utf-8');
  return next.length > MAX_BUF ? next.slice(next.length - MAX_BUF) : next;
}

let finished = false;
function finish(err, stdout, stderr) {
  if (finished) return;
  finished = true;
  clearTimeout(timeoutTimer);
  killGroup(); // no child may outlive the hook
  if (err === null) {
    // Tests passed — clear any prior loop-prevention sentinel so the next
    // genuine failure can wake the model.
    clearSentinel();
    process.exit(0);
  }
  err.stdout = stdout;
  err.stderr = stderr;
  handleFailure(err);
}

let outBuf = '';
let errBuf = '';
let exitInfo = null;

child = spawn(coverageCmd, {
  cwd: projectDir,
  shell: true,
  detached: true, // own process group so the whole tree can be reaped
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, AI_SDLC_VITEST_MAX_WORKERS: '2' },
});

const timeoutTimer = setTimeout(() => {
  finished = true;
  killGroup();
  process.exit(0); // timeout advisory: exit gracefully
}, maxDurationMs);

child.stdout.on('data', (c) => {
  outBuf = appendBounded(outBuf, c);
});
child.stderr.on('data', (c) => {
  errBuf = appendBounded(errBuf, c);
});
child.on('error', () => {
  finished = true;
  process.exit(0);
});
function settle() {
  if (!exitInfo) return;
  const { code, signal } = exitInfo;
  if (code === 0) return finish(null, outBuf, errBuf);
  const e = new Error('Command failed');
  e.status = code;
  e.signal = signal;
  finish(e, outBuf, errBuf);
}
child.on('exit', (code, signal) => {
  exitInfo = { code, signal };
  // Orphaned grandchildren may hold the pipes open; give 'close' a moment,
  // then settle with what we have (finish() kills the group).
  setTimeout(settle, 1000).unref();
});
child.on('close', (code, signal) => {
  exitInfo = exitInfo || { code, signal };
  settle();
});

function handleFailure(err) {
  const stderr = err.stderr || '';
  const stdout = err.stdout || '';
  const combined = stderr + stdout;

  // ── Missing coverage provider — skip gracefully ────────────
  const missingProviderPatterns = [
    /Cannot find package '@vitest\/coverage/i,
    /Cannot find module '@vitest\/coverage/i,
    /Failed to load coverage provider/i,
    /Failed to load url.*@vitest\/coverage/i,
    /coverage provider.*not found/i,
    /ERR_MODULE_NOT_FOUND.*coverage/i,
    /unexpected argument ['"]?--coverage/i,
  ];

  if (missingProviderPatterns.some((p) => p.test(combined))) {
    process.exit(0);
  }

  // ── Timeout — exit gracefully with advisory ────────────────
  if (err.signal === 'SIGTERM') {
    process.exit(0);
  }

  // ── Parse coverage results ─────────────────────────────────
  const coverageMatch = stdout.match(/All files\s*\|\s*([\d.]+)/);
  const threshold = 80;

  if (coverageMatch) {
    const coverage = parseFloat(coverageMatch[1]);
    if (coverage < threshold) {
      // Identify which packages are below threshold
      const packageMatch = stdout.match(/^(\S+)\s*\|\s*([\d.]+)/gm);
      const lowPackages = [];
      if (packageMatch) {
        for (const line of packageMatch) {
          const m = line.match(/^(\S+)\s*\|\s*([\d.]+)/);
          if (m && parseFloat(m[2]) < threshold) {
            lowPackages.push(`${m[1]} (${m[2]}%)`);
          }
        }
      }

      const detail = lowPackages.length > 0 ? ` Low coverage in: ${lowPackages.join(', ')}.` : '';
      const message = `AI-SDLC Coverage: ${coverage}% overall (threshold: ${threshold}%).${detail} Please add tests.`;

      // Loop prevention: only exit 2 (wake the model) if this is a NEW
      // failure. If we already reported the same coverage% on the same
      // HEAD in a prior turn, exit 0 — no point re-asking the model to
      // fix something it couldn't fix last time.
      const head = currentHead();
      const fingerprint = failureFingerprint(message);
      const prior = readSentinel();
      if (prior && prior.head === head && prior.fingerprint === fingerprint) {
        // Same failure as last invocation — don't loop.
        process.stderr.write(
          `AI-SDLC Coverage: same failure as previous turn (${coverage}% on ${head.slice(0, 8)}); not waking. Run \`pnpm test:coverage\` to investigate or set AI_SDLC_SKIP_COVERAGE_GATE=1.\n`,
        );
        process.exit(0);
      }
      writeSentinel(head, fingerprint);
      process.stderr.write(message + '\n');
      process.exit(2);
    }
    // Coverage parsed and is at/above threshold — clear sentinel.
    clearSentinel();
    process.exit(0);
  }

  // ── Test failures — one-line actionable message ────────────
  if (err.status !== 0) {
    // Try to extract the failing package/test name
    const failedSuite = combined.match(/FAIL\s+(\S+)/);
    const failedPkg = combined.match(/ERR_PNPM.*?(\S+@\S+)/);
    const failCount = combined.match(/(\d+)\s+failed/);

    let summary = 'AI-SDLC Coverage: Tests failed.';
    if (failedPkg) {
      summary = `AI-SDLC Coverage: Tests failed in ${failedPkg[1]}.`;
    } else if (failedSuite) {
      summary = `AI-SDLC Coverage: Test failed: ${failedSuite[1]}.`;
    }
    if (failCount) {
      summary += ` ${failCount[1]} test(s) failing.`;
    }
    summary += ' Please fix before stopping.';

    // Loop prevention: dedup against the prior sentinel.
    const head = currentHead();
    const fingerprint = failureFingerprint(summary);
    const prior = readSentinel();
    if (prior && prior.head === head && prior.fingerprint === fingerprint) {
      process.stderr.write(
        `AI-SDLC Coverage: same test failure as previous turn (${head.slice(0, 8)}); not waking. Run \`pnpm test\` to investigate or set AI_SDLC_SKIP_COVERAGE_GATE=1.\n`,
      );
      process.exit(0);
    }
    writeSentinel(head, fingerprint);
    process.stderr.write(summary + '\n');
    process.exit(2);
  }

  process.exit(0);
}
