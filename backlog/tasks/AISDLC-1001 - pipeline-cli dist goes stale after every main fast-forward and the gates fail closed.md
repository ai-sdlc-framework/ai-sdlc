---
id: AISDLC-1001
title: 'pipeline-cli dist goes stale after every main fast-forward: resolver falls back to the plugin cache and the follow-up gate fails closed in fresh worktrees'
status: To Do
assignee: []
created_date: '2026-10-21'
labels:
  - hierarchy
  - hooks
dependencies: []
references:
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
  - scripts/check-followups.mjs
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
---

## Description

Three drain stalls on the night of 2026-10-20/21 had one cause: `pipeline-cli/dist` was older than `pipeline-cli/src`.

1. In the main checkout, every landing fast-forwards `main`, and `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh` (the freshness test at `:125-129`) then rejects the repo build and silently falls back to the plugin cache (`:34`, `:46`, "every other caller keeps the fallback"). The cached CLI (0.30.0) has no `cli-dispatch reenter` or `rule`, so the dispatch tick could not re-enter a PR with a note and three tasks (AISDLC-996, 989, 998) sat failed until the planner rebuilt dist by hand, twice in one evening.
2. In a fresh executor worktree, `pnpm install` leaves no dist at all, and the pre-push follow-up gate (`scripts/check-followups.mjs:109`) fails closed with "pipeline-cli is not built". The developer step does not build, so the push aborts after a full dev and review pass; AISDLC-996 and 989 each lost a cycle to it.

Both are the same defect: a gate or resolver that needs a build does not make one, and reports the absence as a refusal rather than building or failing loudly where the operator can see it.

Fix:

- The resolver, when it rejects a stale or missing repo build in the dogfood monorepo, runs `pnpm --filter @ai-sdlc/pipeline-cli build` itself (bounded, once per call) and re-tests, instead of falling back to the plugin cache. If the build fails it exits non-zero with the build output; the dispatch tick (`pipeline-cli/src/hierarchy/dispatch-loop.ts`) surfaces that line in its report. The plugin-cache fallback stays only for consumer repos that have no `pipeline-cli/src`.
- The follow-up gate, when its rule module is missing in a worktree that has `pipeline-cli/src`, builds it the same way before deciding; it refuses only when the build itself fails.
- Worktree setup for an executor task builds pipeline-cli once after install, so the gate's build is a no-op on the normal path.

Out of scope: the follow-up rule itself (AISDLC-997), the clear handshake (AISDLC-1000), and the lease-push hook's worktree checks.

**Five-step review (requirements first).**
1. Requirement questioned: must a resolver ever hand a dogfood repo a cached older CLI? No: the repo's own source is the only correct version there, so the fallback is deleted for that topology.
2. Delete: the silent plugin-cache fallback in the dogfood monorepo path.
3. Simplify: one "ensure built" helper used by the resolver, the follow-up gate and worktree setup, instead of three places that each notice a missing dist differently.
4. Accelerate: a landing no longer stalls the next tick until a person rebuilds; a fresh worktree no longer loses a dev+review cycle to the push step.
5. Automate: the build runs where the staleness is detected, so no session rebuilds by hand.

## Acceptance Criteria

- [ ] With `pipeline-cli/dist` deleted or older than src in the monorepo, `resolve-pipeline-cli.sh` builds and prints the repo bin; it never prints a plugin-cache path for the monorepo.
- [ ] With the build broken, it exits non-zero and the dispatch tick report carries the build error line.
- [ ] `scripts/check-followups.mjs` in a worktree with `pipeline-cli/src` but no dist builds once and then evaluates the rule; a test covers the missing-dist case.
- [ ] A fresh executor worktree has pipeline-cli built before the developer step runs.
- [ ] `docs/operations/cli-hierarchy.md` states that the monorepo never runs on the plugin-cache CLI.
