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
// Prefer the dedicated test:coverage script (works with turbo, nx, etc.).
// Fall back to passing --coverage via -- passthrough only if no dedicated script exists.

let coverageCmd;

function hasScript(scriptName) {
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    return !!(pkg.scripts && pkg.scripts[scriptName]);
  } catch {
    return false;
  }
}

if (hasScript('test:coverage')) {
  // Dedicated coverage script — works with any task runner (turbo, nx, pnpm, etc.)
  if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
    coverageCmd = 'pnpm test:coverage';
  } else if (existsSync(join(projectDir, 'yarn.lock'))) {
    coverageCmd = 'yarn test:coverage';
  } else {
    coverageCmd = 'npm run test:coverage';
  }
} else if (existsSync(join(projectDir, 'pnpm-lock.yaml'))) {
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
  const combined = stderr + stdout;

  // ── Missing coverage provider — skip gracefully ────────────
  // If @vitest/coverage-v8 (or c8, istanbul, etc.) isn't installed,
  // the coverage command fails with a "cannot find" error. This is
  // the user's project config, not an agent failure — don't block.
  const missingProviderPatterns = [
    /Cannot find package '@vitest\/coverage/i,
    /Cannot find module '@vitest\/coverage/i,
    /Failed to load coverage provider/i,
    /coverage provider.*not found/i,
    /ERR_MODULE_NOT_FOUND.*coverage/i,
    /unexpected argument ['"]?--coverage/i,
  ];

  if (missingProviderPatterns.some((p) => p.test(combined))) {
    // Coverage tooling not available in this project — skip silently
    process.exit(0);
  }

  // ── Parse coverage results if available ────────────────────
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
    // Coverage above threshold — pass
    process.exit(0);
  }

  // ── Test failures (not coverage-related) — report ──────────
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
