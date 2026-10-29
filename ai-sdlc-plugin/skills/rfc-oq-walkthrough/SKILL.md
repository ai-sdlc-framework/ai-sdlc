---
name: rfc-oq-walkthrough
description: End-to-end workflow for resolving open questions in an RFC. Covers the full lifecycle from "operator picked an RFC to walk through" to "PR opened with resolutions + sign-off + implementation tasks." Use whenever the operator asks to walk through an RFC's open questions, re-walk a previously-resolved RFC with higher rigor, or generally make a Draft → Ready for Review lifecycle transition stick. Composes with [[decision-rubric]] for the per-OQ AskUserQuestion mechanics.
---

# RFC OQ walkthrough — the full lifecycle

The decision-rubric skill covers the per-OQ AskUserQuestion mechanics. This skill covers everything around them: the worktree setup, the file edits, the sign-off mechanics, the implementation task generation, and the PR.

The end-to-end shape is **eight phases**, in order. Skipping any of them ships an incomplete RFC resolution.

**Boundary (AISDLC-298):** this skill never writes a `Resolution:` marker on its own. A `**Resolution (...):**` block is written only in Phase 4, only from an answer the operator gave in Phase 3, and never by a developer subagent or an unattended session. The Open Questions hard rule lives in the planner command (`ai-sdlc-plugin/commands/planner.md`, section "Hard rule: Open Questions"); it is referenced here, not restated.

## Phase 1 — Set up a clean worktree

