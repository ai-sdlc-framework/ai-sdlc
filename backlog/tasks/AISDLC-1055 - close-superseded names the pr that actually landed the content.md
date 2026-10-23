---
id: AISDLC-1055
title: 'close-superseded names the merged PR that actually landed the content, never the first merged PR sharing any id'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - dispatch
  - pipeline-cli
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/hierarchy/superseded.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

**Context (2026-10-23 ~06:40Z).** PR #1907 was closed through `cli-dispatch close-superseded 1907`, the coded DEC-0266 path, after PR #1950 landed the same commits. The close itself was right (step (c) verified every file byte-identical on main), but the public comment said "landed through #1298", a 2026-10-09 RFC-0053 docs PR with no relation to the content; dispatch had to add a correcting comment naming #1950.

**Root cause.** In `closeSupersededPr` (`pipeline-cli/src/hierarchy/superseded.ts`) step (b) collects every `<PREFIX>-<n>` id from the title, the branch name and all file paths (`carriedIds`, `ID_RE`), then for each id runs `gh pr list --state merged --search "<id> in:title"` and takes the first merged PR whose title or branch matches. The ids harvested from file paths include task ids of unrelated completed task files, RFC ids of touched docs, and the attestation task id, so the first hit is often a PR that merely mentions the same RFC or task family. The superseding PR is an audit fact posted publicly and written to `audit/superseded-close.jsonl`, so it must be derived from the content, not from a title search.

**Five-step review (requirements first).**
1. Requirement questioned: does the comment need to name the superseding PR at all? Yes: DEC-0266 allows the close only because the content landed elsewhere, and the reader must be able to check that claim in one click.
2. Delete: the id-harvest from file paths and the title search as the source of `supersededBy`.
3. Simplify: derive the superseding PR from the content that step (c) already verifies. For each diff path, `git log -1 --format=%H origin/main -- <path>` gives the commit that last touched it on main; the merge commit's PR number is in its subject (`(#NNNN)`, squash merges) or from `gh pr list --search <sha> --state merged`. All paths must resolve to the same PR; if they resolve to several, name them all, and if any path cannot be attributed, refuse the close with that reason. Keep step (b) only as a cheap pre-check restricted to the branch's own task id.
4. Accelerate: the audit record and the comment carry the merge commit sha next to the PR number, so a reader verifies without a search.
5. Automate: a unit test with a fake runner where the file-path ids point at a wrong merged PR and the content attribution points at the right one asserts the right PR is named; a second test asserts refusal when paths attribute to different PRs.

**Velocity impact.** Neutral on throughput, positive on trust: no manual correcting comments on closed PRs.

## Acceptance Criteria

- [ ] `supersededBy` is derived from the main-branch commits that landed each verified path; a mismatch across paths or an unattributable path refuses the close with the reason.
- [ ] The comment and the audit line name the superseding PR and its merge commit sha.
- [ ] Tests cover the wrong-title-match case and the multi-PR refusal.
- [ ] `docs/operations/cli-hierarchy.md` describes how the superseding PR is determined.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
