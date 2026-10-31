---
name: lease-push-two-call-form
description: Governance hook only accepts a lease push as a lone command run with cwd inside the task's own worktree
metadata:
  type: reference
---

The PreToolUse governance hook allows `git push --force-with-lease origin HEAD:refs/heads/<own-branch>` only when (1) the Bash call's cwd is the task worktree under `.worktrees/` and (2) the command is exactly that, alone. A `cd <wt> &&` prefix, an env-var prefix (e.g. `AI_SDLC_SKIP_*=1 git push ...`), or the short form all resolve to `allowForcePush: never` and are denied. Do it as two Bash calls: a cd-only call, then the push. The main checkout (operator-dispatch cwd) can never lease-push. Verified 2026-10-03.

Related: [[worktree-hooks-missing-ignore-scripts]]
