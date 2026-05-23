---
id: AISDLC-379
title: 'fix(ci): DoR ingress workflow must FAIL the status check on violations (not just post a comment)'
status: Done
assignee: []
created_date: '2026-05-20'
labels:
  - ci
  - dor
  - bug
  - critical
dependencies: []
priority: critical
references:
  - .github/workflows/dor-ingress.yml
  - pipeline-cli/src/dor/ingress-claude.ts
  - pipeline-cli/src/dor/pr-violations.ts
  - scripts/sync-dor-branch-protection.sh
  - docs/operations/dor-ingress-gate.md
---

## Problem

The DoR ingress CI workflow (the `Evaluate backlog tasks changed by PR` check) currently:

1. Detects DoR violations in changed task files
2. Posts a `<!-- ai-sdlc:dor-comment -->` comment on the PR
3. **Exits 0** — the status check is SUCCESS regardless of how many violations were posted

Result: a PR with multiple Gate 3 (unresolved-reference) violations across 5 task files looked CLEAN in the merge state and was auto-mergeable. The DoR feedback was informational-only, not blocking.

**2026-05-20 incident** — an earlier task-breakdown PR (the AISDLC-377 phase files) (RFC-0041 task breakdown) hit Gate 3 violations on every task file but `Evaluate backlog tasks changed by PR` returned SUCCESS. State CLEAN. Auto-merge armed. The whole point of the DoR gate (per AISDLC-296) was to refuse-or-fix at the boundary, not to passively log violations.

## Fix (single PR)

### A. Make the workflow exit non-zero on violations

In the `.github/workflows/` DoR ingress workflow, after the existing comment-post step, add:

```yaml
- name: Fail check on unresolved violations
  if: steps.dor_eval.outputs.has_violations == 'true'
  run: |
    echo "::error::DoR violations detected in staged backlog task changes. See PR comment for details."
    echo "::error::Fix the offending task body or set blocked.reason in frontmatter; push to re-evaluate."
    exit 1
```

`steps.dor_eval.outputs.has_violations` is set by the existing evaluation step (computed internally; expose as a workflow output).

### B. Branch protection update

Add `Evaluate backlog tasks changed by PR` to required status checks via:

```bash
gh api -X PATCH repos/ai-sdlc-framework/ai-sdlc/branches/main/protection/required_status_checks \
  -F 'contexts[]=Backlog Drift' \
  -F 'contexts[]=ai-sdlc/pr-ready' \
  -F 'contexts[]=ai-sdlc/attestation' \
  -F 'contexts[]=Evaluate backlog tasks changed by PR'
```

Ship the helper script under scripts/ so the change is reproducible if branch protection is recreated.

### C. Operator override path

Tasks with `blocked.reason` in frontmatter already bypass the DoR gate per the AISDLC-296 extension to the rubric. The fail-loud workflow honors this — if every staged task has blocked.reason, has_violations stays false and the check passes. Document the override in a new dor-gate operator doc under docs/operations/.

### D. Hermetic test for the workflow

A test fixture under .github/workflows/__tests__/ that simulates:
- Clean PR (no violations) → check passes
- PR with violations on a task that has blocked.reason → check passes (override honored)
- PR with violations on a task WITHOUT blocked.reason → check fails with exit 1

## Acceptance criteria

- [x] #1 DoR ingress workflow exits non-zero when violations exist in any staged task without blocked.reason
- [x] #2 has_violations exposed as a workflow output (currently computed internally only)
- [x] #3 Branch protection updated to require Evaluate backlog tasks changed by PR; helper script committed (helper script `scripts/sync-dor-branch-protection.sh` shipped; operator runs it once post-merge to PATCH branch protection per the runbook in `docs/operations/dor-ingress-gate.md`)
- [x] #4 a new dor-gate operator doc under docs/operations/ updated with the blocked.reason override mechanic
- [x] #5 Hermetic test fixture under .github/workflows/__tests__/ covers clean / override / fail branches
- [ ] #6 Verified by opening a test PR with intentional DoR violations → merge blocked, unblocks only when task body fixed (operator verifies live once the PR for this task itself runs through the updated workflow — the PR's own DoR check is the first live exercise)
- [x] #7 New code reaches 80%+ patch coverage (computePrViolations has 8 hermetic tests covering all branches incl. mixed/missing/absolute-path; CLI subcommand has 3 dedicated tests; workflow structure has 7 tests)

## Final summary

