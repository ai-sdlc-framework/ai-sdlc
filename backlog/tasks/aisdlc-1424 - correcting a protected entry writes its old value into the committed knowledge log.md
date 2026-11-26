---
id: AISDLC-1424
title: Correcting a protected entry writes its old value into the committed knowledge log
status: In Progress
priority: high
labels:
  - pipeline-cli
  - knowledge
  - security
  - bug
dependencies: []
references:
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/log.ts
  - pipeline-cli/src/knowledge/knowledge-store.ts
  - pipeline-cli/src/knowledge/human.test.ts
  - pipeline-cli/src/knowledge/principal.test.ts
  - pipeline-cli/src/cli/context.ts
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - .gitignore
---

## Description

**Five-step review (requirements first).**
1. Question: reported by the ai-sdlc-enterprise planner on 2026-11-26 as B1 against 0.45.0 (`human.js:37-50`, which is `correctEntry` in `pipeline-cli/src/knowledge/human.ts:42-64`). Verified on main. `cli-context correct` passes `ctx.verify.config`, the full loaded config, as the backend selection (`cli/context.ts:530-537`, `:83-92`). That object carries `protectedRoot`, and `correctEntry` opens the store on `{ ...sel, trackedRoot }` (`human.ts:50`), so `update(id)` searches the tracked root and then the protected root (`knowledge-store.ts:118-121`) and finds protected entries. `update` returns the fields as they were before the edit (`:183-194`), and `correctEntry` logs `detail: \`value changed from '${String(before.value)}'\`` (`human.ts:61`). The log is `knowledge-log.jsonl` next to the tracked root (`log.ts:11-14`, so `.ai-sdlc/knowledge-log.jsonl`), which is committed: `.gitignore:146-148` ignores only `.ai-sdlc/knowledge-protected/`. So correcting a protected entry copies the client value into a git-tracked file, against RFC-0053 OQ-1 ("never enter the repository or a PR body", `spec/rfcs/RFC-0053-just-in-time-context-engine.md:414`) and OQ-7 (`:472`). The push-time gate checks entry files, not the log. A registered non-files backend (DEC-0427) returns the same `before.value`, so the leak does not depend on the backend. A second defect sits in the same code: `human.ts:50` passes no `projectRoot` to `openKnowledgeStore`, and `FilesKnowledgeStore` resolves a relative `protectedRoot` with `resolve(p)` against the working directory (`knowledge-store.ts:106-110`), not `--project-dir` (the tracked root is passed absolute, so only the protected root is affected). Confirmed by reading. It also affects `confirmEntry`, `supersedeEntry` and `promoteEntry`.
2. Delete: the old value from the `corrected` event of a protected entry. The new value is not logged today, and that stays.
3. Simplify: decide from the `scope` of `before`, normalised as `exportableEntries` does (`data-room.ts:125-127`: trim, lower-case, equals `protected`). Planner decision: an event for a protected entry carries neither the value nor a hash of it (a short value can be brute-forced from its hash); tracked-entry events are unchanged. A marker such as `value corrected (protected; value not logged)` is enough; the event keeps `id`, `by` and `principal`. Also pass the project directory to `openKnowledgeStore` in the four human-edit functions so a relative `protectedRoot` resolves against `--project-dir`; if one of them does not open a store the same way, fix only those that do.
4. Accelerate: none.
5. Automate: a regression test that reads the raw log (AC #2) and a different-cwd test (AC #4).

**Out of scope.** Rewriting lines already in an adopter's log or in git history. The enterprise's interface change (named async write operations) is separate work.

## Acceptance Criteria
- [ ] #1 `correctEntry` on an entry whose `scope` is `protected` (any case or surrounding whitespace) appends a `corrected` event with neither the old value, the new value nor any hash of either, in `detail` or any other field.
- [ ] #2 A test in `human.test.ts` creates a protected entry with a distinctive value, runs `correctEntry` with the store opened as `cli/context.ts` opens it (full config), then reads the raw `knowledge-log.jsonl` and asserts neither value appears. It fails on main.
- [ ] #3 A correction of a tracked entry logs as before, and a test pins that. The `corrected` event still records `id`, `by` and `principal`; existing assertions in `human.test.ts` and `principal.test.ts` pass.
- [ ] #4 The human-edit functions resolve a relative `protectedRoot` against the project directory. A test runs `correctEntry` with a relative `protectedRoot` from a different working directory and finds the protected entry.
- [ ] #5 The PR body states that existing log lines are not rewritten and gives adopters a one-line check (for example, `grep '"event":"corrected"' .ai-sdlc/knowledge-log.jsonl`).
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
