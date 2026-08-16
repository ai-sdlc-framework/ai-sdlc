---
id: AISDLC-563
title: >-
  fix(dor): Gate 7 flags dependencies that ARE declared, forcing authors to
  reword prose instead of fixing anything
status: To Do
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
- [ ] #1 A body phrase like "depends on AISDLC&#8209;N" / "once AISDLC&#8209;N merges"
      does NOT violate Gate 7 when AISDLC-N is declared in frontmatter
- [ ] #2 The same phrase DOES violate when AISDLC-N is absent from both
      `dependencies:` and `references:` — the gate must not be defanged
- [ ] #3 Matching is case- and surrounding-word insensitive; the extracted
      token is the ID, not the phrase
- [ ] #4 Both real reproductions (AISDLC-557, AISDLC-561) are regression tests
- [ ] #5 Verified against the real task files that tripped it
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
