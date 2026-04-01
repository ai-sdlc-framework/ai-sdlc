/**
 * AI-SDLC Deferred Coverage Check (asyncRewake Stop Hook)
 *
 * Runs the test suite with coverage after the agent stops.
 * If coverage is below the configured threshold, exits with code 2
 * which wakes the model via Claude Code's asyncRewake mechanism.
 *
 * Exit codes:
 *   0 = coverage OK or no coverage tool available
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

// ── Detect package manager and coverage command ──────────────────────

let coverageCmd;
if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
  coverageCmd = 'pnpm test -- --coverage --reporter=json';
} else if (existsSync(join(projectDir, 'yarn.lock'))) {
  coverageCmd = 'yarn test --coverage --json';
} else if (existsSync(join(projectDir, 'package-lock.json'))) {
  coverageCmd = 'npm test -- --coverage --json';
} else {
  // No recognized package manager — skip
  process.exit(0);
}

// ── Check if any code was modified in this session ───────────────────

try {
  const diff = execSync('git diff --name-only HEAD~1 2>/dev/null || echo ""', {
    encoding: 'utf-8',
    cwd: projectDir,
  }).trim();

  if (!diff) {
    // No changes to check coverage for
    process.exit(0);
  }

  // Only check if source files were modified (not just config/docs)
  const sourceFiles = diff
    .split('\n')
    .filter(
      (f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'),
    );

  if (sourceFiles.length === 0) {
    process.exit(0);
  }
} catch {
  // Can't detect changes — skip
  process.exit(0);
}

// ── Run coverage ─────────────────────────────────────────────────────

try {
  execSync(coverageCmd, {
    cwd: projectDir,
    encoding: 'utf-8',
    timeout: 120000, // 2 min max
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Tests passed — coverage is acceptable
  process.exit(0);
} catch (err) {
  // Tests failed or coverage below threshold
  const stderr = err.stderr || '';
  const stdout = err.stdout || '';

  // Look for coverage summary in output
  const coverageMatch = stdout.match(/All files\s*\|\s*([\d.]+)/);
  const threshold = 80;

  if (coverageMatch) {
    const coverage = parseFloat(coverageMatch[1]);
    if (coverage < threshold) {
      process.stderr.write(
        `AI-SDLC Coverage Check: Overall coverage is ${coverage}% (threshold: ${threshold}%).\n` +
          `Please add tests to improve coverage before stopping.\n`,
      );
      process.exit(2);
    }
  }

  // If tests failed (not just coverage), report that
  if (err.status !== 0) {
    process.stderr.write(
      `AI-SDLC Coverage Check: Test suite failed.\n` +
        `${stderr.slice(0, 500)}\n` +
        `Please fix failing tests before stopping.\n`,
    );
    process.exit(2);
  }

  process.exit(0);
}
