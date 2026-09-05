/**
 * AI-SDLC Session Start Hook
 *
 * Reads .ai-sdlc/agent-role.yaml from the project directory and returns
 * governance context as additionalContext, which Claude Code injects
 * into the model's session context.
 *
 * Fail-safe: exits silently on any error.
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync, spawnSync } = require('child_process');

// ── Read stdin ───────────────────────────────────────────────────────

/**
 * Captured install-runtime-deps failure text (AISDLC-557 security review).
 * Module-local rather than process.env so the UNREDACTED value is never
 * inherited by child processes; redaction happens where it is rendered.
 */
let runtimeDepsError = null;

let input;
try {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

// ── AISDLC-441: Self-heal runtime dependencies on first load ─────────
//
// Claude Code's local marketplace installer copies the plugin cache layer
// but does NOT invoke `npm install`, so runtimeDependencies declared in
// plugin.json are missing on a fresh install. Detect this and run the
// self-heal script BEFORE Claude Code tries to start the MCP server or
// any pipeline-cli bin.
//
// Idempotency: the install script writes a sentinel at
// node_modules/.ai-sdlc-installed when it succeeds. We early-exit when
// BOTH the sentinel and the expected entry points exist. If anyone
// manually deletes node_modules, the sentinel disappears and the
// self-heal re-runs naturally.
//
// Fail-safe: the install is best-effort; we never block session start.
// Errors are surfaced as a warning in the governance context so the
// operator sees them but Claude Code still launches.
try {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && existsSync(join(pluginRoot, 'plugin.json'))) {
    const sentinel = join(pluginRoot, 'node_modules', '.ai-sdlc-installed');
    const pipelineCliBin = join(
      pluginRoot,
      'node_modules',
      '@ai-sdlc',
      'pipeline-cli',
      'bin',
      'cli-deps.mjs',
    );
    const mcpServerBin = join(
      pluginRoot,
      'node_modules',
      '@ai-sdlc',
      'plugin-mcp-server',
      'dist',
      'bin.js',
    );
    const needsInstallFileCheck =
      !existsSync(sentinel) || !existsSync(pipelineCliBin) || !existsSync(mcpServerBin);

    // AISDLC-580 review follow-up: file-existence-only is not enough to
    // decide "is this install correct" — a stale-but-present install (all
    // three entry-point files AND the sentinel exist, but the installed
    // version no longer satisfies the plugin.json pin, or a newer satisfying
    // version has since published upstream) must ALSO trigger the self-heal.
    // Without this, the AISDLC-580 version-convergence fix in
    // install-runtime-deps.sh is unreachable on the automatic session-start
    // path — needsInstallFileCheck computes false, the script is never
    // invoked, and the operator stays silently stuck on the stale version
    // exactly as in the original incident. Delegate to
    // check-stale-runtime-deps.mjs — the SAME script install-runtime-deps.sh
    // itself now uses — so there is one implementation of "is this stale",
    // not two independently-drifting copies.
    //
    // Fail-open + fast: only runs when the file-existence check already
    // passed (skip the extra work entirely on a fresh/broken install, which
    // needs a full install regardless), and is bounded by a short timeout so
    // a slow/offline registry can never block session start — any
    // error/timeout here silently falls back to the file-existence result.
    let staleUpgradeNeeded = false;
    if (!needsInstallFileCheck) {
      try {
        const staleCheckScript = join(pluginRoot, 'scripts', 'check-stale-runtime-deps.mjs');
        if (existsSync(staleCheckScript)) {
          const staleResult = spawnSync(process.execPath, [staleCheckScript, pluginRoot, '2000'], {
            encoding: 'utf-8',
            // 3 known packages * ~2s npm-view budget each, plus slack for
            // node startup — still far below the 120s install budget below.
            timeout: 8_000,
          });
          if (staleResult.status === 0 && (staleResult.stdout || '').trim().length > 0) {
            staleUpgradeNeeded = true;
          }
        }
      } catch {
        // Fail open — degrade to the plain file-existence result.
      }
    }

    const needsInstall = needsInstallFileCheck || staleUpgradeNeeded;

    if (needsInstall) {
      const installScript = join(pluginRoot, 'scripts', 'install-runtime-deps.sh');
      if (existsSync(installScript)) {
        // Run synchronously so deps are present before Claude Code launches
        // the MCP server. Allow up to 120s for a cold npm install.
        const result = spawnSync('bash', [installScript, pluginRoot], {
          encoding: 'utf-8',
          timeout: 120_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.status !== 0) {
          // Stash the error for the warnings array below so the operator
          // sees what went wrong in the session-start governance banner.
          // Truncate to keep the banner readable.
          const stderrTail = (result.stderr || '')
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .slice(-3)
            .join(' | ');
          // AISDLC-557 security review: keep the UNREDACTED text out of
          // process.env. Writing it there leaked it into the environment of
          // every child spawned later in this hook (e.g. the `git rev-parse`
          // below), since redaction only happens at read time. A module-local
          // holds it instead; the env var remains a read-only INPUT for tests
          // and cross-process callers.
          runtimeDepsError = `install-runtime-deps.sh exit ${result.status}: ${stderrTail || 'no stderr'}`;
        }
      }
    }
  }
} catch {
  // Never block session start on install errors.
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

// ── Load agent-role.yaml ─────────────────────────────────────────────

const agentRolePath = join(projectDir, '.ai-sdlc', 'agent-role.yaml');

// AISDLC-557: root-cause fix for a marketplace-cache install silently
// leaving node_modules empty with zero operator-visible signal.
//
// Pre-fix, this function returned `process.exit(0)` right here whenever the
// consumer project had no `.ai-sdlc/agent-role.yaml` (i.e. before `ai-sdlc
// init` has ever been run) — which is exactly the state a brand-new adopter
// repo is in immediately after a marketplace plugin install. That early
// exit ran BEFORE the `warnings` array (built below) ever got a chance to
// surface `__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR` — so ANY self-heal failure
// captured above (network unreachable, npm registry misconfigured, prefix
// not writable, etc.) was swallowed with no trace. The operator had no way
// to discover the broken install short of manually invoking
// resolve-pipeline-cli.sh themselves, which is exactly what the AISDLC-557
// reporter had to do.
//
// Fix: when agent-role.yaml is absent, still emit a minimal hook response
// carrying ONLY the runtime-deps warning (skip the full governance banner,
// which legitimately depends on agent-role.yaml existing) instead of exiting
// fully silently.
if (!existsSync(agentRolePath)) {
  const runtimeDepsWarning = buildRuntimeDepsWarning();
  if (runtimeDepsWarning) {
    const result = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `### AI-SDLC Setup Warning\n${runtimeDepsWarning}`,
      },
    };
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  process.exit(0);
}

let yaml;
try {
  yaml = readFileSync(agentRolePath, 'utf-8');
} catch {
  process.exit(0);
}

// ── Parse agent role fields ──────────────────────────────────────────

const role = extractField(yaml, 'role') || 'agent';
const goal = extractField(yaml, 'goal') || '';
const maxFiles = extractField(yaml, 'maxFilesPerChange') || '15';
const requireTests = extractField(yaml, 'requireTests') || 'true';
const blockedActions = parseListField(yaml, 'blockedActions');
const blockedPaths = parseListField(yaml, 'blockedPaths');

// ── Detect missing dev tools ─────────────────────────────────────────

const warnings = [];

// AISDLC-441 / AISDLC-557: surface runtime-deps install failures so the
// operator sees them (buildRuntimeDepsWarning() is shared with the
// pre-agent-role.yaml early-exit path above).
const runtimeDepsWarning = buildRuntimeDepsWarning();
if (runtimeDepsWarning) {
  warnings.push(runtimeDepsWarning);
}

// Check for vitest without coverage provider
try {
  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (
      allDeps['vitest'] &&
      !allDeps['@vitest/coverage-v8'] &&
      !allDeps['@vitest/coverage-istanbul']
    ) {
      warnings.push(
        '⚠ vitest detected without coverage provider. Run: `pnpm add -D -w @vitest/coverage-v8`',
      );
    }
  }
} catch {
  // Non-critical — skip
}

