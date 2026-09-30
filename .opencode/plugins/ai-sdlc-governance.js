/**
 * AI-SDLC governance plugin for the OpenCode harness (v2).
 *
 * In-process port of the Claude Code plugin's governance hooks:
 *   - ai-sdlc-plugin/hooks/enforce-blocked-actions.js   (PreToolUse deny policy)
 *   - ai-sdlc-plugin/hooks/collect-tool-sequence.js    (PostToolUse telemetry)
 *   - ai-sdlc-plugin/hooks/lib/governance-resolver.js  (spec.governance resolver)
 *
 * v2 plugin contract notes:
 *   - The sanctioned deny path is the `permission.evaluate` hook. Declarative
 *     permission rules in opencode.json are evaluated FIRST; calls denied
 *     there never reach this hook. This hook fires for every remaining
 *     (ask/allow) evaluation and may override `effect` + `message`. The
 *     effective policy is the union of both layers (either can deny), which
 *     makes governance immune to config merge ordering.
 *   - `tool.execute.after` is the telemetry port — same normalized JSONL
 *     shape as collect-tool-sequence.js (`{ts,sid,tool,action,project}`), so
 *     the pattern-detection engine can consume both feeds (engine rewiring is
 *     a follow-up).
 *   - `session.context` injects a compact hard-rules banner into the model
 *     context (port of session-start.js / subagent-start.js), guarded by a
 *     marker so it is never double-injected.
 *
 * Fail-open everywhere: an error in this plugin must never break a session.
 * Roots resolve from AI_SDLC_PROJECT_ROOT (set by the dispatch runner), else
 * from this file's location (<root>/.opencode/plugins/ai-sdlc-governance.js
 * → repo root), else the session's own directory.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, isAbsolute, relative, sep, dirname, extname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BANNER_MARKER = "AI-SDLC GOVERNANCE";

// ── Roots ─────────────────────────────────────────────────────────────

function deriveProjectRoot() {
  const fromEnv = process.env.AI_SDLC_PROJECT_ROOT;
  if (fromEnv) return resolve(fromEnv);
  try {
    // <root>/.opencode/plugins/ai-sdlc-governance.js → <root>
    return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  } catch {
    return null;
  }
}

// ── agent-role.yaml list parsing (port of parseListField) ─────────────

function parseListField(yaml, field) {
  const lines = yaml.split("\n");
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

// ── spec.governance resolver (port of governance-resolver.js) ─────────
//
// Fail-closed (RFC-0048): unknown keys / malformed values are IGNORED —
// the resolved value falls back to strict defaults. Malformed input never
// relaxes a rule. An ABSENT governance section → strict defaults, so
// adopters without one are unchanged.

const STRICT_DEFAULTS = Object.freeze({
  allowMerge: "never",
  allowForcePush: false,
  allowClosePrIssue: false,
  allowBranchDelete: false,
  allowResetHard: false,
});

const KNOWN_PRESETS = new Set(["strict", "operator-trusted"]);
const GOV_BOOLEAN_KEYS = ["allowForcePush", "allowClosePrIssue", "allowBranchDelete", "allowResetHard"];

function parseGovernanceBlock(yamlText) {
  if (typeof yamlText !== "string") return null;
  const lines = yamlText.split("\n");
  let govIndent = null;
  const raw = {};
  let found = false;

  for (const line of lines) {
    if (govIndent === null) {
      const m = line.match(/^(\s*)governance:\s*$/);
      if (m) {
        govIndent = m[1].length;
        found = true;
      }
      continue;
    }
    if (/^\s*$/.test(line)) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= govIndent) break;
    const kv = line.match(/^\s*([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let value = kv[2].replace(/\s+#.*$/, "").trim();
    if (value === "") continue;
    value = value.replace(/^['"]/, "").replace(/['"]$/, "");
    if (value === "true") raw[key] = true;
    else if (value === "false") raw[key] = false;
    else raw[key] = value;
  }
  return found ? raw : null;
}

function resolveGovernance(rawGovernance) {
  const resolved = { ...STRICT_DEFAULTS };
  if (!rawGovernance || typeof rawGovernance !== "object") return resolved;
  if (typeof rawGovernance.preset === "string" && KNOWN_PRESETS.has(rawGovernance.preset)) {
    if (rawGovernance.preset === "operator-trusted") resolved.allowMerge = "onGreenClean";
  }
  if (typeof rawGovernance.allowMerge === "string") {
    const v = rawGovernance.allowMerge;
    if (v === "never" || v === "onGreenClean") resolved.allowMerge = v;
  }
  for (const key of GOV_BOOLEAN_KEYS) {
    if (typeof rawGovernance[key] === "boolean") resolved[key] = rawGovernance[key];
  }
  return resolved;
}

/**
 * Load the full governance policy from the project's agent-role.yaml.
 * Mirrors the Claude hook's fail-safe: unreadable/absent file → empty
 * config-driven lists + STRICT governance; the hard-coded floors below are
 * enforced regardless of config content.
 */
