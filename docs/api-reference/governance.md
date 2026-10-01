# Action Governance

The action governance module enforces agent constraints at runtime -- preventing
dangerous operations like merging PRs, force-pushing, or deleting branches.
Enforcement happens at three layers to provide defense-in-depth.

## Import

```typescript
import {
  checkAction,
  enforceAction,
  DEFAULT_BLOCKED_ACTIONS,
  type ActionEnforcementResult,
} from '@ai-sdlc/orchestrator';
```

## Configuration

Blocked actions are declared in `agent-role.yaml` using glob-like patterns:

```yaml
apiVersion: ai-sdlc.io/v1alpha1
kind: AgentRole
metadata:
  name: coding-agent
spec:
  constraints:
    blockedActions:
      - 'gh pr merge*'        # Only humans merge
      - 'git merge*'          # No merging into main
      - 'git push --force*'   # No force push
      - 'git push -f*'        # No force push (short flag)
      - 'gh pr close*'        # Only humans close PRs
      - 'gh issue close*'     # Only humans close issues
      - 'git branch -D*'      # No branch deletion (force)
      - 'git branch -d*'      # No branch deletion
      - 'git reset --hard*'   # No destructive resets
      - 'git checkout -- .'   # No bulk discard
      - 'git restore .'       # No bulk restore
    blockedPaths:
      - '.github/workflows/**'
      - '.ai-sdlc/**'
    requireTests: true
    maxFilesPerChange: 15
```

## Per-repo governance hard-rules (RFC-0048 Phase 1)

`spec.governance` (sibling to `spec.constraints`) is the single per-repo source
of truth for the injected governance hard-rule TEXT — "NEVER merge PRs", "NEVER
force push", etc. — that Claude Code sessions and subagents see in their
SessionStart/SubagentStart banners. All keys are optional; an ABSENT
`governance` section resolves to strict defaults, reproducing the historical
injected text byte-for-byte:

```yaml
spec:
  governance:
    preset: strict            # or: operator-trusted (sugar, see below)
    allowMerge: never          # never | onGreenClean
    allowForcePush: never      # never | leaseOnOwnBranch (booleans: true = leaseOnOwnBranch, false = never)
    allowClosePrIssue: false
    allowBranchDelete: false
    allowResetHard: false
    mergeAuthors: []           # GitHub logins the merge gate may merge for; empty = nobody
```

- **`preset: operator-trusted`** is sugar for `{ allowMerge: onGreenClean }`
  (the rest stay strict) — a one-line opt-in for the common "let the agent
  merge once CI is fully green" case. Explicit granular keys override the
  preset.
- **`allowMerge: onGreenClean`** only softens the *narration*; it does not by
  itself grant merge capability. The only sanctioned merge route is
  `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind backlog`,
  which merges only when ALL of these hold (each fails closed):
  - the policy is read from the **verified main checkout**, as committed on
    `origin/main` (see below);
  - `allowMerge` resolves to `onGreenClean` there, and `--source-kind` is
    `backlog` (`gh-issue` is always refused);
  - facts read from the PR itself via one `gh pr view` call: it is **not from a
    fork** (`isCrossRepository` is `false`), its **base branch is `main`**, and its
    **author login is on `governance.mergeAuthors`**;
  - the **head commit's author login** (resolved by GitHub for that exact SHA) is
    on `governance.mergeAuthors`; a commit whose email is not linked to a GitHub
    account refuses. This is commit *metadata* set by whoever made the commit, not
    authentication: it narrows who can look like an allow-listed author, it does
    not prove who pushed;
  - a **backlog task** matching the PR exists. The id must have the repo's backlog
    shape (`<task_prefix>-<n>[.<n>...]`, prefix from `backlog/config.yml` on
    `origin/main`, default `AISDLC`; `issue-N` / `gh-issue-N` ids never qualify),
    comes from the head branch (`ai-sdlc/<id>-...`) and/or a trailing `(<ID>)` in
    the title (they must agree), and a `backlog/tasks/<id> - *.md` or
    `backlog/completed/<id> - *.md` file must exist on `origin/main` (checked with
    `git ls-tree`, so run `git fetch origin main` first) **or** be added by the
    PR's own diff. A PR that adds its own task file is accepted because the repo
    creates and completes a task in one PR, so the task is a provenance hint, NOT a
    trust signal; the author allow-list is the real trust signal. The PR file list
    comes from `gh pr view --json files`, which GitHub caps at roughly 100 files; a
    task file past the cap is simply not seen in the diff (which can only refuse);
  - the required checks (or, when branch protection has no required contexts,
    every check run and commit status) are green **for the head commit read from
    the PR**: required context names come from `gh pr checks --required`, but
    their state is read from the REST check-runs and status endpoints for that SHA
    (a required context with no result is `MISSING` and refuses; a truncated list
    refuses), and `mergeStateStatus` is `CLEAN`;
  - the PR head commit read in the first call is still the head just before the
    merge, and the merge is issued with `--match-head-commit <sha>` so GitHub
    rejects it if the head moved after the checks were evaluated (the CLI reports
    the refusal and exits non-zero).
