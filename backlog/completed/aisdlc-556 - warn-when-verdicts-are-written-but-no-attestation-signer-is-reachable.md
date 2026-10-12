---
id: AISDLC-556
title: >-
  feat(pipeline): warn at Step 10 when verdicts are written but no attestation
  signer is reachable, and document the adopter prerequisites
status: Done
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
- [x] #1 With no signer reachable, Step 10 emits a warning that names the
      verdict path and states the PR will carry no attestation
- [x] #2 The warning does not block the pipeline (fail open)
- [x] #3 With a signer reachable, no warning is emitted
- [x] #4 The plugin README lists the adopter prerequisites for attestation,
      including that `verify-attestation` CI cannot pass without them
- [x] #5 The execute docs no longer describe the pre-push hook as if it is
      already installed in a consuming repo
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From the 2026-08-14 adopter report against plugin 0.9.0. Kept separate from
AISDLC-554 because that task fixes the signer's own reachability, whereas this
one concerns a different code path — the pipeline step that never attempts to
sign in the first place.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Step 10 of `/ai-sdlc execute` now probes for a reachable attestation signer after writing the verdict file and warns, without blocking, when none is found. The plugin README documents the adopter prerequisites for attestation.

## Changes
- `ai-sdlc-plugin/scripts/warn-if-no-signer.sh` (new): probes with `sign-attestation.mjs --print-content-hash`; warns naming the verdict path and that the PR will carry no attestation; always exits 0.
- `ai-sdlc-plugin/scripts/warn-if-no-signer.test.mjs` (new): hermetic tests for warn, no-warn and fail-open.
- `ai-sdlc-plugin/commands/execute.md` (modified): Step 10 calls the probe; the pre-push hook is no longer described as already installed in a consuming repo.
- `ai-sdlc-plugin/README.md` (modified): "Attestation prerequisites for adopters" section, stating verify-attestation CI cannot pass without a signer.
- `package.json` (modified): `test:warn-if-no-signer-gate`, chained into `pnpm test`.

## Design decisions
- **Fail open**: always exits 0; the defect is silence, not permissiveness.
- **Narrow probe**: warns only when the script or node is missing, or the runtime cannot be located; other probe failures are treated as reachable.

## Verification
- `pnpm build` — clean
- `pnpm test` — new test 4/4, dark-code check OK, plugin command tests 420/420; full suite left to CI
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
- declined: fallback echo in execute.md when the probe script path does not resolve (minor reviewer note; still fails open)
- declined: test tying the probe string to the signer source (suggestion)
- declined: README note that the warning cannot detect a missing hook or key (suggestion)
<!-- SECTION:FINAL_SUMMARY:END -->