function loadPolicy(projectRoot) {
  const root = projectRoot || deriveProjectRoot();
  const empty = { blockedActions: [], blockedPaths: [], governance: { ...STRICT_DEFAULTS } };
  if (!root) return empty;
  let yaml;
  try {
    yaml = readFileSync(join(root, ".ai-sdlc", "agent-role.yaml"), "utf-8");
  } catch {
    return empty;
  }
  return {
    blockedActions: parseListField(yaml, "blockedActions"),
    blockedPaths: parseListField(yaml, "blockedPaths"),
    governance: resolveGovernance(parseGovernanceBlock(yaml)),
  };
}

// ── Matchers ──────────────────────────────────────────────────────────

/** Command-pattern match — port of the Claude hook's blockedActions test
 *  (escape metachars, `*` → `.*`, full-anchored, case-insensitive). */
function cmdMatch(pattern, command) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(command);
}

/** Path-glob match — port of the hook's matchGlob (`**` crosses `/`,
 *  `*` does not; case-insensitive so case-insensitive filesystems cannot
 *  bypass a floor by casing alone). */
function matchGlob(glob, path) {
  const regexStr = glob
    .split("")
    .map((char, i, arr) => {
      if (char === "*" && arr[i + 1] === "*") return "__DOUBLESTAR__";
      if (char === "*" && arr[i - 1] === "*") return "";
      if (char === "*") return "[^/]*";
      if (/[.+?^${}()|[\]\\]/.test(char)) return "\\" + char;
      return char;
    })
    .join("")
    .replace(/__DOUBLESTAR__/g, ".*");
  return new RegExp(`^${regexStr}$`, "i").test(path);
}

// ── Shell governance (port of enforce-blocked-actions.js) ─────────────

const SAFE_ARM_FLAGS = new Set(["--auto", "--squash", "--merge", "--rebase", "--delete-branch", "-d", "--admin"]);
const VALUE_FLAGS = new Set(["-R", "--repo"]);