- **`mergeAuthors`** is an optional list of GitHub logins (compared
  case-insensitively; no leading, trailing or consecutive hyphens, at most 39
  characters) whose PRs the merge gate may merge, for example
  `mergeAuthors: [octocat]`. Absent, empty or malformed means nobody, so every
  merge is refused until the operator sets it. It is read only from the policy
  file as committed on `origin/main`.
- **Verified main checkout and committed policy:** the merge CLI finds the main
  checkout of the repo that contains the running CLI (a real `.git` directory
  matching the git common dir, not a file or symlink), requires it to be the same
  checkout as the invocation's working directory, and reads the policy with
  `git show origin/main:.ai-sdlc/agent-role.yaml` there. So a worktree copy, an
  uncommitted edit of the main checkout's file, or a different repository's policy
  has no effect, and if the root or the committed file cannot be read the CLI
  refuses. The policy is resolved by code inside the CLI itself: no plugin file
  selected through `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DIR` is loaded for the
  merge decision. There is **no** flag or environment variable that overrides the
  policy root or the repository (`--repo-root` and `--repo` were removed; the
  repository comes only from `gh repo view` in the verified checkout). Tests inject
  a root and policy text programmatically through the exported
  `buildMergeIfEligibleCli({ trustedRootOverride })`, which argv and the environment
  cannot reach, and the hook refuses any shell command that names the old override
  variable.
- **API merges are blocked:** the PreToolUse hook denies
  `gh api .../pulls/<n>/merge` (any method, with or without a leading slash,
  flags in any order), `curl`/`wget` to the same endpoint, and the GraphQL
  `mergePullRequest` mutation, under every `allowMerge` value. The sanctioned
  helper stays allowed. `--admin` is not an accepted companion flag of arming
  (`gh pr merge --auto --admin` is denied). This is a text-level matcher: it cannot
  see `eval`, base64 pipelines or constructed strings.
- **Known residuals (be explicit about them):**
  - **Arming is still allowed (open operator decision).** The hook allows
    `gh pr merge --auto`, and the repository workflow arms same-repo PRs itself, so
    an agent can still arm auto-merge on ANY PR (fork PRs and non-allow-listed
    authors included), which becomes a merge as soon as GitHub's own checks pass.
    The helper's checks do not apply to arming; only GitHub-side protections
    mitigate it until the operator chooses to deny agent-side arming or route it
    through the helper.
  - **An agent-editable local CLI is not a trust boundary against that agent.** The
    CLI, the plugin hooks and the repository checkout run from the agent's own
    worktree, so an agent that can edit them is not bound by them; the verified-root
    anchor is the checkout containing the (possibly copied) CLI. The local
    `origin/main` ref is also readable and writable by the agent's git.
  - **The hook is text-level** and not a boundary against a deliberately hostile
    agent (`eval`, constructed strings, other tools).
  - **GitHub-side protections are essential and operator-only:** required status
    checks with strict (up-to-date) mode, `enforce_admins`, CODEOWNERS plus
    required review on governance paths (`.ai-sdlc/**`, hooks, the merge CLI), and
    fork-PR workflow approval. Nothing in this repository can set them.
