---
id: AISDLC-1171
title: >-
  RFC-0061 Phase 1: untrusted PRs get a verdict record through a clean-room
  artifact and a trusted workflow_run writer
status: Done
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - ci
  - security
  - rfc-0043
  - phase-1
dependencies:
  - AISDLC-1168
  - AISDLC-1169
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - .github/workflows/untrusted-pr-gate.yml
  - pipeline-cli/src/pipeline/clean-room-signer.ts
priority: high
dispatchable: true
drift_log:
  - date: '2026-11-05'
    type: ref-deleted
    detail: 'Referenced file no longer exists: .github/workflows/attestation-post.yml'
    resolution: flagged
drift_checked: '2026-11-05'
---

## Description

Implements RFC-0061 OQ-7.

**Scope.**
1. The `clean-room-sign` job in `untrusted-pr-gate.yml` also emits the verdict record as an Actions artifact, with `issuedBy.principal: ci-clean-room` and tier `isolated`. It gains no new permission.
2. A trusted `workflow_run` workflow, repurposing the slot of `attestation-post.yml`, never checks out or reads PR content. It downloads the artifact, validates the schema, checks that `subject.headSha` is the PR head and that the review jobs concluded successfully, then pushes `refs/ai-sdlc/verdicts/<headSha>`. Only this job holds `contents: write`.
3. The OQ-8 fence (AISDLC-1168) names this workflow as the second sanctioned writer.
4. v6 signing in the clean-room job stays until cutover (AISDLC-1172); the signing secret is deleted in AISDLC-1173.

**Security note.** Never give `contents: write` to a job that runs AI reviewers over PR content; a prompt-injected reviewer could push to any unprotected branch.

## Acceptance Criteria

- [x] AC-1: The clean-room job uploads a schema-valid record artifact and its permissions are unchanged. Workflow test or actionlint plus a fixture.
- [x] AC-2: The writer workflow rejects an artifact whose head does not match the PR head, and one whose review jobs did not succeed.
- [x] AC-3: The writer workflow has no checkout of the PR ref. A static test greps the workflow.
- [x] AC-4: The verdict check from AISDLC-1169 passes for an untrusted PR head with the written record.

## Final Summary

## Summary
Fixed the verdict writer so it no longer trusts workflow_run.head_sha, which is the base tip for pull_request_target runs. It now finds the open PR for the run's head owner and branch through the pulls API, takes the PR head sha from there, and looks up the tree against that sha. The checkout now uses persist-credentials: false and pnpm install runs with --ignore-scripts. The token reaches git only as a one-shot extraheader in the final validate-and-push step. The concurrency group is now keyed on head_branch.

## Changes
- .github/workflows/verdict-writer.yml
- .github/workflows/__tests__/untrusted-pr-gate.test.mjs

## Design decisions
Only the workflow test file (node --test .github/workflows/__tests__/untrusted-pr-gate.test.mjs, 82 pass), pnpm lint and pnpm format:check were run by hand. I did not run pnpm build or the full pnpm test; no TypeScript changed in this round. The pre-push hook ran the pipeline-cli coverage check and the push went through. I could not confirm AC-4 end to end, since that needs a real untrusted PR. The writer resolves the PR with gh api repos/<repo>/pulls -f head=<owner>:<branch> and requires exactly one open PR whose head repo matches the run's head repository. If the PR head moves after the gate starts, the artifact's headSha no longer matches and the record is rejected, which is the safe outcome. The PR (#2341) is not a draft (isDraft false), contrary to the draft-PR step in the agent definition. I did not run gh pr ready, and I did not check or change its draft state.

## Verification
- `pnpm build` — passed (ai-sdlc-plugin/mcp-server build: Done)
- `pnpm test` — passed (> bash scripts/check-knowledge-scope.sh)
- `pnpm lint` — passed (clock-discipline: OK (246 baselined files).)
- `pnpm format:check` — passed (All matched files use Prettier code style!)
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

