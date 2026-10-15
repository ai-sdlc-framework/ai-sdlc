---
title: "Cross-harness review"
description: "Independent review agents that run on a different LLM harness than the implementer, so blind spots are not shared."
---

Independent review agents that run on a different LLM harness than the implementer. The reviewer cannot share the implementer's blind spots because it isn't the same model — and isn't even the same agent runtime.

> **RFC:** [RFC-0010 §13 — HarnessAdapter framework](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md)

## The problem

When a Claude-implemented PR is reviewed by another Claude session, the reviewer is statistically more likely to overlook the same kinds of mistakes the implementer made. Same training distribution, same prompt-engineering quirks, same conceptual blind spots. Reviews from the same harness as the implementer are correlated — and correlated reviews are weak reviews.

## What we ship

The pipeline's review stage spawns three reviewer subagents in parallel:

| Reviewer            | Default harness                | Why                                                                    |
| ------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `code-reviewer`     | Codex (or any non-implementer) | Catches implementation mistakes the dev's harness would miss           |
| `test-reviewer`     | Codex                          | Same — applied to test coverage and quality                            |
| `security-reviewer` | Claude (Opus)                  | Reasoning-heavy work; current best-in-class for hostile-input analysis |

The HarnessAdapter framework (RFC-0010 §13) makes "which harness runs this stage" declarative in the `Pipeline` spec. Adding a new harness (Aider, Cursor, etc.) means writing a small adapter; the orchestrator + pipeline code don't change.

## Independence enforcement

A stage can declare `requiresIndependentHarnessFrom: [implement]`. The orchestrator filters the candidate harness chain to exclude any harness that ran the named upstream stages, and emits an `IndependenceViolated` event if no harness survives the filter. So you can't accidentally configure "Claude implements, Claude reviews" — the pipeline refuses to start.

## What you'll see in your PRs

Every code-touching PR opened by the pipeline carries a DSSE attestation envelope at `.ai-sdlc/attestations/<sha>.dsse.json`. Inside the envelope, each reviewer's verdict is recorded with its harness name. The CI verifier (`scripts/verify-attestation.mjs`) checks all three are present and approved before allowing merge.

## Operator runbook

- [`docs/operations/merge-queue-rebase-recovery.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/docs/operations/merge-queue-rebase-recovery.md) — when the merge queue rebases your PR, contentHashV4 may invalidate; you re-sign + re-push.
- [`pipeline-cli/docs/spawner.md`](https://github.com/ai-sdlc-framework/ai-sdlc/blob/main/pipeline-cli/docs/spawner.md) — how the pipeline injects the `SubagentSpawner` for each harness.