- **`allowForcePush: leaseOnOwnBranch`** scopes force-push to the one routine
  case: after rebasing a dispatched task's branch. The PreToolUse hook then
  permits a push only when ALL of these hold:
  - it is a single `git push <configured-remote> --force-with-lease[=<own>[:<sha>]] <refspec>...`
    command (no chaining, quoting, wrapper, env prefix, `git -C`/`--git-dir`, or
    extra flags; plain ASCII only);
  - every refspec is a colon form whose source is `HEAD` (or the own branch /
    `refs/heads/<branch>`) and whose destination is spelled exactly
    `refs/heads/<branch>`, i.e. `HEAD:refs/heads/<branch>`. **The no-colon form
    (`git push --force-with-lease origin <branch>`) is refused in every case.**
    Git does not send a no-colon refspec to `refs/heads/<branch>`: it maps it
    through `remote.<name>.push` and, under `push.default=upstream|tracking`,
    through `branch.<branch>.merge`. Task branches are created from
    `origin/main`, so they track `refs/heads/main`, and the "sanctioned" command
    would force-push the task branch onto main (by accident with
    `push.default=upstream`, or on purpose with one
    `git config remote.origin.push refs/heads/<branch>:refs/heads/main`); both are
    reproduced against real git in the tests. An explicit refspec on the command
    line ignores that configuration. Short destinations such as `HEAD:<branch>`
    are refused too, because git resolves them against the remote with every rule
    (tags and notes refs win over heads), as are names such as `heads/x`,
    `tags/x`, `remotes/x`, `refs/x`;
  - `<branch>` is the task's own branch: the worktree has a valid `.active-task`
    (`AISDLC-123`, `AISDLC-100.5`, or the GitHub-issue form `gh-issue-42`), the
    worktree directory is named `<task-id-lower>` (`.worktrees/aisdlc-123`,
    `.worktrees/gh-issue-42`), and the branch starts with
    `ai-sdlc/<task-id-lower>-` (the `backlog.branching.pattern` default
    `ai-sdlc/{issueIdLower}-{slug}`, hardcoded here; the GitHub-issue path
    produces `ai-sdlc/gh-issue-42-<slug>`). Anything missing or disagreeing
    denies;
  - the worktree is genuine and it is the session's own: its real path (symlinks
    resolved) is directly under `<main checkout>/.worktrees/`; the project
    directory (`CLAUDE_PROJECT_DIR`) is either that worktree itself (a session
    rooted in worktree A that changes into sibling worktree B gets no lease from
    B) or the main checkout (then the worktree must still be a genuine bound
    `.worktrees/<id>`); the main checkout's `.git` is a real
    directory matching the git common dir, and the worktree's own git dir lives
    under `<main>/.git/worktrees/` with a `gitdir` back-pointer to the worktree.
    A forged directory elsewhere (for example `/tmp/x/aisdlc-700`), a symlinked
    `.worktrees` entry, or a hand-built gitdir pointing at the real repo all
    deny, and so does an operator's main checkout;
  - the hook knows the session's own project directory: `CLAUDE_PROJECT_DIR`
    must be set, non-empty and absolute. If it is unset, empty or relative the
    lease decision fails closed to `never` (the toplevel fallback is kept only
    for the legacy `blockedActions` / `blockedPaths` reads, since it would make
    the own-session binding below pass trivially);
  - **the accepted spelling**: run, as its own standalone command from the
    worktree, `git push --force-with-lease origin HEAD:refs/heads/<branch>` with
    the branch printed by `git branch --show-current` written literally (no
    variables, quotes, `cd &&`, chaining; `-u` is allowed, bare `HEAD` and
    `--set-upstream HEAD` are not; a lease value, if given, is
    `--force-with-lease=<branch>:<sha>`). The deny message for any other spelling
    names this one. The `/ai-sdlc rebase` command and the rebase/CI-conflict/developer agents use
    this spelling, and a test parses their push lines and runs them through the
    hook so they cannot drift; **A session with no `.active-task` sentinel (an
    operator's own session) therefore gets no lease push**; the supported paths
    are to run the rebase/push from the dispatched worktree (`/ai-sdlc rebase`)
    or for the operator to push manually. Residual: an agent can rewrite its own
    `.active-task`; the directory-name and branch-prefix agreement is the only
    other check, and the hook does not add a broad write protection for the file;
  - the branch is not protected: `main`, `master`, `release-please--branches--*`,
    `gh-pages`, `production`, `prod`, `release/*`, `releases/*`, plus anything in
    `protectedBranches` (`*` is a simple wildcard; matching is case-insensitive);
  - no other local ref answers to the branch's short name (a local tag, `refs/<name>`,
    `refs/remotes/<name>`); if that cannot be checked the push is denied.

  Everything else that looks like a force-push (plain `--force`/`-f`, `+refspec`,
  `--force-if-includes` alone, another branch, a raw URL remote, `--delete`,
  `--mirror`, `--all`, a push with no explicit refspec, abbreviations of those
  options) is blocked. Other push-affecting git config: with an explicit refspec,
  `push.followTags` only adds tags missing on the remote, `push.pushOption`,
  `push.negotiate` and `transfer.*` only tune the transport, and
  `remote.<name>.mirror=true` makes git abort; none moves a different ref.
  `remote.<name>.pushurl` / `url.<base>.pushInsteadOf` can send the task branch
  name to a different repository, which is not this guard's trust boundary.
  `--follow-tags` is not force-ish on its own but is not part
  of the allowed lease shape. The own branch is read from git state as the full
  ref, never from the command text.

  Policy trust: the lease is granted only when the MAIN checkout of the repo (the
  parent of the git common dir of the project directory, independent of the tool
  call's cwd) says `leaseOnOwnBranch`. A copy of `agent-role.yaml` edited in a
  worktree or PR can only tighten: a copy saying `leaseOnOwnBranch` with a trusted
  `never` has no effect, and a copy saying `never` with a trusted lease also
  denies (deliberate, tested). Any failure to determine the trusted policy blocks.
  The injected SessionStart/SubagentStart rule text is rendered from that same
  trusted source. The legacy `blockedActions` / `blockedPaths` lists are still
  read from the project directory (a PR-tree copy can clear them; this is the
  pre-existing trust model and is unchanged).

  Under `never` (or unset) the hook starts no git subprocess for this check, and
  additionally blocks force-push shapes the anchored `blockedActions` globs miss,
  such as `git push origin --force main`, `git push origin -f HEAD:main` and
  `+refspec` (including `--force-with-lease` and option abbreviations).

  Known limits. A `blockedActions` pattern such as `git push --force*` also
  matches `--force-with-lease`; under `leaseOnOwnBranch` the single allowed
  command shape is exempted only from `git push` patterns that match purely
  because of the lease flags, so adopter patterns like `git push *develop*` keep
  applying. Commands are split on newlines and shell separators without
  understanding quoting, so a multi-line quoted argument (for example a
  `gh pr create --body` containing a line that reads like a force push) can be
  denied under `leaseOnOwnBranch`. Payloads wrapped in `bash -c '...'` or
  `sh -c '...'` are not parsed by this hook (a pre-existing gap, unchanged);
  `xargs git push` is recognised. The matcher is not a boundary against a
  deliberately hostile agent: `bash -c`, `GIT_CONFIG`/`-c` injected `+` refspecs,
  and git aliases (under `never`) are pre-existing gaps, not closed here.
- **`operational`** is a closed list granted to the dispatch role:
  `rebase-own-branch`, `lease-push-own-branch`, `retrigger-ci`, `requeue`,
  `file-subid-followups`, `answer-operational-decisions`,
  `clear-executor-context`. Unknown entries are dropped, not granted. It is
  rendered into the injected rules only for sessions started with
  `AI_SDLC_HIERARCHY_ROLE=operator-dispatch`, and it does not relax any hook on
  its own (force-push is governed solely by `allowForcePush`).
- **Fail-closed:** any unknown key, unknown preset name, or malformed value
  (wrong type / not in the enumerated set) is ignored — the resolved value
  falls back to whatever the preset/default already produced. Malformed
  config can never accidentally relax a rule.
- **Permanently fixed, not configurable through this schema:** never write
  CI-skip magic tokens; never edit `.ai-sdlc/attestations|verdicts`; the
  `governance` declaration itself is honored only from the repo's trusted
  base-branch `.ai-sdlc/agent-role.yaml` — never from PR-modified content (the
  governed party cannot relax its own rules).

The resolver lives at `ai-sdlc-plugin/hooks/lib/governance-resolver.js`
(`resolveGovernanceFromYaml`, `renderSessionStartHardRules`,
`renderSubagentHardRules`) and is consumed by both `session-start.js` and
`subagent-start.js` so narration never drifts between the two surfaces. See
[RFC-0048](../../spec/rfcs/RFC-0048-per-repo-configurable-governance.md) for
the full design and resolved Open Questions.

## Enforcement Layers

### Layer 1: Orchestrator Runtime

The orchestrator checks every shell command before execution:

```typescript
import { checkAction, DEFAULT_BLOCKED_ACTIONS } from '@ai-sdlc/orchestrator';

const result = checkAction('gh pr merge 42 --squash', DEFAULT_BLOCKED_ACTIONS);
// { allowed: false, matchedPattern: 'gh pr merge*', command: 'gh pr merge 42 --squash' }

const safe = checkAction('git push origin feature-branch', DEFAULT_BLOCKED_ACTIONS);
// { allowed: true, command: 'git push origin feature-branch' }
```

### Layer 2: Claude Code Hooks

A PreToolUse hook reads `blockedActions` from `agent-role.yaml` and blocks
matching Bash commands before they execute:

```bash
# .claude/hooks/enforce-blocked-actions.sh
#!/bin/bash
node "$(dirname "$0")/enforce-blocked-actions.js"
```

The Node.js implementation:
- Reads `blockedActions` from `.ai-sdlc/agent-role.yaml`
- Converts glob patterns to regexes (with proper escaping)
- Exits with code 2 to block the tool call if matched

### Layer 3: Branch Protection

GitHub branch protection provides the final safety net:
- Required status checks (CI, review results, codecov/patch)
- `enforce_admins: true` -- no admin bypass
- Required pull request reviews before merging

---

## API Reference

### `checkAction(command, blockedActions)`

Check if a shell command is allowed by the blocked actions policy.

```typescript
function checkAction(
  command: string,
  blockedActions: string[],
): ActionEnforcementResult;
```

**Parameters:**
- `command` -- The shell command to check (whitespace is trimmed)
- `blockedActions` -- Array of glob-like patterns (supports `*` wildcard)

**Returns:** `ActionEnforcementResult`

```typescript
interface ActionEnforcementResult {
  allowed: boolean;
  matchedPattern?: string;  // The pattern that matched, if blocked
  command: string;           // The trimmed command that was checked
}
```

### `enforceAction(command, blockedActions, auditLog?, agentName?)`

Check an action and record the result in the audit log if blocked.

```typescript
function enforceAction(
  command: string,
  blockedActions: string[],
  auditLog?: AuditLog,
  agentName?: string,
): ActionEnforcementResult;
```

**Parameters:**
- `command` -- The shell command to check
- `blockedActions` -- Array of glob-like patterns
- `auditLog` -- Optional audit log instance for recording blocked actions
- `agentName` -- Optional agent name for audit entries (defaults to `'agent'`)

When a command is blocked, the audit log records:

```json
{
  "actor": "coding-agent",
  "action": "execute",
  "resource": "command/gh pr merge 42 --squash",
  "decision": "denied",
  "details": {
    "reason": "blocked-action",
    "pattern": "gh pr merge*",
    "command": "gh pr merge 42 --squash"
  }
}
```

### `DEFAULT_BLOCKED_ACTIONS`

The default set of blocked action patterns:

```typescript
const DEFAULT_BLOCKED_ACTIONS: string[] = [
  'gh pr merge*',
  'git merge*',
  'git push --force*',
  'git push -f*',
  'gh pr close*',
  'gh issue close*',
  'git branch -D*',
  'git branch -d*',
  'git reset --hard*',
  'git checkout -- .',
  'git restore .',
];
```

---

## Pattern Matching

Patterns use a simple glob syntax:
- `*` matches any sequence of characters
- All other characters are matched literally (case-insensitive)
- The entire command must match the pattern (anchored match)

Examples:

| Pattern | Matches | Does Not Match |
|---|---|---|
| `gh pr merge*` | `gh pr merge 42`, `gh pr merge 42 --squash` | `gh pr create` |
| `git push --force*` | `git push --force origin main` | `git push origin main` |
| `git checkout -- .` | `git checkout -- .` | `git checkout -b feature` |

---

## Review Dismissal Policy

By default, agents **can** dismiss PR reviews when they have a documented reason
(e.g., infrastructure failures like API credit exhaustion, or documented false
positives). The dismissal must always include a clear explanation.

For recurring false positives, the preferred approach is updating
`.ai-sdlc/review-policy.md` to calibrate the review agents rather than
repeatedly dismissing reviews.

---

## Testing

The enforcement module includes comprehensive tests verifying consistency
between the orchestrator's `checkAction()` and the Claude Code hook's regex
patterns. Both enforcement points are tested against the same set of blocked
and allowed commands.

```bash
pnpm --filter @ai-sdlc/orchestrator test -- action-enforcement
```
