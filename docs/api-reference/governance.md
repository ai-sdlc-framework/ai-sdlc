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
