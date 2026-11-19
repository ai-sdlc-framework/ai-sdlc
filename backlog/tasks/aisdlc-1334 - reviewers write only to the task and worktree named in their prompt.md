---
id: AISDLC-1334
title: 'Reviewers write only to the task and worktree named in their prompt, and never into the parent checkout'
status: To Do
assignee: []
created_date: '2026-11-19'
labels:
  - bug
  - plugin
  - adopter
dependencies:
  - AISDLC-1333
references:
  - pipeline-cli/src/steps/07-build-review-prompts.ts
  - pipeline-cli/src/steps/07-build-review-prompts.test.ts
  - ai-sdlc-plugin/scripts/resolve-transcript-task-id.sh
  - scripts/resolve-transcript-task-id.sh
  - scripts/resolve-transcript-task-id.test.mjs
  - scripts/adopter-reviewer-attribution-smoke.test.mjs
  - ai-sdlc-plugin/agents/code-reviewer.md
  - ai-sdlc-plugin/agents/code-reviewer-codex.md
  - ai-sdlc-plugin/agents/test-reviewer.md
  - ai-sdlc-plugin/agents/test-reviewer-codex.md
  - ai-sdlc-plugin/agents/correctness-reviewer.md
  - ai-sdlc-plugin/agents/security-reviewer.md
  - ai-sdlc-plugin/agents/agents.test.mjs
priority: medium
dispatchable: true
dispatchableReason: 'Bounded to the review prompt header, one resolver script with its copy, six reviewer definitions and their tests.'
---

## Description

**Gap.** A reviewer subagent starts in the parent checkout, because the Agent tool has no working-directory setting. The review prompt names the task id but not the worktree, and the reviewer definitions look for `.active-task` in the current directory. The parent has none, so each reviewer invents an `UNKNOWN-<agent>-<time>` id and writes its transcript under the parent's `.ai-sdlc/transcripts/`. That dirties the parent and trips the clean-parent check. The security reviewer has no shell and uses the Write tool; the governance hook refuses that write, so it is refused every round.

What was seen in an adopter project on plugin 0.42.0 (reported 2026-11-18): the codex, code and test reviewers wrote into the parent's `.ai-sdlc/transcripts/`, which tripped the clean-parent check, and the security reviewer was refused by the hook in every round.

**Cause (read from the source).**

- `ai-sdlc-plugin/scripts/resolve-transcript-task-id.sh:57-62` reads `.active-task` from `$PWD` and then `AI_SDLC_ACTIVE_TASK_ID`. In a reviewer subagent `$PWD` is the parent.
- `ai-sdlc-plugin/scripts/resolve-transcript-task-id.sh:64-105` invents `UNKNOWN-<reviewer>-<time>-<random>-<pid>` and exits 0 when no source resolves.
- `ai-sdlc-plugin/agents/code-reviewer.md:75` and `:118` (the same lines exist in `test-reviewer.md`, `correctness-reviewer.md` and both codex definitions) fall back to the same invented id inline, then write to the relative path `.ai-sdlc/transcripts/<id>/` in the current directory.
- `ai-sdlc-plugin/agents/security-reviewer.md` (Step 0 under "Transcript Capture") tells the agent to read `.active-task`, invent `UNKNOWN-security-reviewer-<time>` when it is missing, and write the transcript with the Write tool. The persist script header states the hook always refuses Write under `.ai-sdlc/` (`ai-sdlc-plugin/scripts/persist-reviewer-artifacts.sh:5-12`).
- `pipeline-cli/src/steps/07-build-review-prompts.ts:468-486` builds the prompt with the task id in the first line and no worktree path. `PromptInputs` has no worktree field, although the caller holds `opts.worktreePath`.
- The coordinator already copies each reviewer's harness-captured transcript into the task worktree (`pipeline-cli/src/next-step/review-finalize.ts:384`, `persist-reviewer-artifacts.sh`), so a transcript written by the reviewer itself is not what the signing step reads. The staged review agents already write no transcript and say the coordinator persists it (`ai-sdlc-plugin/agents/agents.test.mjs:775-782`).
- Main has not changed any of this since 0.42.0: `ai-sdlc-plugin/scripts/resolve-transcript-task-id.sh` is byte-identical to the 0.42.0 copy.

