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
  The monorepo's own `.husky/pre-push` is unmodified, so the dogfood path keeps
  working as before. `scripts/check-attestation-sign.sh` received exactly ONE
  change from this task — the `AI_SDLC_ALLOW_SIGNER_OVERRIDE` gate described
  below — applied to both copies in lockstep so they do not diverge. (An
  earlier revision of this note said that file was "unmodified"; that was true
  when written and stopped being true in round 3.)
- `HUSKY_PREPUSH_SIGN_SNIPPET` (`init-templates.ts`) resolves the hook script
  from the PLUGIN INSTALL ONLY: `$CLAUDE_PLUGIN_ROOT`/`$CLAUDE_PLUGIN_DIR` →
  a read-only plugin-cache probe (never self-heals from a user-writable cache
  dir). **There is deliberately no repo-local tier.** An earlier revision of
  this note claimed one; that tier existed in the first cut and was REMOVED in
  round 1 because it put repo-tracked content on the push-time execution path
  with the operator's Ed25519 signing key in scope — a contributor could land
  `scripts/check-attestation-sign.sh` and have it run as the maintainer on the
  next push. Pinned by `prepush-sign-snippet.test.ts`'s "does NOT execute a
  signer from the working tree". Documentation that still advertises a removed
  security control is how it gets restored by a well-meaning future change.
- `resolveHookTarget()` (`init-features.ts`, AC#4): decides the hook target by
  asking git, not by guessing. `git config --get core.hooksPath` decides
  WHETHER a hooks path is configured; `git rev-parse --git-path hooks`
  RESOLVES it (expanding `~` and handling linked worktrees/submodules where
  `.git` is a FILE). husky v9 points `core.hooksPath` at `.husky/_` — generated
  internals whose own `.gitignore` is `*`, regenerated by every `npm install` —
  so the resolver steps up to the adopter-owned parent. When no hooks path is
  configured, the `package.json` husky check decides `.husky/pre-push` vs
  `.git/hooks/pre-push`, failing open to husky for back-compat.
  Every write/append sets the exec bit with `mode | 0o111` rather than forcing
  `0o755`: a non-executable hook is silently never run by git, but forcing
  `0o755` would widen an adopter's deliberately restrictive mode (`0600`
  becoming world-readable) on a file in their own repo.
- A hooks path resolving OUTSIDE the project is REFUSED unless
  `AI_SDLC_ALLOW_GLOBAL_HOOKS=1`. `git config --get` reads all scopes, so a
  global `~/.githooks` would otherwise put the key-bearing signer on every push
  in every repo on the machine. A linked worktree's common dir is also outside
  the project but is still this repository, so it installs with a note instead.
