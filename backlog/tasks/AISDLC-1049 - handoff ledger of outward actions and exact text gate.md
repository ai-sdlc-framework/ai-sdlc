---
id: AISDLC-1049
title: 'Handoff keeps a machine-written ledger of outward actions, and the planner gates every public post on its exact text'
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - hierarchy
  - pipeline-cli
  - plugin
dependencies: []
references:
  - pipeline-cli/src/hierarchy/handoff.ts
  - pipeline-cli/src/hierarchy/handoff.test.ts
  - ai-sdlc-plugin/commands/planner.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
---

## Description

`cli-hierarchy handoff write` regenerates the handoff block from board and catalog state. Anything the CLI cannot see, such as a GitHub issue filed on an external repository, a comment posted, or a PR opened by hand, survives a clear only if the session typed it into the prose below the markers. On 2026-10-22 the ai-sdlc-io planner recorded a filing in prose, the Stop hook saved a stale progress line (AISDLC-1048), and the next session trusted the stale line over the prose and filed an unwanted second issue (104458 in the upstream claude-code repository, since closed). Prose is skimmed; data is read.

Two changes:

1. **Ledger.** Add `cli-hierarchy handoff note --role <role> --kind filed|commented|opened|closed|sent --url <url> [--summary <text>] --board-dir <dir>`. It appends one structured line to a per-role ledger file next to the handoff (for example `.claude/memory/handoff_ledger_<role>.jsonl`) with a UTC timestamp, and `handoff write` renders the last 20 ledger lines inside the generated block under `## Outward actions`, newest first. `handoff read` prints them with the block. The ledger is append-only and is never rewritten by `handoff write`.
2. **Exact-text gate.** In `planner.md` (and the dispatch command where it relays), rule: before any action that posts outside the repository (an issue, a comment, a PR body, a message to another project's session), the session shows the operator the exact title and first line it will post and gets a go on that text, never on an option label or a summary; after the post it records the URL with `handoff note` in the same turn. A multi-select option label is not consent for a public post.

**Five-step review (requirements first).** Requirement questioned: could the existing prose notes do this if the planner were simply told to keep them? No: the failure was a session ranking a saved line above correct prose, so the fix must make outward actions data the CLI renders, not more prose. Deletion: nothing to delete; the prose section stays for everything that is not an outward action. Simplified: one append-only JSONL file and one rendered list, no new store. Accelerated: `handoff note` is one command in the same turn as the post, no separate bookkeeping step. Automated last: `handoff write` renders the ledger by itself, so nothing depends on a session remembering to copy it.

## Acceptance Criteria

- [ ] `cli-hierarchy handoff note` appends a timestamped JSON line with role, kind, url and optional summary; invalid `--kind` is refused with the allowed list.
- [ ] `handoff write` renders the newest 20 ledger lines inside the generated block under `## Outward actions`; `handoff read` shows them; a rewrite never drops or reorders ledger lines.
- [ ] Tests cover note, render, and the append-only guarantee.
- [ ] `planner.md` and `operator-dispatch.md` carry the exact-text gate and the same-turn `handoff note` rule; `docs/operations/cli-hierarchy.md` documents the subcommand.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; `ai-sdlc/pr-ready` green.
