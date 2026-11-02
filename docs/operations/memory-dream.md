# Memory dream

**Audience:** operators and adopters whose agent memory folder keeps growing.
**Task:** AISDLC-729. **Not a governance control:** nothing here refuses or blocks.

A memory dream is a synthesis pass over the memory folder, modelled on the managed-agents "dreams" feature. It merges duplicates, keeps the latest value where a note corrects or supersedes another, moves finished work and transient state into an on-disk archive, condenses large notes and rewrites index lines so each says when the note applies. It is a synthesis pass, not an editor: **the live folder is never modified by a run.** You review the output, then apply it as a separate step.

Memory notes are private. The run sends note text only to the model call that does the synthesis, treats it as data rather than instructions, and the report names files and counts, never note content. Do not commit memory folders or output folders.

Commands are written as `cli-memory-dream`; from a checkout use `node pipeline-cli/bin/cli-memory-dream.mjs`. In Claude Code use `/ai-sdlc memory-dream <args>`.

## Run

```bash
cli-memory-dream run --dry-run                       # mechanical pass only; prints what synthesis would read
cli-memory-dream run                                 # full run, model `sonnet`
cli-memory-dream run --instructions "keep every note about releases"
```

The folder is resolved the way sessions do: the `autoMemoryDirectory` setting (`.claude/settings.local.json`, `.claude/settings.json`, then `~/.claude/settings.json`), else `~/.claude/projects/<slug>/memory`. Override with `--dir`.

A run writes, beside the input folder:

| Path | Content |
| --- | --- |
| `<memory>.dream-<stamp>/` | The complete new folder: notes, rebuilt `MEMORY.md`, and `archive/` for archived notes (kept on disk, not indexed) |
| `<memory>.dream-<stamp>.report.md` and `.report.json` | The report |
| `<memory>.dream-<stamp>.meta.json` | The note hashes at run start, used by apply |

**Mechanical pass (no model):** an index entry for every note and none for a missing file; dangling `[[name]]` links repaired where exactly one target matches, listed otherwise; notes with missing or invalid frontmatter reported; index lines over 200 characters flagged.

**Synthesis pass (model):** the model proposes dispositions and rewritten notes. A validator enforces the preservation rules rather than trusting the prompt: operator quotes and dates must survive verbatim, an output may not introduce strengthening or weakening wording (always, never, must, should, may and similar) that its sources lack, every output note lists its source notes in `metadata.sources`, and notes of type `user` and `reference` are never merged, archived or dropped. A proposal that breaks a rule is repaired toward keeping the original note. Merges the model marks low confidence stay unmerged unless you pass `--allow-low-confidence`.

**Budgets** (flags `--index-max-lines`, `--index-max-bytes`, `--note-max-bytes`): index at most 40 lines and 8 KB, each note at most 4 KB. The report says whether the output meets them. When the loaded index exceeds its budget, every invocation prints a one-line suggestion to run a dream. Scheduling is deliberately not automatic.

**Cost:** the `sonnet` alias by default. The report states the notes and bytes processed and the tokens used in the terms of [`usage-ledger.md`](usage-ledger.md) (input, cache write, cache read, output). A dry run makes no model call.

**Transcript mining (opt-in):** `--mine-transcripts [folder]` asks the model for new-note proposals from recent session transcripts. Transcripts contain untrusted text, so proposals appear only in the report. `--add-proposals` is the explicit flag that adds them to the output, tagged `origin: transcript-proposal`.

## Review the report

Open the `.report.md`. Check, in order: the before and after numbers; every input note's disposition (kept, merged into which note, archived, dropped and why); new and rewritten notes with their sources; the low-confidence merges that were left unmerged; validator repairs; warnings. Diff any note you care about against the output folder. If the model call failed, the output holds only the mechanical fixes and the report says so.

## Apply and undo

```bash
cli-memory-dream apply <memory>.dream-<stamp>   # swap the output in
cli-memory-dream undo                           # restore the previous version
```

Apply takes a lock, so two applies cannot run at once. It detects notes added or changed in the live folder since the run started, carries them over unchanged and prints which ones. It then moves the live folder into `<memory>.dream-versions/` and puts the output in its place. At least the last three previous versions are kept (`--keep` can raise that). `undo` swaps the newest previous version back and keeps the folder you undid as a version, so an undo can itself be undone.

## Memory guidance

- One fact per note; many small focused notes beat a few large ones.
- Update the existing note instead of adding a new one that restates or corrects it.
- Put finished work and one-off state in a note you can archive, not in a standing rule.
- Make the index line say when the note applies.

## Backup and recovery (AISDLC-1131)

The memory folder is the agents' institutional memory and lives outside git, so it is copied, not committed.

- **Backup location:** `~/.ai-sdlc/memory-backups/<repo-id>/<YYYY-MM-DD>/`, where `<repo-id>` is the checkout folder name plus a short hash of its absolute path. `cli-hierarchy up` takes at most one copy per day and keeps the newest fourteen. Run it by hand with `cli-memory-dream backup`.
- **Warning:** `cli-hierarchy up` prints a one-line warning when `MEMORY.md` is missing from the memory folder and a backup exists. Restore with `cp -R <backup-dir>/. <memory-dir>/`.
- **Rebuild from transcripts:** `cli-memory-dream recover --from-transcripts <projects-dir>` (for example `~/.claude/projects`) replays `Write`, `Edit` and full `Read` records for `memory/*.md` files, oldest transcript first, into `<memory>.dream-<stamp>/` with a report. It lists the index entries that have no recoverable body. Review the folder, then `cli-memory-dream apply <folder>`; `cli-memory-dream undo` reverts. Live notes the transcripts lack are carried into the output; a transcript record replaces a live note of the same name, so review before applying.

Incident that motivated this: [2026-10-30 parent checkout deleted](incidents/2026-10-30-parent-checkout-deleted-by-pre-push-coverage-gate.md).
