---
id: AISDLC-381
title: 'fix(ci): fork PR workflows must use pull_request_target so the required GitHub Actions app can post statuses + post-back comments'
status: Done
assignee: []
created_date: '2026-05-20'
labels:
  - ci
  - fork-prs
  - external-contributors
  - critical
dependencies: []
priority: critical
references:
  - .github/workflows/verify-attestation.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/auto-enable-auto-merge.yml
  - .github/workflows/auto-rearm-on-dequeue.yml
---

## Problem

External contributor PRs from forks (first observed on PR #568 by akillies) get blocked at the merge queue with:

```
Changes must be made through the merge queue
Required status check "ai-sdlc/pr-ready" is failing
```

Root cause: branch protection mandates the three status checks (Backlog Drift, ai-sdlc/pr-ready, ai-sdlc/attestation) come from app_id 15368 (GitHub Actions) specifically. On fork PRs, GitHub silently downgrades GITHUB_TOKEN to read-only across the upstream repo regardless of the workflow's declared `permissions:` block. The workflows that try to post these statuses get HTTP 403 (`Resource not accessible by integration`) and the required checks never land. Manually-posted statuses (from a maintainer token) do not satisfy branch protection because the app_id differs.

Net effect: **no external contributor PR can land** without a maintainer admin-bypass + branch-protection temp-drop dance.

Evidence (from PR #568 workflow logs):

```
STATUS: valid
REASON: ok
HEAD_SHA: 59e4b46613089aaf9a7b30adde1ab0ad580b81db
PR_URL: https://github.com/ai-sdlc-framework/ai-sdlc/pull/568
gh: Resource not accessible by integration (HTTP 403)
```

## Fix (single PR)

### A. Migrate the four affected workflows to `pull_request_target`

The four workflows that need to post back to the upstream repo on fork PR events:

1. `.github/workflows/verify-attestation.yml` — posts `ai-sdlc/attestation` status
2. `.github/workflows/ai-sdlc-review.yml` — posts `ai-sdlc/pr-ready` rollup + review comments
3. `.github/workflows/auto-enable-auto-merge.yml` — enables auto-merge on PR open
4. `.github/workflows/auto-rearm-on-dequeue.yml` — re-arms after merge-queue dequeue

`pull_request_target` runs workflows in the context of the target repo (main's workflow files) with full secrets + write permissions — even for fork PRs. This is exactly the path for "trusted workflow runs against untrusted PR content."

### B. Critical safety guards (must not omit any)

`pull_request_target` is dangerous if misused. The migration MUST:

1. **Checkout target repo's main, NOT the fork's HEAD** for any workflow logic that runs scripts:
   ```yaml
   - uses: actions/checkout@v4
     # NO `ref:` arg = checks out the workflow file's source ref (main)
   ```
2. **Read fork PR content as DATA only** (via `gh api .../contents/...?ref=<fork sha>` or a separate `actions/checkout` with `path:` into a sandboxed subdirectory):
   ```yaml
   - uses: actions/checkout@v4
     with:
       ref: ${{ github.event.pull_request.head.sha }}
       path: pr-content
       # Sandboxed; never executed
   ```
3. **NEVER run `pnpm install` / `pnpm build` / any script from the fork's content** with elevated permissions. If we need to execute something, it runs against main's checkout.
4. **NEVER run an action specified by the fork's PR** (e.g. `uses: ./action-from-pr`). All actions must come from main or be pinned to specific commits.
5. **Secrets remain available** but only the minimum set: `secrets.GITHUB_TOKEN` and any specifically-needed `secrets.X`. Do NOT pass `secrets.AI_SDLC_SIGNING_KEY` or similar into a fork PR context — verification reads the pubkey from main, not the fork.

### C. Branch protection: keep app_id 15368 requirement

No branch protection change needed — once the workflows post statuses again, they'll be from app_id 15368 (GitHub Actions). The required `Backlog Drift`, `ai-sdlc/pr-ready`, `ai-sdlc/attestation` checks resolve naturally.

### D. Test plan

1. Open a fresh test PR from a fork (use `gh repo fork` to create a quick sandbox if needed)
2. Push a trivial change (e.g. a comment edit in a docs file)
3. Verify all 4 workflows run AND post their statuses back to the upstream PR
4. Verify the test PR can land via auto-merge (no admin bypass needed)
5. Re-trigger PR #568's CI (`gh run rerun --branch fix/session-start-hookeventname`) and confirm it lands without manual unblock

### E. Update operator docs

Add a section to `docs/operations/operator-runbook.md` explaining:
- The `pull_request_target` security model in this repo
- How to safely add NEW workflows that need fork-PR write access (the 5-point guard list above)
- What NOT to do (no `pnpm install` on fork content with secrets, etc.)

## Acceptance criteria

- [ ] #1 All 4 affected workflows migrated from `pull_request` to `pull_request_target` (or hybrid: keep `pull_request` for fast feedback, add `pull_request_target` for status posting)
- [ ] #2 Each migrated workflow includes inline comments documenting the 5-point safety guard (point at the operator runbook)
- [ ] #3 Workflow `permissions:` blocks correct: minimum needed (statuses:write, pull-requests:write, contents:read)
- [ ] #4 Hermetic test in `.github/workflows/__tests__/` validates that the workflows DO NOT execute fork content (greps for forbidden patterns: `pnpm install` after fork checkout, `run: ./pr-content/...`, etc.)
- [ ] #5 Verified by opening a test fork PR end-to-end: 4 workflows post their statuses, PR lands via auto-merge with no maintainer intervention
- [ ] #6 Re-trigger PR #568's CI → all checks pass → PR lands
- [ ] #7 `docs/operations/operator-runbook.md` updated with the fork-PR-workflow safety pattern
- [ ] #8 New code reaches 80%+ patch coverage (workflow files + the hermetic test)

## Out of scope

- Migrating CI/build workflows (`ci.yml`, `ai-sdlc-gate.yml`) to `pull_request_target` — they don't need to post back; they verify the build and the rollup uses `re-actors/alls-green`
- Allowing fork PRs to publish packages or run release-please (out of scope security-wise)
- Adopter-side workflow templates (separate task; once we have a working pattern in our own repo, adopters benefit from the pattern)

## Source

Operator 2026-05-20 during PR #568 (akillies fork): "We need to fix this workflow, users will eventually open PR's like alex did and we need a clean way to merge them and this is the perfect opportunity to fix this workflow"

Confirmed root cause via PR #568 workflow logs: `STATUS: valid REASON: ok` (verifier succeeded) → `gh: Resource not accessible by integration (HTTP 403)` (token couldn't post back).
