---
id: AISDLC-555
title: >-
  feat(plugin): ship check-attestation-sign.sh and an idempotent pre-push hook
  installer so adopter repos actually invoke the signer
status: Done
assignee: []
labels:
  - attestation
  - adoption
  - plugin
  - ci:no-issue-required
priority: high
dependencies:
  - AISDLC-554
references:
  - scripts/check-attestation-sign.sh
  - ai-sdlc-plugin/scripts/install-runtime-deps.sh
  - ai-sdlc-plugin/commands/execute.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
`/ai-sdlc execute` Step 10 stops after writing reviewer verdicts and delegates
signing to a `pre-push` hook in the consuming repo (AISDLC-133). The step's own
text hands three things to that repo: `.husky/pre-push`,
`scripts/check-attestation-sign.sh`, and a working signer invocation.

AISDLC-554 fixed the third. The first two are still never delivered:
`check-attestation-sign.sh` exists only in the ai-sdlc monorepo's `scripts/`,
not under `ai-sdlc-plugin/`, so it is not part of what an adopter installs. The
plugin ships seven hooks and every one of them is a **Claude Code** hook — there
is no git hook and no installer that writes one. An adopter repo that is
otherwise fully configured (review policy, trusted-reviewers, signing key all
present) therefore has nothing that ever calls the signer.

Consequence: even with AISDLC-554 landed, an adopter still gets no attestation
unless they hand-write a hook, because nothing invokes signing at push time.

### Scope

- Move or copy `check-attestation-sign.sh` into `ai-sdlc-plugin/scripts/` so it
  ships with the plugin. Keep the monorepo's own `.husky/pre-push` working.
- Add an installer that writes `.husky/pre-push` into the consuming repo
  idempotently — re-running must not duplicate lines, and it must append to an
  existing hook rather than clobber a repo's own.
- Decide and document the entry point: a dedicated `/ai-sdlc init-hooks`, or an
  extension of `install-runtime-deps.sh`. Prefer whichever an adopter already
  runs, so this is not one more step they must discover.
- Handle repos that do not use husky at all — writing `.git/hooks/pre-push`
  directly, or documenting the manual wiring.

A second adopter report (2026-08-14) widened this: the same consumer repo has
no `.ai-sdlc/verdicts/`, no `dispatch/` board, and no `dispatch-config.yaml`,
and the shipped command list contains no initializer for any of them. So the
deliverable is better framed as a single idempotent `/ai-sdlc init` that brings
a consumer repo to the same state the dogfood monorepo is in, of which the
pre-push hook is one part.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [x] #1 `check-attestation-sign.sh` is present in the plugin's shipped
      `scripts/` directory
- [x] #2 An installer writes a working `.husky/pre-push` into a fresh adopter
      repo, and running it twice is a no-op the second time
- [x] #3 The installer appends to, rather than overwrites, a pre-existing
      `pre-push` hook
- [x] #4 A non-husky repo either gets a `.git/hooks/pre-push` or a documented
      manual path — decided explicitly, not left undefined
- [x] #5 End-to-end on a scratch repo outside the monorepo: verdict file
      present at push time produces a committed DSSE envelope
- [x] #6 Hermetic tests cover the idempotence and append-not-clobber cases
- [ ] #7 The initializer also creates `.ai-sdlc/verdicts/`, the Dispatch Board
      directories, and `dispatch-config.yaml`, so a consumer repo reaches
      parity with the dogfood monorepo in one command
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
From the 2026-08-14 adopter report against plugin 0.9.0. `resolve-pipeline-cli.sh`
plus `install-runtime-deps.sh` are the existing precedent for shipping and
self-healing a runtime artifact in the plugin cache; the same shape applied here,
but the actual root cause turned out to be one level up the stack: `ai-sdlc init
--with-attestation` (`orchestrator/src/cli/commands/init-features.ts` /
`init-templates.ts`) is the REAL existing installer entry point — it already
wrote an idempotent, append-not-clobber `.husky/pre-push` block via
`appendOnce()` keyed on a sentinel. Its bug was narrower than the task
description implied: the written block checked ONLY the monorepo-only
repo-relative path `./scripts/check-attestation-sign.sh`, which never exists
in an adopter repo, so the `[ -x ... ]` guard silently failed forever and the
block was a permanent no-op.

