---
id: AISDLC-387
title: "fix: remove AISDLC-215 docs-only auto-approve synthesis (incompatible with v6)"
status: Done
priority: high
labels: [bug, attestation]
references:
  - scripts/check-attestation-sign.sh
  - scripts/check-attestation-sign.test.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - pipeline-cli/src/attestation/sign-v6.ts
  - CLAUDE.md
created: "2026-05-22"
---

## Context

As of 2026-05-22, the operator set `AI_SDLC_V6_CUTOVER_ACTIVE=1` to flip the default attestation schema from v5 to v6 per RFC-0042 Phase 3.

This broke `scripts/check-attestation-sign.sh`'s AISDLC-215 docs-only auto-approve branch (lines ~111-176 of the script). That branch synthesizes a transient verdict file (3 fake reviewer entries) when:
- `.active-task` sentinel exists
- No verdict file exists at `.ai-sdlc/verdicts/<task-id>.json`
- `scripts/is-docs-only-changeset.mjs` reports the changeset is docs-only

It then invokes `ai-sdlc-plugin/scripts/sign-attestation.mjs` to sign an envelope from those synthetic verdicts.

**Why it breaks under v6**: the v6 signer (`pipeline-cli/src/attestation/sign-v6.ts:230` — `signAndWriteV6Envelope`) reads `.ai-sdlc/transcript-leaves.jsonl`, filters leaves by taskId, and throws unconditionally if `prLeaves.length === 0`:

```
throw new Error(`[sign-v6] No transcript leaves found for taskId '${taskId}'. Ensure reviewers ran and appended leaves before signing.`);
```

Docs-only PRs have no reviewer fan-out (by design) so no leaves are emitted, the signer throws, the hook exits 2, and the push is aborted.

**Why removal is safe (per Gate 6 audit)**:
1. CI's AISDLC-214 short-circuit posts `ai-sdlc/attestation: success` status directly for docs-only PRs WITHOUT verifying any envelope (verify-attestation.yml lines ~287-336).
2. AISDLC-380 sub-attestation gate is SKIPPED entirely on v6 envelopes per AISDLC-383.6.
3. The synthetic envelope was committed, pushed, and read by NO consumer.
4. Removing the synthesis path means docs-only pushes simply exit 0 (no-op) from check-attestation-sign.sh's "no verdict file" branch — exactly how the hook treats every other no-verdict-file case (chore PRs, ad-hoc commits, etc.).

## Acceptance criteria

- [x] AC-1: Backlog task file created at `backlog/tasks/aisdlc-387 - fix-remove-aisdlc-215-docs-only-auto-approve-synthesis.md`.
- [x] AC-2: In `scripts/check-attestation-sign.sh`, the docs-only auto-approve branch (Step 3b) is removed. The hook exits 0 (no-op) when no verdict file exists, regardless of changeset type.
- [x] AC-3: Script header comment block updated to remove docs-only / AISDLC-215 references; explains docs-only PRs are handled by CI (AISDLC-214) per RFC-0042 Phase 3.
- [x] AC-4: `CLAUDE.md` Hooks section item 4 updated — docs-only auto-approve paragraph removed.
- [x] AC-5: `scripts/check-attestation-sign.test.mjs` updated — docs-only-synthesis tests removed; one new no-op test added asserting hook exits 0 on docs-only changeset with no verdict file.
- [x] AC-6: 80%+ patch coverage maintained.
- [x] AC-7: No new bypass env vars, no backward-compat shims, no v5-fallback synthesis.
- [x] AC-8: All other codebase references to `AISDLC-215`, `DOCS_ONLY_SYNTHESIZED`, `docs-only auto-approve`, and `synthesized verdict` audited and updated.
