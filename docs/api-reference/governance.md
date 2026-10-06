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

## Who may edit governance config (AISDLC-720)

Internal sessions (the operator's own agents, run by `/ai-sdlc execute` and the orchestrator) may edit governance config under `.ai-sdlc/` and workflows under `.github/workflows/`, as long as the task names the file and the change. They do not edit config as a side effect of other work. Runtime artifacts (attestations, reviews, transcript leaves, the decision log, the dispatch board) are written through their CLIs. Reviewers can write their own transcripts and ledgers under `.ai-sdlc/`.

**What marks a run untrusted.** Two kinds of signal. (a) Environment: `AI_SDLC_UNTRUSTED_RUN` set to any non-empty value other than `0`, `false`, `no` or `off` (unknown values fail closed to untrusted), with an optional `AI_SDLC_UNTRUSTED_REASON` that is shown in the refusal. Producers: (1) shipped in code: the pipeline wraps the spawner for the `gh-issue` source kind so every spawned agent process carries the signal (`pipeline-cli/src/runtime/untrusted-env.ts`; subprocess spawners such as `ShellClaudePSpawner` only). An interactive Claude Code session cannot mark itself untrusted after launch; launch it with the signal set. (2) Workflows must set it for fork pull requests and pull requests whose author association is not OWNER, MEMBER or COLLABORATOR. Those workflow producers are NOT yet shipped; they and the CI check are a follow-up after AISDLC-721, until which time outside PRs rely on CODEOWNERS and the existing untrusted-PR gate. (3) Fail closed in CI: a run with `GITHUB_ACTIONS=true` and no explicit internal marker (`AI_SDLC_INTERNAL_RUN` set to a truthy value) is untrusted even with no signal, because the issue workflow and the external-PR review workflow do not go through `executePipeline`. Until the workflow half sets the internal marker on trusted jobs (after AISDLC-721), every CI run is untrusted for protected-path writes. The workflow half must set `AI_SDLC_INTERNAL_RUN` only in the step-level `env:` of a trusted step (never job or workflow level, and never via `$GITHUB_ENV`, which carries to later steps), and should set `AI_SDLC_UNTRUSTED_RUN` explicitly on outside-input jobs since it overrides the marker. The rule assumes the host passes `GITHUB_ACTIONS` through to the hook process; non-GitHub CI systems are not detected. Outside GitHub Actions, a session with no signal and no marker is internal.

**Untrusted marker file (AISDLC-730).** (b) A file `<gitdir>/ai-sdlc-untrusted` for the worktree (the linked worktree's own git dir, so it is never part of the working tree or a commit). The hook re-derives it on every call by walking up from the tool's `cwd` to the first `.git` and reading the file, independent of the environment, so a child agent started with a cleared environment is still untrusted. The file wins over env signals: `AI_SDLC_UNTRUSTED_RUN=0` and `AI_SDLC_INTERNAL_RUN=1` cannot override it, and an unreadable marker fails closed. The hook refuses an untrusted run's writes to the marker (Write/Edit and shell patterns). Producers write it at worktree setup alongside the env wrapper: `gh-issue` execution, an inline `taskSpec` with no `sourceKind`, and `rework-pr` (`writeUntrustedMarker` in `pipeline-cli/src/runtime/untrusted-env.ts`). The issue workflow (`.github/workflows/ai-sdlc.yml`, `agent` job) and the external-PR review workflow (`ai-sdlc-review.yml`, `analyze` job) set `AI_SDLC_UNTRUSTED_RUN` at job level, covered by tests in `.github/workflows/__tests__/trust-marker.test.mjs`; `AI_SDLC_INTERNAL_RUN` appears only in step-level `env`, never via `$GITHUB_ENV`. A trusted session never sees a prompt: with no signal and no marker nothing changes, asserted by the hook regression test. To clear a marker left on a worktree you now want to work in, delete the file from a plain shell (outside any untrusted run) or remove the worktree.

**Limits (decided in AISDLC-730).** Other CI systems (GitLab, CircleCI, Jenkins and so on) are NOT detected and stay fail-open: detection would need a per-vendor environment variable list that is itself environment-derived (so clearable) and that would misclassify trusted self-hosted runners; adopters on those systems set `AI_SDLC_UNTRUSTED_RUN=1` on jobs that take outside input. A process that leaves the worktree (a `cwd` outside any checkout carrying the marker) and has no environment signal is not marked by the file. Trust decisions read no policy at all, only the environment and the marker, so there is no working-copy-versus-HEAD policy question for them. The separate lease-push and force-push policy already reads the main checkout through `lib/trusted-policy.js`; moving blockedPaths and other allow-style config to a committed (HEAD) revision is a larger change recorded for the planner rather than done here.

**What untrusted runs cannot do.** The PreToolUse hook refuses Write, Edit and MultiEdit on `.ai-sdlc/**`, `.github/workflows/**`, `.claude/**`, `.husky/**`, `ai-sdlc-plugin/hooks/**` and `.active-task`, whether the path is inside or outside the worktree and including paths that reach those places through a symlink, and refuses shell commands that write there (redirects, `tee`, `sed -i`, `cp`, `mv`, `rm`, `tar`, interpreter one-liners, `cd` into a protected directory and similar, plus `git switch/am/cherry-pick/stash apply/reset --hard`; matched best-effort). If the hook itself errors, an untrusted run is blocked (exit 2). The hook reads the signal from its own process environment, so nothing the run can write (tool input, `agent-role.yaml`, the `.active-task` sentinel, or `VAR=0 cmd` / `unset` in a command) can clear it for that hook process. That holds for the hook process only: a child agent process started without the signal is internal, and an untrusted agent still runs with the operator's user privileges (shell commands, `scripts/`, tests, `.git/` config and hooks that the pipeline's own later `git push` executes). The hook stops naive edits; it does not isolate a deliberately hostile run. Known residuals are tracked as follow-ups in the PR body. The refusal says the run is untrusted and tells the agent to ask a maintainer in the PR.

**Enforcement code location.** The hook and settings are only trustworthy if they come from outside the PR tree: CI must run agents with a pinned plugin installed outside the checkout, not the PR's own `ai-sdlc-plugin/` or `.claude/` directories.

**Where the CI boundary is.** The hook is a guard, not a boundary: shell pattern matching can be bypassed. The real boundary for outside contributions is in CI, derived from GitHub facts (fork, author association) plus CODEOWNERS; a required check that fails PRs from forks or outside authors that change governance config is tracked as a follow-up to AISDLC-720 (AISDLC-721).

**Project opt-in.** `constraints.blockedPaths` keeps working for any project that wants stricter rules; it applies to internal sessions too.

## Per-repo governance hard-rules (RFC-0048 Phase 1)

`spec.governance` (sibling to `spec.constraints`) is the single per-repo source
of truth for the injected governance hard-rule TEXT — "NEVER merge PRs", "NEVER
force push", etc. — that Claude Code sessions and subagents see in their
SessionStart/SubagentStart banners. All keys are optional; an ABSENT
`governance` section resolves to strict defaults, reproducing the historical
injected text byte-for-byte, with ONE exception: `allowForcePush` defaults to
`leaseOnOwnBranch` (see "Velocity impact" below):

```yaml
spec:
  governance:
    preset: strict            # or: operator-trusted (sugar, see below)
    allowMerge: never          # never | onGreenClean
    allowForcePush: leaseOnOwnBranch  # never | leaseOnOwnBranch (default when unset; booleans: true = leaseOnOwnBranch, false = never)
    allowClosePrIssue: false
    allowBranchDelete: false
    allowResetHard: false
    allowReleaseMerge: false   # narrow grant: lets agents land the release PR only
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
  - the policy is read from the repository's **`main` as GitHub serves it** (see
    below);
  - `allowMerge` resolves to `onGreenClean` there, and `--source-kind` is
    `backlog` (`gh-issue` is always refused);
  - facts read from the PR itself via one `gh pr view` call: it is **not from a
    fork** (`isCrossRepository` is `false`), its **base branch is `main`**, and its
    **author login is on `governance.mergeAuthors`**;
  - the **head commit's author login** (resolved by GitHub for that exact SHA) is
    on `governance.mergeAuthors`; a commit whose email is not linked to a GitHub
    account refuses. This is commit *metadata* set by whoever made the commit, not
    authentication: it narrows who can look like an allow-listed author, it does
    not prove who pushed. **Only the head commit's author is checked**; authors of
    earlier commits on the branch are not;
  - a **backlog task** matching the PR exists. The id must have the repo's backlog
    shape (`<task_prefix>-<n>[.<n>...]`, prefix from `backlog/config.yml` on
    `main`, default `AISDLC`; `issue-N` / `gh-issue-N` ids never qualify),
    comes from the head branch (`ai-sdlc/<id>-...`) and/or a trailing `(<ID>)` in
    the title (they must agree), and a `backlog/tasks/<id> - *.md` or
    `backlog/completed/<id> - *.md` file must exist on `main` (read with the git
    trees API; a failed or truncated listing refuses) **or** be added by the PR's
    own diff. A PR that adds its own task file is accepted because the repo
    creates and completes a task in one PR, so the task is a provenance hint, NOT a
    trust signal; the author allow-list is the real trust signal. The PR file list
    comes from `gh pr view --json files`, which GitHub caps at roughly 100 files; a
    task file past the cap is simply not seen in the diff (which can only refuse);
  - the required checks (or, when branch protection has no required contexts,
    every check run and commit status) are green **for the head commit read from
    the PR**: required context names come from `gh pr checks --required`, but
    their state is read, across all pages, from the REST check-runs and status
    endpoints for that SHA (a required context with no result is `MISSING` and
    refuses), and `mergeStateStatus` is `CLEAN`. Required checks are matched **by
    name**: a commit status can be posted under any name by anyone with write
    access, so this is only meaningful once branch protection pins each required
    check to the GitHub Actions app (operator-only; tracked as "H4");
  - the PR changes **no governance-sensitive path**: `.ai-sdlc/**` (except the
    generated attestation evidence, below), `.claude/**`, `.opencode/**`,
    `.codex/**`, `.github/**`, `.husky/**`, `ai-sdlc-plugin/hooks/**`,
    `ai-sdlc-plugin/.claude-plugin/**`, `ai-sdlc-plugin/agents/**`,
    `ai-sdlc-plugin/commands/**`, `ai-sdlc-plugin/scripts/**`,
    `pipeline-cli/src/governance/**`, the merge CLI sources and
    `pipeline-cli/bin/cli-merge-if-eligible.mjs`, `pipeline-cli/src/runtime/exec.ts`,
    `pipeline-cli/package.json`, `pipeline-cli/tsconfig*.json`, `scripts/check-*`,
    `spec/schemas/agent-role.schema.json`, any `CODEOWNERS`, `opencode.json`,
    `opencode.jsonc`, any `CLAUDE.md` or `AGENTS.md`, and the bare names `.claude`,
    `.opencode`, `.codex` (a symlink or gitlink has no trailing path). Matching is
    case-insensitive on the normalised path (`.` and `..` resolved), and for a
    rename both the new and the previous name count. **Exempt** are only the files
    directly inside the generated evidence directories that every attested code PR
    commits: `.ai-sdlc/attestations/`, `.ai-sdlc/transcript-leaves/`,
    `.ai-sdlc/reviews/`, `.ai-sdlc/verdicts/`, `.ai-sdlc/transcripts/` and
    `.ai-sdlc/transcript-leaves.jsonl`; a nested path, an evidence-looking name
    elsewhere, or `.ai-sdlc/attestations/../agent-role.yaml` stays sensitive.
    Ordinary agent PRs (source, tests, docs, `backlog/`, `spec/rfcs`, other
    schemas, `reference/`, `orchestrator/`) are unaffected. Some listed paths do
    appear in ordinary work (for example `pipeline-cli/package.json` when adding a
    bin, or `ai-sdlc-plugin/commands/*.md`); they stay sensitive on purpose, so a
    human merges those. Governance changes need a human merge, in both merge and
    `--arm` mode, so a PR that edits the policy or the gate itself (including the
    PR that introduced this rule, and the PR that grants `allowMerge`) is merged by
    a human. The file list is the compare between the resolved `main` SHA and the
    PINNED head SHA (all pages, deduplicated), not the PR's current file list, so a
    push after the head was read cannot change it. A failed or malformed read, or a
    list that reaches GitHub's 300-file compare cap, refuses, and so does a PR with
    no changed files (nothing to merge). This rule holds for the helper only, see
    the residuals below;
  - the PR head commit read in the first call is still the head just before the
    merge, and the merge is issued with `--match-head-commit <sha>` so GitHub
    rejects it if the head moved after the checks were evaluated (the CLI reports
    the refusal and exits non-zero).
- **`mergeAuthors`** is an optional list of GitHub logins (compared
  case-insensitively; no leading, trailing or consecutive hyphens, at most 39
  characters) whose PRs the merge gate may merge, for example
  `mergeAuthors: [octocat]`. Absent, empty or malformed means nobody, so every
  merge is refused until the operator sets it. It is read only from the policy
  file on `main` as GitHub serves it.
- **`--source-kind release` (AISDLC-702)** is the sanctioned path for the rolling
  release-please PR (`chore: release main`), for example
  `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind release --arm`
  (merge now with the same command minus `--arm`). It uses squash and needs either
  `allowMerge: onGreenClean` or the narrower `governance.allowReleaseMerge: true`
  (see Enablement); it can only ever land a PR that passes every check below, so
  it widens merge rights to release PRs only.
  A release is still cut only on an explicit operator instruction each time.
  The facts are read from GitHub for the exact head commit, and any failure
  refuses with a message naming the failed check:
  - same-repo PR (not a fork), head ref exactly `release-please--branches--main`,
    base `main`;
  - the PR author is in the effective release author set, resolved for the release
    path ONLY (it never widens the other source kinds): `governance.releaseAuthors`
    if present (an explicit empty list disables the release path),
    else a non-empty `governance.mergeAuthors`, else the built-in release-please bot
    logins `github-actions[bot]` and `release-please[bot]` (REST spelling; the
    `app/<slug>` spelling printed by `gh` compares equal). A refusal names the PR's
    actual author, the effective set and which tier it came from, and the exact
    value to add (`governance.releaseAuthors: [<login>]`). `release.yml` runs
    release-please with the `AI_SDLC_PAT` token (PRs created with the workflow
    token do not trigger CI, so the workflow stays on the PAT), so past release PRs
    (#1078, #1105) are authored by the account that owns the PAT, not a bot. In such
    a repo the author check passes only once that account is in `releaseAuthors` or
    `mergeAuthors`. **When the release PR is authored by a shared PAT identity that
    agents also push as, the author check is NOT the control**: anyone holding that
    identity passes it. The controls are the exact release branch, the content-based
    (not path-only) file validation, green required checks, the enablement grant
    below, and the CLI role mistake guard (DEC-0038, see below). No hook-level
    control exists yet; a follow-up task adds one;
  - **Enablement:** release merges are refused unless `governance.allowMerge:
    onGreenClean` or `governance.allowReleaseMerge: true` (default `false`). The
    refusal names both keys and values, what is currently set, and the next step
    (the dispatch/planner session sets one on `main`). `allowReleaseMerge` is a
    narrower grant for release PRs only and never satisfies the backlog or
    gh-issue kinds. `allowMerge: never` does NOT stop release merges while
    `allowReleaseMerge: true`; to stop all agent merges also leave
    `allowReleaseMerge` unset/false or set `releaseAuthors: []` (an explicit empty
    list disables the release path even when a grant is set). Neither key affects
    merges GitHub's own auto-merge performs once a workflow has armed them. There is no separate switch for the sanctioned CLI
    itself;
  - every commit on the PR has an author AND committer that is one of those
    logins, or an unlinked identity with the pin-sync job's email
    `release-bot@ai-sdlc.io` (AISDLC-577; that identity has no GitHub login, which
    is why the unlinked case is allowed). **Weakness, stated plainly:** the
    release-please and pin-sync commits on #1078 and #1105 are unsigned
    (`verified: false`), so a verified signature cannot be required; author and
    committer are metadata that anyone with push access to the branch can set. The
    content validation below is what bounds the impact. Whether all commits are
    verified is recorded in the audit line;
  - every changed file (and every rename source) is on a fixed allowlist of release
    artifacts: the `CHANGELOG.md` files, the `package.json` of the packages
    release-please bumps, `sdk-python/pyproject.toml`, `.release-please-manifest.json`,
    `release-please-config.json`, `.claude-plugin/marketplace.json`, and the two
    plugin manifests `ai-sdlc-plugin/plugin.json` and
    `ai-sdlc-plugin/.claude-plugin/plugin.json` (the files the AISDLC-577 pin-sync
    commits). Any other path makes the PR ineligible;
  - file CONTENT is validated, not only paths. Removed, renamed or copied files and
    non-regular entries (symlinks, submodules) are refused. Every allowlisted file
    except `CHANGELOG.md` (markdown, any content) is fetched at the base (tip of
    `main`) and at the head and must be identical after parsing except for
    version-like values: `version` in package and plugin manifests,
    `plugins[0].version` in the marketplace file, the values in
    `.release-please-manifest.json`, and the two `runtimeDependencies` pins that
    the pin-sync writes (`>=X.Y.Z <1.0.0`). Any other key change (for example
    `hooks`, `mcpServers` or `scripts`), a malformed value, or unparsable content
    refuses with the file and key named. `sdk-python/pyproject.toml` may change
    only its `version` line. A blob that cannot be fetched refuses. A `main` that
    moved one of these files since the release PR was last rebased also refuses
    (fail-closed) until release-please rebases;
  - all required checks are green for the head AND `mergeStateStatus` is `CLEAN`,
    in `--arm` as well as merge mode, so there is no window between verification
    and the merge. **Residual risk:** auto-merge armed on GitHub persists; a push
    to the release branch after arming is not re-verified by this CLI (the arm is
    pinned with `--match-head-commit`, and branch protection and required checks
    apply afterwards).
  - **Who may call it:** `governance.releaseMergeRoles` (default `operator`,
    `planner`; executor denied), read from the policy on `main`. The caller role is
    `AI_SDLC_CALLER_ROLE` when set explicitly; otherwise `executor` when
    `AI_SDLC_ACTIVE_TASK_ID` is set or an `.active-task` sentinel exists in the cwd
    or an ancestor; otherwise the role is undeterminable and the CLI refuses, so an
    operator running from a plain shell sets `AI_SDLC_CALLER_ROLE=operator`. **This restriction is a mistake guard, not a security
    boundary**: the role comes from the caller's own environment, and a same-user
    CLI check cannot stop a determined same-user process (DEC-0038). The
    GitHub-derived PR checks above are the real control.
  - **Merge method:** always squash; any other `--merge-method` is refused.
  - **Audit:** every attempt that reaches the release path (merged, armed, dry-run,
    refused) appends one JSON
    line (`sourceKind: release`, caller, gh-authenticated login from `gh api user`,
    caller role, PR, head, whether all commits are verified, outcome, reason) to
    `$ARTIFACTS_DIR/_governance/merge-audit-YYYY-MM-DD.jsonl`. `caller` is `$USER`
    and advisory only; `ghLogin` is the authenticated identity. Refusals that
    happen before the release path runs (no verified main checkout, repository slug
    not resolvable) are printed but not audited.
- **What is authoritative (policy trust):** the policy
  (`spec.governance.allowMerge` + `mergeAuthors`), `backlog/config.yml`
  (`task_prefix`) and the task-file existence check are read from GitHub
  (`gh api repos/<slug>/contents/<path>?ref=<sha>` and the git trees API), against
  the SAME repository slug as the PR being merged or armed. The `main` BRANCH is
  resolved once (`git/ref/heads/main`, so a tag named `main` cannot shadow it; a
  non-commit object or any error refuses) and every one of those reads uses that
  one commit SHA. They are not read from
  any local ref, working tree, worktree copy or git environment variable, so a
  forged local `origin/main`, an uncommitted edit, `GIT_COMMON_DIR` and friends
  have no effect, and a revocation on `main` applies on the very next run with no
  local fetch. Any gh/API failure, non-200 answer or empty body refuses. The slug
  comes only from `gh repo view` in the verified main checkout (a real `.git`
  directory matching the git common dir, not a file or symlink, which must be the
  same checkout as the invocation's working directory); that checkout is an extra
  anchor, not the policy source. The policy is resolved by code inside the CLI
  itself: no plugin file selected through `CLAUDE_PLUGIN_ROOT` /
  `CLAUDE_PLUGIN_DIR` is loaded for the merge decision. There is **no** flag or
  environment variable that overrides the policy root or the repository
  (`--repo-root` and `--repo` were removed). Tests inject a root and policy text
  programmatically through the exported
  `buildMergeIfEligibleCli({ trustedRootOverride })`, which argv and the
  environment cannot reach, and the hook refuses any shell command that names the
  old override variable. What this does NOT cover: an agent that edits or copies
  the CLI itself is not bound by it (see the residuals below).
- **Arming goes through the helper (`--arm`):**
  `node pipeline-cli/bin/cli-merge-if-eligible.mjs <pr> --source-kind backlog --arm`
  arms auto-merge (`gh pr merge <n> --auto --squash --match-head-commit <sha>`,
  matching the repository workflow's squash method) only when the same policy gate
  and trust checks pass: `allowMerge: onGreenClean` on `main`,
  `--source-kind backlog`, not a fork, base `main`, author and head commit author on
  `mergeAuthors`, a backlog task, and the head re-read unchanged just before arming.
  It does NOT require the checks to be green or `mergeStateStatus` to be `CLEAN`,
  because waiting for GitHub's checks is the point of arming, and it adds
  `--dry-run`, `--format json` and the `REFUSED` / `ARMED` output and exit codes of
  merge mode. An armed PR is a merge in waiting, so arming needs the same grant as
  merging: under the default `allowMerge: never` it is refused. Neither the head
  re-read nor `--match-head-commit` bounds pushes made AFTER arming: GitHub keeps
  auto-merge enabled when someone with write access pushes again, so an armed PR
  can merge a later commit once its checks pass. Because
  `auto-enable-auto-merge.yml` already arms every same-repo PR on open, the
  `--arm` trust checks matter mainly for fork PRs and for re-arming.
- **Raw merge commands and API merges are blocked:** the PreToolUse hook denies
  EVERY raw `gh pr merge` invocation, whatever the flags (`--auto`, `--squash`,
  `--rebase`, `--admin`, `--delete-branch`, `--disable-auto`), and
  `gh api .../pulls/<n>/merge` (any method, with or without a leading slash,
  flags in any order), `curl`/`wget` to the same endpoint, and the GraphQL
  `mergePullRequest` and `enablePullRequestAutoMerge` mutations, under every
  `allowMerge` value. The sanctioned helper (merge mode and `--arm`) stays allowed.
  Every line of the command text is matched, heredoc bodies included (a heredoc
  can be fed to a shell, `source`, `eval`, `xargs` or written to a script, and no
  opener list is complete), so documentation or a commit message that merely
  quotes the command is also denied: write such text with a file tool or describe
  the command in words. The repository workflow `auto-enable-auto-merge.yml` still arms
  same-repo PRs on open; it is not an agent action and is unchanged. This is a
  text-level matcher: it cannot see `eval`, base64 pipelines, variable-expanded
  URLs, `node -e` / `python -c` with argv arrays, `gh api graphql --input <file>`,
  shell aliases, `gh pr --repo o/r merge`-style reordering or constructed strings.
- **Known residuals (be explicit about them):**
  - **"Governance changes need a human merge" holds for the helper only.**
    `.github/workflows/auto-enable-auto-merge.yml` still arms EVERY same-repo PR,
    governance PRs included, and the in-repo arming sites (`reconcile.ts`,
    `resume-from-draft.ts`, `execute-pipeline.ts`) arm through a child-process `gh`
    call outside the hook. Today only GitHub-side review requirements keep a
    governance PR human. Before the `allowMerge` grant (AISDLC-663.3), either run
    this path rule in the workflow and route the in-repo sites through `--arm`
    (recommended follow-up AISDLC-663.5.1), or confirm that branch protection
    enforces required code-owner review (H4).
  - **Operator-token power.** Agents act as the operator's `gh` login and
    `mergeAuthors` matches that same login, so the allow-list does not separate the
    agent from the operator. An admin-scoped token can bypass branch protection or
    change rulesets. H4 therefore requires a non-admin agent token with no bypass
    role, `enforce_admins` on, and an empty bypass list. CODEOWNERS is
    `* @deefactorial`, and an author cannot approve their own PR, so a
    governance PR still needs a second human identity to approve.
  - **Race window.** The policy is read once at the start of a run and the merge
    happens seconds later; a revocation landing in between is missed (the next run
    sees it).
  - **The operator's token is not constrained here.** Everything above governs the
    agent's shell; a GitHub token with merge rights used by anything else is outside
    this change.
  - **An agent-editable local CLI is not a trust boundary against that agent.** The
    CLI, the plugin hooks and the repository checkout run from the agent's own
    worktree, so an agent that can edit or copy them is not bound by them; the
    verified-root anchor is the checkout containing the (possibly copied) CLI.
  - **In-repo arming call sites are not gated.** `pipeline-cli` code that arms
    through a child-process `gh` call (the orchestrator reconcile path,
    `resume-from-draft.ts`, `execute-pipeline.ts`) bypasses the hook, which only
    sees Bash tool calls. Routing them through `--arm` is a recommended follow-up.
  - **The hook is text-level** and not a boundary against a deliberately hostile
    agent (see the list above).
  - **Forged commit statuses:** see "matched by name" above.
  - **GitHub-side protections are essential and operator-only:** required status
    checks with strict (up-to-date) mode with each check pinned to the GitHub
    Actions app, `enforce_admins`, CODEOWNERS plus required review on the governance
    paths (`.ai-sdlc/**`, hooks, the merge CLI), a ruleset that blocks creating a
    tag or branch named `main` (the CLI resolves the branch by its full ref, but
    other tools use the short name), fork-PR workflow approval, and no bypass
    actors. Nothing in this repository can set them.
  - **A fake `gh`, `PATH` or proxy** (anything the agent controls in the
    environment that the CLI shells out through) can feed the CLI false answers;
    this is part of the edited-or-copied-CLI residual above.
- **`allowForcePush: leaseOnOwnBranch`** (the DEFAULT when the key is unset,
  AISDLC-710) scopes force-push to the one routine case: after rebasing a
  dispatched task's branch. The key is `spec.governance.allowForcePush` in
  `.ai-sdlc/agent-role.yaml`. An explicit `never` (or boolean `false`) always
  wins over the default and refuses every lease push; any other present value
  is malformed and fails closed to `never`. The PreToolUse hook permits a push
  only when ALL of these hold:
  - it is a single `git push <configured-remote> --force-with-lease[=<own>[:<sha>]] <refspec>`
    command (no chaining, quoting, wrapper, env prefix, `git -C`/`--git-dir`, or
    flags other than `-u`/`--set-upstream`, `--force-if-includes`, `-q`, `-v`;
    plain ASCII only; the flag may sit before or after the remote);
  - the destination provably lands on `refs/heads/<branch>` on a configured
    remote. The remote and a refspec are both required. Accepted spellings:
    `HEAD:refs/heads/<branch>`, `<branch>:refs/heads/<branch>`,
    `refs/heads/<branch>:refs/heads/<branch>`.
    **Every refspec without a colon (bare `HEAD`, `<branch>`, `refs/heads/<branch>`)
    and every omitted remote or refspec is refused.**
    Git does not send such a refspec to `refs/heads/<branch>`: it maps it
    through `remote.<name>.push`, `push.default` and, under
    `push.default=upstream|tracking`, `branch.<branch>.merge`. Task branches are
    created from `origin/main`, so they track `refs/heads/main`, and the "sanctioned"
    command would force-push the task branch onto main (by accident with
    `push.default=upstream`, or on purpose with one
    `git config remote.origin.push refs/heads/<branch>:refs/heads/main`). Bare
    `HEAD` is no safer: a local tag named `HEAD` plus
    `git config remote.origin.push refs/tags/HEAD:refs/heads/main` overwrites main.
    All of these are reproduced against real git in the tests, as is the fact
    that an explicit `HEAD:refs/heads/<branch>` ignores that configuration. Short
    destinations such as `HEAD:<branch>` are refused too, because git resolves
    them against the remote with every rule (tags and notes refs win over heads),
    as are names such as `heads/x`, `tags/x`, `remotes/x`, `refs/x`;
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
    B) or the main checkout, in which case the session must be bound to ONE task
    by the `AI_SDLC_ACTIVE_TASK_ID` environment variable the hook itself sees
    (set by the dispatcher; the agent's own commands cannot change it) and the
    worktree's `.active-task` must equal it, so `cd .worktrees/<sibling>` gets no
    lease and a main-checkout session without that variable gets none; the main checkout's `.git` is a real
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
    variables, quotes, `cd &&`, chaining; `-u` is allowed; bare `HEAD`, `-u origin HEAD`
    and the omitted-remote / omitted-refspec forms are refused; a lease value, if given, is
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
  call's cwd) resolves to `leaseOnOwnBranch` (explicitly, or by default: a
  missing `agent-role.yaml` or an unset key counts as the default, while a file
  that exists but cannot be read blocks). A copy of `agent-role.yaml` edited in a
  worktree or PR can only tighten: a copy saying `leaseOnOwnBranch` with a trusted
  `never` has no effect, and a copy saying `never` with a trusted lease also
  denies (deliberate, tested). Any failure to determine the trusted policy blocks.
  An operator session in the main checkout (not a dispatched task worktree) gets
  no lease under any value.

  When a force push is refused, the message names the config key
  (`spec.governance.allowForcePush` in `.ai-sdlc/agent-role.yaml`) and the value
  that allows the push (`leaseOnOwnBranch`), and points at the supported
  spelling; it never suggests a skip variable, a hook bypass or a plain force.
  `/ai-sdlc doctor` reports the effective value and whether it is the default or
  set in the file (check `force-push-policy`).
  The injected SessionStart/SubagentStart rule text is rendered from that same
  trusted source. The legacy `blockedActions` / `blockedPaths` lists are still
  read from the project directory (a PR-tree copy can clear them; this is the
  pre-existing trust model and is unchanged).

  Under an explicit `never` the hook starts no git subprocess for this check, and
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
- **`roles.<role>.blockedTools`** lists tool calls a hierarchy session holding that
  role is refused by the `enforce-role-tools` PreToolUse hook (roles: `executor`,
  `operator-dispatch`, `planner`; each entry is a `tool` name, exact or with `*`
  wildcards, plus an optional built-in `match` or an `argument` + `contains` pair).
  Only the executor has defaults: `SendMessage` only to the dispatch session, a
  `cli-decisions` subcommand allowlist (`escalate`, `add` without autonomous-fallback
  or timebox flags, and the read-only subcommands), and sub-task-only creation
  through the `task_create` tools, Write/Edit/MultiEdit of new task files and
  `backlog task create`. The MCP create tools and Write/Edit/MultiEdit are enforced by
  tool matcher; the Bash rules are pattern matchers and do not catch every way a
  shell can write a file. A non-empty
  list replaces the role's defaults, `blockedTools: []` disables that role's tool
  blocks, and a malformed list is ignored (defaults apply). The policy is read from the verified main checkout's copy
  when available. A session whose role cannot be resolved from the roster is treated
  as the operator and never blocked. See
  [parallel dispatch](../operations/parallel-dispatch.md#role-tool-rules).
- **Fail-closed:** any unknown key, unknown preset name, or malformed value
  (wrong type / not in the enumerated set) is ignored — the resolved value
  falls back to whatever the preset/default already produced. Malformed
  config can never accidentally relax a rule. The one exception to "ignored" is
  `allowForcePush`, whose default is the lease mode: a PRESENT but malformed
  value (including an empty one) resolves to `never` instead of the default, so
  a typo never widens it.
- **Velocity impact (AISDLC-710).** The `allowForcePush` default changed from
  `never` to `leaseOnOwnBranch`. This is a behavior change adopters get on
  upgrade: a repo that sets nothing now lets a dispatched agent
  `--force-with-lease` its own task branch after the rebase the framework
  requires, instead of stopping to ask the operator to authorize the push after
  every rebase. Nothing else relaxes: plain `--force`/`-f`/`+refspec`, any force
  push to `main`/`master`/a protected branch, and a lease push of a branch the
  session does not own stay refused. To keep the old behavior, set
  `spec.governance.allowForcePush: never` in `.ai-sdlc/agent-role.yaml`.
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
