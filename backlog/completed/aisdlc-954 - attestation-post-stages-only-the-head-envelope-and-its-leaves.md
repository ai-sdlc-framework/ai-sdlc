---
id: AISDLC-954
title: 'attestation-post stages only the head envelope, the leaf index and the leaves it references, under one concurrency group per PR'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - ci
  - attestation
  - cost
dependencies: []
references:
  - .github/workflows/attestation-post.yml
  - scripts/stage-attestation-data-api.sh
  - docs/operations/attestation-reference.md
priority: high
dispatchable: true
---

## Description

The Actions GITHUB_TOKEN bucket is 1,000 requests per hour per repository. `scripts/stage-attestation-data-api.sh`, run by `attestation-post.yml` after every finished gate run on a code PR, lists the head tree and then fetches EVERY `.ai-sdlc/attestations/*.dsse.json` and `.ai-sdlc/transcript-leaves/*.jsonl` blob with one `gh api git/blobs` call each: 955 envelopes + 630 leaves + the index = about 1,586 calls per run, so one run empties the bucket. The next callers (`Detect Changes` dorny step, `ai-sdlc/issue-link`) then fail with `API rate limit exceeded for installation` and every downstream gate job is skipped. This has taken the gate down for part of every hour on 2026-10-15 and 2026-10-16, since the script was introduced on 2026-10-14. Only the envelope for the PR head, the leaf index and the leaves that index names for this head are needed by the verifier.

**Five-step review (requirements first).**
1. Requirement questioned: must the privileged workflow_run job hold every attestation file in the repository? No: the verifier reads one envelope (named by the head patch id) plus the leaves listed for it. The API-only staging (no fetch or checkout of the head) stays; it is the file set that was wrong.
2. Delete: the recursive tree walk that selects every attestation and leaf path.
3. Simplify: fetch `.ai-sdlc/transcript-leaves.jsonl` and the envelope whose name is the head patch id (the gate job already computes it; pass it through the workflow_run artifact or recompute from the index), then only the leaf files that index references for that envelope: about 3 to 6 calls per run.
4. Accelerate: a `concurrency` group `attestation-post-<pr>` with cancel-in-progress so overlapping gate completions on one PR run once; skip staging on the same-repo release-please branch (the step already short-circuits later, after the staging cost).
5. Automate: a unit test over a fixture tree asserting the selected path set is exactly {index, head envelope, referenced leaves}; the existing quota-report step prints `x-ratelimit-remaining` at the start and end of the job.

## Acceptance Criteria

- [ ] One attestation-post run on a code PR makes at most 10 GitHub API calls (job summary shows remaining before and after).
- [ ] The staged file set is exactly the head envelope, the leaf index and the leaves the index references for that envelope; a test covers it.
- [ ] `attestation-post.yml` declares a per-PR concurrency group and skips the staging step on the same-repo release-please branch.
- [ ] `docs/operations/attestation-reference.md` describes the staged set.