**Framing (per operator note, post-AISDLC-560):** attestation shipping
audit-only is a deliberate, documented architecture (`docs/operations/
quality-gate.md` Q3 / AISDLC-140 redesign — "audit at source, enforce at
deploy", matching SLSA/npm/PyPI precedent), not a half-finished install. This
task does not add enforcement and does not need the DEC-0012 decision AISDLC-560
escalated. It closes the gap in that architecture's own precondition: an audit
trail requires the audit to actually run. Before this task nothing ever
invoked the signer in an adopter repo, so the audit trail was empty by
construction (the motivating 2026-08-14 report: 2 transcripts across 200+ PRs
on a fully-configured adopter repo).

**What shipped:**
- `ai-sdlc-plugin/scripts/check-attestation-sign.sh` — a plugin-shipped copy
  that resolves `sign-attestation.mjs` relative to its OWN on-disk directory
  (not `$WT_ROOT/ai-sdlc-plugin/...`), so it works from any install topology.
  The monorepo's own `scripts/check-attestation-sign.sh` + `.husky/pre-push`
  are unmodified — the dogfood path keeps working exactly as before.
- `HUSKY_PREPUSH_SIGN_SNIPPET` (`init-templates.ts`) now resolves the hook
  script via repo-local copy → `$CLAUDE_PLUGIN_ROOT`/`$CLAUDE_PLUGIN_DIR` →
  a read-only plugin-cache probe, mirroring `resolve-pipeline-cli.sh`'s
  topology chain (including its read-only-cache-probe security posture —
  never self-heals from a user-writable cache dir).
- `resolveHookTarget()` (`init-features.ts`, AC#4): explicit husky vs.
  `.git/hooks/pre-push` decision based on a `package.json` `husky` dependency
  check, fails open to husky (back-compat) when undetermined. Every
  write/append now `chmod 0755`s the hook file (a freshly-written hook that
  isn't executable is silently never run by git — this would have made AC#2
  look like it passed when it hadn't).
- `.ai-sdlc/verdicts/.gitkeep` added to `ATTESTATION_TEMPLATES` (partial
  AC#7 — verdicts/ is tightly coupled to attestation). Dispatch Board
  directories + `dispatch-config.yaml` are explicitly OUT of scope for this
  task per the AISDLC-560 coordination note ("560 owns... the init-time
  decision") — AC#7 left unchecked.

**AC#5 (end-to-end, scratch repo outside the monorepo):** verified via a
`mkdtemp`-style scratch tree under the scratchpad dir (not a worktree of this
repo — no inherited git history/hooks). Built a fake plugin install dir
(built `@ai-sdlc/orchestrator` + `@ai-sdlc/pipeline-cli`, plus the two
`ai-sdlc-plugin/scripts/*` files) and reproduced the full round trip in two
configurations: (a) `CLAUDE_PLUGIN_ROOT` set (the `/ai-sdlc execute` push
path), and (b) neither env var set, fake plugin placed under
`~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/` (bare-terminal
`git push`, the cache-probe fallback). Both produced a committed v6 DSSE
envelope from a verdict file present at push time, and a second run of the
hook was a clean idempotent no-op (exit 0, no new commit).

Coordination: AISDLC-560 (draft PR #971, unmerged at time of this commit)
touches the same two files (`init-features.ts`, `init-templates.ts`) but in
disjoint regions — its `renderNextSteps()` / audit-only-messaging additions
vs. this task's `resolveHookTarget()` / `HUSKY_PREPUSH_SIGN_SNIPPET` /
adapter-interface changes. `applyFeatureSelection()`'s hook-writing block
(which calls `resolveHookTarget()`) is the reusable, independently callable
installer entry point — AISDLC-560's `init` / `doctor` work should call it
(or invoke `applyFeatureSelection` with `selection.attestation = true`)
rather than reimplementing hook-writing.
<!-- SECTION:NOTES:END -->