- Create a new branch from `origin/main` at `.worktrees/<rfc-slug>-oq-walkthrough/` (or `-rewalkthrough` if revisiting a prior resolution).
- Never edit an RFC in the parent worktree; the parent checkout is read-only in the plugin's worktree convention (Pattern C).
- If the branch name collides with an old one, pick a new suffix; never delete branches (cleanup is the operator's job).

## Phase 2 — Read the RFC + survey shipped substrate

- Read the full RFC body — don't skim. The OQs may reference earlier sections that constrain the answer space.
- **Grep the project's source tree for shipped substrate that already partially implements the RFC.** This is the most common source of substantive bugs in resolutions: an OQ asks "should we ship X?" but X is already half-shipped in the source tree, and the resolution needs to harmonize against it rather than spec it from scratch.
- Examples observed (project-specific, from the repository this skill originated in; illustrative only):
  - RFC-0028 OQ-7.1 asked about `identityClass` — but `'core' | 'evolving'` was already shipped in `layer1-deterministic.ts`. Resolution had to harmonize.
  - RFC-0030 OQ-13.5 asked about flooding detection — but `sourceBaselineDriftMultiplier` was already shipped. Refinement REPLACED the algorithm rather than adding it.
- Note any shipped/spec mismatch in the resolution body so the implementer knows whether to add net-new code, replace existing code, or harmonize against it.

## Phase 3 — Per-OQ walkthrough (decision-rubric)

For each OQ, apply the [[decision-rubric]] skill: problem statement → industry research → 3-4 options with tradeoffs → recommendation + counter-argument → AskUserQuestion. **One OQ per AskUserQuestion call** — never batch.

After each operator answer, record the chosen option but do not yet write to the RFC. Hold the resolution text in working memory through the rest of the walkthrough so you can write everything in one batched pass at Phase 4.

## Phase 4 — Apply resolutions to the RFC body

Edits to make in a single batched pass:

1. **Frontmatter**: bump `updated:` to today's date; if promoting Draft → Ready for Review, set `lifecycle:`; expand `requires:` if new RFCs became dependencies (for example the Decision Catalog RFC if catalog routing was added).
2. **Body status header** (the `**Status:** ...` line below `# RFC-NNNN`): rewrite to reflect new lifecycle + version + one-line summary of every refinement made.
3. **§Open Questions**: for each OQ, ADD a `**Resolution (YYYY-MM-DD, full rubric):** ...` block after the original question text. Do NOT delete the original OQ text — preserving the question makes the resolution interpretable in context.
4. **§Configuration Schema** (if the RFC has one): add any new config fields the resolutions introduced. Mark them as `# NEW (re-walkthrough)` so future readers can see what came from this pass.
5. **§Revision History**: add a new row capturing every refinement, with bullet-per-OQ rationale. This is the audit trail that survives forever.

The Resolution block per OQ has a load-bearing shape:

```markdown
**Resolution (YYYY-MM-DD, full rubric):** **<recommendation summary>.**
Industry research: <one paragraph of citations>. **Substantive gaps in
v0.X surfaced by re-walkthrough:** <list>. **Refinement over v0.X:**
<concrete spec change>. **Counter-argument:** "<steel-manned objection>"
Rebuttal: <response>. **Selected over <other options> because <reason>.**
```

If the body only records "answer: A" it has failed the shape — edge cases six months in have nothing to interpret against.

## Phase 5 — Update the RFC registry, footer and upstream cross-references

- **Registry row**: lifecycle column, OQ-count column (drop to 0 if all resolved), description column gets a one-paragraph summary of every refinement with cross-references to the resolution markers in the RFC body. The description column is the single source of truth that operators scan first.
- **Active design walkthroughs section**: if the RFC was listed here as pending, move it to "*Awaiting lifecycle promotion (N/N OQs resolved YYYY-MM-DD)*" or remove it entirely if all OQs are now closed.
- **Totals footer**: add a sentence describing the walkthrough date, OQ-count delta (often unchanged for re-walkthroughs because OQs were already counted as resolved — only rigor improved), and cross-link to the registry row.

The footer note is the operator-facing log of what changed when. It should read end-to-end like a changelog.

### Cross-references in upstream RFCs

If the resolution introduces a "see-also" relationship with another RFC (e.g., RFC-0028 sits under RFC-0009 §5.2 + §7.2 as the authoring-time companion), add the cross-ref pointers in the upstream RFC. Light pointers only:

```markdown
> **See also: [RFC-NNNN](RFC-NNNN-slug.md) (one-line description).** Sentence
> explaining the integration.
```

Don't inline the content — pointers preserve the "RFCs shouldn't accumulate" principle.

## Phase 6 — Generate implementation backlog tasks

**This is the step that's easy to skip, and the operator's standing habit.** After OQ resolution + sign-off, every walkthrough must generate the implementation backlog tasks unless one of the explicit exemptions applies (below).

### How many tasks?

- For RFCs with discrete implementation phases (`§9. Implementation Plan` or similar), one task per phase. Typical: 4-6 tasks.
- For RFCs with cross-cutting refinements (re-walkthroughs of already-shipped substrate), one task per refinement surface area. The phases of the original walkthrough may already have been completed — file follow-up tasks against the shipped substrate rather than fresh phase tasks.

### Task ID allocation

Before claiming IDs, check for collisions:

1. `git ls-tree -r origin/main --name-only | grep -oE "aisdlc-[0-9]+" | sort -t- -k2 -n -u | tail -3` — highest IDs on main
2. `git worktree list | grep -oE "aisdlc-[0-9]+" | sort -t- -k2 -n -u | tail -3` — IDs claimed by active worktrees
3. `gh pr list --state open --json files --limit 30 | jq -r '.[].files[].path' | grep -oE "aisdlc-[0-9]+" | sort -u | tail -5` — IDs claimed by open PRs (a past trap)

The next free ID is `max(all three sources) + 1`. **Always check all three sources** — two-PR collisions waste an hour of renumbering.

### Task structure

Each task needs:

- Substantive Description (Scope section enumerating concrete changes per OQ resolution)
- Substantive ACs (testable checks, not "implement X")
- `references:` frontmatter listing the parent RFC + any RFCs it composes with
- `dependencies:` between tasks (Phase 2 depends on Phase 1, etc.) — encoded in frontmatter so the dependency graph composes correctly
- `labels:` including `rfc-NNNN`, `<surface-area>`, `phase-N`

### Replacement vs additive semantics

If the task REPLACES shipped behavior (not adds to it), say so explicitly in the Description with a "Replacement semantics (load-bearing)" section. Mark the deprecated config fields / code paths / decision types as removed, with a migration path. Leaving both the old and new path in place is the failure mode to avoid. (Project-specific example: the RFC-0030 OQ-13.5 z-score to multiplier replacement.)

### Exemptions — when NOT to generate tasks

- **RFC is already Implemented** (for example one shipped before the walkthrough). Sign-off only; no new tasks.
- **RFC is purely declarative / vision** (no implementation surface).
- **RFC was a docs-only addendum** (cross-ref edits, glossary additions).
- **RFC is Reserved / Placeholder** (no spec to implement against).

Always note the exemption rationale in the PR body so the operator can verify the absence of tasks was intentional.

## Phase 7 — Sign-off

**Only when the operator explicitly authorizes** (e.g., "Add my sign off"). Sign-off is not automatic from completing the walkthrough.

### Mechanics

- For RFCs with a table-format `## Sign-Off`: edit the row matching the operator's name; change `⏸ Pending` to `✅ Signed (one-line rationale; date)` and date to today.
- For RFCs with a checklist `## Sign-Off`: change `- [ ]` to `- [x]` and add the date + rationale inline.
- For RFCs where the operator covers both Engineering and Operator pillars (per the project's team-roles record), sign both. Update the role label to "CTO / Engineering Authority + AI-SDLC Operator" if it's a combined row.

### NEVER auto-fill

- **Product owner** — operator-only
- **Design owner** — operator-only
- Any role the operator doesn't explicitly claim

The single Sign-Off action is the operator stamping their pillars; never silently extend it.

### Sibling-PR awareness

If there are other open sign-off PRs (run `gh pr list --search "sign-off"` or scan recent docs PRs), document the coverage map in the PR body so reviewers know which PRs cover which RFCs. Avoid duplicating work that's already in flight.

## Phase 8 — Drift check + commit + PR

- `npx backlog-drift check` should pass with 0 errors before committing
- Commit message: `docs(rfc): RFC-NNNN OQ walkthrough — N OQs with full rigor rubric + M phase tasks (<TASK-IDs>)`
- PR body shape:
  - Summary (one paragraph)
  - OQ resolution table (one row per OQ with Resolution + Key innovation columns)
  - Substantive bugs/gaps surfaced (the load-bearing section — what the rubric caught that a shallow resolution would have missed)
  - Phase tasks table (ID / Phase / Scope / Deps)
  - Verification checklist
  - Sibling-PR coverage map (if any sign-off PRs in flight)

> Project-specific statements in this skill (ID prefix `aisdlc-`, `backlog/` layout, `spec/rfcs/README.md` registry, `npx backlog-drift`) follow this repository's conventions; adapt the names in an adopter repository.

## Compose with other patterns

- [[decision-rubric]] — the per-OQ AskUserQuestion mechanics; load-bearing for Phase 3
- The OQ-resolution prohibition (AISDLC-298), see the planner command's "Hard rule: Open Questions"; this skill assumes an operator-driven session and never writes a resolution on its own
- The AISDLC-308 scope-creep convention — do not auto-dispatch implementation work after sign-off; just file the tasks and stop

## Anti-patterns to avoid

- **Generating tasks before operator confirms the OQ resolutions.** Tasks reference the resolutions; resolving the wrong way means filing the wrong tasks. Operator confirmation gates task generation.
- **Reusing AISDLC IDs claimed by open PRs.** The active-worktree + open-PR scan is non-optional.
- **Marking task ACs as `[x]` because "the work is in this PR."** If the AC is satisfied by the PR diff, the task should be filed at `status: Done` AND moved to `backlog/completed/` AND committed there — OR filed at `status: To Do` with ACs unchecked for the implementer to verify. The mixed state (Done with unchecked ACs, or To Do with checked ACs) confuses the implementer.
- **Skipping sign-off because the operator didn't say so.** Don't auto-sign — but DO ask if the operator wants to sign at PR-creation time (one AskUserQuestion: "Sign off on this RFC now?").
- **Filing the same task with the same ID as an open PR.** This is the worst collision because both PRs look valid until merge — fix by renumbering whichever PR hasn't merged yet.
