---
id: AISDLC-1145
title: 'Resync the standing-rules block in operator-dispatch.md and executor.md after the DEC-0167 fixture removal (lands PR #2235)'
status: To Do
assignee: []
created_date: '2026-10-31'
labels:
  - plugin
  - prompt-rules
  - main-health
dependencies: []
references:
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
  - ai-sdlc-plugin/commands/prompt-rules.test.mjs
  - ai-sdlc-plugin/scripts/sync-prompt-rules.mjs
  - ai-sdlc-plugin/hooks/lib/prompt-rules.js
priority: high
dispatchable: true
---

## Description

`main-health-monitor` is red on every main commit since af112057 (#2214, AISDLC-1135). That PR removed the DEC-0167 fixture `decision-opened` event, which was the only catalog event carrying the standing rule "Never relaunch a session for a stale node probe". The rendered `<!-- standing-rules:begin -->` block in `ai-sdlc-plugin/commands/operator-dispatch.md` and `ai-sdlc-plugin/commands/executor.md` still carries that line, so `ai-sdlc-plugin/commands/prompt-rules.test.mjs` ("carries the standing-rules block, in sync with the catalog") fails on main and in the Build & Test job of every open PR. No PR can reach a green `ai-sdlc/pr-ready` until main is green.

PR #2235 (branch `docs/standing-rules-sync`, commit d93cfe86) already holds the fix: the output of `ai-sdlc-plugin/scripts/sync-prompt-rules.mjs` on origin/main, no hand edits. The governance gate refuses it as a code PR without reviewer verdicts and a signed envelope, which is correct: command files are rendered prompts, not docs. This task runs the pipeline against that branch (fix-on-PR) so the reviewers and the signer attest it.

## Fix

**Five-step review (requirements first).** Requirement questioned: should a catalog change that drops a standing rule leave the rendered block stale until someone notices main is red? No: the requirement is that the rendered block always equals the catalog projection. Deletion: the stale rendered line (two files); nothing else is deleted. Simplified: the diff is exactly the sync script's output, so the review scope is the renderer's correctness, not prose. Accelerated: landing this unblocks every open PR's Build & Test. Automated (last, out of scope here): a follow-up may make the pre-push or the decisions-sync step run `sync-prompt-rules.mjs` whenever `.ai-sdlc/_decisions/**` changes, so a future catalog edit cannot leave main red; file it separately if the reviewers agree.

Work on the existing branch `docs/standing-rules-sync` (PR #2235). Do not re-derive the change by hand: run `node ai-sdlc-plugin/scripts/sync-prompt-rules.mjs` from the branch tip and confirm `git status` is clean, which proves the committed diff is the script output. Then run the full verification and let the pipeline review and sign.

## Acceptance Criteria

- [ ] AC-1: On the branch, `node ai-sdlc-plugin/scripts/sync-prompt-rules.mjs` leaves the tree unchanged.
- [ ] AC-2: `node --test ai-sdlc-plugin/commands/prompt-rules.test.mjs` passes (0 failures), including "commands/operator-dispatch.md carries the standing-rules block, in sync with the catalog" and the executor.md counterpart.
- [ ] AC-3: No other file changes; the PR diff stays the two command files.
- [ ] AC-4: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green, with `pnpm test` recorded as passed, not waived.
- [ ] AC-5: PR #2235 carries the signed v6 envelope with the full reviewer set and `ai-sdlc/pr-ready` is green.