// Check for .env issues (AISDLC-36)
try {
  const envFiles = ['.env', '.env.local'].map((f) => join(projectDir, f)).filter(existsSync);
  for (const envFile of envFiles) {
    const lines = readFileSync(envFile, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      // Spaces in key
      if (/^[A-Za-z_]+ [A-Za-z_]/.test(line) && line.includes('=')) {
        warnings.push(`⚠ ${envFile}:${i + 1}: key contains spaces — will cause parse errors`);
        break;
      }
      // Unbalanced quotes
      const afterEq = line.split('=').slice(1).join('=');
      if (
        (afterEq.startsWith('"') && !afterEq.endsWith('"')) ||
        (afterEq.startsWith("'") && !afterEq.endsWith("'"))
      ) {
        warnings.push(`⚠ ${envFile}:${i + 1}: unbalanced quotes — will cause parse errors`);
        break;
      }
      // Leading bullet
      if (/^[-*]\s/.test(line)) {
        warnings.push(
          `⚠ ${envFile}:${i + 1}: looks like a list item, not an env var — add # to comment out`,
        );
        break;
      }
    }
  }
} catch {
  // Non-critical — skip
}

// ── Load review policy if present ────────────────────────────────────

let reviewPolicySummary = '';
const reviewPolicyPath = join(projectDir, '.ai-sdlc', 'review-policy.md');
if (existsSync(reviewPolicyPath)) {
  reviewPolicySummary =
    '\nReview policy is active at .ai-sdlc/review-policy.md — consult it before reviewing code.';
}

