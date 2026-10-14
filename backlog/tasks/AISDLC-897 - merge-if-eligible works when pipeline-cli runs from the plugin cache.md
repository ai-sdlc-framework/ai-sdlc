---
id: AISDLC-897
title: 'fix(governance): merge-if-eligible reads the target repo''s policy from origin/main and works when pipeline-cli runs from the plugin cache'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [governance, adopters, velocity, trust-chain]
dependencies: []
references:
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - docs/operations/merge-without-queue.md
  - docs/operations/decision-authority.md
priority: critical
dispatchable: true
---

## Context

Upstream bug report from the ai-sdlc-io planner session on 2026-10-14. Reproduction in an adopter checkout with plugin 0.28.0 resolved from the plugin cache:

```
node cli-merge-if-eligible.mjs 17 --source-kind backlog --dry-run
PR #17 | DRY-RUN | eligible=false | could not establish a verified main checkout to read the governance policy from (could not verify the main checkout of the repo containing this CLI) — refusing (fail-closed; the worktree/cwd copy is never trusted)
```

Verified in `pipeline-cli/src/governance/merge-if-eligible.ts:148-172`: `resolveTrustedMainRoot` anchors trust on the main checkout of the repo that CONTAINS the running CLI (`anchorDir`) and requires the cwd to belong to that same checkout. The comment states there is deliberately no flag or environment variable that supplies a root. A plugin-cache install is not a git repository, so `verifiedMainRoot(anchorDir)` is null for every adopter and the CLI fails closed unconditionally. The intent of the anchor (an agent must not `cd` into a repo it controls to pick up a lenient policy) is sound; the mechanism only works in this repo's own dogfood layout.

**Gated by DEC-0222.** This changes a trust-chain control, so the replacement anchor is chosen in the decision catalog, not in this task. The Fix below describes the recommended option; the dev subagent implements whichever option DEC-0222 records on `main`, and returns `prUrl: null` if the decision is not yet answered.

**Five-step review (requirements first).** Requirement questioned: "the policy must come from a checkout the agent cannot write". The real requirement is "the policy must be the one on the target repository's `origin/main`, read through a channel the agent cannot rewrite locally". Delete: the CLI-repo anchor and `anchorDir`. Simplify: one policy source, the target repo's `main` branch via the GitHub API (`repos/{slug}/contents/.ai-sdlc/agent-role.yaml?ref=<mainSha>`), which the CLI already resolves (`mainSha` is an `evaluatePrTrust` input). Accelerate: no local checkout verification. Automate: deterministic; a non-git-directory test keeps the regression out.

## Fix (recommended option `target-origin-main-api`)

1. `governance/merge-if-eligible.ts`: replace `resolveTrustedMainRoot` with `resolveTargetRepo(cwd)`: the cwd must be inside a git work tree whose `origin` is the `repoSlug` of the PR (refuse on mismatch, fail closed). The policy (`.ai-sdlc/agent-role.yaml`) is fetched from the GitHub API at the resolved `main` sha, never read from disk. The task-file existence check (L805) likewise reads via the API at `mainSha` (or the PR head for the moved task file).
2. `cli/merge-if-eligible.ts`: drop `anchorDir`; `--dry-run` output names the policy source (`policy: origin/main@<sha> via api`).
3. Tests: run the built CLI from a non-git temp directory against a fixture repo slug with a mocked `gh` runner; cwd-origin mismatch refuses; API policy with `allowMerge: never` refuses; a linked worktree cwd is accepted when its origin matches.
4. Docs: `docs/operations/merge-without-queue.md` (policy source) and `docs/operations/attestation-troubleshooting.md` entry for the old refusal text.

## Acceptance Criteria

- [ ] #1 `cli-merge-if-eligible <pr> --dry-run` run from a plugin-cache install inside an adopter checkout reports eligibility from the target repo's `origin/main` policy, never the "repo containing this CLI" refusal.
- [ ] #2 A cwd whose `origin` is not the PR's repository is refused (fail closed).
- [ ] #3 The policy and task-file checks are read through the GitHub API at the resolved `main` sha; no on-disk `.ai-sdlc/agent-role.yaml` is consulted.
- [ ] #4 A test executes the CLI from a non-git directory against a fixture and passes.
- [ ] #5 Behaviour in this repository's own hierarchy (dogfood layout) is unchanged.

**Velocity impact.** Positive: today no adopter can use `cli-merge-if-eligible` at all, so AISDLC-894 through 896 would be dead code outside this repo. Unblocks the site repo's standing order (ai-sdlc-io DEC-0008).

Authority: class (b) timeboxed via DEC-0222 (a trust-chain control is replaced); implementation proceeds only on the option recorded on `main`.
