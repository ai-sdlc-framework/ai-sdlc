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

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');

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

try {
  const diff = execSync('git diff --name-only HEAD~1 2>/dev/null || echo ""', {
    encoding: 'utf-8',
    cwd: projectDir,
  }).trim();

  if (!diff) {
    process.exit(0);
  }

  const sourceFiles = diff
    .split('\n')
    .filter(
      (f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'),
    );

  if (sourceFiles.length === 0) {
    process.exit(0);
  }
} catch {
  process.exit(0);
}

// ── Run coverage ─────────────────────────────────────────────────────

try {
  execSync(coverageCmd, {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: maxDurationMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

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
      process.stderr.write(
        `AI-SDLC Coverage: ${coverage}% overall (threshold: ${threshold}%).${detail} Please add tests.\n`,
      );
      process.exit(2);
    }
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
    summary += ' Please fix before stopping.\n';

    process.stderr.write(summary);
    process.exit(2);
  }

  process.exit(0);
}
