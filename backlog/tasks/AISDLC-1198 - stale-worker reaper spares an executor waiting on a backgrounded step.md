---
id: AISDLC-1198
title: 'Stale-worker reaper spares an executor waiting on a backgrounded step'
status: In Progress
assignee: []
created_date: '2026-11-06'
labels:
  - hierarchy dispatch defect fix
dependencies: []
references:
  - pipeline-cli/src/hierarchy/stall.ts
priority: high
dispatchable: true
---

## Description

**Source.** Planner session 2026-11-06 08:35Z and 10:20Z; filed on operator go (decision rubric, same day).

When `next-step` verification runs longer than the 120-second Bash tool timeout, it is backgrounded and the executor session goes idle waiting for it. The heartbeat ages, and the stale-worker reaper (`hierarchy/stall.ts`) treats the executor as stalled and kills it mid-verification. Seen three times on 2026-11-06: AISDLC-1191 at 06-dev-done (08:15Z, load 30+) and AISDLC-1189 twice (the third at 09:30Z, load 102). Each kill cost a full round and counted toward the two-failure limit.

## Fix

**Five-step review (requirements first).** Requirement: the reaper kills only an executor that is doing nothing, never one whose child process is still working. Delete: nothing. Simplify: before reaping, check whether the executor has a live descendant process started by its current step (or a fresh step-progress stamp written by `next-step`), and if so extend rather than kill; record the reason in the stall event. Accelerate/automate: a test with a fake process table.

## Acceptance Criteria
- [ ] #1 An executor with an aged heartbeat but a live `next-step` descendant is not reaped; the stall event records why.
- [ ] #2 An executor with an aged heartbeat and no live work is still reaped as today.
- [ ] #3 Tests cover both cases.
