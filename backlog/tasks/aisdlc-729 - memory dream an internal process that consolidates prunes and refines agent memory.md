---
id: AISDLC-729
title: >-
  Memory dream: an internal process that consolidates, prunes and refines agent memory
status: To Do
assignee: []
created_date: '2026-10-05'
labels:
  - memory
  - cost
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - docs/operations/usage-ledger.md
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator request 2026-10-05: develop an internal process like Anthropic's managed-agents "dreams" (https://platform.claude.com/docs/en/managed-agents/dreams) to process, prune and refine the memories our sessions accumulate.

What the reference feature does, per its documentation (research preview): "A dream reads an existing memory store alongside past session transcripts, then produces a new, reorganized memory store: duplicates merged, stale or contradicted entries replaced with the latest value, and new insights surfaced." It runs only on an explicit request, takes optional instructions that steer focus and what to preserve, is "a synthesis pass over the inputs, not an editor", and "the input store is never modified, so you can review the output and discard it." Its memory guidance: "Structure memory as many small focused files, not a few large ones."

Our memory today: one shared folder (set by `autoMemoryDirectory`, for this repository `.claude/memory` in the main checkout, git-excluded) holding one Markdown note per fact with frontmatter (`name`, `description`, `metadata.type` of user, feedback, project or reference) and an index `MEMORY.md` with one line per note that every session loads at start. Profile on 2026-10-05: 116 notes, 305 KB; index 98 lines and 22.5 KB loaded by the planner, dispatch and every executor; 24 notes carry WITHDRAWN, SUPERSEDED, RESOLVED or DONE markers; 16 notes are corrections of or replacements for other notes; 17 record finished work or transient state (old handoffs, finished overnight drains); 8 notes are not in any index; 41 of 173 `[[name]]` links dangle; 4 notes exceed 6 KB; 76 notes are older than 120 days. Nothing ever removes or merges a note.

This is not a governance control: nothing here refuses or blocks.

## Conventions
- Memory notes are private operator and project context; they are never committed, printed in PR bodies or sent anywhere except the model call that performs the synthesis. The synthesis prompt treats note text as data, not instructions.
- The command ships as a plugin slash command in `ai-sdlc-plugin/commands/` (see `ai-sdlc-plugin/commands/execute.md` for the house shape) backed by a pipeline-cli subcommand.
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared `/tmp` path.

## Acceptance Criteria
- [ ] A command (a plugin slash command backed by a pipeline-cli subcommand, usable in any adopter repository) runs a dream over the configured memory folder. It resolves the folder the same way sessions do (the `autoMemoryDirectory` setting, else the harness default) and takes optional instructions.
- [ ] The input folder is never modified by the run. Output is a complete new folder beside it (same note format and index format) plus a report. Applying the result is a separate, explicit step that swaps the folders atomically and keeps the previous versions (at least the last three) so any swap can be undone with one command.
- [ ] Mechanical pass, no model calls: index entries for every note and no entry for a missing file; dangling `[[name]]` links repaired where the target is unambiguous and listed where not; notes whose frontmatter is missing or invalid reported; index lines over a length budget flagged.
- [ ] Synthesis pass, model-driven: merge notes that state the same rule; where a later note corrects, withdraws or supersedes an earlier one, keep the latest value in one note and drop the superseded text; move finished work and transient state (old handoffs, completed drains, resolved incidents) out of the loaded index into an archive that is kept on disk; condense notes over a size budget; rewrite index lines so each says when the note applies.
- [ ] Preservation rules the synthesis must follow, with tests on fixtures: the operator's quoted words, dates and stated reasons are kept verbatim; a rule is never strengthened, weakened or generalised beyond its sources; nothing is invented; every output note lists the input notes it came from, so a reader can trace it; notes of type user and reference are never merged away.
- [ ] The report lists every input note with its disposition (kept, merged into which note, archived, dropped and why), every new or rewritten note with its sources, and before and after numbers: note count, index lines and bytes, dangling links. Low-confidence merges are listed separately and left unmerged unless the instructions say otherwise.
- [ ] Budgets are configurable with defaults: loaded index at most 40 lines or 8 KB, a note at most 4 KB. The run reports whether the output meets them.
- [ ] Mining session transcripts for new insights is a second, opt-in phase: it proposes new notes in the report and never adds them to the output folder without an explicit flag, because transcripts contain untrusted text (tool output, fetched pages, other sessions' messages) and a planted instruction must not become a standing memory.
- [ ] Concurrency: sessions append to the live folder while a dream runs. Applying a result detects notes added or changed since the run started, carries them over unchanged and says so; a lock prevents two applies at once.
- [ ] Cost is bounded and visible: the run uses the `sonnet` alias by default, states the notes and tokens it processed (reported in the same terms as `docs/operations/usage-ledger.md`), and has a dry-run that performs only the mechanical pass and prints what the synthesis pass would look at.
- [ ] Triggering stays explicit in this task. The command also prints a one-line suggestion when the loaded index exceeds its budget; scheduling it automatically is out of scope until the explicit run has been used several times.
- [ ] Docs: one operations page describing the run, the review of the report, apply and undo; the memory guidance for agents (one fact per note, when to update instead of add) is restated there in a short form.
- [ ] First real use is part of the task: run it on this repository's memory folder, attach the report's summary numbers to the PR body (not the note contents, which are private), and leave the output folder unapplied for the planner to review.

## Out of scope
- Changing how the harness loads memory.
- Per-role memory folders.
- Automatic scheduling.
<!-- SECTION:DESCRIPTION:END -->
