---
id: AISDLC-1256
title: 'The webhook forwarder recovers from `launchctl bootstrap` error 5 (Input/output error) by bootout-then-bootstrap and reports an unpersisted receiver in status'
status: In Progress
assignee: []
created_date: '2026-11-09'
labels:
  - pipeline-cli
  - hierarchy
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/webhook-forwarder.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - docs/operations/cli-hierarchy.md
priority: medium
dispatchable: true
dispatchableReason: 'DRAFT, awaiting operator go (peer report from ai-sdlc-io-planner 2026-11-09, plugin cache 0.42.0). `webhook up --feed gh-forward` printed "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error" so the io receiver runs unpersisted and dies at logout.'
---

## Description

**Gap.** `webhook-forwarder.ts` throws on any non-zero `launchctl bootstrap`. launchd returns `5: Input/output error` when a job with the same label is already loaded (often a stale entry from a previous session or crash) or when the plist path changed under the same label. The command then leaves the receiver running in the foreground session only, and `webhook status` says nothing about persistence, so the operator learns about it at the next logout.

**Shape.** On bootstrap error 5 the forwarder runs `launchctl bootout gui/<uid>/<label>` and retries bootstrap once; if that fails it prints the launchctl stderr, the plist path and the manual commands. `webhook status` gains a `persisted: launchd <label>` / `persisted: no (<reason>)` line from `launchctl print gui/<uid>/<label>`. The label includes the per-project port or project name so two projects never collide (depends on the port resolution of AISDLC-1254 only for the label text; may land first with the board-dir hash).

## Fix

**Five-step review (requirements first).**
1. Requirement questioned: the receiver must survive logout, which is why launchd is used at all. Stands.
2. Deleted: nothing.
3. Simplified: one retry path, one status line.
4. Accelerated: no operator debugging of launchctl error codes.
5. Automated: status shows persistence; tests fake launchctl.

## Acceptance Criteria

- [ ] AC-1: on `launchctl bootstrap` exit with stderr matching `Bootstrap failed: 5`, the forwarder runs `launchctl bootout gui/<uid>/<label>` and retries once; test with a fake runner returning error 5 then success.
- [ ] AC-2: a second failure prints the full launchctl stderr, the plist path and the two manual commands, and `webhook up` exits non-zero while leaving the foreground receiver running; test.
- [ ] AC-3: the launchd label is per project (`com.ai-sdlc.webhook.<project-slug>`), derived from the board dir; two board dirs give two labels; test.
- [ ] AC-4: `webhook status` prints a `persisted:` line based on `launchctl print`; test.
- [ ] AC-5: `docs/operations/cli-hierarchy.md` documents the error and the recovery.
- [ ] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
