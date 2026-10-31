---
id: AISDLC-1133
title: 'SessionEnd hook archives each session transcript into .claude/transcripts (lands PR #2201)'
status: In Progress
assignee: []
created_date: '2026-10-31'
labels:
  - hooks
  - context
  - handoff
dependencies: []
references:
  - .claude/settings.json
  - .claude/hooks/collect-tool-sequence.sh
  - .gitignore
priority: high
dispatchable: true
---

## Description

Claude Code keeps session transcripts under `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl`, outside the project. When a session ends, the handoff written from board state is often incomplete and the next session cannot look at what happened. PR #2201 adds a `SessionEnd` hook, `.claude/hooks/archive-transcript.sh`, that copies the transcript (and subagent transcripts) into the gitignored `.claude/transcripts/` directory so the history lives with the project. The branch was opened by hand, so it has no task id and no attestation envelope and no source kind can land it. This task lands that PR through the pipeline: review, sign, lease-push to the same branch.

**Five-step review (requirements first).**
1. Requirement questioned: could `CLAUDE_CONFIG_DIR` point the whole config dir into the repo instead? No: it drags credentials and plugins along and is set only from the shell, never from project settings. A copy on SessionEnd is the smallest change.
2. Delete: nothing.
3. Simplify: one bash script, `jq` for the payload, `cp -f`, every error exits 0.
4. Accelerate: a single file copy per session end.
5. Automate: registered in the committed `.claude/settings.json`, so every session in this repo archives without anyone remembering.

Velocity impact: positive (feeds AISDLC-1132, transcript recall in the handoff).

## Acceptance Criteria

- [ ] AC-1: `.claude/hooks/archive-transcript.sh` reads the SessionEnd payload (`session_id`, `transcript_path`, `reason`) and copies the transcript to `.claude/transcripts/<utc-stamp>-<reason>-<session-id>.jsonl`; subagent transcripts (`<dir>/<session-id>/subagents/*.jsonl`) go to `.claude/transcripts/<session-id>-subagents/`; a line is appended to `.claude/transcripts/.log`.
- [ ] AC-2: Every failure path exits 0 (empty payload, missing file, unwritable directory); the hook never fails a session.
- [ ] AC-3: `.claude/settings.json` registers the hook under `SessionEnd` with a 30s timeout; `.gitignore` ignores `.claude/transcripts/`.
- [ ] AC-4: A `node --test` file under `.claude/hooks/` (same convention as `collect-tool-sequence`) covers: a valid payload copies the file and writes the log line; a missing transcript path exits 0 with no copy; subagent transcripts are copied when present.
- [ ] AC-5: `docs/operations/` gains a short section naming the archive directory, the file naming scheme and the untrusted-plaintext caveat, linked from the cli-hierarchy handoff docs.

## Notes

Origin: operator request 2026-10-31. Lands on PR #2201 (`feat/session-end-transcript-archive`) via `fixesPr`; AISDLC-1132 builds on it. The hook is also active locally through `settings.local.json` on the operator machine until this lands.
