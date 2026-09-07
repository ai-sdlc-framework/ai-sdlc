/**
 * AI-SDLC Action Enforcement Hook (PreToolUse)
 *
 * Enforces governance from .ai-sdlc/agent-role.yaml across three tool families:
 *
 * 1. **Bash** — checks `tool_input.command` against `blockedActions` patterns.
 * 2. **Write / Edit** — checks `tool_input.file_path` against `blockedPaths` globs
 *    (relative to the agent's "home" — the active worktree when resolvable, else
 *    the project root; see AISDLC-567). `.ai-sdlc/**` is ALWAYS refused, even if
 *    a project's `agent-role.yaml` is missing or doesn't list it — this is a
 *    hardcoded floor, not config-driven. `.github/workflows/**` is NOT blocked
 *    by default; it is refused only when a project's `agent-role.yaml` lists it
 *    (or a matching glob) under `blockedPaths` (AISDLC-567 Part A). Paths outside
 *    the agent's home are denied unless they fall under `permittedExternalPaths`
 *    declared in the active task's frontmatter (active task =
 *    `AI_SDLC_ACTIVE_TASK_ID` env var or a per-worktree `.active-task` sentinel) —
 *    this applies uniformly to loose files AND sibling git repos (AISDLC-567
 *    Part B); there is no special case that allows writing into another repo.
 * 3. **Stale-base guard** — before a Write/Edit is allowed to proceed, warns
 *    (via stderr, non-blocking) when the resolved worktree's HEAD is behind
 *    `origin/main`, using only locally-cached refs (no network fetch).
 *
 * Returns a deny decision when a tool call matches a guarded pattern.
 * Fail-safe: allows everything on any error — never block a session because
 * the policy file couldn't be parsed.
 *
 * 4. **Merge governance (AISDLC-602)** — reconciles the `blockedActions`
 *    mechanism (Bash-command glob matching against `git merge*` etc.) with
 *    the resolved `spec.governance` policy (AISDLC-601's resolver). A raw
 *    `gh pr merge` (i.e. WITHOUT `--auto`) is always blocked here regardless
 *    of the resolved `allowMerge` policy — the only sanctioned merge path is
 *    the AISDLC-603 `node pipeline-cli/bin/cli-merge-if-eligible.mjs` helper,
 *    which owns the real green+CLEAN+trusted-sourceKind evaluation (never
 *    reimplemented in this hook). Arming auto-merge (`gh pr merge --auto`)
 *    is NOT merging and stays allowed under every policy. This closes the
 *    pre-AISDLC-602 gap where `blockedActions: git merge*` never matched
 *    `gh pr merge` at all, so the loudest governance rule ("never merge")
 *    wasn't actually enforced by this hook.
 */

const { readFileSync, existsSync, readdirSync } = require('fs');
const { join, resolve, isAbsolute, relative, sep, dirname } = require('path');
const { execSync } = require('child_process');
const { resolveGovernanceFromYaml, STRICT_DEFAULTS } = require('./lib/governance-resolver');

// ── Read stdin (tool input JSON from Claude Code) ────────────────────

let input;
try {
  // Read from fd 0 (stdin) rather than '/dev/stdin' — the device-file path
  // ENXIOs on some Linux runners (e.g. GitHub Actions ubuntu-latest) where
  // /dev/stdin's state after a spawn rejects open(). Reading fd 0 directly
  // works cross-platform (macOS, Linux, Windows). Fixed 2026-05-23 after
  // the AC-2 (real-hook) test failed only in CI.
  const raw = readFileSync(0, 'utf-8');
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolName = input?.tool_name;
const toolInput = input?.tool_input || {};
const toolCwd = typeof input?.cwd === 'string' ? input.cwd : null;

// ── Find project root and load agent-role.yaml ───────────────────────

const projectDir =
  process.env.CLAUDE_PROJECT_DIR ||
  (() => {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    } catch {
      return process.cwd();
    }
  })();

const agentRolePath = join(projectDir, '.ai-sdlc', 'agent-role.yaml');

