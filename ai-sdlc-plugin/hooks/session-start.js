/**
 * AI-SDLC Session Start Hook
 *
 * Reads .ai-sdlc/agent-role.yaml from the project directory and returns
 * governance context as additionalContext, which Claude Code injects
 * into the model's session context.
 *
 * Fail-safe: exits silently on any error.
 */

const { readFileSync, readSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync, spawnSync } = require('child_process');
const {
  resolveGovernanceFromYaml,
  renderSessionStartHardRules,
} = require('./lib/governance-resolver');

// ── Read stdin ───────────────────────────────────────────────────────

/**
 * Captured install-runtime-deps failure text (AISDLC-557 security review).
 * Module-local rather than process.env so the UNREDACTED value is never
 * inherited by child processes; redaction happens where it is rendered.
 */
let runtimeDepsError = null;

// AISDLC-608: captured outcomes of the version-convergence stale-check so
// buildRuntimeDepsWarning() can surface actionable, non-silent messages for
// both "stale detected + auto-upgrading" (AC-3) and "could not confirm —
// registry check timed out" (AC-1), instead of the pre-fix behavior where
// both outcomes produced zero operator-visible signal.
let staleUpgradeSummary = null;
let staleCheckTimedOut = false;

// Number of packages check-stale-runtime-deps.mjs's own KNOWN_PACKAGES probes
// (kept in sync manually; a mismatch only affects the outer spawnSync timeout
// budget, never correctness).
const KNOWN_RUNTIME_PACKAGE_COUNT = 3;

