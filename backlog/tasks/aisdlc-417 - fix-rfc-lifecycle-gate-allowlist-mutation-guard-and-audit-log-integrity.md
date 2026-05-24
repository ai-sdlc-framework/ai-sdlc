---
id: AISDLC-417
title: 'fix(rfc-lifecycle-gate): allowlist same-PR mutation guard + audit-log append-only enforcement (AISDLC-350 follow-up)'
status: To Do
labels: [fix, security, follow-up-aisdlc-350]
dependencies:
  - AISDLC-350
references:
  - scripts/check-rfc-lifecycle-transitions.mjs
priority: high
permittedExternalPaths: []
blocked:
  reason: "Referenced workflow (rfc-lifecycle-check.yml) ships via AISDLC-350 PR #652 — reference will resolve after that merges. The companion script reference is already on main from AISDLC-297. This is the follow-up to add allowlist same-PR mutation guard + audit-log integrity protection."
---

## Description

AISDLC-350 shipped the RFC lifecycle gate CI wiring + hardening. The GH-review-override critical was addressed inline (path removed). Two remaining MAJOR security gaps from the security review need workflow-level fixes:

1. **Allowlist same-PR mutation**: `loadLifecycleApprovers()` reads `.ai-sdlc/lifecycle-approvers.yaml` from HEAD, with no check that the allowlist was not modified in the current PR diff. A single PR can both (a) add a new operator entry to the allowlist AND (b) include an override marker citing that new operator — bypassing the ladder. CODEOWNERS (`* @deefactorial`) is the current mitigation but the GATE itself doesn't enforce it. The diagnostic at line 398 already says "Add `<operator>` to the allowlist via a separate PR first" — make that enforceable.

2. **Audit log integrity**: `.ai-sdlc/_audit/lifecycle-overrides.jsonl` is described as append-only but has no protection against rewrite or deletion. Any PR can edit/delete entries with no gate check. An attacker exploiting any future bypass could also delete prior audit entries in the same PR (or a follow-up) to hide their tracks.

## Acceptance criteria

- [ ] AC-1: workflow guard — fail the PR if `git diff $BASE_SHA $HEAD_SHA -- .ai-sdlc/lifecycle-approvers.yaml` is non-empty AND any override marker is used in the same PR. Diagnostic must direct operator to "split into two PRs: allowlist add, then override use".
- [ ] AC-2: workflow guard — fail the PR if `git diff $BASE_SHA $HEAD_SHA -- .ai-sdlc/_audit/lifecycle-overrides.jsonl` shows any line removals (only additions allowed). Suggest hash-chained entries as a future hardening.
- [ ] AC-3: hermetic tests for both guards.
- [ ] AC-4: also address the 2 lesser findings: unknown-fromLifecycle silent pass (script returns ok:true when fromIdx===-1); --pr-body command substitution via $(cat) reintroduces shell-quoting exposure (use --pr-body-file flag instead).

## Out of scope

- Restructuring the override marker shape
- Replacing the operator allowlist with a different identity mechanism (e.g. GPG signing)

## Estimated effort

30-60 min. Two workflow conditional steps + helper script tests + 2 minor script tweaks.
