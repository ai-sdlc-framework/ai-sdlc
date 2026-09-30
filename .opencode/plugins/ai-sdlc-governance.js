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

import {
  readFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, isAbsolute, relative, sep, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BANNER_MARKER = 'AI-SDLC GOVERNANCE';

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

// ── spec.governance resolver (port of governance-resolver.js) ─────────
//
// Fail-closed (RFC-0048): unknown keys / malformed values are IGNORED —
// the resolved value falls back to strict defaults. Malformed input never
// relaxes a rule. An ABSENT governance section → strict defaults, so
// adopters without one are unchanged.

const STRICT_DEFAULTS = Object.freeze({
  allowMerge: 'never',
  allowForcePush: false,
  allowClosePrIssue: false,
  allowBranchDelete: false,
  allowResetHard: false,
});

const KNOWN_PRESETS = new Set(['strict', 'operator-trusted']);
const GOV_BOOLEAN_KEYS = [
  'allowForcePush',
  'allowClosePrIssue',
  'allowBranchDelete',
  'allowResetHard',
];

function parseGovernanceBlock(yamlText) {
  if (typeof yamlText !== 'string') return null;
  const lines = yamlText.split('\n');
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
    let value = kv[2].replace(/\s+#.*$/, '').trim();
    if (value === '') continue;
    value = value.replace(/^['"]/, '').replace(/['"]$/, '');
    if (value === 'true') raw[key] = true;
    else if (value === 'false') raw[key] = false;
    else raw[key] = value;
  }
  return found ? raw : null;
}

function resolveGovernance(rawGovernance) {
  const resolved = { ...STRICT_DEFAULTS };
  if (!rawGovernance || typeof rawGovernance !== 'object') return resolved;
  if (typeof rawGovernance.preset === 'string' && KNOWN_PRESETS.has(rawGovernance.preset)) {
    if (rawGovernance.preset === 'operator-trusted') resolved.allowMerge = 'onGreenClean';
  }
  if (typeof rawGovernance.allowMerge === 'string') {
    const v = rawGovernance.allowMerge;
    if (v === 'never' || v === 'onGreenClean') resolved.allowMerge = v;
  }
  for (const key of GOV_BOOLEAN_KEYS) {
    if (typeof rawGovernance[key] === 'boolean') resolved[key] = rawGovernance[key];
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
    yaml = readFileSync(join(root, '.ai-sdlc', 'agent-role.yaml'), 'utf-8');
  } catch {
    return empty;
  }
  return {
    blockedActions: parseListField(yaml, 'blockedActions'),
    blockedPaths: parseListField(yaml, 'blockedPaths'),
    governance: resolveGovernance(parseGovernanceBlock(yaml)),
  };
}

// ── Matchers ──────────────────────────────────────────────────────────

/** Command-pattern match — port of the Claude hook's blockedActions test
 *  (escape metachars, `*` → `.*`, full-anchored, case-insensitive). */
function cmdMatch(pattern, command) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(command);
}

/** Path-glob match — port of the hook's matchGlob (`**` crosses `/`,
 *  `*` does not; case-insensitive so case-insensitive filesystems cannot
 *  bypass a floor by casing alone). */
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
  return new RegExp(`^${regexStr}$`, 'i').test(path);
}

// ── Shell governance (port of enforce-blocked-actions.js) ─────────────

const SAFE_ARM_FLAGS = new Set([
  '--auto',
  '--squash',
  '--merge',
  '--rebase',
  '--delete-branch',
  '-d',
  '--admin',
]);
const VALUE_FLAGS = new Set(['-R', '--repo']);

function splitShellSegments(command) {
  return command
    .split(/(?:&&|\|\||;|\||&|\n)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Removes an unquoted trailing shell comment and all quote characters. */
function stripCommentAndQuotes(segment) {
  return segment.replace(/(^|\s)#.*$/, '$1').replace(/['"]/g, '');
}

/** Removes only a trailing unquoted shell comment (quotes preserved). */
function stripComment(segment) {
  return segment.replace(/(^|\s)#.*$/, '$1');
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
  if (tokens[i] !== 'gh' || tokens[i + 1] !== 'pr' || tokens[i + 2] !== 'merge') return false;
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
      i++; // consume the flag's value token (matches gh's own parser)
      continue;
    }
    if (
      !sawPositional &&
      !tok.startsWith('-') &&
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

const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
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
  const lines = command.split('\n');
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
      const bodyLine = dashed ? lines[i].replace(/^\t+/, '') : lines[i];
      i++;
      if (bodyLine === marker) break;
    }
  }
  return kept.join('\n');
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
  out = out.replace(/\$\{IFS\}/g, ' ');
  out = out.replace(/\$\{IFS[^}A-Za-z0-9_][^}]*\}/g, ' ');
  out = out.replace(/\$IFS\b/g, ' ');
  out = out.replace(/\$\{[^}]*\}/g, '');
  out = out.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '');
  out = stripCommentAndQuotes(out);
  out = out.replace(/\\/g, '');
  out = out.replace(/[(){}`$]/g, ' ');
  return out;
}

/** True when `tok` is `git` or a path ending in `/git` (e.g. `/usr/bin/git`). */
function isGitToken(tok) {
  return typeof tok === 'string' && /(^|\/)git$/.test(tok);
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
    if (tok === 'stash') return j;
    if (GIT_GLOBAL_VALUE_FLAGS.has(tok)) {
      j += 2;
      continue;
    }
    if (tok.startsWith('-')) {
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
    if (!tokens[i].startsWith('-')) return true;
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
  if (!sub || sub.startsWith('-')) return { blocked: false };

  if (sub === 'pop') {
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

  if (sub === 'clear') {
    return {
      blocked: true,
      reason:
        `'git stash clear' DELETES every entry on the SHARED stash stack (main checkout + all ` +
        `worktrees + concurrent sessions), destroying stashes that may belong to the operator or a ` +
        `sibling session. Safe pattern: ${SAFE_STASH_PATTERN}.`,
    };
  }

  if (sub === 'drop') {
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
 *
 * The carve-out is STRICT (AISDLC-660 review): a prefix glob such as
 * `git push --force-with-lease*` also matches
 * `git push --force-with-lease --force origin main`, which is a plain
 * force-push. So the carve-out applies only when `isStrictLeasePush` holds.
 */
const FORCE_PUSH_PATTERN_RE = /^git push (--force|-f)/;
const PROTECTED_PUSH_TARGETS = new Set(['main', 'master']);

function isForcePushPattern(pattern) {
  return FORCE_PUSH_PATTERN_RE.test(pattern);
}

/** Command prefixes that merely wrap the real command (`env git push …`). */
const WRAPPER_PREFIXES = new Set([
  'env',
  'command',
  'exec',
  'nice',
  'time',
  'nohup',
  'sudo',
  'timeout',
  'stdbuf',
  'caffeinate',
  'xcrun',
]);
// Wrapper flags that take a SEPARATE value token.
const WRAPPER_VALUE_FLAGS = {
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
};

/**
 * Tokenize a segment for git analysis. Reuses normalizeStashObfuscation (quote
 * stripping, `$VAR`/`${IFS}` collapsing, backslash removal) so obfuscated
 * spellings normalize to what a real shell would execute, then drops leading
 * env assignments and wrapper prefixes (env, /usr/bin/env, command, exec,
 * nice, time, timeout <dur>, stdbuf, caffeinate, xcrun, sudo -u <user> and
 * their flags). Returns null when the command is not a git invocation.
 * Best effort only — see the runbook: this is NOT a shell parser.
 */
function parseGit(segment) {
  const rawTokens = normalizeStashObfuscation(segment).trim().split(/\s+/).filter(Boolean);
  // Drop redirections: `2>&1`, `>out`, and a bare operator plus its target (`> file`).
  const tokens = [];
  for (let k = 0; k < rawTokens.length; k++) {
    const t = rawTokens[k];
    if (/^\d*[<>]+$/.test(t)) k++;
    else if (!/^\d*[<>]+\S*$/.test(t)) tokens.push(t);
  }
  let i = 0;
  const envAssigns = [];
  for (;;) {
    if (i >= tokens.length) return null;
    const t = tokens[i];
    const base = t.split('/').pop();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      envAssigns.push(t);
      i++;
    } else if (WRAPPER_PREFIXES.has(base)) {
      i++;
      const valueFlags = WRAPPER_VALUE_FLAGS[base];
      let needDuration = base === 'timeout';
      while (i < tokens.length) {
        const w = tokens[i];
        if (w.startsWith('-')) {
          i += valueFlags && valueFlags.has(w) ? 2 : 1;
        } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
          envAssigns.push(w); // `env VAR=x git …`
          i++;
        } else if (/^\d/.test(w) && (needDuration || /^\d+$/.test(w))) {
          needDuration = false;
          i++;
        } else {
          break;
        }
      }
    } else {
      break;
    }
  }
  if (!isGitToken(tokens[i])) return null;
  i++;
  const configs = [];
  const cwdArgs = [];
  const globalOpts = [];
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const t = tokens[i];
    if (t === '-c' && tokens[i + 1] !== undefined) {
      configs.push(tokens[i + 1]);
      i += 2;
    } else if (t === '-C' && tokens[i + 1] !== undefined) {
      cwdArgs.push(tokens[i + 1]);
      i += 2;
    } else if (t.startsWith('-c') && t.length > 2 && !t.startsWith('--')) {
      configs.push(t.slice(2));
      i += 1;
    } else {
      globalOpts.push(t);
      i += GIT_GLOBAL_VALUE_FLAGS.has(t) ? 2 : 1;
    }
  }
  return {
    subcommand: tokens[i],
    args: tokens.slice(i + 1),
    configs,
    cwdArgs,
    cwdArg: cwdArgs.length === 1 ? cwdArgs[0] : null,
    globalOpts,
    envAssigns,
  };
}

/** `-c alias.*` (hides the real subcommand) and push-rewriting configs. */
function hasDangerousGitConfig(parsed) {
  return parsed.configs.some(
    (c) =>
      /^alias\./i.test(c) ||
      (parsed.subcommand === 'push' &&
        /^(remote\.[^=]*\.(push|mirror|pushurl)|push\.default|branch\.[^=]*\.(merge|remote|pushremote))=?/i.test(
          c,
        )),
  );
}

// Long options of `git push` that widen a push beyond the named branch or run
// code. git accepts any unambiguous PREFIX of a long option, so matching is by
// prefix (`--mirr` == `--mirror`); an ambiguous prefix is treated as every
// option it could mean (fail closed).
const DANGEROUS_PUSH_LONG = [
  'mirror',
  'delete',
  'force',
  'all',
  'branches',
  'tags',
  'prune',
  'receive-pack',
  'exec',
];
const FORCEISH_PUSH_LONG = ['force', 'force-with-lease', 'force-if-includes', 'mirror'];
// `--signed` only takes `--signed=<v>` (never a separate value token).
const PUSH_LONG_VALUE_OPTS = ['repo', 'push-option', 'receive-pack', 'exec'];

function longOptMatches(tok, candidates) {
  if (!tok.startsWith('--') || tok.length < 3) return [];
  const name = tok.slice(2).split('=')[0];
  if (!name) return [];
  const exact = candidates.filter((c) => c === name);
  if (exact.length > 0) return exact;
  return candidates.filter((c) => c.startsWith(name));
}

/** `--force-with-lease[=…]` or an unambiguous abbreviation (`--force-w…`). */
function isLeaseFlag(tok) {
  const m = tok.match(/^--(force-w[a-z-]*)(=.*)?$/);
  return !!m && 'force-with-lease'.startsWith(m[1]);
}

/** True when an arg list carries any force-ish flag (incl. lease) or `+refspec`. */
function hasForceIndicator(args) {
  return args.some(
    (t) =>
      isLeaseFlag(t) ||
      longOptMatches(t, FORCEISH_PUSH_LONG).length > 0 ||
      (/^-[A-Za-z]+$/.test(t) && t.includes('f')) ||
      (!t.startsWith('-') && (t.startsWith('+') || t.includes(':+'))),
  );
}

/**
 * Current branch of `dir`, or null when unresolvable / detached. Uses
 * `symbolic-ref` (works on an unborn branch, exits 1 on a detached HEAD) —
 * equivalent to `rev-parse --abbrev-ref HEAD` for this purpose.
 */
function resolveCurrentBranch(dir) {
  if (!dir) return null;
  try {
    const out = execFileSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return out && out !== 'HEAD' ? out : null;
  } catch {
    return null;
  }
}

/** True when `branch` (already stripped of refs/heads/) is main/master-like. */
function isProtectedBranchName(branch) {
  const parts = branch.toLowerCase().split('/');
  if (PROTECTED_PUSH_TARGETS.has(branch.toLowerCase())) return true;
  return PROTECTED_PUSH_TARGETS.has(parts[parts.length - 1]);
}

/**
 * Validate ONE push destination. Returns true when it is a plain, non-glob,
 * non-protected branch (`name`, `heads/name` or `refs/heads/name`).
 */
function isSafeBranchDestination(dst) {
  if (!dst || /[*?[\]^~\\]/.test(dst) || dst.includes('..') || dst.startsWith('-')) return false;
  let name = dst;
  if (name.startsWith('refs/')) {
    if (!name.startsWith('refs/heads/')) return false; // tags, notes, remotes, …
    name = name.slice('refs/heads/'.length);
  } else if (name.startsWith('heads/')) {
    name = name.slice('heads/'.length); // git expands heads/x -> refs/heads/x
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  const segs = name.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  return !isProtectedBranchName(name);
}

/**
 * Strict lease form: `--force-with-lease[=<ref>[:<sha>]]` and NOTHING wider:
 *   - no other force flag (`--force`, `-f`/`-fu`; `--force-if-includes` is
 *     tolerated — it only tightens the lease), no `--mirror/--all/--branches/
 *     --tags/--prune/--delete`, no `--receive-pack/--exec` (abbreviations of
 *     any long option are matched by prefix);
 *   - every refspec destination is a plain branch name or refs/heads/<name>:
 *     no `+`, no glob, not main/master (final path component included, and
 *     after stripping `refs/`/`heads/`), no delete (`:dst`);
 *   - `HEAD`, `@`, or NO refspec resolve to the current branch of `cwd`
 *     (`git rev-parse --abbrev-ref HEAD`); unresolvable => denied (fail closed).
 */
function isStrictLeasePush(segment, cwd, tainted = false) {
  // Fail closed on any shell expansion: `$BR`, `${BR}`, `$'\\x6dain'`, `$(…)`, backticks.
  if (/[$`]/.test(segment)) return false;
  // A preceding cd / GIT_* export / ref-mutating segment changes what the push means.
  if (tainted) return false;
  const parsed = parseGit(segment);
  if (!parsed || parsed.subcommand !== 'push') return false;
  if (hasDangerousGitConfig(parsed)) return false;
  if (
    parsed.envAssigns.some((e) => /^GIT_(DIR|WORK_TREE|CONFIG_\w+|CONFIG_PARAMETERS)=/i.test(e)) ||
    parsed.globalOpts.some((o) => /^--(git-dir|work-tree|namespace)\b/.test(o))
  ) {
    return false;
  }
  // At most ONE -C, and it must be a plain path under the session dir.
  if (parsed.cwdArgs.length > 1) return false;
  if (parsed.cwdArgs.length === 1) {
    const target = resolve(cwd || process.cwd(), parsed.cwdArgs[0]);
    const base = resolve(cwd || process.cwd());
    if (target !== base && !target.startsWith(base + sep)) return false;
  }
  const args = parsed.args;
  if (args.some((t) => /^--(git-dir|work-tree)\b/.test(t))) return false;
  if (!args.some(isLeaseFlag)) return false;

  const positionals = [];
  let repoFlag = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t.startsWith('--')) {
      // `--force-with-lease` / `--force-if-includes` match nothing dangerous;
      // a bare or ambiguous-prefix `--force`/`--forc` does (fail closed).
      if (longOptMatches(t, DANGEROUS_PUSH_LONG).length > 0) return false;
      if (longOptMatches(t, ['repo']).length > 0) repoFlag = true;
      if (!t.includes('=') && longOptMatches(t, PUSH_LONG_VALUE_OPTS).length === 1) i++;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(t)) {
      if (t.includes('f') || t.includes('d')) return false;
      if (t === '-o') i++;
      continue;
    }
    if (t.startsWith('-')) return false;
    positionals.push(t);
  }
  const refspecs = repoFlag ? positionals : positionals.slice(1);

  const gitDir = parsed.cwdArg ? resolve(cwd || process.cwd(), parsed.cwdArg) : cwd;
  const needsCurrent = refspecs.length === 0 || refspecs.some((s) => s === 'HEAD' || s === '@');
  let current = null;
  if (needsCurrent) {
    current = resolveCurrentBranch(gitDir);
    if (!current || !isSafeBranchDestination(current)) return false;
  }
  for (const spec of refspecs) {
    if (spec === 'HEAD' || spec === '@') continue; // resolved + validated above
    if (spec.startsWith('+') || spec.includes(':+')) return false;
    const colon = spec.indexOf(':');
    let dst = spec;
    if (colon !== -1) {
      const src = spec.slice(0, colon);
      dst = spec.slice(colon + 1);
      if (!src || !dst || dst === 'HEAD' || dst === '@') return false; // delete / ambiguous
    }
    if (!isSafeBranchDestination(dst)) return false;
  }
  return true;
}