// AISDLC-601 CI follow-up: read stdin via `readStdinSync()` (a bounded
// `fs.readSync(0, ...)` retry loop), NOT `readFileSync('/dev/stdin')`. Node's
// synchronous read of a piped (non-TTY) fd 0 can throw `EAGAIN` on Linux when
// the pipe hasn't fully buffered the writer's output yet — a well-known
// Node/libuv difference from macOS. A single `readFileSync('/dev/stdin')` call
// treats that transient `EAGAIN` as a hard failure; the fail-safe `catch` then
// exited the whole hook, silently skipping governance injection on every
// Linux-hosted `SessionStart` that raced the same way (reproduced
// deterministically in GitHub Actions). This mirrors the AISDLC-571 fix already
// applied to subagent-start.js / enforce-blocked-actions.js.
let input;
try {
  const raw = readStdinSync();
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
          // AISDLC-608: the original 2000ms per-package budget was too
          // aggressive for a correctness-gating registry round-trip — a
          // routine `npm view` on a slow/cold-DNS network commonly exceeds
          // 2s, and check-stale-runtime-deps.mjs fails OPEN on timeout by
          // design (never blocks offline). That combination meant a normal,
          // reachable-but-slow network silently skipped staleness detection
          // with zero signal: no reinstall, no warning, adopter stuck on a
          // stale version (the local-trades AISDLC-607 report).
          //
          // AISDLC-608 balance (code-review follow-up): the OLD 2s masked
          // staleness silently; a naive 8s made every session-start on a
          // slow-but-reachable network (VPN / throttled / slow private
          // registry) block up to ~24-30s. We instead pair a MODERATE 4s
          // default with the new timeout-surfaces-a-warning behavior: a
          // timeout no longer masks staleness (it emits the `TIMEOUT` marker
          // -> session warns "could not confirm; run --force"), so a shorter
          // budget is safe. Worst-case blocking is now ~4s x 3 packages
          // (~12s), and an offline registry still fails fast via DNS/ENOTFOUND
          // (not the timeout). Operators on genuinely slow registries can
          // raise it via AI_SDLC_RUNTIME_DEPS_STALE_TIMEOUT_MS (clamped to
          // 1000-20000ms).
          const DEFAULT_STALE_TIMEOUT_MS = 4_000;
          const rawTimeoutOverride = Number.parseInt(
            process.env.AI_SDLC_RUNTIME_DEPS_STALE_TIMEOUT_MS || '',
            10,
          );
          const perPackageTimeoutMs = Number.isFinite(rawTimeoutOverride)
            ? Math.min(Math.max(rawTimeoutOverride, 1_000), 20_000)
            : DEFAULT_STALE_TIMEOUT_MS;
          const staleResult = spawnSync(
            process.execPath,
            [staleCheckScript, pluginRoot, String(perPackageTimeoutMs)],
            {
              encoding: 'utf-8',
              timeout: perPackageTimeoutMs * KNOWN_RUNTIME_PACKAGE_COUNT + 6_000,
            },
          );
          const staleStdout = (staleResult.stdout || '').trim();
          if (staleResult.status === 0 && staleStdout.length > 0) {
            staleUpgradeNeeded = true;
            staleUpgradeSummary = summarizeStaleUpgrades(staleStdout);
          }
          // AISDLC-608: a genuine timeout must NOT read as "confirmed
          // up-to-date" — check-stale-runtime-deps.mjs emits `TIMEOUT\t...`
          // lines to stderr specifically for this case (distinct from an
          // ordinary offline/no-npm failure, which stays silent by design).
          // Surface it as a governance-context warning rather than masking
          // it as convergence.
          if (!staleUpgradeNeeded && /(^|\n)TIMEOUT\t/.test(staleResult.stderr || '')) {
            staleCheckTimedOut = true;
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
const resolvedGovernance = resolveGovernanceFromYaml(yaml);

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

${renderSessionStartHardRules(resolvedGovernance)}${reviewPolicySummary}`;

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
  if (raw) {
    return (
      `⚠ Plugin runtime-dependency install failed — [untrusted tool output] ${sanitizeForContext(raw)}. ` +
      'MCP tools + /ai-sdlc commands may not work. Manual recovery: ' +
      'bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh" "$CLAUDE_PLUGIN_ROOT"'
    );
  }

  // AISDLC-608 AC-3: a stale runtime dep (installed version doesn't match
  // the pin's resolved target) was detected and this session-start is
  // auto-upgrading it now. Pre-fix this was completely silent even though
  // it has a real, visible side effect (an rm -rf + npm install runs).
  if (staleUpgradeSummary) {
    return (
      `⚠ ai-sdlc runtime deps were stale — auto-upgrading now (${sanitizeForContext(staleUpgradeSummary)}). ` +
      'If a tool still behaves unexpectedly after this session starts, force a clean ' +
      're-resolve: bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh" "$CLAUDE_PLUGIN_ROOT" --force'
    );
  }

  // AISDLC-608 AC-1: the registry freshness check could not complete within
  // its budget. Pre-fix, a timeout produced identical output to "confirmed
  // up to date" (empty stdout either way) — the adopter got zero signal that
  // staleness could not actually be ruled out. Distinguish it explicitly.
  if (staleCheckTimedOut) {
    return (
      '⚠ ai-sdlc could not confirm runtime deps are up to date (registry check timed out). ' +
      'If you recently bumped the plugin (e.g. via `/plugin update`), the change may not have ' +
      'taken effect yet. Force a clean re-resolve: bash "$CLAUDE_PLUGIN_ROOT/scripts/install-runtime-deps.sh" ' +
      '"$CLAUDE_PLUGIN_ROOT" --force, then reload/restart this session.'
    );
  }

  return null;
}

/**
 * Render a short human-readable summary of the tab-delimited
 * check-stale-runtime-deps.mjs stdout (`<name>\t<installed>\t<target>\t<pin>`
 * per line) for the AC-3 auto-upgrade warning, e.g.
 * "@ai-sdlc/pipeline-cli 0.24.0 -> 0.24.1". Multiple stale packages are
 * joined with "; ". Malformed lines are skipped defensively rather than
 * throwing — this only feeds an advisory banner, never gates behavior.
 */
function summarizeStaleUpgrades(stdout) {
  const parts = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const [name, installed, target] = fields;
    parts.push(`${name} ${installed} -> ${target}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
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

// ── stdin helpers (AISDLC-601 CI follow-up) ──────────────────────────
//
// Bounded `fs.readSync(0, ...)` retry loop that tolerates the transient
// `EAGAIN` a piped fd 0 can raise on Linux before the writer's output is
// buffered. Ported from subagent-start.js (AISDLC-571). A genuinely closed
// or absent stdin still fails after MAX_EAGAIN_RETRIES so the caller's
// fail-safe `catch` continues to short-circuit correctly.
function readStdinSync() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  const MAX_EAGAIN_RETRIES = 200;
  let eagainRetries = 0;

  for (;;) {
    let bytesRead;
    try {
      bytesRead = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        eagainRetries += 1;
        if (eagainRetries > MAX_EAGAIN_RETRIES) {
          throw err;
        }
        sleepSync(10);
        continue;
      }
      // EOF is thrown as an error on some platforms when the fd is
      // already exhausted; treat it the same as a 0-byte read.
      if (err && err.code === 'EOF') {
        break;
      }
      throw err;
    }
    if (bytesRead === 0) {
      break;
    }
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }

  return Buffer.concat(chunks).toString('utf-8');
}

function sleepSync(ms) {
  const sharedBuffer = new SharedArrayBuffer(4);
  const view = new Int32Array(sharedBuffer);
  Atomics.wait(view, 0, 0, ms);
}