### Changes
- `pipeline-cli/src/dor/pr-violations.ts` (new): `computePrViolations()` — the workflow-gate oracle. Consumes the per-task verdict JSONL, applies the `extractBlockedReason()` operator-override rule, returns `{hasViolations, blocking, overridden, decisions}`.
- `pipeline-cli/src/dor/pr-violations.test.ts` (new): 8 hermetic unit tests (clean / override two-line / override inline-braces / mixed batch / missing file / absolute path / empty input / no-override-blocks branches).
- `pipeline-cli/src/cli/index.ts` (modified): new `dor-pr-has-violations` subcommand exposing `{has_violations, blocking, overridden, decisions}` JSON envelope + optional `--fail-on-violations` exit-1 flag.
- `pipeline-cli/src/cli/index.test.ts` (modified): 3 new CLI router tests covering the subcommand's envelope shape, override behavior, and `--fail-on-violations` exit code.
- `.github/workflows/dor-ingress.yml` (modified): added `id: dor_eval` to the evaluate step, new `Compute has_violations` step (id `compute_violations`) writing `has_violations` + `blocking_count` to GITHUB_OUTPUT, new `Fail check on unresolved violations` step that `exit 1`s with `::error::` annotations when has_violations is true. Ordered AFTER the comment-post step so the operator sees the violations comment before the check fails.
- `.github/workflows/__tests__/dor-ingress.test.mjs` (new): 7 workflow-structure tests covering AC #1 (fail step exists + exits 1), AC #2 (has_violations output), AC #3 (override wiring), step order, CLAUDE.md CI rule (direct node bin invocation).
- `scripts/sync-dor-branch-protection.sh` (new): helper script PATCHing the canonical required-checks list (idempotent; `--dry-run` + `--repo` flags). `REQUIRED_CONTEXTS` array at the top documents each context's purpose.
- `docs/operations/dor-ingress-gate.md` (new): operator runbook covering gate behavior, the `blocked.reason` override mechanic, branch-protection helper usage, hermetic-test wiring, and recovery flow.
- `CLAUDE.md` (modified): new "DoR ingress workflow gate (AISDLC-379)" subsection under Backlog Workflow describing the fail-the-check behavior, override, branch-protection helper, and code surface.
- `package.json` (modified): new `test:dor-ingress-workflow` script matching the existing per-workflow test pattern.

### Design decisions
- **One source of truth for `blocked.reason`**: the workflow gate calls `extractBlockedReason()` from `pipeline-cli/src/dor/upstream-oq-gate.ts` (via `computePrViolations` → `stripFrontmatter` → `extractBlockedReason`). Reimplementing the parser in YAML or github-script would re-create exactly the bug class AISDLC-379 fixed. Drift between the workflow gate and the `/ai-sdlc execute` upstream-OQ gate is now impossible without a unit-test failure.
- **Comment posts BEFORE check fails**: the operator must see WHAT to fix before the check goes red. The workflow-structure test asserts this ordering (`postIdx < failIdx`).
- **CLI envelope, not just exit code**: the subcommand emits a full JSON envelope to stdout AND optionally exits 1 with `--fail-on-violations`. The workflow uses the envelope (writes to a file, parses with `node -e`) so the same step can populate BOTH `has_violations` and `blocking_count` outputs in one CLI call. Keeps the YAML readable.
- **Helper script, not one-shot `gh api`**: branch protection is a moving target (AISDLC-388 already changed the required list once). Centralising the canonical list in a script makes future cutovers a one-file edit instead of grepping commit history.

### Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 4328 pass, 1 pre-existing skip
- `pnpm test:dor-ingress-workflow` — 7/7 pass
- `pnpm lint` — clean
- `pnpm format:check` — clean
- E2E smoke: ran `dor-pr-has-violations` against a fixture with and without `blocked.reason`; output JSON shape + exit codes match expectations.

### Follow-up
- Operator: run `scripts/sync-dor-branch-protection.sh` after merge to add `Evaluate backlog tasks changed by PR` to required-status-checks on `main` (AC #3 second half).
- Operator: confirm AC #6 by inspecting THIS PR's own `Evaluate backlog tasks changed by PR` check result (the PR exercises the updated workflow against the task file it ships).

## Out of scope

- Pre-push hook tightening (separate task AISDLC-378)
- Changing what counts as a violation (the existing seven-point rubric gates remain authoritative)
- Auto-fixing DoR violations (separate idea; LLM-driven)

## Source

Operator 2026-05-20 frustration during RFC-0041 task breakdown: "shouldn't this be a gate" — referring to the DoR ingress workflow that posts a comment but doesn't block merge. Confirmed by inspecting an earlier task-breakdown PR (the AISDLC-377 phase files) check rollup: Evaluate backlog tasks changed by PR returned SUCCESS despite posting a 5-task violations comment.