/**
 * Wrapped/dynamic invocations (`bash -c '…'`, `$(…)`, backticks, eval, xargs)
 * cannot be analysed statically. Fail closed: if the raw command text contains
 * a git push together with any force-ish token, deny it (documented in the
 * runbook; write the push as a plain top-level command instead).
 */
function wrappedForcePushSuspicion(command) {
  const wrapped =
    // any shell (sh/bash/zsh/ksh/dash) with ANY flags before -c
    /\b(?:ba|z|k|da)?sh\b[^|;&\n]*\s-[A-Za-z]*c[A-Za-z]*(\s|$)/.test(command) ||
    // piping text into a shell
    /\|\s*(?:\S*\/)?(?:ba|z|k|da)?sh\b/.test(command) ||
    // interpreters running inline code
    /\b(?:python[\d.]*|node|perl|ruby)\b[^|;&\n]*\s-[ecEC]\b/.test(command) ||
    /(\beval\b|\bxargs\b|\$\(|`)/.test(command);
  if (!wrapped) return false;
  const flat = normalizeStashObfuscation(command);
  if (!/\bpush\b/.test(flat)) return false;
  return /(^|[\s,[(])(--force\S*|--mirr\S*|--all|--branches|--tags|-[A-Za-z]*f[A-Za-z]*|\+\S+)(?=[\s,\])]|$)/.test(
    flat,
  );
}

/**
 * Commands that re-point what a later push means or rewrite push config:
 * `git config` setting remote.*.push / push.default / alias.*, `git
 * symbolic-ref <name> <target>`, `git branch -f|-M main|master`, `git
 * checkout -B|switch -C main|master`. Returns a reason string or null.
 * Best effort: only the trivially recognisable spellings.
 */
function refMutationReason(parsed) {
  if (!parsed) return null;
  const args = parsed.args;
  const positional = args.filter((a) => !a.startsWith('-'));
  if (parsed.subcommand === 'config') {
    const readOnly = args.some((a) =>
      /^--(get|get-all|get-regexp|list|unset|unset-all)$|^-l$/.test(a),
    );
    if (
      !readOnly &&
      positional.some((k) =>
        /^(remote\.[^.]*\.(push|mirror|pushurl)|push\.default|alias\..*)$/i.test(k),
      )
    ) {
      return 'git config must not set remote.*.push/mirror, push.default or alias.*';
    }
  }
  if (parsed.subcommand === 'symbolic-ref' && positional.length >= 2) {
    return 'git symbolic-ref must not re-point a ref';
  }
  const forceBranch = args.some((a) => /^(-f|--force|-M|-B|-C)$/.test(a));
  const protectedArg = positional.some((a) => PROTECTED_PUSH_TARGETS.has(a.toLowerCase()));
  if (
    (parsed.subcommand === 'branch' ||
      parsed.subcommand === 'checkout' ||
      parsed.subcommand === 'switch') &&
    forceBranch &&
    protectedArg
  ) {
    return 'forcing/resetting a local main/master branch is not permitted';
  }
  return null;
}

/** True for a segment that changes directory or GIT_* environment for what follows. */
function isTaintingSegment(segment) {
  const flat = normalizeStashObfuscation(segment).trim();
  if (/^(?:(?:command|builtin)\s+)?(?:cd|pushd|popd)\b/.test(flat)) return true;
  // `GIT_DIR=x`, `export GIT_DIR=x`, `export FOO=1 GIT_DIR=x`, `declare|typeset -x GIT_DIR=x`
  return /^(?:(?:export|declare\s+-x|typeset\s+-x)\s+)?(?:[A-Za-z_]\w*=\S*\s+)*GIT_(?:DIR|WORK_TREE|CONFIG_\w+)=/i.test(
    flat,
  );
}

/**
 * blockedActions matching, SEGMENT-AWARE (splits on shell control operators
 * first, so a chained `cd x && git push --force origin` is still caught —
 * a strict superset of the Claude hook's whole-command match). Force-push
 * patterns are additionally enforced by token analysis so a force flag AFTER
 * the remote (`git push origin main --force`) cannot dodge the prefix glob.
 * Only a strict lease push (see isStrictLeasePush) survives.
 */
function checkBlockedActions(command, patterns, cwd) {
  const hasForceRule = patterns.some(isForcePushPattern);
  let tainted = false;
  for (const segment of splitShellSegments(command)) {
    const wasTainted = tainted;
    if (isTaintingSegment(segment)) tainted = true;
    for (const pattern of patterns) {
      if (!cmdMatch(pattern, segment)) continue;
      if (isForcePushPattern(pattern) && isStrictLeasePush(segment, cwd, wasTainted)) {
        continue; // carve-out: the DoD-required lease-protected form
      }
      return { blocked: true, reason: `command matches blockedAction pattern '${pattern}'` };
    }
    if (hasForceRule) {
      const parsed = parseGit(segment);
      // Any push whose RAW text contains an expansion is unanalysable
      // (normalisation deletes `$VAR`/`${…}`): `git push ${F:---force} origin ${M:-main}`,
      // `F=--force; git push $F origin`. Deny the push outright.
      if (parsed && parsed.subcommand === 'push' && /[$`]/.test(segment)) {
        return {
          blocked: true,
          reason:
            'a git push containing a shell expansion ($VAR, ${…}, $(…), backticks) cannot be ' +
            'verified — write the refspec and flags literally',
        };
      }
      if (
        parsed &&
        parsed.subcommand === 'push' &&
        hasForceIndicator(parsed.args) &&
        !isStrictLeasePush(segment, cwd, wasTainted)
      ) {
        return {
          blocked: true,
          reason:
            'force-push is blocked; the only permitted form is a strict ' +
            "'git push --force-with-lease[=<ref>[:<sha>]] <remote> <branch>' with no other force " +
            'flag, no --all/--branches/--tags/--mirror, no "+" refspec, no glob destination, and a ' +
            'non-main/master destination (HEAD / no refspec resolve to the current branch)',
        };
      }
    }
  }
  if (hasForceRule && wrappedForcePushSuspicion(command)) {
    return {
      blocked: true,
      reason:
        'a git push with force-ish flags inside a wrapped/dynamic command (bash -c, eval, xargs, ' +
        '$(…), backticks) cannot be verified — run the push as a plain top-level command',
    };
  }
  return null;
}