function splitShellSegments(command) {
  return command
    .split(/(?:&&|\|\||;|\||&|\n)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Removes an unquoted trailing shell comment and all quote characters. */
function stripCommentAndQuotes(segment) {
  return segment.replace(/#.*$/, "").replace(/['"]/g, "");
}

/** Removes only a trailing unquoted shell comment (quotes preserved). */
function stripComment(segment) {
  return segment.replace(/#.*$/, "");
}

/**
 * Minimal shell-ish tokenizer: splits on unquoted whitespace, honoring
 * single/double quotes so a quoted value (`--body "--auto"`) stays one token
 * and its inner `--auto` is NOT mistaken for the arming flag.
 */
function tokenizeShellish(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/** True when a segment invokes `gh pr merge` (quote-tolerant, case-insensitive). */
function segmentInvokesGhPrMerge(segment) {
  return /\bgh\s+pr\s+merge\b/i.test(stripCommentAndQuotes(segment));
}

/**
 * True ONLY for a recognized clean auto-arm: `gh pr merge [<pr>] --auto
 * [safe flags...]`. A bare `--auto` token must be present and every token
 * must be allowlisted (or a single PR-ref positional, or a `-R/--repo
 * <value>` pair). Anything else → not a clean arm → caller blocks
 * (fail-closed; over-blocking an exotic arm is the safe bias).
 */
function isCleanAutoArmSegment(segment) {
  const tokens = tokenizeShellish(stripComment(segment));
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (tokens[i] !== "gh" || tokens[i + 1] !== "pr" || tokens[i + 2] !== "merge") return false;
  i += 3;
  let sawAuto = false;
  let sawPositional = false;
  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "--auto") {
      sawAuto = true;
      continue;
    }
    if (SAFE_ARM_FLAGS.has(tok)) continue;
    if (VALUE_FLAGS.has(tok)) {
      i++; // consume the flag's value token (matches gh's own parser)
      continue;
    }
    if (
      !sawPositional &&
      !tok.startsWith("-") &&
      /^(\d+|[^/]+\/[^/]+#\d+|https?:\/\/\S+)$/.test(tok)
    ) {
      sawPositional = true;
      continue;
    }
    return false; // unknown flag / `--auto=false` / value-bearing flag / extra positional
  }
  return sawAuto;
}

/**
 * Merge governance (AISDLC-602): any `gh pr merge` that is NOT a clean
 * `--auto` arm is blocked regardless of the resolved allowMerge policy —
 * the only sanctioned merge path is the cli-merge-if-eligible helper.
 * Arming auto-merge is NOT merging and stays allowed.
 */
function checkMergeGovernance(segment, governance) {
  if (!segmentInvokesGhPrMerge(segment)) return null;
  if (isCleanAutoArmSegment(segment)) return null;
  return {
    blocked: true,
    reason:
      `raw 'gh pr merge' is not a permitted merge path (resolved governance allowMerge=` +
      `"${governance.allowMerge}"). Merges must go through 'node pipeline-cli/bin/cli-merge-if-eligible.mjs' ` +
      `(AISDLC-603), which enforces the real green+CLEAN+trusted-sourceKind gate — never a raw ` +
      `'gh pr merge' call. Arming auto-merge ('gh pr merge --auto') remains allowed.`,
  };
}

// ── No-bare-stash governance (AISDLC-611) ────────────────────────────

const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const SAFE_STASH_PATTERN =
  'prefer a temporary WIP commit to set work aside; if you must stash, tag it uniquely ' +
  `('git stash push -u -m "<unique-tag>"'), restore it by exact ref/SHA ` +
  `('git stash apply <ref>'), and only then drop it by that same tag/ref ` +
  `('git stash drop <ref>')`;

/**
 * Removes heredoc BODY lines (between a `<<[-]MARKER` opener and its closing
 * MARKER line) so a heredoc that merely CONTAINS `git stash pop` (e.g.
 * documentation piped via `cat <<EOF`) is not mistaken for an invocation.
 * The opener line is preserved; an unterminated heredoc consumes the rest
 * (under-inspection only — never a false BLOCK).
 */
function stripHeredocBodies(command) {
  const lines = command.split("\n");
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!match) {
      kept.push(line);
      i++;
      continue;
    }
    const marker = match[2];
    const dashed = /<<-/.test(line);
    kept.push(line);
    i++;
    while (i < lines.length) {
      const bodyLine = dashed ? lines[i].replace(/^\t+/, "") : lines[i];
      i++;
      if (bodyLine === marker) break;
    }
  }
  return kept.join("\n");
}

/**
 * Aggressively normalizes a command string for stash DETECTION (never alters
 * what the shell executes — only this local copy). Collapses the shell
 * mechanisms that obfuscate a `git stash` invocation to their plain-text
 * equivalent, in order:
 *   1. `${IFS}`/`${IFS:…}`/`$IFS` → space (its default value word-splits
 *      neighbors); every other `${VAR}`/`$VAR` → empty (an unset var
 *      concatenates neighbors). Runs BEFORE quote-stripping — an unescaped
 *      quote terminates a `$VAR` name in a real shell.
 *   2. stripCommentAndQuotes (a real shell's word-concatenation is mirrored:
 *      `git st''ash` collapses to `git stash`).
 *   3. Backslashes removed (a shell drops unescaped `\` and joins sides).
 *   4. `()` `{}` backtick `$` → space (they EXECUTE their contents).
 * Coarse character-level transform — can only ADD detections, never hide a
 * real one (deliberate safe bias).
 */
function normalizeStashObfuscation(text) {
  let out = text;
  out = out.replace(/\$\{IFS\}/g, " ");
  out = out.replace(/\$\{IFS[^}A-Za-z0-9_][^}]*\}/g, " ");
  out = out.replace(/\$IFS\b/g, " ");
  out = out.replace(/\$\{[^}]*\}/g, "");
  out = out.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, "");
  out = stripCommentAndQuotes(out);
  out = out.replace(/\\/g, "");
  out = out.replace(/[(){}`$]/g, " ");
  return out;
}

/** True when `tok` is `git` or a path ending in `/git` (e.g. `/usr/bin/git`). */
function isGitToken(tok) {
  return typeof tok === "string" && /(^|\/)git$/.test(tok);
}

/**
 * Index of the `stash` token after `git` at `gitIdx`, tolerating global
 * flags (`-C <dir>`, `-c <k=v>`, …) in between. -1 when the invocation is
 * `git <something-else>` (detection is BY SUBCOMMAND POSITION, so
 * `git commit -m stash` / `git log --grep stash` are not stash invocations).
 */
function findGitStashIndex(tokens, gitIdx) {
  let j = gitIdx + 1;
  while (j < tokens.length) {
    const tok = tokens[j];
    if (tok === "stash") return j;
    if (GIT_GLOBAL_VALUE_FLAGS.has(tok)) {
      j += 2;
      continue;
    }
    if (tok.startsWith("-")) {
      j += 1;
      continue;
    }
    return -1;
  }
  return -1;
}

/** True when a non-flag (positional) token appears from `fromIdx` onward. */
function hasPositionalArg(tokens, fromIdx) {
  for (let i = fromIdx; i < tokens.length; i++) {
    if (!tokens[i].startsWith("-")) return true;
  }
  return false;
}

/**
 * Evaluates ONE shell segment for a `git stash` invocation. Returns null when
 * the segment does not invoke `git stash` at all. Blocks ONLY the genuinely
 * destructive stack ops (round-5 operator scope): `pop`, `clear`, and bare
 * `drop` (no ref). Everything else (bare `git stash`, tagged/untagged
 * `push`/`save`, `apply`, `list`, `show`, `drop <ref>`) is allowed.
 */
function evaluateStashSegment(segment) {
  const tokens = stripCommentAndQuotes(segment).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (!isGitToken(tokens[i])) return null;
  const stashIdx = findGitStashIndex(tokens, i);
  if (stashIdx === -1) return null;
  const sub = tokens[stashIdx + 1];

  // Bare `git stash` (no subcommand / next token is a flag) is a push — allow.
  if (!sub || sub.startsWith("-")) return { blocked: false };

  if (sub === "pop") {
    return {
      blocked: true,
      reason:
        `'git stash pop' applies AND drops in one step on the SHARED stash stack (main ` +
        `checkout + all worktrees + concurrent sessions) — if your own stash captured nothing, ` +
        `the pop can silently apply-and-drop a PRE-EXISTING stash belonging to the operator or a ` +
        `sibling session, permanently losing their work (real incident: local-trades LT-595, HIGH-3). ` +
        `Safe pattern: ${SAFE_STASH_PATTERN}.`,
    };
  }

  if (sub === "clear") {
    return {
      blocked: true,
      reason:
        `'git stash clear' DELETES every entry on the SHARED stash stack (main checkout + all ` +
        `worktrees + concurrent sessions), destroying stashes that may belong to the operator or a ` +
        `sibling session. Safe pattern: ${SAFE_STASH_PATTERN}.`,
    };
  }

  if (sub === "drop") {
    if (hasPositionalArg(tokens, stashIdx + 2)) return { blocked: false };
    return {
      blocked: true,
      reason:
        `bare 'git stash drop' (no explicit ref) drops whatever is CURRENTLY on top of the SHARED ` +
        `stash stack, which may not be yours. Safe pattern: ${SAFE_STASH_PATTERN}.`,
    };
  }

  return { blocked: false };
}

function checkStashGovernance(command) {
  const normalized = normalizeStashObfuscation(stripHeredocBodies(command));
  for (const segment of splitShellSegments(normalized)) {
    const verdict = evaluateStashSegment(segment);
    if (verdict && verdict.blocked) return { blocked: true, reason: verdict.reason };
  }
  return null;
}

/**
 * The ONE sanctioned force-push form. The project agent-role.yaml denies
 * `git push --force*` and `git push -f*` wholesale, but the developer
 * Definition of Done REQUIRES `git push --force-with-lease` after the
 * mandatory rebase. The live Claude hook (which the project still runs)
 * denies `--force-with-lease` too — a pre-existing spec conflict, flagged
 * upstream; the opencode port resolves it in favor of the DoD by carving
 * the lease-protected form out of the force-push denies.
 */
const FORCE_WITH_LEASE_PATTERN = "git push --force-with-lease*";

function isForcePushPattern(pattern) {
  return /^git push (--force|-f)/.test(pattern);
}

/**
 * blockedActions matching, SEGMENT-AWARE (splits on shell control operators
 * first, so a chained `cd x && git push --force origin` is still caught —
 * a strict superset of the Claude hook's whole-command match). When a
 * force-push pattern matches, the force-with-lease carve-out above skips it;
 * the force-with-lease form is the only force-push that survives.
 */
function checkBlockedActions(command, patterns) {
  for (const segment of splitShellSegments(command)) {
    for (const pattern of patterns) {
      if (!cmdMatch(pattern, segment)) continue;
      if (isForcePushPattern(pattern) && cmdMatch(FORCE_WITH_LEASE_PATTERN, segment)) {
        continue; // carve-out: the DoD-required lease-protected form
      }
      return { blocked: true, reason: `command matches blockedAction pattern '${pattern}'` };
    }
  }
  return null;
}

/**
 * Full shell-command governance (the port of enforceBash): merge governance
 * and stash governance are unconditional floors; blockedActions is
 * config-driven. Returns the first blocking verdict or null.
 */
function checkShellCommand(command, policy) {
  if (!command || typeof command !== "string" || !command.trim()) return null;
  const trimmed = command.trim();

  for (const segment of splitShellSegments(trimmed)) {
    const verdict = checkMergeGovernance(segment, policy.governance);
    if (verdict) return verdict;
  }

  const stash = checkStashGovernance(trimmed);
  if (stash) return stash;

  if (policy.blockedActions.length > 0) {
    return checkBlockedActions(trimmed, policy.blockedActions);
  }
  return null;
}

// ── Path governance (port of enforceWriteEdit, AISDLC-567) ───────────

/**
 * Walk `startFrom` up looking for a `<projectAbs>/.worktrees/<id>/`
 * ancestor; return that worktree's `.active-task` sentinel path (whether or
 * not it exists), or null when startFrom is not under the worktrees root.
 */
function findWorktreeSentinel(projectAbs, startFrom) {
  if (!startFrom) return null;
  const start = isAbsolute(startFrom) ? resolve(startFrom) : resolve(projectAbs, startFrom);

  const worktreesRoot = join(projectAbs, ".worktrees");
  if (start !== worktreesRoot && !start.startsWith(worktreesRoot + sep)) {
    return null;
  }

  let current = start;
  for (;;) {
    if (dirname(current) === worktreesRoot) {
      return join(current, ".active-task");
    }
    const parent = dirname(current);
    if (parent === current) return null; // hit fs root
    if (parent === worktreesRoot) return join(current, ".active-task");
    if (!parent.startsWith(worktreesRoot + sep) && parent !== worktreesRoot) {
      return null;
    }
    current = parent;
  }
}

/**
 * Resolve the agent's ACTIVE WORKTREE dir (home for path checks) by cwd
 * shape alone — no sentinel file required (AISDLC-567 Part B). null when
 * not nested under `<projectAbs>/.worktrees/<id>/` → home = project root.
 */
function resolveActiveWorktreeDir(projectAbs, searchFrom) {
  const sentinelPath = findWorktreeSentinel(projectAbs, searchFrom);
  return sentinelPath ? dirname(sentinelPath) : null;
}

/**
 * Active task ID resolution (AISDLC-81): 1. per-worktree `.active-task`
 * sentinel (walk up from searchFrom) 2. legacy project-level sentinel 3.
 * `AI_SDLC_ACTIVE_TASK_ID` env var. Null when no source is set.
 */
function readActiveTaskId(projectAbs, searchFrom) {
  const perWorktree = findWorktreeSentinel(projectAbs, searchFrom);
  if (perWorktree) {
    try {
      const id = readFileSync(perWorktree, "utf-8").trim();
      if (id) return id;
    } catch {
      // fall through
    }
  }

  const projectSentinel = join(projectAbs, ".worktrees", ".active-task");
  if (existsSync(projectSentinel)) {
    try {
      const id = readFileSync(projectSentinel, "utf-8").trim();
      if (id) return id;
    } catch {
      // fall through
    }
  }

  return process.env.AI_SDLC_ACTIVE_TASK_ID || null;
}

/**
 * permittedExternalPaths from the active task's frontmatter. Task files are
 * named `<id-lower> - <slug>.md` under `backlog/tasks/`; matched
 * case-insensitively on the id prefix. [] when no task/file/field.
 */
function loadPermittedExternalPaths(projectAbs, searchFrom) {
  const taskId = readActiveTaskId(projectAbs, searchFrom);
  if (!taskId) return [];

  const tasksDir = join(projectAbs, "backlog", "tasks");
  if (!existsSync(tasksDir)) return [];

  let entries;
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }

  const idLower = taskId.toLowerCase();
  const taskFile = entries.find((f) => f.toLowerCase().startsWith(idLower + " "));
  if (!taskFile) return [];

  let content;
  try {
    content = readFileSync(join(tasksDir, taskFile), "utf-8");
  } catch {
    return [];
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];

  return parseListField(fmMatch[1], "permittedExternalPaths");
}

/**
 * AISDLC-567: warn (non-blocking, offline) when `dir`'s HEAD is behind the
 * locally cached `origin/main`. No `git fetch` — hooks must stay fast.
 * Silent on any error; best-effort advisory only.
 */
function warnIfStaleBase(dir) {
  if (!dir) return;
  try {
    const output = execSync("git rev-list --count HEAD..origin/main", {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
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
    // best-effort only — never block
  }
}

/**
 * Full path governance (port of enforceWriteEdit). `home` is the active
 * worktree when resolvable (cwd shape), else the project root.
 *
 *   - inside home: hardcoded `.ai-sdlc/**` floor (always) + project
 *     blockedPaths globs (relative to home)
 *   - outside home: allowed only under the active task's
 *     permittedExternalPaths (uniform for loose files AND sibling repos —
 *     AISDLC-567 Part B)
 *
 * Relative paths resolve against `searchFrom` (the session directory) —
 * more accurate than the Claude hook, which resolved against the project
 * root and was only correct when the tool cwd WAS the root.
 */
function checkPath(filePath, policy, projectAbs, searchFrom) {
  if (!filePath || typeof filePath !== "string") return null;

  const base = searchFrom || projectAbs;
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath);

  const worktreeDir = resolveActiveWorktreeDir(projectAbs, searchFrom || projectAbs);
  const homeAbs = worktreeDir || projectAbs;
  const insideHome = absPath === homeAbs || absPath.startsWith(homeAbs + sep);

  warnIfStaleBase(homeAbs);

  if (insideHome) {
    const relPath = relative(homeAbs, absPath).split(sep).join("/");

    // `.ai-sdlc/**` is ALWAYS refused, regardless of agent-role.yaml
    // content (or its absence) — hardcoded floor (AISDLC-567 Part A).
    if (matchGlob(".ai-sdlc/**", relPath) || relPath === ".ai-sdlc") {
      return {
        blocked: true,
        reason:
          `path '${relPath}' is under .ai-sdlc/, which is never editable — pipeline ` +
          `configuration is out of scope for agent edits regardless of project config.`,
      };
    }

    for (const glob of policy.blockedPaths) {
      if (matchGlob(glob, relPath)) {
        return {
          blocked: true,
          reason:
            `path '${relPath}' matches blocked path '${glob}'. Configuration files under ` +
            `blockedPaths are out of scope for agent edits.`,
        };
      }
    }
    return null;
  }

  const allowed = loadPermittedExternalPaths(projectAbs, searchFrom || projectAbs);
  for (const ext of allowed) {
    const extAbs = resolve(projectAbs, ext);
    if (absPath === extAbs || absPath.startsWith(extAbs + sep)) {
      return null; // explicit allow
    }
  }

  return {
    blocked: true,
    reason:
      allowed.length === 0
        ? `path '${absPath}' is outside the agent's active worktree/project root. To permit ` +
          `cross-repo writes for this task, add 'permittedExternalPaths' to the task frontmatter ` +
          `and set AI_SDLC_ACTIVE_TASK_ID before invoking the agent.`
        : `path '${absPath}' is outside the agent's active worktree/project root and not under ` +
          `the active task's permittedExternalPaths (${allowed.join(", ")}).`,
  };
}

// ── Telemetry (port of collect-tool-sequence.js) ──────────────────────

/**
 * Canonicalize a tool call to a short action token (same scheme as the
 * Claude PostToolUse hook; tool names are the v2 lowercase set and the
 * input field for read/edit/write is `path`).
 */
function canonicalizeAction(tool, input) {
  const inp = input && typeof input === "object" ? input : {};
  switch (tool) {
    case "shell":
    case "Bash": {
      const cmd = String(inp.command || "").trim();
      const lastCmd = cmd.includes("&&") ? cmd.split("&&").pop().trim() : cmd;
      const tokens = lastCmd.split(/\s+/).slice(0, 3);
      return tokens.join(" ").slice(0, 60) || "shell";
    }
    case "read":
      return `read:${extname(String(inp.path || "")) || "file"}`;
    case "edit":
      return `edit:${extname(String(inp.path || "")) || "file"}`;
    case "write":
      return `write:${extname(String(inp.path || "")) || "file"}`;
    case "grep":
      return `grep:${String(inp.pattern || "").slice(0, 30)}`;
    case "glob":
      return `glob:${String(inp.pattern || "").slice(0, 30)}`;
    case "subagent":
    case "Agent":
      return `agent:${String(inp.description || "").slice(0, 30)}`;
    case "webfetch":
      return `webfetch:${String(inp.url || "").slice(0, 40)}`;
    case "websearch":
      return `websearch:${String(inp.query || "").slice(0, 40)}`;
    default:
      return String(tool).toLowerCase();
  }
}

/**
 * Append one JSONL line per completed/errored tool call. Same
 * `{ts,sid,tool,action,project}` shape as collect-tool-sequence.js so the
 * pattern-detection engine can consume both feeds once rewired (follow-up).
 * Default dir: ~/.local/share/opencode/usage-data (opencode-native); env
 * AI_SDLC_TELEMETRY_DIR overrides. Must be fast and NEVER fail.
 */
function appendTelemetry(sessionID, tool, input, projectAbs) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      sid: sessionID,
      tool: String(tool || "unknown"),
      action: canonicalizeAction(String(tool || ""), input),
      project: projectAbs || process.cwd(),
    };
    const dir = process.env.AI_SDLC_TELEMETRY_DIR || join(homedir(), ".local", "share", "opencode", "usage-data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "tool-sequences.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // Never fail — telemetry is best-effort
  }
}