- `.ai-sdlc/verdicts/.gitkeep` added to `ATTESTATION_TEMPLATES` (partial
  AC#7 — verdicts/ is tightly coupled to attestation). Dispatch Board
  directories + `dispatch-config.yaml` are OUT of scope for this task and
  **currently have no owning task** — an earlier note cited AISDLC-560, but
  that task covers attestation enforcement/doctor and nothing under
  `backlog/tasks/` mentions `dispatch-config.yaml`. AC#7 left unchecked.

**Known-open, deliberately not fixed here** (recorded so they survive the
merge rather than living only in PR review threads).

> Two items previously listed here were CLOSED in round 7 at the operator's
> direction: symlink/realpath containment, and the word-split override
> invocation. Both are described under "What shipped" above.

- **CLOSED (round 7): symlink/realpath containment.** `outsideProject` is
  decided with `path.relative`, which is LEXICAL — a repo committing `.husky`
  (or `.husky/pre-push`) as a symlink out of the tree still looked *inside* it,
  so neither the machine-wide refusal nor any string check fired while
  `writeFileSync`/`chmodSync` followed the link. A new `realpath` adapter now
  resolves the DEEPEST RESOLVING component (the hook file if it currently
  resolves, else its parent) and the install is REFUSED when that real path
  escapes the project. Scoped to the case where the lexical check claimed
  "inside": the worktree-common-dir and explicit `AI_SDLC_ALLOW_GLOBAL_HOOKS`
  cases are knowingly outside and are handled separately. Covered by a stub
  test and a real-filesystem test that plants an actual symlink and asserts
  the victim file is neither appended to nor made executable.
  **Follow-up hardening:** the "deepest resolving component" fallback alone
  had a gap — a DANGLING final-component symlink (`.husky/pre-push`, or
  `.husky` itself, pointing at a path that does not exist YET) makes
  `realpath(hookPath)` throw ENOENT the same way "hookPath simply doesn't
  exist" does, so the old fallback silently resolved to the real, in-project
  parent directory and containment PASSED even though the final component
  redirected somewhere unverifiable — `writeFileSync`/`chmodSync` would then
  follow the dangling link and create the target (with the exec bit set)
  outside the project. A new `isSymlink` adapter (`lstatSync(...).isSymbolicLink()`,
  which does NOT follow the link) lets the check ask "is this a symlink"
  independently of whether it currently resolves: `hookPath` and its parent
  directory are now checked explicitly, and EITHER being a symlink with a
  non-resolving (dangling) or out-of-project target is refused unconditionally
  — a dangling symlink is never treated as "probably fine". A `.husky` itself
  being a dangling symlink previously also crashed the whole wizard with an
  unhandled `mkdirSync` `ENOENT`/`EEXIST`; the create path is now wrapped so
  that failure is caught and reported as a clean refusal instead. Covered by
  two stub tests (hook-path-dangling, parent-dir-dangling) and two
  real-filesystem tests in `prepush-sign-snippet.test.ts` (a symlink to a
  path that does not exist, and `.husky` itself as a dangling symlink),
  mutation-verified against reverting each of the two defenses.
- **CLOSED (round 7): the override is gated AND no longer word-split.**
  `AI_SDLC_SIGN_ATTESTATION_CMD` requires `AI_SDLC_ALLOW_SIGNER_OVERRIDE=1`
  (closing the AISDLC-133 note "add a test-mode sentinel guard so prod doesn't
  honor a stray operator export"), and the invocation is now read into a bash
  array via `read -r -a` instead of being left as an unquoted expansion. The
  same change fixes `HARNESS_ARGS`, which was unquoted in BOTH the override and
  the real-signer branches. Empty-array expansions use the
  `${ARR[@]+"${ARR[@]}"}` idiom because macOS ships bash 3.2, where a bare
  `"${ARR[@]}"` on an empty array errors under `set -u`.
  *Honest limit:* `read -r -a` still splits on IFS, so a signer path containing
  spaces is still unsupported — what this removes is GLOB EXPANSION, i.e. the
  old form let the filesystem decide what ran. Pinned by a glob test in BOTH
  script suites. The sentinel remains defense-in-depth against stale exports,
  **not** a privilege boundary: anyone who can set env before a push can set
  both variables.
  *Second, smaller behaviour change:* `read -r -a ARR <<< "$VAR"` (a here-string,
  with no `-d ''`) reads only the FIRST LINE of `$VAR` — `read` stops at the
  first newline regardless of `-a`. A `AI_SDLC_SIGN_ATTESTATION_CMD` value that
  (accidentally or maliciously) contains an embedded newline is silently
  TRUNCATED to its first line rather than split across the array the way the
  rest of the value might suggest. This is fail-safe (less of the value is
  used, not more, and no code beyond the first line can be smuggled in), but it
  is a behaviour change from the old unquoted `$VAR` expansion, which would
  have word-split across the newline too. Not separately tested — the
  glob-expansion tests already cover the array-splitting contract; this note
  exists so a future reader isn't surprised by the truncation.
- **The husky step-up has one repo-controlled disjunct.**
  `looksLikeHuskyInternals` accepts "the project declares husky" (read from the
  repo's own `package.json`) as evidence of a husky layout. A repo that
  declares husky while `core.hooksPath` points at a non-husky directory whose
  basename is `_` (e.g. `vendor/_`) gets the hook written one level up, where
  git never reads it — init reports success and no attestation is ever signed.
  Narrowly gated by the `basename === '_'` requirement, and the
  husky-not-declared direction has an explicit regression test. Accepted
  because dropping the disjunct reintroduces the fresh-clone custom-husky-dir
  miss (`.config/husky/_`, whose internals do not exist until `npm install`).
- **`--workspace <name>` resolves the hooks dir against the subdirectory.**
  `projectDir` is then `<git-root>/packages/<name>`, so (a) a relative
  `core.hooksPath` is joined onto the subdirectory, producing an inert hook
  under `packages/<name>/.husky/`, and (b) an absolute repo-local hooks path at
  the git root is lexically outside that subdirectory and, if it came from
  `core.hooksPath`, is REFUSED with a message telling the operator to scope the
  hooks path to "this repo" — which it already is. Both outcomes are "no
  attestation gets signed". Not a regression (pre-555 the hook always went to
  `<projectDir>/.husky/pre-push`), but resolving against the git root rather
  than the install dir would close it.

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
