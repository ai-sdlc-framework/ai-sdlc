/**
 * AI-SDLC Action Enforcement Hook (PreToolUse)
 *
 * Enforces governance from .ai-sdlc/agent-role.yaml across three tool families:
 *
 * 1. **Bash** — checks `tool_input.command` against `blockedActions` patterns.
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
 * 4. **Merge governance (AISDLC-602)** — reconciles the `blockedActions`
 *    mechanism (Bash-command glob matching against `git merge*` etc.) with
 *    the resolved `spec.governance` policy (AISDLC-601's resolver). EVERY
 *    `gh pr merge` invocation is blocked here regardless of the resolved
 *    `allowMerge` policy and regardless of flags: that includes arming
 *    (`--auto`), `--squash`/`--rebase`/`--admin`/`--delete-branch` and
 *    `--disable-auto`. The only sanctioned routes are the
 *    `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr>` helper (merge mode)
 *    and `... <pr> --arm` (arming), which own the real policy, fork, author,
 *    base, task and head-commit checks (never reimplemented in this hook).
 *    Arming used to be allowed as "not merging", but an armed PR merges as
 *    soon as GitHub's checks pass, so it is a merge in waiting and must
 *    pass the same gate.
 *
 * 4b. **API-merge governance** — merging through the GitHub API (the REST
 *    `.../pulls/<n>/merge` endpoint via `gh api`, `curl` or `wget`, or the
 *    GraphQL `mergePullRequest` mutation) is denied under every `allowMerge`
 *    value (see `enforceApiMergeGovernance`); the sanctioned helper stays allowed.
 *
 * 5. **Destructive-stash governance (AISDLC-611)** — the git stash stack is
 *    shared across the main checkout, all worktrees, and concurrent
 *    sessions. A `git stash pop` can silently apply-and-drop a PRE-EXISTING
 *    stash belonging to the operator or a sibling session (real data-loss
 *    incident: local-trades LT-595, HIGH-3). Round-5 scope (operator
 *    decision): this hook BLOCKS ONLY the genuinely destructive shared-stack
 *    ops — `git stash pop`, `git stash clear`, and a bare `git stash drop`
 *    (no explicit ref). It ALLOWS everything else: bare `git stash`, tagged
 *    OR untagged `push`/`save`, `apply`, `list`, `show`, and
 *    `git stash drop <ref>` (explicit ref). Tagging (`-m`) is still strongly
 *    recommended but no longer enforced. Obfuscated invocations are caught by
 *    normalizing the command with a single shell-accurate pass — `$IFS`
 *    (including `${IFS:0:1}`-style parameter expansions) → whitespace
 *    (word-split), every other `$VAR`/`${VAR}` → empty (unset var
 *    concatenates) — plus quote/backslash/wrapper stripping, then blocking if
 *    the result is a destructive op (see
 *    `enforceStashGovernance`/`normalizeStashObfuscation`).
 *
 *    SCOPE (operator decision, AISDLC-611 / LT-595): this guard prevents a
 *    cooperative agent from ACCIDENTALLY running a destructive stash op (the
 *    actual incident it exists for). It is NOT — and a static PreToolUse regex
 *    matcher fundamentally CANNOT be — proof against a DELIBERATELY-obfuscating
 *    agent: inline shell-variable state (`X=pop; git stash $X`), `eval`,
 *    `base64 | sh`, and a leading `sudo`/`env` prefix all execute a real op
 *    that no static normalizer can resolve. Those are a different threat model
 *    (a hostile agent, not an accidental one) and are accepted as out of scope
 *    here; defense against a hostile agent belongs at the sandbox/permission
 *    layer, not this hook.
 */

const {
  readFileSync,
  existsSync,
  readdirSync,
  realpathSync,
  lstatSync,
  readlinkSync,
} = require('fs');
const { join, resolve, isAbsolute, relative, sep, dirname, basename } = require('path');
const { execSync } = require('child_process');
const {
  resolveGovernanceFromYaml,
  resolveGovernanceExtrasFromYaml,
  STRICT_DEFAULTS,
  isUntrustedRun,
  UNTRUSTED_MARKER_FILE,
} = require('./lib/governance-resolver');
const { evaluateLeasePush, hasForcePushOption } = require('./lib/lease-push-guard');
const {
  commandRunsGhPrMerge,
  commandHasUninertMatch,
  stripCommentAndQuotes: libStripCommentAndQuotes,
} = require('./lib/merge-matcher');
const {
  runGit: gitOut,
  probeRef,
  readPolicyText,
  loadTrustedExtras,
  resolveLeaseWorktree,
  readTaskId,
} = require('./lib/trusted-policy');