/**
 * Full shell-command governance (the port of enforceBash): merge governance
 * and stash governance are unconditional floors; blockedActions is
 * config-driven. Returns the first blocking verdict or null. `cwd` is the
 * session directory (used to resolve the current branch for bare pushes).
 */
function checkShellCommand(command, policy, cwd) {
  if (!command || typeof command !== 'string' || !command.trim()) return null;
  // Join backslash-newline continuations BEFORE segment splitting, or
  // `git push \<nl> --force` would split into two harmless-looking segments.
  const trimmed = command.replace(/\\\r?\n/g, ' ').trim();

  for (const segment of splitShellSegments(trimmed)) {
    const verdict = checkMergeGovernance(segment, policy.governance);
    if (verdict) return verdict;
    const parsed = parseGit(segment);
    const mutation = refMutationReason(parsed);
    if (mutation) return { blocked: true, reason: mutation };
    if (parsed && hasDangerousGitConfig(parsed)) {
      return {
        blocked: true,
        reason:
          'git -c alias.* / remote.*.push|mirror overrides can hide or rewrite a push and are not permitted',
      };
    }
  }

  const stash = checkStashGovernance(trimmed);
  if (stash) return stash;

  if (policy.blockedActions.length > 0) {
    return checkBlockedActions(trimmed, policy.blockedActions, cwd);
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

  const worktreesRoot = join(projectAbs, '.worktrees');
  if (start !== worktreesRoot && !start.startsWith(worktreesRoot + sep)) {
    return null;
  }

  let current = start;
  for (;;) {
    if (dirname(current) === worktreesRoot) {
      return join(current, '.active-task');
    }
    const parent = dirname(current);
    if (parent === current) return null; // hit fs root
    if (parent === worktreesRoot) return join(current, '.active-task');
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
      const id = readFileSync(perWorktree, 'utf-8').trim();
      if (id) return id;
    } catch {
      // fall through
    }
  }

  const projectSentinel = join(projectAbs, '.worktrees', '.active-task');
  if (existsSync(projectSentinel)) {
    try {
      const id = readFileSync(projectSentinel, 'utf-8').trim();
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

  const tasksDir = join(projectAbs, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) return [];

  let entries;
  try {
    entries = readdirSync(tasksDir);
  } catch {
    return [];
  }

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

/**
 * AISDLC-567: warn (non-blocking, offline) when `dir`'s HEAD is behind the
 * locally cached `origin/main`. No `git fetch` — hooks must stay fast.
 * Silent on any error; best-effort advisory only.
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
    // best-effort only — never block
  }
}

const HARNESS_CONFIG_FLOOR = ['opencode.json', 'opencode.jsonc', '.opencode/**'];

/**
 * realpath of the DEEPEST EXISTING ancestor of `abs`, re-joined with the
 * not-yet-existing tail. A write through a symlink (`link -> /etc`,
 * `docs -> .ai-sdlc`) must be judged by where it actually lands.
 */
function realResolve(abs) {
  let current = abs;
  const tail = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return join(realpathSync(current), ...tail.reverse());
      } catch {
        return abs;
      }
    }
    const parent = dirname(current);
    if (parent === current) return abs;
    tail.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
}

/**
 * permittedExternalPaths with a per-task cache. The cache is PRIMED at plugin
 * setup for the dispatched task; once primed, that task id is authoritative
 * (a later `.active-task` rewrite or task-file edit made from a shell inside
 * the worktree cannot widen the allowance).
 */
function getPermittedExternalPaths(projectAbs, searchFrom, cache) {
  const id = cache.primedId || readActiveTaskId(projectAbs, searchFrom);
  if (!id) return [];
  if (!cache.byTask.has(id))
    cache.byTask.set(id, loadPermittedExternalPaths(projectAbs, searchFrom));
  return cache.byTask.get(id);
}

function newPermittedCache(projectAbs) {
  const cache = { byTask: new Map(), primedId: null };
  try {
    const id = readActiveTaskId(projectAbs, projectAbs);
    if (id) {
      cache.primedId = id;
      cache.byTask.set(id, loadPermittedExternalPaths(projectAbs, projectAbs));
    }
  } catch {
    // best effort — lazy lookup still works
  }
  return cache;
}

/**
 * Full path governance (port of enforceWriteEdit). `home` is the active
 * worktree when resolvable (cwd shape), else the project root.
 *
 *   - inside home: hardcoded `.ai-sdlc/**` floor (always) + harness-config
 *     floor + project blockedPaths globs (relative to home)
 *   - outside home: allowed only under the active task's
 *     permittedExternalPaths (uniform for loose files AND sibling repos —
 *     AISDLC-567 Part B)
 *
 * Relative paths resolve against `searchFrom` (the session directory) —
 * more accurate than the Claude hook, which resolved against the project
 * root and was only correct when the tool cwd WAS the root. Symlinks are
 * resolved (deepest existing ancestor) before comparing, so a link inside the
 * worktree cannot smuggle a write outside it or into a blocked directory.
 */
function checkPath(filePath, policy, projectAbs, searchFrom, permittedCache) {
  if (!filePath || typeof filePath !== 'string') return null;

  const base = searchFrom || projectAbs;
  const absPath = isAbsolute(filePath) ? resolve(filePath) : resolve(base, filePath);
  const realAbs = realResolve(absPath);

  const worktreeDir = resolveActiveWorktreeDir(projectAbs, searchFrom || projectAbs);
  const homeAbs = worktreeDir || projectAbs;
  const realHome = realResolve(homeAbs);
  const within = (p, dir) => p === dir || p.startsWith(dir + sep);
  const insideHome = within(realAbs, realHome);

  warnIfStaleBase(homeAbs);

  if (insideHome) {
    // Judge BOTH the real landing spot and (when lexically inside) the path as
    // written: a symlink can hide a blocked dir, and case/alias games can
    // hide it the other way.
    const rels = [relative(realHome, realAbs).split(sep).join('/')];
    if (within(absPath, homeAbs)) rels.push(relative(homeAbs, absPath).split(sep).join('/'));

    for (const relPath of rels) {
      // `.ai-sdlc/**` is ALWAYS refused, regardless of agent-role.yaml
      // content (or its absence) — hardcoded floor (AISDLC-567 Part A).
      if (matchGlob('.ai-sdlc/**', relPath) || relPath === '.ai-sdlc') {
        return {
          blocked: true,
          reason:
            `path '${relPath}' is under .ai-sdlc/, which is never editable — pipeline ` +
            `configuration is out of scope for agent edits regardless of project config.`,
        };
      }

      // Harness-config floor (AISDLC-660 review): an agent must not rewrite the
      // very permission policy / plugin that governs it.
      for (const glob of HARNESS_CONFIG_FLOOR) {
        if (matchGlob(glob, relPath)) {
          return {
            blocked: true,
            reason:
              `path '${relPath}' is opencode harness configuration (governance policy/plugin) — ` +
              `never editable by the agent it governs.`,
          };
        }
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
    }
    return null;
  }

  const allowed = getPermittedExternalPaths(projectAbs, searchFrom || projectAbs, permittedCache);
  for (const ext of allowed) {
    const extAbs = resolve(projectAbs, ext);
    if (within(absPath, extAbs) && within(realAbs, realResolve(extAbs))) {
      return null; // explicit allow
    }
  }

  return {
    blocked: true,
    reason:
      allowed.length === 0
        ? `path '${realAbs}' is outside the agent's active worktree/project root. To permit ` +
          `cross-repo writes for this task, add 'permittedExternalPaths' to the task frontmatter ` +
          `and set AI_SDLC_ACTIVE_TASK_ID before invoking the agent.`
        : `path '${realAbs}' is outside the agent's active worktree/project root and not under ` +
          `the active task's permittedExternalPaths (${allowed.join(', ')}).`,
  };
}

// ── Telemetry (port of collect-tool-sequence.js) ──────────────────────

/**
 * Canonicalize a tool call to a short action token (same scheme as the
 * Claude PostToolUse hook; tool names are the v2 lowercase set and the
 * input field for read/edit/write is `path`).
 */
function canonicalizeAction(tool, input) {
  const inp = input && typeof input === 'object' ? input : {};
  switch (tool) {
    case 'shell':
    case 'Bash': {
      const cmd = String(inp.command || '').trim();
      const lastCmd = cmd.includes('&&') ? cmd.split('&&').pop().trim() : cmd;
      const tokens = lastCmd.split(/\s+/).slice(0, 3);
      return tokens.join(' ').slice(0, 60) || 'shell';
    }
    case 'read':
      return `read:${extname(String(inp.path || '')) || 'file'}`;
    case 'edit':
      return `edit:${extname(String(inp.path || '')) || 'file'}`;
    case 'write':
      return `write:${extname(String(inp.path || '')) || 'file'}`;
    case 'grep':
      return `grep:${String(inp.pattern || '').slice(0, 30)}`;
    case 'glob':
      return `glob:${String(inp.pattern || '').slice(0, 30)}`;
    case 'subagent':
    case 'Agent':
      return `agent:${String(inp.description || '').slice(0, 30)}`;
    case 'webfetch':
      return `webfetch:${String(inp.url || '').slice(0, 40)}`;
    case 'websearch':
      return `websearch:${String(inp.query || '').slice(0, 40)}`;
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
      tool: String(tool || 'unknown'),
      action: canonicalizeAction(String(tool || ''), input),
      project: projectAbs || process.cwd(),
    };
    const dir =
      process.env.AI_SDLC_TELEMETRY_DIR ||
      join(homedir(), '.local', 'share', 'opencode', 'usage-data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'tool-sequences.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
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
  return lines.join('\n');
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
    if (typeof d === 'string' && d) return resolve(d);
  } catch {
    // fall through
  }
  try {
    const d = ctx.location?.directory;
    if (typeof d === 'string' && d) return resolve(d);
  } catch {
    // fall through
  }
  return process.cwd();
}

export default {
  id: 'ai-sdlc.governance',
  setup: async (ctx) => {
    const registrations = [];
    const register = async (fn, label) => {
      try {
        const reg = await fn();
        if (reg?.dispose) registrations.push(reg);
      } catch (err) {
        // Fail-open (the other hooks still run) but NEVER silent: a missing
        // permission.evaluate hook means the plugin layer is not enforcing.
        process.stderr.write(
          `[ai-sdlc governance] WARNING: failed to register ${label} hook: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    };

    // Snapshot the policy inputs ONCE at setup. A later shell write to
    // <worktree>/.ai-sdlc/agent-role.yaml, the task file, or .active-task
    // (shell commands are not path-governed) must not weaken enforcement.
    // Limitation: a session that starts after such a write sees the written
    // state; dispatched runs set up the plugin before the agent runs.
    const snapRoot = deriveProjectRoot();
    const snapPolicy = loadPolicy(snapRoot);
    const permittedCache = snapRoot
      ? newPermittedCache(snapRoot)
      : { byTask: new Map(), primedId: null };

    // 1) permission.evaluate — the sanctioned deny path. Fires for every
    //    evaluation that was NOT already denied declaratively (opencode.json
    //    is evaluated first and short-circuits); we may override
    //    effect + message. Effective policy = union of both layers, so
    //    governance is immune to config merge ordering.
    await register(
      () =>
        ctx.permission.hook('evaluate', async (input) => {
          try {
            const action = String(input.action ?? '');
            const resources = Array.isArray(input.resources) ? input.resources : [input.resources];
            const root = snapRoot;
            let verdict = null;

            // Check EVERY resource: a multi-resource call (e.g. a patch touching
            // several files) is denied if ANY one is blocked.
            if (action === 'shell' || action === 'bash') {
              const dir = await sessionDir(ctx, input.sessionID);
              for (const resource of resources) {
                verdict = checkShellCommand(
                  typeof resource === 'string' ? resource : '',
                  snapPolicy,
                  dir,
                );
                if (verdict) break;
              }
            } else if (action === 'edit' || action === 'write' || action === 'patch') {
              const dir = await sessionDir(ctx, input.sessionID);
              for (const resource of resources) {
                if (typeof resource !== 'string' || !resource) continue;
                verdict = checkPath(resource, snapPolicy, root, dir, permittedCache);
                if (verdict) break;
              }
            }
            // MCP tools (ai-sdlc_*) and everything else: no opinion.

            if (verdict && verdict.blocked) {
              input.effect = 'deny';
              input.message = `Blocked by AI-SDLC governance policy: ${verdict.reason}`;
            }
          } catch {
            // fail-open — a plugin error must never break a session
          }
        }),
      'permission.evaluate',
    );

    // 2) tool.execute.after — telemetry JSONL (port of collect-tool-sequence).
    await register(
      () =>
        ctx.tool.hook('execute.after', async (e) => {
          try {
            appendTelemetry(e?.sessionID, e?.tool, e?.input, deriveProjectRoot());
          } catch {
            // never fail
          }
        }),
      'tool.execute.after',
    );

    // 3) session.context — hard-rules banner (port of session-start.js).
    //    Marker-guarded so it is never double-injected; the push is
    //    idempotent-safe either way (if the mutation doesn't persist across
    //    model calls we re-see a marker-free system and re-push; if it does,
    //    the guard skips).
    await register(
      () =>
        ctx.session.hook('context', async (req) => {
          try {
            const system = req?.system;
            if (!Array.isArray(system)) return;
            if (system.some((p) => typeof p?.text === 'string' && p.text.includes(BANNER_MARKER)))
              return;
            system.push({
              type: 'text',
              text: renderGovernanceBanner(snapPolicy),
            });
          } catch {
            // fail-open
          }
        }),
      'session.context',
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