let blockedActions = [];
let blockedPaths = [];
// AISDLC-602: resolved governance policy, used by the merge-governance check
// below. Fails closed to STRICT_DEFAULTS (allowMerge: 'never') on any parse
// error or absent agent-role.yaml — mirrors the trust-boundary contract
// documented in governance-resolver.js (resolved from the trusted on-disk
// project root, never PR-tree content).
let resolvedGovernance = { ...STRICT_DEFAULTS };
try {
  const yaml = readFileSync(agentRolePath, 'utf-8');
  blockedActions = parseListField(yaml, 'blockedActions');
  blockedPaths = parseListField(yaml, 'blockedPaths');
  resolvedGovernance = resolveGovernanceFromYaml(yaml);
} catch {
  // No agent-role.yaml (or unreadable) — fall through with empty config.
  // `.ai-sdlc/**` and the outside-worktree/permittedExternalPaths rules are
  // hardcoded floors enforced regardless of config (AISDLC-567), so we must
  // NOT exit early here the way the Bash-only enforcement used to.
  // resolvedGovernance stays at STRICT_DEFAULTS (fail-closed).
}

// ── Merge-governance token allowlists (AISDLC-602) ───────────────────
// Declared BEFORE the top-level dispatch below so they are initialized before
// enforceBash() → enforceMergeGovernance() runs at module load — a `const` in
// the temporal dead zone here would crash the hook (fail-OPEN). Do not move
// these below the dispatch.

// Value-less flags that are safe to accompany an auto-arm.
const SAFE_ARM_FLAGS = new Set([
  '--auto',
  '--squash',
  '--merge',
  '--rebase',
  '--delete-branch',
  '-d',
  '--admin',
]);
// Flags that consume the NEXT token as their value (safe to skip both).
const VALUE_FLAGS = new Set(['-R', '--repo']);

// ── Dispatch by tool ─────────────────────────────────────────────────

if (toolName === 'Bash' || (!toolName && toolInput.command)) {
  enforceBash(toolInput.command);
} else if (toolName === 'Write' || toolName === 'Edit') {
  enforceWriteEdit(toolInput.file_path);
}

process.exit(0);

// ── Bash enforcement (unchanged behavior) ────────────────────────────

