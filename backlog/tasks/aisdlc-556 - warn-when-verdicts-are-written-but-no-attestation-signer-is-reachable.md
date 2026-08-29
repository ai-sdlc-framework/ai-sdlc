---
id: AISDLC-556
title: >-
  feat(pipeline): warn at Step 10 when verdicts are written but no attestation
  signer is reachable, and document the adopter prerequisites
status: To Do
assignee: []
labels:
  - attestation
  - adoption
  - observability
  - ci:no-issue-required
priority: medium
dependencies:
  - AISDLC-554
references:
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - ai-sdlc-plugin/README.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The adopter-facing failure reported on 2026-08-14 was not merely that signing
was broken — it was that signing was broken **silently**. Reviews ran, verdicts
were written, the PR opened, nothing errored, and the pipeline looked like it
completed. Finding the gap required tracing `/ai-sdlc execute` by hand.

AISDLC-554 makes the signer fail loudly *when something invokes it*. This task
closes the remaining window: Step 10 writes a verdict file and returns without
ever checking that a signer is reachable, so in a repo where nothing invokes
signing there is no signal at all.

The reporter's framing is the acceptance bar: a warning here "alone would have
surfaced the gap immediately instead of a trace being needed to find it."

Step 7a is the model to copy — it already documents an explicit fail-open path
when the classifier binary is missing, rather than degrading quietly.

### Scope

- At Step 10, after writing the verdict file, probe whether an attestation
  signer is reachable (the AISDLC-554 resolver makes this a cheap check —
  `--print-content-hash` needs no signing key).
- When it is not, emit a warning naming the consequence in adopter terms, e.g.
  "verdicts written to X, but no attestation signer is available in this repo —
  the PR will carry no attestation."
- Fail open, not closed: a missing signer must not block the pipeline. The
  defect is silence, not permissiveness.
- Document the adopter prerequisites in the plugin README: signing key, the
  runtime dependency, and the pre-push hook (AISDLC-555). The execute docs
  currently describe the hook as though it exists, which reads as
  "already set up" to anyone installing the plugin.
- Note that `verify-attestation` CI cannot pass in a repo with no signer, so
  adopters are currently required to omit that check — say so explicitly rather
  than leaving them to infer it.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 With no signer reachable, Step 10 emits a warning that names the
      verdict path and states the PR will carry no attestation
- [ ] #2 The warning does not block the pipeline (fail open)
- [ ] #3 With a signer reachable, no warning is emitted
- [ ] #4 The plugin README lists the adopter prerequisites for attestation,
      including that `verify-attestation` CI cannot pass without them
- [ ] #5 The execute docs no longer describe the pre-push hook as if it is
      already installed in a consuming repo
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From the 2026-08-14 adopter report against plugin 0.9.0. Kept separate from
AISDLC-554 because that task fixes the signer's own reachability, whereas this
one concerns a different code path — the pipeline step that never attempts to
sign in the first place.
<!-- SECTION:NOTES:END -->