// ── Session banner (port of session-start.js / subagent-start.js) ─────

function renderGovernanceBanner(policy) {
  const g = policy.governance;
  const lines = [
    `# ${BANNER_MARKER} — hard rules (injected by the ai-sdlc.governance plugin; enforced at runtime, not by this text)`,
    `- **Never merge PRs** — the only sanctioned merge path is 'node pipeline-cli/bin/cli-merge-if-eligible.mjs'; arming auto-merge ('gh pr merge --auto') is allowed.`,
    g.allowForcePush
      ? `- **Force-push** is allowed per repo policy — still use \`--force-with-lease\` only.`
      : `- **Never force-push** (\`git push --force\`/\`-f\`) — the ONLY permitted form is \`--force-with-lease\` after the mandatory rebase.`,
    g.allowClosePrIssue
      ? `- **PRs/issues may be closed per repo policy.**`
      : `- **Never close PRs or issues** (\`gh pr close\`, \`gh issue close\`).`,
    g.allowBranchDelete
      ? `- **Branch deletion is allowed per repo policy.**`
      : `- **Never delete branches** (\`git branch -D\`/\`-d\`).`,
    g.allowResetHard
      ? `- **\`git reset --hard\` is allowed per repo policy.**`
      : `- **Never run destructive git** (\`git reset --hard\`, \`git checkout -- .\`, \`git restore .\`).`,
    `- **No bare stash ops** — never \`git stash pop\`/\`clear\`/bare \`drop\`; ${SAFE_STASH_PATTERN}`,
    `- **Never write under \`.ai-sdlc/\`** or any path the project lists in \`.ai-sdlc/agent-role.yaml\` blockedPaths.`,
    `- **Never write outside the active worktree** unless the active task's frontmatter permittedExternalPaths allows it.`,
  ];
  return lines.join("\n");
}