function enforceBash(command) {
  if (!command || typeof command !== 'string' || !command.trim()) return;

  const trimmed = command.trim();

  // AISDLC-602: merge governance is enforced unconditionally — independent
  // of whatever blockedActions patterns the project has (or hasn't)
  // configured. See enforceMergeGovernance() for the exact rules.
  enforceMergeGovernance(trimmed);

  if (blockedActions.length === 0) return;

  for (const pattern of blockedActions) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexStr}$`, 'i');
    if (regex.test(trimmed)) {
      deny(`command matches blockedAction pattern '${pattern}'`);
    }
  }
}

// ── Merge governance (AISDLC-602) ────────────────────────────────────

/**
 * Enforces the merge rule from the resolved governance policy, closing the
 * pre-existing gap where `blockedActions: git merge*` never matched
 * `gh pr merge` at all.
 *
 * Rules (apply regardless of the resolved `allowMerge` value):
 *   - Arming auto-merge (`gh pr merge --auto`, in any flag order/combination
 *     e.g. `--auto --squash`) is NOT merging and is ALLOWED.
 *   - Any OTHER `gh pr merge` invocation is BLOCKED. The only sanctioned merge
 *     path when policy permits merge is the AISDLC-603 `cli-merge-if-eligible`
 *     helper (`node pipeline-cli/bin/cli-merge-if-eligible.mjs`), which owns the
 *     real green+CLEAN+trusted-sourceKind evaluation — never reimplemented here.
 *     Under strict policy the helper self-refuses anyway (fail-closed on its own
 *     governance-resolver read), so blocking the raw command here is sufficient
 *     defense-in-depth for both policies.
 *
 * ── Fail-closed matching (AISDLC-602 security review) ──────────────────
 * This runs against a raw shell command STRING, not a parsed argv, so the
 * match is best-effort defense-in-depth — NOT an impenetrable sandbox. A
 * determined agent with Bash access can always obfuscate (command
 * substitution `$(...)`, backticks, base64|sh, aliases). Those are out of
 * scope for a string matcher; the real backstop is branch protection +
 * humans-merge. What this DOES close, fail-closed, are the realistic
 * bypasses a reviewer found:
 *   1. The `--auto` decision is scoped to the SPECIFIC `gh pr merge`
 *      invocation's own tokens, not the whole command string — so a stray
 *      `--auto` in a chained command / comment / quoted arg cannot unblock
 *      an embedded raw merge (`gh pr merge 5 && echo --auto`).
 *   2. Only a BARE `--auto` token counts as arming; `--auto=false`/`--auto=0`
 *      (which are IMMEDIATE merges) do not, and are blocked.
 *   3. The command is split on shell control operators (`&&`, `||`, `;`,
 *      `|`, `&`, newline) and each segment evaluated independently; any one
 *      raw-merge segment blocks the whole command.
 *   4. Quotes are tolerated when detecting the `gh pr merge` token span
 *      (`gh "pr" merge`), and an ALLOWLIST of known-safe arming tokens is
 *      required — any unrecognized token (unknown flag, value-bearing flag
 *      like `--body`, `--auto=…`) makes the segment NOT a clean arm, so it
 *      is blocked. Over-blocking an exotic-but-legit arm is the safe bias.
 *
 * Commands that don't invoke `gh pr merge` at all are untouched — they still
 * flow through the generic `blockedActions` pattern matching in enforceBash().
 */
function enforceMergeGovernance(trimmed) {
  for (const segment of splitShellSegments(trimmed)) {
    if (!segmentInvokesGhPrMerge(segment)) continue;
    if (isCleanAutoArmSegment(segment)) continue; // arming is not merging — allowed
    deny(
      `raw 'gh pr merge' is not a permitted merge path (resolved governance allowMerge=` +
        `"${resolvedGovernance.allowMerge}"). Merges must go through ` +
        `'node pipeline-cli/bin/cli-merge-if-eligible.mjs' (AISDLC-603), which enforces the ` +
        `real green+CLEAN+trusted-sourceKind gate — never a raw 'gh pr merge' call. Arming ` +
        `auto-merge ('gh pr merge --auto') remains allowed.`,
    );
  }
}

/**
 * Splits a command into segments on shell control operators so a `gh pr merge`
 * embedded in a chain (`x && gh pr merge 5`) is evaluated on its own. `&&` and
 * `||` are matched before the single-char `&`/`|` forms.
 */
function splitShellSegments(command) {
  return command
    .split(/(?:&&|\|\||;|\||&|\n)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Removes an unquoted trailing shell comment and all quote characters. */
function stripCommentAndQuotes(segment) {
  // Cut at the first '#' (conservative: a '#' inside a quoted arg would only
  // cause us to DROP later args, which can never turn a raw merge into a clean
  // arm — fail-closed).
  const noComment = segment.replace(/#.*$/, '');
  return noComment.replace(/['"]/g, '');
}

/**
 * True when a segment invokes `gh pr merge` (quote-tolerant, case-insensitive).
 * Strips quotes first so `gh "pr" merge` / `gh 'pr' merge` are detected.
 */
function segmentInvokesGhPrMerge(segment) {
  return /\bgh\s+pr\s+merge\b/i.test(stripCommentAndQuotes(segment));
}

/**
 * Minimal shell-ish tokenizer: splits on unquoted whitespace, honoring single
 * and double quotes so a quoted value (`--body "--auto"`) stays one token and
 * its inner `--auto` is NOT mistaken for the arming flag. Backslash-escapes are
 * not interpreted (rare in this surface; erring toward more tokens = more
 * likely to hit the unknown-token deny path = fail-closed).
 */
function tokenizeShellish(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * True ONLY for a recognized clean auto-arm: `gh pr merge [<pr>] --auto [safe
 * flags...]`. A bare `--auto` token must be present, and every token must be in
 * the allowlist (or a single PR-ref positional, or a `-R/--repo <value>` pair).
 * Anything else — `--auto=false`, an unknown/value-bearing flag, extra
 * positionals — returns false so the caller blocks (fail-closed).
 */
function isCleanAutoArmSegment(segment) {
  const tokens = tokenizeShellish(stripComment(segment));
  let i = 0;
  // Skip a leading run of `VAR=value` env assignments.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] !== 'gh' || tokens[i + 1] !== 'pr' || tokens[i + 2] !== 'merge') {
    // Quote-obfuscated `gh "pr" merge` reaches here as a non-clean arm →
    // caller blocks (segmentInvokesGhPrMerge already matched it).
    return false;
  }
  i += 3;
  let sawAuto = false;
  let sawPositional = false;
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--auto') {
      sawAuto = true;
      continue;
    }
    if (SAFE_ARM_FLAGS.has(tok)) continue;
    if (VALUE_FLAGS.has(tok)) {
      i++; // consume the flag's value token
      continue;
    }
    // A single PR-ref positional (number, owner/repo#n, or a PR URL) is allowed.
    if (
      !sawPositional &&
      !tok.startsWith('-') &&
      /^(\d+|[^/]+\/[^/]+#\d+|https?:\/\/\S+)$/.test(tok)
    ) {
      sawPositional = true;
      continue;
    }
    // Anything else (unknown flag, `--auto=false`, `--body`, extra positional,
    // a stray token) → not a clean arm.
    return false;
  }
  return sawAuto;
}

/** Removes only a trailing unquoted shell comment (quotes preserved). */
function stripComment(segment) {
  return segment.replace(/#.*$/, '');
}

// ── Write/Edit enforcement (new behavior) ────────────────────────────

function enforceWriteEdit(filePath) {
  if (!filePath || typeof filePath !== 'string') return;

  // Always work with absolute paths so both relative tool inputs and
  // already-absolute ones get the same treatment.
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(projectDir, filePath);

  const projectAbs = resolve(projectDir);
  const searchFrom = toolCwd || process.cwd();

  // AISDLC-567 Part B: an agent's "home" is its ACTIVE WORKTREE when one is
  // resolvable (Pattern C: non-bare parent repo + `.worktrees/<id>/`
  // isolates), not the whole project root. This closes the isolation gap
  // where a dev subagent whose cwd is `.worktrees/<id>/` could write into
  // the parent repo's own working tree (or a sibling worktree) unchecked,
  // because both live "inside the project root". When no worktree is
  // resolvable (plain, non-Pattern-C project), home falls back to the
  // project root — unchanged behavior for those projects.
  const worktreeDir = resolveActiveWorktreeDir(projectAbs, searchFrom);
  const homeAbs = worktreeDir || projectAbs;
  const insideHome = absPath === homeAbs || absPath.startsWith(homeAbs + sep);

  // AISDLC-567: stale-base guard. Non-blocking — warns to stderr only, using
  // whatever refs are already cached locally (no network fetch from a hook).
  warnIfStaleBase(homeAbs);

  if (insideHome) {
    // Path is inside the agent's home — check against the hardcoded
    // never-editable floor plus the project's configured blockedPaths globs.
    // Relative path uses POSIX separators because globs do.
    const relPath = relative(homeAbs, absPath).split(sep).join('/');

    // `.ai-sdlc/**` is ALWAYS refused, regardless of agent-role.yaml content
    // (or its absence) — AISDLC-567 Part A net rule.
    if (matchGlob('.ai-sdlc/**', relPath) || relPath === '.ai-sdlc') {
      deny(
        `path '${relPath}' is under .ai-sdlc/, which is never editable — ` +
          `pipeline configuration is out of scope for agent edits regardless of project config.`,
      );
    }

    for (const glob of blockedPaths) {
      if (matchGlob(glob, relPath)) {
        deny(
          `path '${relPath}' matches blocked path '${glob}'. ` +
            `Configuration files under blockedPaths are out of scope for agent edits.`,
        );
      }
    }
    return;
  }

  // Path is OUTSIDE the agent's home — only allowed if the active task's
  // permittedExternalPaths covers it. This applies uniformly whether the
  // target is a loose file or itself a sibling git repository (AISDLC-567
  // Part B) — there is no directory-type special case. The hook resolves
  // "which task is active" by walking up from the tool's cwd (the developer
  // subagent's worktree) to find a per-worktree `.active-task` sentinel; if
  // none is found it falls back to the legacy project-level sentinel.
  //
  // We use cwd here rather than the file_path because external writes
  // sit OUTSIDE `.worktrees/<id>/`, so file_path can never contain a
  // worktree ancestor. The cwd of the subagent always does.
  const allowed = loadPermittedExternalPaths(projectAbs, searchFrom);
  for (const ext of allowed) {
    const extAbs = resolve(projectAbs, ext);
    if (absPath === extAbs || absPath.startsWith(extAbs + sep)) {
      return; // explicit allow
    }
  }

  // No allowlist match — deny with a clear, actionable reason.
  if (allowed.length === 0) {
    deny(
      `path '${absPath}' is outside the agent's active worktree/project root. ` +
        `To permit cross-repo writes for this task, add 'permittedExternalPaths' to ` +
        `the task frontmatter and set AI_SDLC_ACTIVE_TASK_ID before invoking the agent.`,
    );
  } else {
    deny(
      `path '${absPath}' is outside the agent's active worktree/project root and not under the ` +
        `active task's permittedExternalPaths (${allowed.join(', ')}).`,
    );
  }
}

/**
 * Resolve the absolute path of the agent's ACTIVE WORKTREE directory by
 * walking up from `searchFrom` (normally the tool call's cwd) looking for a
 * `<projectAbs>/.worktrees/<id>/` ancestor. This does NOT require the
 * `.active-task` sentinel file to exist — only the directory structure — so
 * it works purely off cwd shape (AISDLC-567 Part B).
 *
 * Returns `null` when `searchFrom` is not nested under `<projectAbs>/.worktrees/`,
 * i.e. plain (non-Pattern-C) projects where the whole project root is home.
 */