// ── Build governance context ─────────────────────────────────────────

let context = `## AI-SDLC Governance Active

**Role:** ${role}
**Goal:** ${goal}

### Constraints
- Maximum files per change: ${maxFiles}
- Tests required: ${requireTests}`;

if (blockedPaths.length > 0) {
  context += `\n- Blocked paths: ${blockedPaths.join(', ')}`;
}

context += `

### Blocked Actions (NEVER execute these)
${blockedActions.map((a) => `- \`${a}\``).join('\n')}

### Pre-Commit Checklist
Before EVERY commit, run these and fix any failures:
1. \`pnpm build\` — TypeScript compilation
2. \`pnpm test\` — All tests must pass
3. \`pnpm lint\` — No lint errors
4. \`pnpm format:check\` — Run \`pnpm format\` to fix

AI-SDLC: \`.husky/pre-push\` runs \`pnpm -r test:coverage\` (80% threshold) as the canonical verification gate. Run the four commands above before \`git push\` to fail fast.

**NEVER merge PRs. Only humans merge.**
**NEVER close issues or PRs.**
**NEVER force push.**${reviewPolicySummary}`;

if (warnings.length > 0) {
  context += `\n\n### Setup Warnings\n${warnings.join('\n')}`;
}

// ── Output ───────────────────────────────────────────────────────────

