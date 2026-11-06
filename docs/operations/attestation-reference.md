# Review verdict gate reference

The merge gate reads a review verdict record held outside the branch (RFC-0061, which superseded the RFC-0042 signed-envelope scheme). This page holds the mechanics, the trust claim and the operator runbook. The rules stay in `CLAUDE.md` and `.claude/rules/review-attestations.md`.

## How the gate works

1. `/ai-sdlc execute` runs the reviewer subagents. Step 8 derives the independence tier once and builds the verdict record (`record.json`: subject head and tree, base, verdict, coverage, and `reviewers[]` carrying each reviewer's findings and tier).
2. Step 11 pushes the record atomically to `refs/ai-sdlc/verdicts/<headSha>` before the PR leaves draft. Nothing is committed to the branch: `.ai-sdlc/attestations/`, `.ai-sdlc/transcript-leaves.jsonl` and the proof trees are gone, and no key signs anything.
3. The `verdict-check` job in `ai-sdlc-gate.yml` runs `cli-attestation verdict-check` from the BASE tree, fetches the head record (or carries an earlier approved record forward through the clean-replay rule, RFC-0061 OQ-2), checks subject, coverage and tier, and posts the kept `ai-sdlc/attestation` status. The job feeds the `ai-sdlc/pr-ready` rollup, the only required check on `main` besides `Backlog Drift`.
4. Reason codes: `ok`, `ok-carried:<sha>`, `no-record`, `subject-mismatch`, `coverage-short`, `replay-dirty`, `tier-short`.
5. A rebase needs no re-sign. When the head changes and the reviewed diff replays cleanly onto the new base, the gate carries the earlier approved record forward; a conflicting or changed replay is `replay-dirty` and needs a new review.
6. Untrusted PRs (fork, non-collaborator, bot) produce their record through a split CI writer: an untrusted job uploads an artifact and a trusted `workflow_run` job writes the record (RFC-0043, amended by RFC-0061 OQ-7).
7. Docs-only, records-only, draft, dependabot and same-repo release-please PRs skip the job; `alls-green` treats `skipped` as success.

**Operator action** (AISDLC-388): branch protection on `main` should require ONLY `ai-sdlc/pr-ready` and `Backlog Drift`, not `ai-sdlc/attestation` directly. If your repo still lists it, run: `gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks -F 'contexts[]=Backlog Drift' -F 'contexts[]=ai-sdlc/pr-ready' -F 'strict=true'`

**v6 is refused.** A v6 envelope given to `cli-attestation verify` fails with `attestation-schema-v6-refused` (DEC-0284). There is no signer, verifier or patch-id code.

## What the gate proves (RFC-0061 OQ-8)

The trust claim, as resolved with the operator on 2026-11-03: **Error-resistant, not forgery-resistant.** The gate guarantees that (1) the pipeline's reviewer step ran and (2) it ran against this exact head (or a head OQ-2 accepts as a clean replay). (4) "Not edited after the fact" holds as an audit trail: a re-posted status or re-pushed ref leaves history with its creator. The gate does **not** guarantee (3) that the reviewer was a different principal from the author, nor (5) verification without GitHub, beyond the record being readable from git. The threat it defends against is a goal-seeking or mistaken agent, the 2026-05-20 shape; a deliberately adversarial agent holding the operator token is outside the claim.

Only the pipeline writes a verdict (Step 11 and the split CI writer); a hook refuses agent sessions any push to `refs/ai-sdlc/verdicts/*` or any status post with the gate's context.

**Upgrade trigger:** one forged or out-of-pipeline verdict found by the catch report, or a recorded decision granting agents broader autonomy, reopens this question for a separate-principal issuer (a GitHub App or a CI workflow identity).

The independence tier is a pipeline claim, consistent with this trust claim (RFC-0046, amended by RFC-0061 OQ-6).

## Operator runbook: the verdict namespace (RFC-0061)

**Prune the verdict namespace.** Refs under `refs/ai-sdlc/verdicts/*` accumulate one per reviewed head. Prune those whose PR is closed or merged and older than the age limit. The command is not scheduled; run it by hand or from your own cron:

```bash
node pipeline-cli/bin/cli-attestation.mjs verdict-prune --dry-run          # list what would go
node pipeline-cli/bin/cli-attestation.mjs verdict-prune --max-age-days 30  # delete (default 30)
```

**Run the catch report.** A catch is a PR where the verdict check failed while every other `ai-sdlc/pr-ready` input passed (RFC-0061 OQ-4b). The gate writes its reason code into the description of the `ai-sdlc/attestation` status, so the report is derived from the status history of each head, with no second ledger. Until a dedicated report command ships, read the description per PR with `gh pr checks <pr>` (or the head's commit status history in the GitHub UI) and count `no-record`, `subject-mismatch`, `coverage-short`, `replay-dirty` and `tier-short` over the period. Statuses on force-pushed-away heads can be garbage-collected, so keep a snapshot of the counts if you need them later.

**What to do when a catch is found.**

1. Read the reason code. `no-record` and `coverage-short` mean the review did not run or did not cover the diff: re-run `/ai-sdlc execute` for the task so Step 11 pushes a record. `subject-mismatch` means the head moved after review: re-review, or rebase and let the clean-replay rule carry the record. `replay-dirty` means the rebase changed the reviewed diff: re-review. `tier-short` means the independence tier is below the policy floor: run the reviewers at the required tier.
2. Never write the `ai-sdlc/attestation` status or push a verdict ref by hand to unblock a merge. That is the forgery the upgrade trigger watches for.
3. If a record is missing or wrong with no pipeline run behind it (a verdict ref nobody can account for, or a success with no ref), treat it as a forged or out-of-pipeline verdict: the upgrade trigger above fires, so escalate with `cli-decisions escalate` and park the task.

## Adopter path

Adopters run the same check from `consumer-verify-attestation.yml`. See [`adopter-attestation-verify-ci.md`](adopter-attestation-verify-ci.md).

## Review-ledger path (AISDLC-1020)

`reviewsLedgerPath()` and `reviewsLedgerRelativePath()` in `pipeline-cli/src/attestation/reviews-ledger.ts` are the only way to locate the review ledger (the task id is lowercased there). Never build `.ai-sdlc/reviews/<id>.jsonl` by string template; `scripts/check-no-handbuilt-ledger-paths.test.mjs` fails `pnpm test` on any such literal in non-test source.