// AISDLC-720: untrusted runs fail closed (exit 2 = block) on any internal error.
function failClosed(why) {
  process.stderr.write(
    `Blocked by AI-SDLC governance policy: this run is marked untrusted and the hook hit an ` +
      `internal error (${why}); failing closed. Ask a maintainer in the PR; do not retry.\n`,
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

let blockedActions = [];
let blockedPaths = [];
// AISDLC-602: resolved governance policy, used by the merge-governance check
// below. Falls back to STRICT_DEFAULTS (the schema default, allowMerge: 'never',
// which is a configurable value rather than a project rule) on any parse
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

// ── Own-branch lease policy (RFC-0051 §10) ───────────────────────────

/**
 * Resolves the lease policy (see lib/trusted-policy.js for the trust model).
 *
 * Step 1 reads the project-dir policy text with NO git subprocess; unless it
 * says `leaseOnOwnBranch`, the mode is `never` and nothing else runs. Because
 * that text may be a PR-tree copy, the grant is only honored when the trusted
 * main-checkout policy ALSO says lease (so a worktree copy can only tighten).
 * Any failure fails closed to `never`.
 */
function loadLeasePolicy() {
  // `why` says which gate closed the lease so a refusal can name the right fix
  // (see forcePushRefusal): 'policy-never' = an explicit/malformed `never`.
  const closed = (why) => ({ mode: 'never', protectedBranches: [], cwd: undefined, why });
  try {
    // A missing policy file means the repo sets nothing: the default
    // (`leaseOnOwnBranch`, AISDLC-710) applies. Any other read failure fails closed.
    const localText = readPolicyText(join(projectDir, '.ai-sdlc', 'agent-role.yaml'));
    if (resolveGovernanceExtrasFromYaml(localText).forcePushMode !== 'leaseOnOwnBranch') {
      return closed('policy-never');
    }
    // The lease needs an EXPLICIT, absolute CLAUDE_PROJECT_DIR: the toplevel
    // fallback used for blockedActions would make the own-session binding pass
    // trivially (project dir == whatever the cwd is in).
    const envDir = process.env.CLAUDE_PROJECT_DIR;
    if (!envDir || !isAbsolute(envDir)) return closed('no-project-dir');
    const cwd = toolCwd || process.cwd();
    const trusted = loadTrustedExtras(projectDir, cwd);
    if (!trusted) return closed('trusted-policy-unavailable');
    if (trusted.forcePushMode !== 'leaseOnOwnBranch') return closed('policy-never');
    // The cwd must be a genuine dispatched worktree under <main>/.worktrees/
    // (realpath), else no lease: operator main-checkout sessions get none.
    const wt = resolveLeaseWorktree(projectDir, cwd);
    if (!wt) return closed('not-task-worktree');
    return {
      mode: 'leaseOnOwnBranch',
      protectedBranches: trusted.protectedBranches,
      cwd,
      top: wt.top,
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
function forcePushRefusal(why) {
  const key = 'spec.governance.allowForcePush in .ai-sdlc/agent-role.yaml';
  if (why === 'policy-never') {
    return (
      `force-push is refused because ${key} resolves to never (set explicitly in this repo). ` +
      `Agents must not edit .ai-sdlc/: escalate to the dispatch session and ask the operator to set ` +
      `spec.governance.allowForcePush to leaseOnOwnBranch, which allows 'git push --force-with-lease ` +
      `origin HEAD:refs/heads/<own-branch>' on a dispatched task's own branch. Plain force pushes and any ` +
      `push to main/master or a protected branch are never permitted.`
    );
  }
  const mainRooted =
    why === 'not-task-worktree'
      ? ` From a session rooted at the main checkout, the cwd worktree must be bound to ONE task in either of ` +
        `two ways: (1) the task id bound to the session at launch equals the worktree's .active-task, or ` +
        `(2) the session is a hierarchy executor that holds exactly one inflight claim on the dispatch ` +
        `board, for that same task. Next step: claim the task through the executor loop (/ai-sdlc executor) ` +
        `and push from its worktree, or run the push from a session rooted in the worktree.`
      : '';
  return (
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

// AISDLC-611: same temporal-dead-zone constraint applies to the stash
// governance constants — must be initialized before enforceBash() →
// enforceStashGovernance() runs at module load.
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const SAFE_STASH_PATTERN =
  'prefer a temporary WIP commit to set work aside; if you must stash, tag it uniquely ' +
  `('git stash push -u -m "<unique-tag>"'), restore it by exact ref/SHA ` +
  `('git stash apply <ref>'), and only then drop it by that same tag/ref ` +
  `('git stash drop <ref>')`;

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
      if (depth < 16) {
        try {
          if (lstatSync(cur).isSymbolicLink()) {
            const target = resolve(dirname(cur), readlinkSync(cur));
            return join(realpathDeepest(target, depth + 1), ...tail.reverse());
          }
        } catch {
          /* not a symlink / unreadable: fall through to the parent */
        }
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
    const realHome = realpathDeepest(homeAbs);
    hit = check(realpathDeepest(absPath), realHome);
  }
  if (hit) deny(untrustedMessage(`path '${hit}'`));
}

function untrustedMessage(what) {
  const why = UNTRUSTED.reason ? ` (${UNTRUSTED.reason})` : '';
  return (
    `${what} is governance config or enforcement code, and this run is marked untrusted${why} ` +
    `(AI_SDLC_UNTRUSTED_RUN or the git-dir untrusted marker is set for fork PRs, outside authors, or issue-sourced runs). ` +
    `Untrusted runs cannot change .ai-sdlc/**, .github/workflows/**, .claude/**, .husky/**, ` +
    `ai-sdlc-plugin/hooks/** or .active-task. Next step: leave a note in the PR ` +
    `or issue asking a maintainer to make that change; do not retry or route around this. ` +
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

  // AISDLC-602: merge governance is enforced unconditionally — independent
  // of whatever blockedActions patterns the project has (or hasn't)
  // configured. See enforceMergeGovernance() for the exact rules.
  enforceMergeGovernance(trimmed);

  // Merging through the REST/GraphQL API is the same act as a raw merge
  // command and must not be a side door around the sanctioned helper (denied
  // under every allowMerge value).
  enforceApiMergeGovernance(trimmed);

  // Defense in depth: no legitimate command mentions the removed policy-root
  // override, so any attempt to name it is refused.
  if (/AI_SDLC_MERGE_POLICY_ROOT/i.test(trimmed)) {
    deny('overriding the merge policy root is not a permitted action');
  }

  // AISDLC-611: no-bare-stash governance is enforced unconditionally too —
  // independent of whatever blockedActions patterns the project configured.
  enforceStashGovernance(trimmed);

  // RFC-0051 §10: own-branch force-with-lease. Only active when the TRUSTED
  // policy resolved to `leaseOnOwnBranch`; under `never` (default, absent,
  // malformed) this is a no-op and the blockedActions patterns below behave
  // exactly as before.
  let leasePushAllowed = false;
  try {
    const lease = loadLeasePolicy();
    if (lease.mode === 'leaseOnOwnBranch') {
      const top = lease.top;
      const verdict = evaluateLeasePush(trimmed, {
        ownRef: gitOut(['symbolic-ref', '-q', 'HEAD'], lease.cwd),
        protectedBranches: lease.protectedBranches,
        remotes: (gitOut(['remote'], lease.cwd) || '').split('\n').filter(Boolean),
        aliasLookup: (name) => gitOut(['config', '--get', `alias.${name}`], lease.cwd),
        taskId: top ? readTaskId(top) : null,
        worktreeName: top ? basename(top) : null,
        refAliasState: (name) => refAliasState(name, lease.cwd),
      });
      if (verdict.decision === 'deny') deny(verdict.reason);
      leasePushAllowed = verdict.decision === 'allow';
    }
    // Default policy (`never`/unset): also catch the common non-prefix shapes the
    // anchored blockedActions globs miss (`git push origin --force main`,
    // `git push origin -f HEAD:main`, `+refspec`). Runs no git subprocess.
    if (lease.mode !== 'leaseOnOwnBranch' && hasForcePushOption(trimmed)) {
      deny(forcePushRefusal(lease.why));
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

  if (blockedActions.length === 0) return;

  const withoutLeaseFlags = trimmed
    .replace(/\s--force-with-lease(=\S*)?/g, '')
    .replace(/\s--force-if-includes/g, '');

  for (const pattern of blockedActions) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexStr}$`, 'i');
    // The one command shape the lease policy positively allowed is exempt only
    // from `git push` patterns that match PURELY because of the lease flags
    // (e.g. `git push --force*`). A pattern that still matches once those flags
    // are removed (e.g. `git push *develop*`) keeps applying.
    if (leasePushAllowed && /^git\s+push\b/i.test(pattern) && !regex.test(withoutLeaseFlags)) {
      continue;
    }
    if (regex.test(trimmed)) {
      const forceHint =
        !leasePushAllowed && /^git\s+push\b/i.test(pattern) && hasForcePushOption(trimmed);
      deny(
        `command matches blockedAction pattern '${pattern}'` +
          (forceHint
            ? ` (a force-with-lease push on a task's own branch is allowed by spec.governance.allowForcePush = leaseOnOwnBranch in .ai-sdlc/agent-role.yaml, when the push is spelled 'git push --force-with-lease origin HEAD:refs/heads/<own-branch>' from the task worktree)`
            : ''),
      );
    }
  }
}

// ── Merge governance (AISDLC-602) ────────────────────────────────────

/**
 * Denies every raw `gh pr merge` invocation (any flags, including arming) so the
 * only route is `node pipeline-cli/bin/cli-merge-if-eligible.mjs` (merge mode
 * or `--arm`). The deny does not depend on the resolved `allowMerge` value.
 *
 * This runs against a raw shell command STRING, not a parsed argv, so the match
 * is best-effort defense-in-depth, NOT an impenetrable sandbox; the real backstop
 * is GitHub-side branch protection. It FAILS CLOSED (see lib/merge-matcher.js):
 * the command is split on shell control operators (quote-aware) and, when the
 * merge phrase appears in a segment (quote-aware comment stripping, quotes kept
 * or removed, case ignored), the command is denied unless that segment's command
 * word is on a short positive allowlist of inert commands (echo, grep, cat,
 * git commit, ...) and every later pipe stage is inert too. Shells, interpreters,
 * `env`/`sudo`/`pnpm exec` prefixes, reserved words, substitutions and unknown
 * commands all deny. Heredoc bodies are dropped only when the opener line is
 * made solely of inert commands; any other opener keeps its body in view.
 *
 * Commands that don't contain the merge phrase are untouched; they still flow
 * through the generic `blockedActions` pattern matching in enforceBash().
 */
function enforceMergeGovernance(trimmed) {
  // AISDLC-605: fail closed unless the phrase is inert data (see lib/merge-matcher.js).
  if (commandRunsGhPrMerge(trimmed)) {
    deny(
      `raw 'gh pr merge' (including 'gh pr merge --auto') is not a permitted merge path ` +
        `(resolved governance allowMerge="${resolvedGovernance.allowMerge}"). Merges go through ` +
        `'node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr>' and arming auto-merge goes ` +
        `through 'node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --arm'; both enforce the ` +
        `real policy, fork, author, base, task and head-commit checks. The release-please PR ` +
        `('chore: release main') is landed with ` +
        `'node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm'.`,
    );
  }
}

// ── API-merge governance ─────────────────────────────────────────────

/**
 * Denies merging a PR through the GitHub API instead of the sanctioned
 * `node pipeline-cli/bin/cli-merge-if-eligible.mjs` helper, under EVERY
 * `allowMerge` value (the helper, not the hook, owns the real eligibility
 * gate and performs the merge itself, so nothing legitimate needs the API
 * route from a Bash tool call). Covered:
 *   - the REST endpoint `.../pulls/<n>/merge`, any HTTP method (a GET only
 *     reads, but the whole path is denied: simpler and safer), in the
 *     `gh api repos/<o>/<r>/pulls/<n>/merge` and `gh api /repos/...` spellings,
 *     flags in any order (`-X PUT`, `--method=PUT`, `-f merge_method=...`),
 *     `curl`/`wget`/`http` to `https://api.github.com/repos/<o>/<r>/pulls/<n>/merge`,
 *     and script-runner (`node -e`, `python -c`, ...) spellings;
 *   - the GraphQL `mergePullRequest` and `enablePullRequestAutoMerge` (arming)
 *     mutations sent through `gh api graphql` / `curl`.
 * Raw `gh pr merge` in every form is denied separately; see enforceMergeGovernance().
 *
 * Detection runs on a normalized copy of the command (variables collapsed like
 * a default shell, quotes/backslashes/percent-escapes removed; inert heredoc
 * bodies are dropped, see enforceMergeGovernance) and is deliberately text-level:
 * like every matcher here it cannot defeat base64 pipelines or constructed
 * strings; branch protection + required checks remain the backstop. Like the raw
 * merge check it FAILS CLOSED: a segment containing a merge path or mutation is
 * denied unless its command word is on the inert allowlist (echo, grep, cat,
 * git commit, ...) and every later pipe stage is inert, so `grep`/`cat`/`git log`
 * on text that merely mentions such a path stay allowed.
 */
function enforceApiMergeGovernance(command) {
  const mergePath = /(?:^|[/\s])pulls\/[^\s/]*\/merge(?![A-Za-z0-9_.-])/i;
  const mergeMutation = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/i;
  const matches = (segment) => {
    const text = normalizeForApiMerge(segment);
    return mergePath.test(text) || mergeMutation.test(text);
  };
  if (commandHasUninertMatch(command, matches)) {
    deny(
      `merging a PR through the GitHub API ('.../pulls/<n>/merge' or the mergePullRequest ` +
        `mutation) is not a permitted merge path under any governance allowMerge value. ` +
        `Merges must go through 'node pipeline-cli/bin/cli-merge-if-eligible.mjs', which ` +
        `enforces the real eligibility gate, and arming auto-merge goes through the same helper with --arm.`,
    );
  }
}

/**
 * Normalizes a command for API-merge DETECTION only (never alters what runs).
 * Mirrors a default shell for variables (`$IFS` splits, any other `$VAR` is
 * empty so its neighbours concatenate), drops quotes and backslashes (so
 * `pu''lls` / `pulls\/5` collapse), and decodes `%XX` escapes. Unlike the stash
 * normalizer it KEEPS braces/parens so `{owner}` placeholders and URLs stay intact.
 */
function normalizeForApiMerge(text) {
  let out = text;
  out = out.replace(/\$\{IFS\}/g, ' ');
  out = out.replace(/\$\{IFS[^}A-Za-z0-9_][^}]*\}/g, ' ');
  out = out.replace(/\$IFS\b/g, ' ');
  out = out.replace(/\$\{[^}]*\}/g, '');
  out = out.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '');
  out = out.replace(/['"]/g, '');
  out = out.replace(/\\\n/g, '');
  out = out.replace(/\\/g, '');
  try {
    out = decodeURIComponent(out);
  } catch {
    out = out.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return out;
}

/**
 * Splits a command into segments on shell control operators so a `gh pr merge`
 * embedded in a chain (`x && gh pr merge 5`) is evaluated on its own. `&&` and
 * `||` are matched before the single-char `&`/`|` forms.
 *
 * Note: the split runs on the RAW command, BEFORE comment stripping — so a `#`
 * comment that itself contains `&&`/`;`/`|` splits into extra pseudo-segments.
 * This can only ever OVER-block (an inert comment fragment is treated as its
 * own segment), never under-block, which is the safe bias for this boundary.
 */
function splitShellSegments(command) {
  return command
    .split(/(?:&&|\|\||;|\||&|\n)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Removes an unquoted trailing shell comment and all quote characters. */
function stripCommentAndQuotes(segment) {
  // Shared with lib/merge-matcher.js: quote-aware, `#` only starts a comment at a word boundary.
  return libStripCommentAndQuotes(segment);
}

// ── No-bare-stash governance (AISDLC-611) ────────────────────────────

/**
 * Enforces the no-bare-stash rule. The git stash stack is a single shared
 * resource across the main checkout, every `.worktrees/<id>/` isolate, and
 * any concurrent session — a bare `git stash` followed by `git stash pop`
 * can silently apply-and-drop a stash that belongs to someone else (the
 * motivating incident: a dev subagent's own stash captured nothing, so its
 * `pop` applied+dropped a pre-existing operator stash — local-trades LT-595,
 * HIGH-3, a REAL data-loss incident).
 *
 * Heredoc bodies are stripped BEFORE segment-splitting so a heredoc that
 * merely CONTAINS the text `git stash pop` (e.g. documentation piped via
 * `cat <<EOF`) is not mistaken for an actual invocation (AC-3 no-over-block).
 * The remaining text is then aggressively NORMALIZED (see
 * `normalizeStashObfuscation`) to collapse the many shell-level ways of
 * spelling the same invocation — quotes, backslashes, subshell/brace/
 * command-substitution wrappers, and `$VAR`/`${VAR}` word-splitting tricks —
 * down to their plain-text equivalent BEFORE segment-splitting and
 * detection. This is deliberately NOT an enumerate-every-obfuscation
 * strategy (security review found that approach keeps producing new
 * bypasses — `/usr/bin/git`, `git st''ash`, `git${IFS}stash`, `git st\ash`,
 * `\git stash`, `(git stash pop)`, etc. were each patched individually and
 * each left a sibling bypass). Instead: normalize the obfuscation-capable
 * characters away FIRST, then run ONE fail-closed subcommand-position
 * detector (`evaluateStashSegment`) over the clean text — see that
 * function's docstring for the fail-closed contract.
 */
function enforceStashGovernance(command) {
  const withoutHeredocs = stripHeredocBodies(command);
  // AISDLC-611: normalize the command with a SINGLE shell-accurate pass (see
  // `normalizeStashObfuscation`) — `$IFS` → whitespace (word-split), every
  // other `$VAR`/`${VAR}` → empty (an unset var concatenates its neighbors).
  // This models what a real default shell actually does to EACH variable
  // INDEPENDENTLY, so a mixed splice like `g${x}it${IFS}stash pop` (empty $x
  // joins `git`, $IFS splits `stash`/`pop`) collapses to `git stash pop` and
  // is caught. (An earlier two-uniform-corner approach — all-space OR
  // all-empty — could not represent mixed expansions and let that form
  // through; security round-5 finding.)
  const normalized = normalizeStashObfuscation(withoutHeredocs);
  for (const segment of splitShellSegments(normalized)) {
    const verdict = evaluateStashSegment(segment);
    if (verdict && verdict.blocked) {
      deny(verdict.reason);
    }
  }
}

/**
 * Aggressively normalizes a command string for stash-governance DETECTION
 * (never used to alter what the shell/Bash tool actually executes — only
 * this local copy is transformed). Collapses the shell mechanisms that can
 * be used to obfuscate a `git stash` invocation down to their plain-text
 * equivalent, in order:
 *
 * 1. `stripCommentAndQuotes` — drops a trailing `#` comment and EVERY quote
 *    character, so a real shell's word-concatenation behavior is mirrored:
 *    `git st''ash pop` / `git sta"sh" pop` both collapse to the literal
 *    text `git stash pop` (closes the mid-token quote-splice bypass).
 * 2. `${...}` / `$VAR` → a single space. Bash's default `$IFS` is
 *    whitespace, so `git${IFS}stash${IFS}pop` really does word-split into
 *    `git stash pop` at execution time — detection must mirror that
 *    (closes the `$IFS`-splice bypass) rather than leave a stray `IFS`
 *    token that corrupts subcommand-position detection.
 * 3. Backslashes removed entirely (not replaced with a space) — a real
 *    shell drops an unescaped `\` and joins what's on either side of it,
 *    so `git st\ash pop` → `git stash pop` and `\git stash pop` →
 *    `git stash pop` (closes the backslash-splice bypass).
 * 4. Subshell / brace-group / backtick / remaining `$` wrapper punctuation
 *    (`(`, `)`, `{`, `}`, `` ` ``, `$`) replaced with a space — all of
 *    these EXECUTE their contents, so `(git stash pop)` /
 *    `{ git stash pop; }` / `` `git stash pop` `` / `$(git stash pop)`
 *    are exactly as dangerous as a bare invocation (closes the shell-
 *    wrapper bypass). The bare `$` catches command substitution's opening
 *    `$(` after step 4 already removed the parens — without it, a stray
 *    `$` token survives and corrupts subcommand-position detection by
 *    displacing the `git` token from index 0.
 *
 * This is a coarse CHARACTER-LEVEL transform, not balanced shell parsing —
 * it can only ever ADD false-positive detections (e.g. turning an unrelated
 * `foo(bar)` into two harmless tokens) or expose a hidden invocation for
 * correct detection; it can never HIDE a real one. That is the deliberate
 * safe bias for this boundary.
 */
function normalizeStashObfuscation(text) {
  // ORDER MATTERS (3rd security round finding): `${VAR}`/`$VAR` collapse
  // MUST run BEFORE quote-stripping. In a real shell, an unescaped quote
  // TERMINATES a `$VAR` name — `$IFS'stash'` expands `$IFS` then emits the
  // literal `stash`. If quotes were stripped FIRST, `$IFS'stash'` would
  // already read as `$IFSstash`, and the greedy `/\$[A-Za-z_][A-Za-z0-9_]*/`
  // variable-name regex would swallow the whole thing as ONE (bogus)
  // variable reference — silently deleting the `stash` token itself rather
  // than collapsing `$IFS` to whitespace and leaving `stash` intact. That
  // was the exact bypass in `git$IFS'stash'${IFS}pop`.
  //
  // SHELL-ACCURATE per-variable resolution (round-5): each variable is
  // resolved INDEPENDENTLY, mirroring a real default shell —
  //   • `$IFS` / `${IFS}` → a single space (its default value is whitespace,
  //     so it word-splits its neighbors);
  //   • every OTHER `$VAR` / `${VAR}` → the empty string (an unset variable
  //     expands to nothing, so its neighbors CONCATENATE).
  // A two-uniform-corner sweep (all-space OR all-empty) could not represent a
  // MIXED command like `g${x}it${IFS}stash pop` (unset `$x` joins → `git`,
  // `$IFS` splits → `stash`/`pop`); this single pass does, because it applies
  // the correct rule to each variable at once. IFS is handled BEFORE the
  // generic `$VAR` rules so it isn't swallowed by the empty-collapse.
  let out = text;
  out = out.replace(/\$\{IFS\}/g, ' '); // ${IFS} → space (whitespace word-split)
  // ${IFS:0:1} / ${IFS#x} / ${IFS/a/b} / ${IFS:-x} … — any PARAMETER EXPANSION
  // of the IFS var (IFS followed by an operator char, not a name char) yields
  // whitespace in a real shell, so → space. Must run BEFORE the generic
  // `${...}`→empty rule (which would otherwise delete it). `${IFSX}` (name
  // char after IFS = a DISTINCT var) is intentionally NOT matched and falls to
  // the empty rule below. (Security round-6 finding: `git${IFS:0:1}stash pop`.)
  out = out.replace(/\$\{IFS[^}A-Za-z0-9_][^}]*\}/g, ' ');
  out = out.replace(/\$IFS\b/g, ' '); // $IFS → space (\b so $IFStash is NOT matched here)
  out = out.replace(/\$\{[^}]*\}/g, ''); // any other ${VAR} → empty (concatenate)
  out = out.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, ''); // any other $VAR → empty (concatenate)
  out = stripCommentAndQuotes(out); // NOW strip comment + quotes, after $VAR is already gone
  out = out.replace(/\\/g, ''); // drop backslashes; join adjoining text
  // Unwrap subshell/brace/backtick/`$(` execution forms. Note: this also
  // strips the `{`/`}` in a stash ref like `stash@{0}` (→ `stash@0` after
  // the surrounding space collapse), which is harmless for OUR purposes —
  // every safety check below only asks "is there a non-flag token present"
  // (`hasPositionalArg`), never inspects the ref's exact contents — but a
  // future editor adding ref-content validation here would need to reverse
  // this stripping first.
  out = out.replace(/[(){}`$]/g, ' ');
  return out;
}

/** True when `tok` is `git` or a path ending in `/git` (e.g. `/usr/bin/git`, `./git`). */
function isGitToken(tok) {
  return typeof tok === 'string' && /(^|\/)git$/.test(tok);
}

/**
 * Removes heredoc BODY lines (the content between a `<<[-~]MARKER` opener and
 * its closing `MARKER` line) from a multi-line command, replacing them with
 * nothing. The opener line itself (which contains the real shell redirect,
 * e.g. `cat <<EOF`) is preserved — only the inert body text is dropped. This
 * prevents a heredoc that quotes `git stash pop` as documentation/example
 * text from being mistaken for a real invocation once the command is split
 * on newlines by splitShellSegments().
 *
 * Handles the common forms: `<<EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF` (tab-
 * stripped closing delimiter). Best-effort — an unterminated heredoc simply
 * consumes the remainder of the command, which can only ever cause
 * under-inspection of trailing content, never a false BLOCK.
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
 * Locates the index of the `stash` token in a git invocation's token list,
 * starting the scan just after the `git` token at `gitIdx`, tolerating
 * global flags (`-C <dir>`, `-c <key=val>`, etc.) in between. Returns -1 when
 * the invocation is `git <something-else>` (not stash) — e.g. `git commit`.
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
    return -1; // some other git subcommand — not stash
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
 * Evaluates a single shell segment for a `git stash` invocation and decides
 * whether it should be blocked. Returns `null` when the segment does not
 * invoke `git stash` at all (not a stash command → no opinion, caller
 * moves on).
 *
 * The caller (`enforceStashGovernance`) already ran `normalizeStashObfuscation`
 * over the WHOLE command before segment-splitting, so by the time a segment
 * reaches this function, quotes/backslashes/`$VAR`/wrapper punctuation are
 * already gone. `stripCommentAndQuotes()` runs again here (idempotent — no
 * quotes remain, so this is a defensive no-op) before splitting on
 * whitespace, and the `git` token itself is matched by BASENAME
 * (`isGitToken`, e.g. `/usr/bin/git`) rather than exact string equality, so a
 * path-qualified invocation is treated exactly like a bare `git`.
 *
 * DETECTION IS BY SUBCOMMAND POSITION, not "the word stash appears
 * anywhere": `findGitStashIndex` walks forward from the `git` token, skips
 * recognized GLOBAL git flags (`-C <dir>`, `-c <k=v>`, etc.), and returns
 * the index of the very next non-flag token. Only when THAT token is
 * literally `stash` do we treat this as a stash invocation at all — so
 * `git commit -m stash`, `git branch stash-experiment`, and
 * `git log --grep stash` (where `stash` is an ARGUMENT, not the subcommand)
 * correctly return `null` (not a stash invocation, no opinion) rather than
 * being blocked.
 *
 * SCOPE (round 5, operator decision): once the subcommand IS `stash`, block
 * ONLY the genuinely destructive stack ops — `pop`, `clear`, and bare `drop`
 * (no ref). All other stash forms (bare `git stash`, `push`/`save` tagged or
 * untagged, `apply`/`list`/`show`, `drop <ref>`) are non-destructive to other
 * sessions' stashes and are allowed. Obfuscation is handled UPSTREAM by the
 * caller running `normalizeStashObfuscation`, whose single shell-accurate pass
 * (`$IFS` → space, every other `$VAR` → empty) collapses splices inside the
 * `git`/`stash`/subcommand tokens to their real executed form before this
 * function sees them, so a mixed `g${x}it${IFS}stash pop` is caught.
 */
function evaluateStashSegment(segment) {
  const tokens = stripCommentAndQuotes(segment).trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip a leading run of `VAR=value` env assignments.
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (!isGitToken(tokens[i])) return null; // not a git invocation at all (basename-tolerant)

  const stashIdx = findGitStashIndex(tokens, i);
  if (stashIdx === -1) return null; // `git <something-else>` — stash isn't the subcommand

  const subIdx = stashIdx + 1;
  const sub = tokens[subIdx];

  // AISDLC-611 (round 5, operator scope decision): block ONLY the genuinely
  // DESTRUCTIVE stash-stack ops — `pop`, `clear`, and bare `drop` (no ref).
  // Everything else, including bare `git stash` and untagged `push`/`save`, is
  // ALLOWED: once `pop`/`clear`/bare-`drop` are blocked, an untagged stash can
  // never be accidentally destroyed, so the old "push/save must be -m tagged"
  // requirement was redundant defense-in-depth. Dropping it also removes the
  // tag-VALUE parsing that a `$VAR`-valued tag (`-m "$TAG"`) turned into a
  // false-block regression. Tagging remains RECOMMENDED (SAFE_STASH_PATTERN),
  // just not enforced.

  // Bare `git stash` (no subcommand / next token is a flag like `-u`) is a
  // push — not destructive to anyone else's stash. Allow.
  if (!sub || sub.startsWith('-')) {
    return { blocked: false };
  }

  if (sub === 'pop') {
    return {
      blocked: true,
      reason:
        `'git stash pop' applies AND drops in one step on the SHARED stash stack (main ` +
        `checkout + all worktrees + concurrent sessions) — if your own stash captured nothing ` +
        `(e.g. nothing was staged/dirty), the pop can silently apply-and-drop a PRE-EXISTING ` +
        `stash belonging to the operator or a sibling session, permanently losing their work ` +
        `(real incident: local-trades LT-595, HIGH-3). Safe pattern: ${SAFE_STASH_PATTERN}.`,
    };
  }

  if (sub === 'clear') {
    return {
      blocked: true,
      reason:
        `'git stash clear' DELETES every entry on the SHARED stash stack (main checkout + all ` +
        `worktrees + concurrent sessions), destroying stashes that may belong to the operator ` +
        `or a sibling session. Safe pattern: ${SAFE_STASH_PATTERN}.`,
    };
  }

  if (sub === 'drop') {
    if (hasPositionalArg(tokens, subIdx + 1)) return { blocked: false }; // explicit ref → allowed
    return {
      blocked: true,
      reason:
        `bare 'git stash drop' (no explicit ref) drops whatever is CURRENTLY on top of the ` +
        `SHARED stash stack, which may not be yours. Safe pattern: ${SAFE_STASH_PATTERN}.`,
    };
  }

  // Every other subcommand (push/save tagged OR untagged, apply, list, show,
  // branch, create, store, export, drop <ref>, ...) is non-destructive to
  // other sessions' stashes — allow. (Operator scope: destructive-ops-only.)
  return { blocked: false };
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

  // AISDLC-720: untrusted runs — protected paths inside OR outside home, before
  // any permittedExternalPaths allow.
  if (UNTRUSTED.untrusted) enforceUntrustedPath(absPath, homeAbs);

  if (insideHome) {
    // Path is inside the agent's home — check against the hardcoded
    // never-editable floor plus the project's configured blockedPaths globs.
    // Relative path uses POSIX separators because globs do.
    const relPath = relative(homeAbs, absPath).split(sep).join('/');

    // AISDLC-720: no hardcoded `.ai-sdlc/**` floor for internal sessions; untrusted
    // runs are handled by enforceUntrustedPath() above.
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
  } catch {
    /* use the lexical path */
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
