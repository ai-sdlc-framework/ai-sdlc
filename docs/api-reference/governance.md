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
```

- **`preset: operator-trusted`** is sugar for `{ allowMerge: onGreenClean }`
  (the rest stay strict) — a one-line opt-in for the common "let the agent
  merge once CI is fully green" case. Explicit granular keys override the
  preset.
- **`allowMerge: onGreenClean`** only softens the *narration*; it does not by
  itself grant merge capability — merge eligibility is additionally gated on
  the work item's trust tier (internal backlog tasks vs. external
  GitHub-sourced work) and the deterministic `merge-if-eligible` gate
  (AISDLC-602/603, not yet implemented as of Phase 1).
- **`allowForcePush: leaseOnOwnBranch`** scopes force-push to the one routine
  case: after rebasing a dispatched task's branch. The PreToolUse hook then
  permits a push only when ALL of these hold:
  - it is a single `git push <configured-remote> --force-with-lease[=<own>[:<sha>]] <refspec>...`
    command (no chaining, quoting, wrapper, env prefix, `git -C`/`--git-dir`, or
    extra flags; plain ASCII only);
  - every refspec is either the bare no-colon form (`<branch>` or
    `refs/heads/<branch>`) or a colon form whose destination is spelled exactly
    `refs/heads/<branch>` (for example `HEAD:refs/heads/<branch>`). Short
    destinations such as `HEAD:<branch>` are refused because git resolves them
    against the remote with every rule (tags and notes refs win over heads), and
    names such as `heads/x`, `tags/x`, `remotes/x`, `refs/x` are refused;
  - `<branch>` is the task's own branch: the worktree has a valid `.active-task`,
    the worktree directory is named `<task-id-lower>`, and the branch starts
    with `ai-sdlc/<task-id-lower>-` (the `backlog.branching.pattern` default
    `ai-sdlc/{issueIdLower}-{slug}`, hardcoded here). Anything missing or
    disagreeing denies. **A session with no `.active-task` sentinel (an
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
  options) is blocked. `--follow-tags` is not force-ish on its own but is not part
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
  `xargs git push` is recognised.
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
