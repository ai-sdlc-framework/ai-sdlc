---
id: AISDLC-563
title: >-
  fix(dor): Gate 7 flags dependencies that ARE declared, forcing authors to
  reword prose instead of fixing anything
status: Done
assignee: []
labels:
  - dor
  - pipeline-cli
  - ci:no-issue-required
priority: medium
dependencies: []
references:
  - pipeline-cli/src/dor/upstream-oq-gate.ts
  - pipeline-cli/bin/cli-dor-check.mjs
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Gate 7 ("No invisible dependencies") reports a violation for a dependency that
is correctly declared in frontmatter. It appears to extract the prose phrase and
compare it literally, without normalising to the task ID and reconciling against
`dependencies:` / `references:`.

Reproduced twice on 2026-08-14/16:

- **AISDLC-557** — frontmatter `dependencies: [AISDLC-554]`. Body said
  "self-resolve once AISDLC&#8209;554 merges to main". Gate 7:
  `1 tracked-work dependency reference(s) in body not listed in frontmatter
  'dependencies:': 'once AISDLC&#8209;554'`. Note the extracted token is
  `once AISDLC&#8209;554`, not `AISDLC&#8209;554`.
- **AISDLC-561** — frontmatter `dependencies: [AISDLC-560]`. Body said
  "Depends on AISDLC&#8209;560 because …". Same violation, extracted token
  `Depends on AISDLC&#8209;560`.

Both cleared only by rewording the prose to avoid the trigger phrasing. Nothing
about either task's actual dependency declaration changed.

**Why this matters more than the inconvenience:** the gate blocks a push, so the
cheapest way out is always to reword the sentence rather than to add the missing
dependency. That trains authors — and dev subagents — to edit prose until a gate
goes quiet. A gate whose false positives are resolved by deleting the sentence
that tripped it is worse than no gate, because it erodes the habit the gate
exists to build. It also produces exactly the wrong lesson in a repo whose whole
review culture is "make the check assert the real property".

**This task could not be filed without tripping the bug it reports.** Quoting
the two offending phrases as evidence caused Gate 7 to flag five violations on
this very file, for IDs it has no dependency on at all. The quoted IDs are
written with a non-breaking hyphen entity so the evidence survives. That is
itself the clearest statement of severity: the gate's false positives are
resolved by mangling the text, never by fixing a dependency.

### Scope

- Normalise extracted references to the bare task/RFC ID before comparing.
- Compare against BOTH `dependencies:` and `references:`, matching the
  documented contract.
- Add regression cases for the two reproductions above, plus the genuine
  positive (a body reference with no frontmatter entry) so the gate keeps
  catching what it is for.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [x] #1 A body phrase like "depends on AISDLC&#8209;N" / "once AISDLC&#8209;N merges"
      does NOT violate Gate 7 when AISDLC-N is declared in frontmatter
- [x] #2 The same phrase DOES violate when AISDLC-N is absent from both
      `dependencies:` and `references:` — the gate must not be defanged
- [x] #3 Matching is case- and surrounding-word insensitive; the extracted
      token is the ID, not the phrase
- [x] #4 Both real reproductions (AISDLC-557, AISDLC-561) are regression tests
- [x] #5 Verified against the real task files that tripped it
<!-- SECTION:ACCEPTANCE:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Found while filing the adopter-onboarding tasks (AISDLC-560/561/562), which is
fitting: the report those tasks come from is about checks that report a state
they have not verified. This is the same failure in the opposite direction — a
check reporting a violation it has not verified.

The error message is otherwise good: it quotes the offending text and names the
remedy. Only the comparison is wrong.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Root cause was upstream of the comparison logic implied by the task title: Gate
7's regex/comparison in `gate-7-deps.ts` was already correct (it captures only
the bare tracked-work id, never the surrounding phrase, and already compares
case-insensitively). The actual bug is that `refineBacklogTask()`
(`ingress-claude.ts`) — the only real caller of the gate — never populated
`IssueInput.references` (or any other field) from the task's frontmatter
`dependencies:` / `references:` lists. Gate 7 was therefore always comparing
against an empty declared-dependency set, so every body dep-phrase was flagged
regardless of frontmatter. Fixed by adding a dedicated
`IssueInput.declaredDependencyRefs` field, a frontmatter-list parser that
merges `dependencies:` + `references:`, and wiring it into the ingress shim.