**Shape.** The review prompt opens with an attribution block that carries the task id and the absolute worktree path. A Bash-capable reviewer reads both from the prompt, checks that the id has a safe shape and that `<worktree>/.active-task` holds the same id, and writes its transcript only under `<worktree>/.ai-sdlc/transcripts/<id>/`, by absolute path. It never writes a relative path in its working directory.

When the block is missing, the id is malformed, or the worktree check fails, the reviewer writes no transcript. It prints one line that names the cause and the fix, and still returns its verdict; the coordinator persists the transcript from the harness record. No `UNKNOWN-` id is ever created. The resolver script takes the id and worktree as arguments, wins over every other source, and exits non-zero with the reason when it has none, instead of inventing an id.

The security reviewer has no shell and its Write is refused under `.ai-sdlc/`, so it writes no transcript and says the coordinator persists it, as the staged review agents do.

**Control.** No control changes. The governance hook, the clean-parent check, the nonce binding and the coordinator-side persistence are untouched. A reviewer that cannot attribute its run now writes nothing instead of writing somewhere wrong.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: a reviewer must write its own transcript. The coordinator already persists the harness record, so the self-written copy is a convenience, not what signing reads. 2. Deleted: the invented `UNKNOWN-` id, in the script and in the five inline fallbacks, and the security reviewer's transcript steps. 3. Simplified or optimised: one source of truth for the id and the worktree, the prompt the coordinator built. 4. Accelerated: a bad or missing attribution stops the write in the first call with a reason, not after the clean-parent check fails. 5. Automated: tests assert the prompt carries the block, the script refuses without an id, and no reviewer definition contains an invented-id fallback.

- **Prompt block.** `buildPrompt` in `07-build-review-prompts.ts` adds an attribution block (task id, absolute worktree path, one sentence saying to write only under that path) near the top, from `opts.taskId` and `opts.worktreePath`.
- **Resolver.** `resolve-transcript-task-id.sh` accepts the id and the worktree path as arguments, validates the id shape, checks the worktree's `.active-task` matches, and prints the id. With neither arguments nor another source it prints a named reason to stderr and exits non-zero. The root copy under `scripts/` stays byte-identical.
- **Bash reviewers.** The five definitions read the block, call the resolver with it, and write to `<worktree>/.ai-sdlc/transcripts/<id>/` by absolute path. On a non-zero exit they print the reason, skip the transcript steps, and continue the review.
- **Security reviewer.** Replace the transcript capture section with the short coordinator-persists statement used by the staged review agents.
- **Tests.** Update the resolver test, the adopter smoke test and `agents.test.mjs` to the new contract; add the prompt test.

Out of scope: the developer agent definition and its push and pull request instructions (`ai-sdlc-plugin/agents/developer.md`, the developer prompt) and the push guard hook, which stays as it is; the `review-pr` command path; how the coordinator persists transcripts.

## Acceptance Criteria

- [ ] #1 A test builds the review prompts for a task with a worktree path and asserts every prompt contains the task id and the absolute worktree path in the attribution block.
- [ ] #2 A test runs the resolver with the id and worktree arguments from a directory that has no `.active-task`: it prints the id and exits 0, and creates no file in that directory.
- [ ] #3 A test runs the resolver with no arguments, no `.active-task` and no `AI_SDLC_ACTIVE_TASK_ID`: exit code is non-zero, stdout is empty, stderr names the cause and the fix, and no `UNKNOWN-` string is printed.
- [ ] #4 A test runs the resolver with a malformed id, and with a worktree whose `.active-task` names a different id: both exit non-zero with a reason.
- [ ] #5 A test asserts no file under `ai-sdlc-plugin/agents/` contains `UNKNOWN-` or a relative `.ai-sdlc/transcripts` write for a reviewer, and that `security-reviewer.md` contains no instruction to use the Write tool for a transcript.
- [ ] #6 `scripts/check-reviewer-script-bundle-parity.mjs` still passes (the two resolver copies are byte-identical).
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