function resolveActiveWorktreeDir(projectAbs, searchFrom) {
  const sentinelPath = findWorktreeSentinel(projectAbs, searchFrom);
  return sentinelPath ? dirname(sentinelPath) : null;
}

/**
 * AISDLC-567: warn (non-blocking) when `dir`'s HEAD is behind the locally
 * cached `origin/main` ref. Deliberately does NOT run `git fetch` — hooks
 * fire on every Write/Edit and must stay fast and offline-safe; this only
 * reads whatever `origin/main` state is already cached. Silent on any error
 * (not a git repo, no `origin/main` ref, git not on PATH, etc.) — this is a
 * best-effort advisory, never a hard dependency.
 */
function warnIfStaleBase(dir) {
  if (!dir) return;
  try {
    const output = execSync('git rev-list --count HEAD..origin/main', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const behindCount = parseInt(output, 10);
    if (Number.isFinite(behindCount) && behindCount > 0) {
      process.stderr.write(
        `[ai-sdlc governance] warning: this worktree's HEAD is ${behindCount} commit(s) behind ` +
          `origin/main. Run 'git fetch origin main && git rebase origin/main' before continuing ` +
          `to avoid stale-base edits that could revert merged work.\n`,
      );
    }
  } catch {
    // Best-effort only — never block or crash the hook on this check.
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function deny(reason) {
  const result = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Blocked by AI-SDLC governance policy: ${reason}`,
    },
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
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

/**
 * Read the active task ID. Resolution order (AISDLC-81):
 *   1. Per-worktree sentinel: walk `searchFrom` up looking for an ancestor
 *      `<projectRoot>/.worktrees/<id>/` and read its `.active-task`. This
 *      lets parallel `/ai-sdlc execute` runs each have their own active
 *      task without racing on a project-level file.
 *   2. Project-level sentinel `<projectRoot>/.worktrees/.active-task`
 *      (legacy fallback, retained for one release for non-execute callers
 *      and old runs that still write the project-level path).
 *      DEPRECATED: drop in v0.9.0+. Per-worktree sentinels are the only
 *      supported location once existing worktrees on the legacy layout
 *      have rolled over.
 *   3. `AI_SDLC_ACTIVE_TASK_ID` env var so the hook stays testable from
 *      a normal shell / external tooling.
 *
 * Returns the task ID string or `null` if no source is set.
 */
function readActiveTaskId(projectAbs, searchFrom) {
  // 1. Per-worktree sentinel from the tool's cwd (or file_path's dir).
  const perWorktree = findWorktreeSentinel(projectAbs, searchFrom);
  if (perWorktree) {
    try {
      const id = readFileSync(perWorktree, 'utf-8').trim();
      if (id) return id;
    } catch {
      // fall through to project-level sentinel
    }
  }

  // 2. Project-level sentinel (DEPRECATED — remove in v0.9.0+).
  const projectSentinel = join(projectAbs, '.worktrees', '.active-task');
  if (existsSync(projectSentinel)) {
    try {
      const id = readFileSync(projectSentinel, 'utf-8').trim();
      if (id) return id;
    } catch {
      // fall through to env var
    }
  }

  // 3. Env var fallback.
  return process.env.AI_SDLC_ACTIVE_TASK_ID || null;
}

/**
 * Walk `startFrom` up the directory tree looking for a path of the form
 * `<projectAbs>/.worktrees/<id>/`. When found, return the absolute path
 * to that worktree's `.active-task` sentinel (whether or not it exists
 * — the caller checks). Returns `null` when no `.worktrees/<id>/`
 * ancestor exists at or under projectAbs.
 *
 * Notes:
 * - Search is bounded: stops as soon as we reach `projectAbs` or the
 *   filesystem root, whichever comes first.
 * - The matched ancestor must be a DIRECT child of `<projectAbs>/.worktrees/`
 *   (i.e. exactly one path component below `.worktrees/`). Nested
 *   directories like `.worktrees/<id>/sub/` correctly resolve UP to
 *   `<projectAbs>/.worktrees/<id>/`.
 */
function findWorktreeSentinel(projectAbs, startFrom) {
  if (!startFrom) return null;
  const start = isAbsolute(startFrom) ? resolve(startFrom) : resolve(projectAbs, startFrom);

  const worktreesRoot = join(projectAbs, '.worktrees');

  // The candidate worktree must live inside <projectAbs>/.worktrees/.
  // If start is not under that, no per-worktree sentinel is reachable.
  if (start !== worktreesRoot && !start.startsWith(worktreesRoot + sep)) {
    return null;
  }

  let current = start;
  // Walk up until the parent of current === worktreesRoot. That makes
  // current === `<projectAbs>/.worktrees/<id>/`.
  while (true) {
    if (dirname(current) === worktreesRoot) {
      // current is `.worktrees/<id>/`
      return join(current, '.active-task');
    }
    const parent = dirname(current);
    if (parent === current) return null; // hit fs root
    if (parent === worktreesRoot) {
      // Already handled above, defensive.
      return join(current, '.active-task');
    }
    if (!parent.startsWith(worktreesRoot + sep) && parent !== worktreesRoot) {
      return null;
    }
    current = parent;
  }
}

/**
 * Convert a glob like `.ai-sdlc/**` or `.github/workflows/*.yml` to a regex.
 * - `**` matches any sequence including `/`
 * - `*` matches any sequence except `/`
 * - other characters are matched literally
 */
function matchGlob(glob, path) {
  const regexStr = glob
    .split('')
    .map((char, i, arr) => {
      if (char === '*' && arr[i + 1] === '*') return '__DOUBLESTAR__';
      if (char === '*' && arr[i - 1] === '*') return '';
      if (char === '*') return '[^/]*';
      if (/[.+?^${}()|[\]\\]/.test(char)) return '\\' + char;
      return char;
    })
    .join('')
    .replace(/__DOUBLESTAR__/g, '.*');

  // Case-insensitive: on case-insensitive filesystems (macOS, Windows) a
  // mixed-case path like `.AI-SDLC/agent-role.yaml` resolves to the SAME
  // real file as `.ai-sdlc/agent-role.yaml`, so the glob match must not be
  // case-sensitive or the hardcoded `.ai-sdlc/**` floor (and any configured
  // blockedPaths glob) can be bypassed by case alone. Matches the `i` flag
  // already used by enforceBash()'s pattern matching.
  const regex = new RegExp(`^${regexStr}$`, 'i');
  return regex.test(path);
}

/**
 * Load permittedExternalPaths from the active task's frontmatter.
 *
 * Active task is identified by `readActiveTaskId`, which prefers a
 * per-worktree sentinel `<projectRoot>/.worktrees/<id>/.active-task`
 * (resolved by walking up from the tool's cwd) and falls back to a
 * project-level `<projectRoot>/.worktrees/.active-task` (legacy, kept
 * for one release per AISDLC-81) and finally to the env var
 * `AI_SDLC_ACTIVE_TASK_ID` for tests / external tooling.
 *
 * The per-worktree sentinel is what enables parallel `/ai-sdlc execute`
 * runs to share a project root without racing each other's allowlist.
 *
 * Returns [] when no active task, no matching task file, or no frontmatter field.
 */
function loadPermittedExternalPaths(projectAbs, searchFrom) {
  const taskId = readActiveTaskId(projectAbs, searchFrom);
  if (!taskId) return [];

  const tasksDir = join(projectAbs, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) return [];

  let entries;
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }

  // Task files are named `<id-lower> - <slug>.md` (e.g. `aisdlc-68 - foo.md`).
  // Match case-insensitively on the id prefix to be tolerant.
  const idLower = taskId.toLowerCase();
  const taskFile = entries.find((f) => f.toLowerCase().startsWith(idLower + ' '));
  if (!taskFile) return [];

  let content;
  try {
    content = readFileSync(join(tasksDir, taskFile), 'utf-8');
  } catch {
    return [];
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];

  return parseListField(fmMatch[1], 'permittedExternalPaths');
}
