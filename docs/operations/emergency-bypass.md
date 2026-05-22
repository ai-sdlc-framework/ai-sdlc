# Emergency Gate Bypass — `AI_SDLC_BYPASS_ALL_GATES`

## When to use

`AI_SDLC_BYPASS_ALL_GATES=1` is a **single env var that stops the entire pre-push chain**.
All hooks exit 0 immediately when it is set:

1. `scripts/check-coverage.sh`
2. `scripts/squash-attestation-chores.sh`
3. `scripts/check-dor-gate.sh`
4. `scripts/pre-push-fixups.sh` (AISDLC-386 mechanical-fixups orchestrator)
5. `scripts/check-task-moved.sh`
6. `scripts/check-mcp-bundle-sync.sh`
7. `scripts/check-attestation-sign.sh`

The orchestrator (`scripts/pre-push-fixups.sh`) and its three sub-hooks all
check `AI_SDLC_BYPASS_ALL_GATES` at the very top and exit 0 immediately. Setting
the bypass once therefore skips both the orchestrator pass AND each sub-hook's
defense-in-depth invocation.

**Use this only in the following narrow circumstances:**

- **RFC-0042 / gate-rewrite cutover** — when you are shipping code that modifies the very hooks being gated. Trying to push a hook-rewrite through the hook it is rewriting produces an un-resolvable chicken-and-egg failure.
- **Confirmed CI-side gate coverage** — when every gate check is already enforced by a CI workflow so the local pre-push check is redundant for this specific push.
- **Operator-directed incident response** — when the operator explicitly authorises skipping all gates to land an urgent hotfix and has committed to a post-landing remediation plan.

## How to use

```bash
AI_SDLC_BYPASS_ALL_GATES=1 git push
```

Or, if you need it for the session:

```bash
export AI_SDLC_BYPASS_ALL_GATES=1
git push
unset AI_SDLC_BYPASS_ALL_GATES   # <-- unset immediately after
```

Never leave `AI_SDLC_BYPASS_ALL_GATES=1` in your shell profile or a committed `.env` file.

## What it does NOT bypass

- `git push --no-verify` is a separate escape hatch that skips the entire husky pre-push chain including the bypass logic. If both are set, `--no-verify` wins (git never invokes the hook).
- CI-side gates are independent. Bypassing locally does not affect `verify-attestation.yml`, `ai-sdlc-review.yml`, or any other required status on `main`.
- `scripts/check-skip-ci-marker.sh` is a pre-push hook but is NOT part of the 6 gates above. It is NOT bypassed by `AI_SDLC_BYPASS_ALL_GATES`. If your commit contains a `(skip ci marker)` token, that check still fires.

## Per-gate bypasses remain available independently

If you need to skip only one gate, prefer the targeted skip:

| Gate | Skip var |
|---|---|
| Coverage | `AI_SDLC_SKIP_COVERAGE_GATE=1` |
| Task-move | `AI_SDLC_SKIP_TASK_MOVE=1` |
| DoR | `AI_SDLC_SKIP_DOR_GATE=1` |
| Attestation sign | `AI_SDLC_SKIP_ATTESTATION_SIGN=1` |

## Risks

| Risk | Mitigation |
|---|---|
| Coverage regression ships to `main` | CI codecov patch gate is still required; PR cannot merge if patch < 80% |
| Task file stays in `backlog/tasks/` forever | Move it manually with `git mv` before or after push |
| DoR violation enters the backlog | `cli-dor-check` still runs in CI against changed task files |
| Unattested code PR merges | `verify-attestation.yml` is a required check; missing envelope → PR blocked |

## Required PR-body disclosure

Every PR that was pushed with `AI_SDLC_BYPASS_ALL_GATES=1` MUST include the following in the PR body:

```
> **Emergency bypass used:** `AI_SDLC_BYPASS_ALL_GATES=1`
> Reason: <one sentence>
> Remediation: <what will be done to restore full gate coverage post-merge>
```

Reviewers treat undisclosed bypass use as a critical finding.