## Changes

- `pipeline-cli/src/dor/types.ts` (modified): added `IssueInput.declaredDependencyRefs?: string[]` — deliberately a NEW field, not a reuse of `references` (which Gate 3 treats as file-existence resolution targets; mixing tracked-work ids into it would turn a Gate-7 false positive into a Gate-3 one).
- `pipeline-cli/src/dor/gates/gate-7-deps.ts` (modified): added `extractFrontmatterListField()` (generic YAML list-field parser, inline + block-list forms) and `extractDeclaredDependencyRefs()` (merges `dependencies:` + `references:`). `findInvisibleDependencies()` now merges `input.references` (legacy caller override, kept for backward compat) with `input.declaredDependencyRefs` before the case-insensitive comparison.
- `pipeline-cli/src/dor/ingress-claude.ts` (modified): `refineBacklogTask()` now calls `extractDeclaredDependencyRefs(frontmatter)` and populates `input.declaredDependencyRefs` before evaluating the rubric.
- `pipeline-cli/src/dor/gates/gate-7-deps.test.ts` (modified): added `extractFrontmatterListField` / `extractDeclaredDependencyRefs` unit tests plus a dedicated AISDLC-563 describe block covering both real reproductions (AISDLC-557's "once AISDLC&#8209;554 merges", AISDLC-561's "Depends on AISDLC&#8209;560 because"), the true positive (undeclared reference still fails), a `references:`-only declaration, and explicit case-/surrounding-word-insensitivity assertions.
- `pipeline-cli/src/dor/ingress-claude.test.ts` (modified): added 4 end-to-end tests through the real `refineBacklogTask()` entry point (not just the gate unit) — both real reproductions pass, the true positive still fails, and a `references:`-only declaration passes.

## Design decisions

- **New `declaredDependencyRefs` field instead of populating `references`**: `IssueInput.references` already has an established, different consumer (Gate 3's file-existence resolver, which unconditionally treats every entry as a file path to resolve on disk). Populating it with `AISDLC-554`-shaped ids would have silently broken Gate 3 for every task that declares a `dependencies:` list — trading one false positive for another. A dedicated field keeps the two gates' inputs independent.
- **`extractFrontmatterListField` accepts any shape, not just tracked-work-id patterns**: unlike the RFC-only extractors in `upstream-oq-gate.ts`, this parser doesn't filter by regex shape, because Gate 7's dependency phrases can legitimately pair with file paths too (an existing test case pairs the "depends on" phrase with a `.ts` path) — filtering to only `AISDLC-N`/`RFC-NNNN` shapes would have silently dropped that case.
- **Kept `input.references` as a fallback in the merge**: existing `gate-7-deps.test.ts` unit tests construct `IssueInput` with `references` directly; merging rather than replacing preserves that contract for any other caller that already passes deps via `references`.

## Verification

- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean.
- `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/dor/gates/gate-7-deps.test.ts src/dor/ingress-claude.test.ts` — 64/64 passing.
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 6994/7008 passing; the 1 failure (`src/tui/app.test.tsx`) is a pre-existing timeout unrelated to this change and passes standalone in isolation (re-ran green).
- `pnpm build`, `pnpm lint`, `pnpm format:check` — clean across the whole repo.
- `npx backlog-drift check` — exit 0, no error-severity issues.
- **Verified against real task files (AC#5):** `node pipeline-cli/bin/cli-dor-check.mjs --task <AISDLC-561's task file>` and `--task <this file>` both exit 0. Also reconstructed AISDLC-557's exact original wording (self-resolves once AISDLC&#8209;554 merges to main, with `dependencies: [AISDLC-554]`) as a scratch task file — exit 0 post-fix, and confirmed exit 1 with the pre-fix reported finding text when the frontmatter `dependencies:` entry is removed (true positive still fires).
- **This task's own file trips nothing** — same non-breaking-hyphen convention the original filing used, applied to this Verification section too once drafting it turned out to reproduce the exact bug being described (`cli-dor-check` against this file exits 0).

## Follow-up

(none)
<!-- SECTION:FINAL_SUMMARY:END -->
