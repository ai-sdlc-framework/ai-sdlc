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

const { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { createHash } = require('crypto');
const { homedir } = require('os');

// ── Read stdin ───────────────────────────────────────────────────────

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
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
// Priority: dedicated test:coverage > -- passthrough with turbo awareness

let coverageCmd;

if (hasScript('test:coverage')) {
  // Dedicated script — works with any task runner
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
    coverageCmd = 'pnpm test:coverage';
  } else if (existsSync(join(projectDir, 'yarn.lock'))) {
    coverageCmd = 'yarn test:coverage';
  } else {
    coverageCmd = 'npm run test:coverage';
  }
} else if (usesTaskRunner()) {
  // Turbo/nx detected but no test:coverage script — skip rather than fail.
  // Can't safely pass --coverage through a task runner.
  process.exit(0);
} else if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
  coverageCmd = 'pnpm test -- --coverage';
} else if (existsSync(join(projectDir, 'yarn.lock'))) {
  coverageCmd = 'yarn test --coverage';
} else if (existsSync(join(projectDir, 'package-lock.json'))) {
  coverageCmd = 'npm test -- --coverage';
} else {
  process.exit(0);
}

// ── Apply workspace exclusions ──────────────────────────────────────

if (excludeWorkspaces.length > 0 && coverageCmd.startsWith('pnpm')) {
  // For pnpm workspaces, add --filter to exclude listed packages
  const filters = excludeWorkspaces.map((ws) => `--filter '!${ws}'`).join(' ');
  coverageCmd = coverageCmd.replace('pnpm ', `pnpm ${filters} `);
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
} catch {
  process.exit(0);
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

// ── Run coverage ─────────────────────────────────────────────────────

try {
  execSync(coverageCmd, {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: maxDurationMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Tests passed — clear any prior loop-prevention sentinel so the next
  // genuine failure can wake the model.
  clearSentinel();
  process.exit(0);
} catch (err) {
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
  if (err.killed || (err.signal && err.signal === 'SIGTERM')) {
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
