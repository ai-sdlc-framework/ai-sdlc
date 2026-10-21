/**
 * AI-SDLC Action Enforcement Hook (PreToolUse)
 *
 * Enforces governance from .ai-sdlc/agent-role.yaml across two tool families:
 *
 * 1. **Bash** — untrusted-run shell writes and the own-branch lease push guard (no command-text matching, AISDLC-1014).
 * 2. **Write / Edit** — checks `tool_input.file_path` against `blockedPaths` globs
 *    (relative to the agent's "home" — the active worktree when resolvable, else
 *    the project root; see AISDLC-567). AISDLC-720: there is no hardcoded
 *    `.ai-sdlc/**` floor for internal sessions; `.ai-sdlc/**` and
 *    `.github/workflows/**` are refused only for UNTRUSTED runs (env signal
 *    `AI_SDLC_UNTRUSTED_RUN`, see lib/governance-resolver `isUntrustedRun`) or
 *    when a project lists them in `blockedPaths`. `.github/workflows/**` is NOT blocked
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
 * 4. **Own-branch lease push** (AISDLC-1005, lib/lease-push-guard.js).
 *
 * AISDLC-1014 (DEC-0267): the command-text matcher (blockedActions glob
 * patterns, the raw landing, API landing, stash and policy-root text checks) is
 * deleted. It matched free text and refused JSON field names, paths, echo
 * strings and heredoc bodies. The controls that hold are server-side: GitHub
 * branch protection on main (no direct push, no force push, required
 * pr-ready rollup), and cli-merge-if-eligible. The prompt rule stays as
 * instruction (lib/prompt-rules.js).
 */

const {
  readFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  lstatSync,
  readlinkSync,
  writeFileSync,
  mkdirSync,
} = require('fs');
const { tmpdir } = require('os');
const { createHash } = require('crypto');
const { join, resolve, isAbsolute, relative, sep, dirname, basename } = require('path');
const { execSync, execFileSync } = require('child_process');
const {
  resolveGovernanceExtrasFromYaml,
  isUntrustedRun,
  UNTRUSTED_MARKER_FILE,
} = require('./lib/governance-resolver');
const { evaluateLeasePush, hasForcePushOption } = require('./lib/lease-push-guard');
const {
  runGit: gitOut,
  probeRef,
  readPolicyText,
  loadTrustedExtras,
  evaluateLeasePush: evaluateLeasePreflight,
  renderLeaseFailing,
  readTaskId,
  minForcePushMode,
} = require('./lib/trusted-policy');

// AISDLC-720: untrusted runs fail closed (exit 2 = block) on any internal error.
function failClosed(why) {
  process.stderr.write(
    `Blocked by AI-SDLC governance policy: this run is marked untrusted and the hook hit an ` +
      `internal error (${why}); failing closed ` +
      `(rule AISDLC-720, untrusted-run fail-closed). Next step: do not retry; describe the needed change in the PR or issue body, ` +
      `or record it with 'node pipeline-cli/bin/cli-decisions.mjs escalate'.\n`,
  );
  process.exit(2);
}
process.on('uncaughtException', (err) => {
  if (isUntrustedRun(process.env, process.cwd()).untrusted)
    failClosed(String((err && err.message) || err));
  process.stderr.write(String((err && err.stack) || err) + '\n');
  process.exit(1);
});

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
  // AISDLC-720: an untrusted run fails closed when its input cannot be read.
  if (isUntrustedRun(process.env, process.cwd()).untrusted)
    failClosed('could not read or parse the hook input');
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

let blockedPaths = [];
try {
  const yaml = readFileSync(agentRolePath, 'utf-8');
  blockedPaths = parseListField(yaml, 'blockedPaths');
} catch {
  // No agent-role.yaml (or unreadable) — fall through with empty config.
  // `.ai-sdlc/**` and the outside-worktree/permittedExternalPaths rules are
  // hardcoded floors enforced regardless of config (AISDLC-567), so we must
  // NOT exit early here the way the Bash-only enforcement used to.
}

// ── Own-branch lease policy (RFC-0051 §10) ───────────────────────────