// ── Setup ─────────────────────────────────────────────────────────────

/**
 * Resolve the session's working directory (the base for relative path
 * resources). Order: session record → this process's location → cwd.
 */
async function sessionDir(ctx, sessionID) {
  try {
    const s = await ctx.session.get(sessionID);
    const d = s?.location?.directory ?? s?.directory;
    if (typeof d === "string" && d) return resolve(d);
  } catch {
    // fall through
  }
  try {
    const d = ctx.location?.directory;
    if (typeof d === "string" && d) return resolve(d);
  } catch {
    // fall through
  }
  return process.cwd();
}

export default {
  id: "ai-sdlc.governance",
  setup: async (ctx) => {
    const registrations = [];
    const register = async (fn) => {
      try {
        const reg = await fn();
        if (reg?.dispose) registrations.push(reg);
      } catch {
        // registration failure is fail-open — the other hooks still run
      }
    };

    // 1) permission.evaluate — the sanctioned deny path. Fires for every
    //    evaluation that was NOT already denied declaratively (opencode.json
    //    is evaluated first and short-circuits); we may override
    //    effect + message. Effective policy = union of both layers, so
    //    governance is immune to config merge ordering.
    await register(() =>
      ctx.permission.hook("evaluate", async (input) => {
        try {
          const action = String(input.action ?? "");
          const resources = Array.isArray(input.resources) ? input.resources : [input.resources];
          const resource = resources[0];
          const root = deriveProjectRoot();
          let verdict = null;

          if (action === "shell" || action === "bash") {
            verdict = checkShellCommand(typeof resource === "string" ? resource : "", loadPolicy(root));
          } else if (action === "edit" || action === "write" || action === "patch") {
            const dir = await sessionDir(ctx, input.sessionID);
            if (typeof resource === "string" && resource) {
              verdict = checkPath(resource, loadPolicy(root), root, dir);
            }
          }
          // MCP tools (ai-sdlc_*) and everything else: no opinion.

          if (verdict && verdict.blocked) {
            input.effect = "deny";
            input.message = `Blocked by AI-SDLC governance policy: ${verdict.reason}`;
          }
        } catch {
          // fail-open — a plugin error must never break a session
        }
      }),
    );

    // 2) tool.execute.after — telemetry JSONL (port of collect-tool-sequence).
    await register(() =>
      ctx.tool.hook("execute.after", async (e) => {
        try {
          appendTelemetry(e?.sessionID, e?.tool, e?.input, deriveProjectRoot());
        } catch {
          // never fail
        }
      }),
    );

    // 3) session.context — hard-rules banner (port of session-start.js).
    //    Marker-guarded so it is never double-injected; the push is
    //    idempotent-safe either way (if the mutation doesn't persist across
    //    model calls we re-see a marker-free system and re-push; if it does,
    //    the guard skips).
    await register(() =>
      ctx.session.hook("context", async (req) => {
        try {
          const system = req?.system;
          if (!Array.isArray(system)) return;
          if (system.some((p) => typeof p?.text === "string" && p.text.includes(BANNER_MARKER))) return;
          system.push({ type: "text", text: renderGovernanceBanner(loadPolicy(deriveProjectRoot())) });
        } catch {
          // fail-open
        }
      }),
    );

    return async () => {
      for (const reg of registrations) {
        try {
          await reg.dispose();
        } catch {
          // ignore
        }
      }
    };
  },
};