const result = {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * AISDLC-441 / AISDLC-557: builds the runtime-deps install-failure warning
 * string from `__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR` (set above when the
 * self-heal spawnSync call exits non-zero). Returns `null` when there is no
 * error to report. Shared by both the pre-agent-role.yaml early-exit path
 * and the full governance-banner warnings array so the message text never
 * drifts between the two surfaces.
 */
/**
 * Redact credentials and bound the length of text that reaches model-visible
 * context (AISDLC-557 security review).
 *
 * Two reasons this is not paranoia:
 *   - npm failures quote the registry URL, and a private registry configured
 *     in .npmrc can embed `https://user:token@host/...`. That would put a
 *     live credential into session context.
 *   - This value is read from the ambient environment, not only from what
 *     this hook itself set, so anyone able to set env for the Claude Code
 *     process could otherwise inject unbounded instruction-like text.
 */
function sanitizeForContext(text, maxLen = 400) {
  // Bound the input BEFORE the regex chain. Two reviewers measured this
  // function as quadratic on long non-matching input, and it runs on a value
  // the code itself treats as attacker-influenceable (an ambient env var, or
  // stderr from a hostile registry), before any truncation. Removing the
  // `[\w-]*` prefix was not sufficient — the residual cost is the URL
  // patterns' `[a-z][a-z0-9+.-]*` scheme prefix, which rescans the run at
  // every start position. Measured after this slice: 64k chars goes from
  // ~5.3s to sub-millisecond.
  //
  // Round-6 security review DISPROVED my first version of this reasoning. I
  // claimed a straddling credential still redacts because `\S+` matches what
  // remains — true only when the trigger PRECEDES the secret. The two
  // URL-userinfo patterns trigger on the `@` that FOLLOWS it, so a cut landing
  // between the password and the `@` leaves both unmatched and `user` matches
  // no label. Reproduced: 'password=' + 'A'.repeat(8165) + ' https://user:
  // SUPERSECRET@host/path' rendered `https://user:SUPE` in the banner, because
  // the leading run collapsed to `password=***` and pulled the fragment inside
  // the 400-char window.
  //
  // So drop the final partial whitespace-delimited token whenever the input
  // was actually truncated. A straddling credential is ALWAYS that token, so
  // this closes every straddle shape rather than just the URL one.
  let bounded = String(text);
  if (bounded.length > 8192) {
    bounded = bounded.slice(0, 8192).replace(/\S+$/, '');
  }
  const redacted = bounded
    // https://user:pass@host -> https://***:***@host
    //
    // Round-4 review: the userinfo class must span to the LAST '@' before the
    // host, not the first. RFC 3986 requires %40 in userinfo, but npm prints
    // what it was given — so `https://user:p@ss@host/path` previously matched
    // only up to the first '@' and leaked the `ss` tail of the password.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:]+:[^/\s]+@(?=[^/\s@]*(?:[/\s]|$))/gi, '$1***:***@')
    // https://<token>@host — userinfo with NO colon still carries a secret.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+@/gi, '$1***@')
    // Authorization: Basic <base64> / Bearer <jwt>
    .replace(/\b(basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    // npmrc keys AND bare credential labels.
    //
    // Round-4 closed two shapes: `\b` cannot fire between `_` and `T` (both
    // word chars), so `NPM_TOKEN=` and `MY_api_key=` went through untouched,
    // and the alternation lacked the hyphenated `x-api-key:` spelling.
    //
    // Round-5 review then measured the `[\w-]*` prefix I used for that as
    // genuinely quadratic (2k chars 11ms, 8k 178ms, 16k 703ms) — a greedy
    // prefix overlapping the alternation, scanned BEFORE truncation on
    // attacker-influenceable input. So drop the prefix entirely: with no `\b`
    // anchor there is nothing to defeat, and `NPM_TOKEN=x` simply matches at
    // the `TOKEN` offset. No prefix, no backtracking.
    //
    // Requiring an explicit `=` or `:` (rather than also accepting bare
    // whitespace) additionally stops the over-redaction round 5 flagged:
    // "session token is fresh" no longer becomes "session token *** fresh".
    .replace(
      /(_authToken|_auth|_password|authToken|password|passwd|secret|api[-_]?key|token)(\s*[=:]\s*)\S+/gi,
      '$1$2***',
    )
    // Newlines and backticks would let injected text forge a heading or code
    // fence inside the governance banner — flatten them.
    .replace(/[\r\n`]+/g, ' ');
  // Truncate AFTER redaction, never before: otherwise a long prefix could push
  // a credential past the cut and it would survive unredacted.
  return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}… (truncated)` : redacted;
}

function buildRuntimeDepsWarning() {
  // Prefer the module-local capture; the env var remains a read-only input for
  // tests and cross-process callers. Both are treated as UNTRUSTED data.
  const raw = runtimeDepsError ?? process.env.__AI_SDLC_INSTALL_RUNTIME_DEPS_ERROR;
  if (!raw) return null;
  return (
    `⚠ Plugin runtime-dependency install failed — [untrusted tool output] ${sanitizeForContext(raw)}. ` +
    'MCP tools + /ai-sdlc commands may not work. Manual recovery: ' +
    'bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh" "$CLAUDE_PLUGIN_ROOT"'
  );
}

function extractField(yaml, field) {
  const match = yaml.match(new RegExp(`^\\s*${field}:\\s*(.+)$`, 'm'));
  if (!match) return null;
  return match[1]
    .replace(/^['">-]+\s*/, '')
    .replace(/['"]$/, '')
    .trim();
}

function parseListField(yaml, field) {
  const lines = yaml.split('\n');
  const items = [];
  let inSection = false;

  for (const line of lines) {
    if (new RegExp(`^\\s*${field}:\\s*$`).test(line)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^[a-zA-Z]/.test(line)) break;
      if (/^\s*$/.test(line)) continue;
      const match = line.match(/^\s+-\s+['"]?(.+?)['"]?\s*$/);
      if (match) items.push(match[1]);
    }
  }

  return items;
}