/**
 * AISDLC-861: where a lease push runs. A leading `git -C <path> push ...` (a plain
 * path, no shell syntax) names the worktree and is rewritten to the equivalent
 * `git push ...` for the guard. The executed command keeps its `-C`, so the push
 * the guard validated is the push that runs. With no `-C` the cwd form applies
 * unchanged (an AI_SDLC_ACTIVE_TASK_ID fallback was rejected: the shell would run
 * the push in the parent cwd, where HEAD is main). The resolved cwd still passes every evaluateLeasePreflight condition
 * (worktree-location included), so a path outside `.worktrees/` is refused.
 */
function resolveLeaseTarget(command) {
  const base = toolCwd || process.cwd();
  const m = /^git[ \t]+-C[ \t]+([A-Za-z0-9_.\/@+-]+)[ \t]+(push(?:[ \t][^;&|$`()<>\n]*)?)$/.exec(
    command,
  );
  if (m) return { cwd: resolve(base, m[1]), command: `git ${m[2]}` };
  return { cwd: undefined, command };
}

/**
 * Resolves the lease policy (see lib/trusted-policy.js for the trust model).
 *
 * Step 1 reads the project-dir policy text with NO git subprocess; unless it
 * says `leaseOnOwnBranch`, the mode is `never` and nothing else runs. Because
 * that text may be a PR-tree copy, the grant is only honored when the trusted
 * main-checkout policy ALSO says lease (so a worktree copy can only tighten).
 * Any failure fails closed to `never`.
 */
function loadLeasePolicy(rawCommand) {
  // `why` says which gate closed the lease so a refusal can name the right fix
  // (see forcePushRefusal): 'policy-never' = an explicit/malformed `never`.
  const closed = (why) => ({ mode: 'never', protectedBranches: [], cwd: undefined, why });
  try {
    // A missing policy file means the repo sets nothing: the default
    // (`leaseOnOwnBranch`, AISDLC-710) applies. Any other read failure fails closed.
    const localText = readPolicyText(join(projectDir, '.ai-sdlc', 'agent-role.yaml'));
    const localMode = resolveGovernanceExtrasFromYaml(localText).forcePushMode;
    if (localMode === 'never') return closed('policy-never');
    // The lease needs an EXPLICIT, absolute CLAUDE_PROJECT_DIR: the toplevel
    // fallback used for blockedActions would make the own-session binding pass
    // trivially (project dir == whatever the cwd is in).
    const envDir = process.env.CLAUDE_PROJECT_DIR;
    if (localMode !== 'lease' && (!envDir || !isAbsolute(envDir))) return closed('no-project-dir');
    const target = resolveLeaseTarget(rawCommand);
    const cwd = target.cwd || toolCwd || process.cwd();
    const trusted = loadTrustedExtras(projectDir, cwd);
    if (!trusted) return closed('trusted-policy-unavailable');
    // A PR-tree copy can only tighten the trusted grant: the stricter mode wins.
    const mode = minForcePushMode(localMode, trusted.forcePushMode);
    if (mode === 'never') return closed('policy-never');
    // AISDLC-1005 (DEC-0264): `lease` needs no task worktree, sentinel or claim; the
    // lease itself plus the protected-branch refusal are the safeguards.
    if (mode === 'lease') {
      return {
        mode: 'lease',
        protectedBranches: trusted.protectedBranches,
        cwd,
        command: target.command,
      };
    }
    // The cwd must be a genuine dispatched worktree under <main>/.worktrees/
    // (realpath), else no lease: operator main-checkout sessions get none.
    const wt = evaluateLeasePreflight({ projectDir, cwd, env: process.env });
    if (!wt.allowed) return { ...closed('not-task-worktree'), failing: wt.failing };
    return {
      mode: 'leaseOnOwnBranch',
      protectedBranches: trusted.protectedBranches,
      cwd,
      command: target.command,
      top: wt.top,
      claimTaskId: wt.claimTaskId || null,
    };
  } catch {
    return closed('error');
  }
}

/**
 * Refusal text for a force push the guard will not allow when the lease policy is
 * NOT in effect. Always names the config key and the value that allows the push.
 * Never suggests an exit the guard itself forbids (no skip variable, no hook
 * bypass flag, no plain force) — the next step is the config or the task worktree.
 */
function forcePushRefusal(why, failing) {
  const key = 'spec.governance.allowForcePush in .ai-sdlc/agent-role.yaml';
  if (why === 'policy-never') {
    return (
      `force-push is refused because ${key} resolves to never (set explicitly in this repo). ` +
      `Agents must not edit .ai-sdlc/. Next step: do not force-push; push with 'git push origin HEAD:refs/heads/<own-branch>' ` +
      `(after 'git fetch origin main && git rebase origin/main' when no force is needed), or record the need with ` +
      `'node pipeline-cli/bin/cli-decisions.mjs escalate --task-id <id> --summary <one line> --option <id>:<description>' ` +
      `so the dispatch or planner session routes a change of spec.governance.allowForcePush to leaseOnOwnBranch, which allows ` +
      `'git push --force-with-lease origin HEAD:refs/heads/<own-branch>' on a dispatched task's own branch. Plain force pushes and any ` +
      `push to main/master or a protected branch are never permitted.`
    );
  }
  const mainRooted =
    why === 'not-task-worktree'
      ? ` From a session rooted at the main checkout, the cwd worktree must be bound to ONE task in either of ` +
        `two ways: (1) the task id bound to the session at launch equals the worktree's .active-task, or ` +
        `(2) the session is a hierarchy executor that holds exactly one inflight claim on the dispatch ` +
        `board, for that same task. Next step: claim the task through the executor loop (/ai-sdlc executor) ` +
        `and push from its worktree, or run the push from a session rooted in the worktree.` +
        (failing && failing.length > 0
          ? ` Unmet conditions (AISDLC-798):\n${renderLeaseFailing(failing)}\n`
          : '')
      : '';
  const loc = (failing || []).find((f) => f.condition === 'worktree-location');
  const cwdCause = loc
    ? `CAUSE (AISDLC-905): the tool's cwd is outside the task worktree: the hook saw ${loc.found}, ` +
      `expected ${loc.expected}. The shell cwd can silently reset to the main checkout between calls. ` +
      `Fix: run it as a lone command from that worktree (cd <worktree> in a call of its own, then the push by itself, ` +
      `or git -C <main>/.worktrees/<task-id> push ...). `
    : '';
  return (
    cwdCause +
    `force-push is refused here: ${key} = leaseOnOwnBranch (the default) allows a lease push only from a ` +
    `dispatched task worktree under <repo>/.worktrees/ whose .active-task, directory name and ai-sdlc/<task-id>-* ` +
    `branch agree, with a trusted policy that can be read (${why}). Push from the task worktree with ` +
    `'git push --force-with-lease origin HEAD:refs/heads/<own-branch>'. Plain force pushes and any push ` +
    `to main/master or a protected branch are never permitted.` +
    mainRooted
  );
}

/** Local refs (other than refs/heads/<name>) that git would resolve the short name to. */
function refAliasState(name, cwd) {
  const candidates = [
    `refs/tags/${name}`,
    `refs/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ];
  for (const c of candidates) {
    const st = probeRef(c, cwd);
    if (st !== 'missing') return st === 'found' ? 'collides' : 'error';
  }
  return 'clear';
}

/** True when the command text mentions a git push (used to fail closed on errors). */
function looksLikeGitPush(command) {
  return /\bgit\b[\s\S]*\bpush\b/i.test(command.replace(/['"\\]/g, ''));
}

// ── Module-level constants ───────────────────────────────────────────
// Declared BEFORE the top-level dispatch below so they are initialized before
// enforceBash() runs at module load — a `const` in the temporal dead zone here
// would crash the hook (fail-OPEN). Do not move these below the dispatch.

// ── AISDLC-720: untrusted-run enforcement ───────────────────────────
// Signal is read ONCE from this hook process's own environment. Nothing in the
// tool input (including `VAR=0 cmd`, `export`, `unset`), agent-role.yaml, the
// .active-task sentinel or project settings can change it.
// AISDLC-730: also re-derived from the untrusted marker file found by walking up from the
// hook's cwd, so a child agent that cleared its environment is still untrusted.
const UNTRUSTED = isUntrustedRun(process.env, toolCwd || process.cwd());
// Governance config, CI workflows, and the enforcement mechanism itself.
const UNTRUSTED_PROTECTED = [
  ['.ai-sdlc'],
  ['.github', 'workflows'],
  ['.claude'],
  ['.husky'],
  ['ai-sdlc-plugin', 'hooks'],
  // AISDLC-730: worktree admin dirs hold the untrusted marker.
  ['.git', 'worktrees'],
];

/** Does this POSIX-style path contain a protected segment sequence (case-insensitive)? */
function isProtectedForUntrusted(p) {
  const segs = p
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  if (segs[segs.length - 1] === '.active-task') return true;
  // AISDLC-730: the untrusted marker itself (in the git dir) is not removable by an untrusted run.
  if (segs[segs.length - 1] === UNTRUSTED_MARKER_FILE) return true;
  // AISDLC-730: a `.git` entry (pointer file or dir) anchors the marker lookup; an untrusted
  // run must not overwrite or create one.
  if (segs[segs.length - 1] === '.git') return true;
  return UNTRUSTED_PROTECTED.some((seq) =>
    segs.some((_, i) => seq.every((part, j) => segs[i + j] === part)),
  );
}

class SymlinkCapError extends Error {
  constructor(p) {
    super(`symlink chain too deep (cap reached) resolving ${p}`);
    this.name = 'SymlinkCapError';
  }
}

/** realpath of the deepest existing ancestor of `p`, re-joined with the missing tail. */
function realpathDeepest(p, depth = 0) {
  let cur = resolve(p);
  const tail = [];
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse());
    } catch {
      // A DANGLING symlink fails realpath but a write through it creates the target:
      // follow it (bounded) instead of treating the link name as a plain missing file.
      let isLink = false;
      try {
        isLink = lstatSync(cur).isSymbolicLink();
      } catch {
        /* unreadable: fall through to the parent */
      }
      if (isLink) {
        // Fail closed at the depth cap: callers deny rather than judge a half-resolved path.
        if (depth >= 16) throw new SymlinkCapError(p);
        let target = null;
        try {
          target = resolve(dirname(cur), readlinkSync(cur));
        } catch {
          /* unreadable link: fall through to the parent */
        }
        if (target) return join(realpathDeepest(target, depth + 1), ...tail.reverse());
      }
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

function enforceUntrustedPath(absPath, homeAbs) {
  const inHome = (p, h) => p === h || p.startsWith(h + sep);
  const check = (p, h) => {
    // Inside home: judge the home-relative path (home itself may sit under a
    // `.claude/worktrees/...` dir). Outside home: judge the whole path.
    const rel = inHome(p, h) ? relative(h, p).split(sep).join('/') : p;
    return isProtectedForUntrusted(rel) ? rel : null;
  };
  let hit = check(absPath, homeAbs);
  if (!hit) {
    // Symlink bypass: judge where the path REALLY lands.
    try {
      const realHome = realpathDeepest(homeAbs);
      hit = check(realpathDeepest(absPath), realHome);
    } catch (e) {
      if (e instanceof SymlinkCapError) {
        deny(untrustedMessage(`path '${absPath}' (symlink chain too deep to resolve)`));
      }
      throw e;
    }
  }
  if (hit) deny(untrustedMessage(`path '${hit}'`));
}

function untrustedMessage(what) {
  const why = UNTRUSTED.reason ? ` (${UNTRUSTED.reason})` : '';
  return (
    `${what} is governance config or enforcement code, and this run is marked untrusted${why} ` +
    `(AI_SDLC_UNTRUSTED_RUN or the git-dir untrusted marker is set for fork PRs, outside authors, or issue-sourced runs). ` +
    `Rule (AISDLC-720, untrusted-run protected paths): untrusted runs cannot change .ai-sdlc/**, .github/workflows/**, .claude/**, .husky/**, ` +
    `ai-sdlc-plugin/hooks/** or .active-task. Next step: describe the needed change in the PR (a maintainer reviews every PR) ` +
    `or issue body, or record it with 'node pipeline-cli/bin/cli-decisions.mjs escalate'; do not retry or route around this. ` +
    `A trusted CI job (not one that takes outside input) that legitimately needs this sets ` +
    `AI_SDLC_INTERNAL_RUN=1 in the step-level env: of that step only, never at job or workflow ` +
    `level and never via $GITHUB_ENV.`
  );
}

const PROT = String.raw`(?:\.ai-sdlc|\.github\/workflows|\.claude|\.husky|ai-sdlc-plugin\/hooks|\.active-task|ai-sdlc-unt[^\s'"\/;|&]*|\.git\/worktrees)`;
// AISDLC-730: a `.git` entry itself (not `.git/<x>`) as the target of a write verb or redirect.
const DOTGIT_ENTRY = String.raw`(?:^|[\s'"=/<>:])\.git(?=['"\s;|&]|$)`;
const SHELL_DOTGIT_TARGET = new RegExp(DOTGIT_ENTRY, 'i');
const SHELL_REDIRECT_TO_DOTGIT = new RegExp(
  String.raw`>>?\s*['"]?(?:[^\s;|&'"]*\/)?\.git(?=['"\s;|&]|$)`,
  'i',
);
const PROTECTED_SHELL_PATH = new RegExp(
  String.raw`(?:^|[\s'"=/<>:])${PROT}(?:\/|['"\s;|&]|$)`,
  'i',
);
const SHELL_WRITE_VERB =
  /(?:^|[\s;&|(])(?:tee|sed\s+(?:-\w*i|--in-place)|cp|mv|rm|ln|touch|chmod|chown|install|truncate|dd|perl\s+-\w*i|patch|rsync|tar|unzip|git\s+(?:apply|checkout|restore|rm|mv|switch|am|cherry-pick))(?=\s)/i;
const SHELL_ANY_REDIRECT = />>?/;
const SHELL_REDIRECT_TO_PROTECTED = new RegExp(
  String.raw`>>?\s*['"]?[^\s;|&'"]*${PROT}(?:\/|['"\s;|&]|$)`,
  'i',
);
const SHELL_INTERPRETER_EVAL =
  /(?:^|[\s;&|(])(?:python3?|node|perl|ruby)\s+(?:-\w*[ceEp]\b|--eval)/i;
// Rewrite the working tree wholesale without naming a path.
const SHELL_TREE_REWRITE =
  /(?:^|[\s;&|(])git\s+(?:-\S+\s+\S+\s+)*(?:switch|am|cherry-pick|stash\s+apply|reset\s+--hard)(?=\s|$)/i;
const SHELL_CD_PROTECTED = new RegExp(String.raw`(?:^|[\s;&|(])cd\s+['"]?[^\s;|&'"]*${PROT}`, 'i');

// AISDLC-740: GITHUB_ENV / GITHUB_PATH / GITHUB_OUTPUT writes persist into later steps, which
// is how an untrusted step would smuggle AI_SDLC_INTERNAL_RUN=1 past the step-level rule.
const SHELL_GITHUB_ENV_WRITE =
  /(?:>>?\s*['"]?\$\{?GITHUB_(?:ENV|PATH)\b|\btee\b[^;&|\n]*\$\{?GITHUB_(?:ENV|PATH)\b)/i;

function enforceUntrustedShellWrites(command) {
  if (!UNTRUSTED.untrusted) return;
  const msg = untrustedMessage('a shell command writing to a protected path');
  if (SHELL_GITHUB_ENV_WRITE.test(command)) deny(msg);
  // Best-effort pattern matching; shell is not a boundary (CI is). Glob, variable and
  // eval forms of the protected names can still evade it.
  if (SHELL_TREE_REWRITE.test(command)) deny(msg);
  // `cd <protected>` then any write verb or redirect later in the same command.
  if (
    SHELL_CD_PROTECTED.test(command) &&
    (SHELL_WRITE_VERB.test(command) || SHELL_ANY_REDIRECT.test(command))
  ) {
    deny(msg);
  }
  for (const segment of command.split(/[;&|\n]+/)) {
    if (
      SHELL_DOTGIT_TARGET.test(segment) &&
      (SHELL_WRITE_VERB.test(segment) || SHELL_REDIRECT_TO_DOTGIT.test(segment))
    ) {
      deny(msg);
    }
    if (!PROTECTED_SHELL_PATH.test(segment)) continue;
    if (
      SHELL_WRITE_VERB.test(segment) ||
      SHELL_REDIRECT_TO_PROTECTED.test(segment) ||
      SHELL_INTERPRETER_EVAL.test(segment)
    ) {
      deny(msg);
    }
  }
  if (SHELL_REDIRECT_TO_PROTECTED.test(command) || SHELL_REDIRECT_TO_DOTGIT.test(command))
    deny(msg);
}

// ── Dispatch by tool ─────────────────────────────────────────────────

if (toolName === 'Bash' || (!toolName && toolInput.command)) {
  enforceBash(toolInput.command);
} else if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
  enforceWriteEdit(toolInput.file_path);
}

process.exit(0);

// ── Bash enforcement (unchanged behavior) ────────────────────────────

function enforceBash(command) {
  if (!command || typeof command !== 'string' || !command.trim()) return;

  const trimmed = command.trim();

  // AISDLC-720: untrusted runs may not write governance config / workflows via shell.
  enforceUntrustedShellWrites(trimmed);

  // RFC-0051 §10: own-branch force-with-lease. Only active when the TRUSTED
  // policy resolved to `leaseOnOwnBranch`; under `never` (default, absent,
  // malformed) this is a no-op.
  let leasePushAllowed = false;
  try {
    // AISDLC-861: a `-C` path built by shell expansion cannot be resolved, so the
    // push it names is unverifiable: refuse rather than let it escape the guard.
    if (/^git[ \t]+-C[ \t]/.test(trimmed) && /[$`]/.test(trimmed) && /\bpush\b/.test(trimmed)) {
      deny(
        'a git -C push whose path is shell-expanded cannot be verified. Next step: spell the path literally as git -C <main>/.worktrees/<task-id> followed by the push.',
      );
    }
    const lease = loadLeasePolicy(trimmed);
    if (lease.mode === 'lease') {
      const verdict = evaluateLeasePush(
        lease.command,
        {
          ownRef: gitOut(['symbolic-ref', '-q', 'HEAD'], lease.cwd),
          protectedBranches: lease.protectedBranches,
          remotes: (gitOut(['remote'], lease.cwd) || '').split('\n').filter(Boolean),
          aliasLookup: (name) => gitOut(['config', '--get', `alias.${name}`], lease.cwd),
        },
        'lease',
      );
      if (verdict.decision === 'deny') deny(verdict.reason);
      leasePushAllowed = verdict.decision === 'allow';
    } else if (lease.mode === 'leaseOnOwnBranch') {
      const top = lease.top;
      const verdict = evaluateLeasePush(lease.command, {
        ownRef: gitOut(['symbolic-ref', '-q', 'HEAD'], lease.cwd),
        protectedBranches: lease.protectedBranches,
        remotes: (gitOut(['remote'], lease.cwd) || '').split('\n').filter(Boolean),
        aliasLookup: (name) => gitOut(['config', '--get', `alias.${name}`], lease.cwd),
        taskId: top ? readTaskId(top) || lease.claimTaskId || null : null,
        worktreeName: top ? basename(top) : null,
        refAliasState: (name) => refAliasState(name, lease.cwd),
      });
      if (verdict.decision === 'deny') deny(verdict.reason);
      leasePushAllowed = verdict.decision === 'allow';
    }
    // Default policy (`never`/unset): refuse force-push shapes found by the lease guard's own tokenizer.
    if (lease.mode === 'never' && hasForcePushOption(trimmed)) {
      deny(forcePushRefusal(lease.why, lease.failing));
    }
  } catch {
    // A thrown error (or timeout) must not become an allow: deny pushes, ignore the rest.
    if (looksLikeGitPush(trimmed)) {
      deny(
        'could not evaluate the own-branch lease policy for this git push; ' +
          'spec.governance.allowForcePush = leaseOnOwnBranch in .ai-sdlc/agent-role.yaml ' +
          "allows 'git push --force-with-lease origin HEAD:refs/heads/<own-branch>' on the task worktree's own branch",
      );
    }
  }
}

// ── Write/Edit enforcement (new behavior) ────────────────────────────

/** realpathDeepest, failing closed (deny) when the symlink chain is too deep to resolve. */
function realpathOrDeny(p) {
  try {
    return realpathDeepest(p);
  } catch (e) {
    if (e instanceof SymlinkCapError) {
      deny(
        `path '${p}' has a symlink chain too deep to resolve; refusing the write. Next step: write ` +
          `to a path without the symlink chain, or record the need with ` +
          `'node pipeline-cli/bin/cli-decisions.mjs escalate'.`,
      );
    }
    throw e;
  }
}

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
  const lexHomeAbs = worktreeDir || projectAbs;
  // AISDLC-569: containment is judged on REAL paths (symlinks resolved on both
  // sides) so a symlink inside home that points outside is treated as outside,
  // while a symlinked home itself still works. The lexical form is kept too
  // so blockedPaths matching also fires on the path as the agent spelled it.
  const homeAbs = realpathOrDeny(lexHomeAbs);
  const lexAbsPath = absPath;
  const realAbsPath = realpathOrDeny(absPath);
  const insideHome = realAbsPath === homeAbs || realAbsPath.startsWith(homeAbs + sep);

  // AISDLC-567: stale-base guard. Non-blocking — warns to stderr only, using
  // whatever refs are already cached locally (no network fetch from a hook).
  warnIfStaleBase(homeAbs);

  // AISDLC-720: untrusted runs — protected paths inside OR outside home, before
  // any permittedExternalPaths allow.
  if (UNTRUSTED.untrusted) {
    enforceUntrustedPath(realAbsPath, homeAbs);
    if (lexAbsPath !== realAbsPath) enforceUntrustedPath(lexAbsPath, lexHomeAbs);
  }

  if (insideHome) {
    // Path is inside the agent's home — check against the hardcoded
    // never-editable floor plus the project's configured blockedPaths globs.
    // Relative path uses POSIX separators because globs do.
    const relPath = relative(homeAbs, realAbsPath).split(sep).join('/');
    const lexInHome = lexAbsPath === lexHomeAbs || lexAbsPath.startsWith(lexHomeAbs + sep);
    const lexRel = lexInHome ? relative(lexHomeAbs, lexAbsPath).split(sep).join('/') : relPath;

    // AISDLC-720: no hardcoded `.ai-sdlc/**` floor for internal sessions; untrusted
    // runs are handled by enforceUntrustedPath() above.
    for (const glob of blockedPaths) {
      if (matchGlob(glob, relPath) || matchGlob(glob, lexRel)) {
        deny(
          `path '${relPath}' matches blockedPaths entry '${glob}' in .ai-sdlc/agent-role.yaml. ` +
            `Next step: if this task needs the file, record it with ` +
            `'node pipeline-cli/bin/cli-decisions.mjs escalate --task-id <id> --summary <one line> --option <id>:<description>' ` +
            `so the dispatch or planner session routes the change to blockedPaths (or a task that names the file).`,
        );
      }
    }
    return;
  }

  // AISDLC-605: scratch space (session scratch dir, OS temp dirs) is allowed by
  // default. Never inside the project root (main checkout / other worktrees) and
  // never inside a git repository (sibling repos), so confinement is unchanged.
  if (isScratchPath(absPath, projectAbs)) return;

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
    const extAbs = realpathOrDeny(resolve(projectAbs, ext));
    if (realAbsPath === extAbs || realAbsPath.startsWith(extAbs + sep)) {
      return; // explicit allow
    }
  }

  // No allowlist match — deny with a clear, actionable reason.
  if (allowed.length === 0) {
    deny(
      `path '${realAbsPath}' is outside the agent's active worktree/project root. ` +
        `To permit cross-repo writes for this task, add 'permittedExternalPaths' to ` +
        `the task frontmatter and set AI_SDLC_ACTIVE_TASK_ID before invoking the agent.`,
    );
  } else {
    deny(
      `path '${realAbsPath}' is outside the agent's active worktree/project root and not under the ` +
        `active task's permittedExternalPaths (${allowed.join(', ')}). Next step: add the path to ` +
        `'permittedExternalPaths' in the task frontmatter, or record the need with ` +
        `'node pipeline-cli/bin/cli-decisions.mjs escalate'.`,
    );
  }
}

/** Directories that count as scratch space: OS temp dirs and the session scratch dir. */
function scratchRoots() {
  const roots = new Set();
  // Never treat the filesystem root, the home directory, or any ancestor of home as scratch
  // (a TMPDIR misconfigured to `/` or `~` must not open the whole disk for writes).
  const home = (() => {
    try {
      return realpathSync(require('os').homedir());
    } catch {
      return resolve(require('os').homedir());
    }
  })();
  const add = (p) => {
    if (!p || typeof p !== 'string' || !isAbsolute(p)) return;
    const abs = resolve(p);
    if (abs === resolve(sep) || abs.split(sep).filter(Boolean).length < 1) return;
    let absReal = abs;
    try {
      absReal = realpathSync(abs);
    } catch {
      /* not created yet */
    }
    for (const a of new Set([abs, absReal])) {
      if (a === home || home.startsWith(a + sep)) return;
    }
    roots.add(abs);
    try {
      roots.add(realpathSync(abs));
    } catch {
      /* not created yet */
    }
  };
  add(require('os').tmpdir());
  add(process.env.TMPDIR);
  add(process.env.TEMP);
  add(process.env.TMP);
  add(process.env.CLAUDE_SCRATCHPAD_DIR);
  if (process.platform !== 'win32') {
    add('/tmp');
    add('/private/tmp');
    add('/var/tmp');
  }
  return [...roots];
}

/**
 * True when the REAL path of `absPath` (symlinks resolved) is under a scratch
 * root, is NOT inside the project root (the main checkout and its `.worktrees/`),
 * and is NOT inside any git repository (a sibling repo that merely lives in a temp dir).
 */
function isScratchPath(absPath, projectAbs) {
  let real = absPath;
  try {
    real = realpathDeepest(absPath);
  } catch (e) {
    // Symlink cap reached: the real destination is unknown, so it is never scratch.
    if (e instanceof SymlinkCapError) return false;
    /* otherwise use the lexical path */
  }
  const under = (p, root) => p === root || p.startsWith(root + sep);
  const projectReal = (() => {
    try {
      return realpathSync(projectAbs);
    } catch {
      return projectAbs;
    }
  })();
  // The main checkout owning this worktree (project root may itself be `<main>/.worktrees/<id>`).
  const mainRoots = new Set([projectAbs, projectReal]);
  for (const p of [projectAbs, projectReal]) {
    const i = p.split(sep).indexOf('.worktrees');
    if (i > 0) mainRoots.add(p.split(sep).slice(0, i).join(sep) || sep);
  }
  for (const candidate of new Set([absPath, real])) {
    if ([...mainRoots].some((r) => under(candidate, r))) return false;
    // Any path inside a `.worktrees/` directory is another worktree: never scratch.
    if (candidate.split(sep).includes('.worktrees')) return false;
  }
  // Only the REAL path counts (a symlink under /tmp pointing at a sibling repo or dotfiles
  // lands outside every scratch root), and the git-repo walk runs on the real path all the
  // way to the filesystem root (a repo above the scratch root also disqualifies it).
  const inGitRepo = (() => {
    let dir = dirname(real);
    for (;;) {
      if (existsSync(join(dir, '.git'))) return true;
      const parent = dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  })();
  if (inGitRepo) return false;
  for (const root of scratchRoots()) {
    if (real !== root && under(real, root)) return true;
  }
  return false;
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
    // Hooks run as a fresh process per tool call, so throttle through a small
    // cache file (outside `.ai-sdlc/**`) rather than an in-process variable.
    const ttlRaw = process.env.AI_SDLC_STALE_BASE_TTL_SECONDS;
    const ttlMs = (ttlRaw !== undefined && ttlRaw !== '' ? Number(ttlRaw) : 60) * 1000;
    const cacheDir = process.env.AI_SDLC_STALE_BASE_CACHE_DIR || tmpdir();
    const cacheFile = join(
      cacheDir,
      `ai-sdlc-stale-base-${createHash('sha1').update(dir).digest('hex').slice(0, 16)}.json`,
    );
    let behindCount;
    if (Number.isFinite(ttlMs) && ttlMs > 0) {
      try {
        const cached = JSON.parse(readFileSync(cacheFile, 'utf-8'));
        if (
          cached &&
          typeof cached.checkedAt === 'number' &&
          Date.now() - cached.checkedAt >= 0 &&
          Date.now() - cached.checkedAt < ttlMs
        ) {
          behindCount = cached.behind;
        }
      } catch {
        // no usable cache — fall through to a live check
      }
    }
    if (behindCount === undefined) {
      const output = execFileSync('git', ['rev-list', '--count', 'HEAD..origin/main'], {
        cwd: dir,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      behindCount = parseInt(output, 10);
      if (Number.isFinite(ttlMs) && ttlMs > 0 && Number.isFinite(behindCount)) {
        try {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(cacheFile, JSON.stringify({ checkedAt: Date.now(), behind: behindCount }));
        } catch {
          // cache is best-effort
        }
      }
    }
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
