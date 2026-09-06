---
id: AISDLC-589
title: >-
  RFC-0046 Phase 2 — attested tier: fix worktree project-dir + agentType namespace (supersedes AISDLC-587)
status: To Do
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0046
  - phase-2
dependencies:
  - AISDLC-588
references:
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0046 Phase 2. Make the `attested` (lower, informational, same-machine) tier correctly compute in the real worktree topology. **This supersedes AISDLC-587** — its two produce-side gaps are re-scoped here as the honest `attested` tier's plumbing (NOT as an independence *guarantee*; per RFC-0046 OQ-1/OQ-4 `attested` is explicitly non-load-bearing — the load-bearing claim is Phase 3's `isolated` tier).

## Scope (the two AISDLC-587 gaps, under the attested tier)
- **Gap A — worktree project-dir:** `cli-attestation emit-leaf` resolves the Claude project transcripts dir from the WORKTREE path slug, which doesn't exist; the real session dir is the main-checkout slug. Resolve from the main-checkout root (`git rev-parse --git-common-dir` → main worktree root, slugify THAT) and/or accept a `--project-dir` override. A reviewer dispatched from a Pattern-C worktree must yield a non-null `harnessTranscriptHash` when marker + transcript exist.
- **Gap B — agentType namespace:** the SubagentStart marker records `agentType: "ai-sdlc:code-reviewer"` but the role match expects bare `code-reviewer`. Strip the plugin namespace (`agentType.split(':').pop()`) before matching, covering code/test/security + codex variants; fix symmetrically if a writer and matcher both exist (AISDLC-421-class drift).
- Set `independenceTier: 'attested'` (from AISDLC-588's field) when the marker heuristic matches; `none` otherwise. Keep the honest scoping: `attested` is informational context, never the independence guarantee.

## Replacement semantics (load-bearing)
AISDLC-587 is CLOSED as superseded-by-AISDLC-589 (folded into RFC-0046 Phase 2). Do not implement 587 separately.

## Acceptance Criteria
- [ ] emit-leaf resolves the Claude project dir from the main-checkout (not the worktree slug); worktree-dispatched reviewer yields non-null `harnessTranscriptHash` when marker+transcript exist; `--project-dir` override supported.
- [ ] Namespaced `agentType: "ai-sdlc:code-reviewer"` matches role `code-reviewer` (+ test/security + codex variants).
- [ ] A genuine harness-dispatched reviewer from a worktree yields `independenceTier: attested`; no marker ⇒ `none` (the security-critical negative — must NOT falsely credit).
- [ ] Hermetic tests for both gaps + the attested/none classification; two pre-existing unrelated failures (bin-invocation, Ink app.test) not attributed here.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0046 §Proposal (`attested` tier), §Behavioral Changes. Supersedes AISDLC-587. Depends on AISDLC-588 (the `independenceTier` field).
<!-- SECTION:DESCRIPTION:END -->
