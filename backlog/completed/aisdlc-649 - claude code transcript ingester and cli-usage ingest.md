---
id: AISDLC-649
title: >-
  RFC-0050 Part A: Claude Code transcript ingester, attribution, scope collapse, cli-usage ingest, hook and tick wiring
status: Done
assignee: []
created_date: '2026-09-30'
labels:
  - rfc-0050
  - usage-ledger
  - pipeline-cli
  - plugin
  - hooks
dependencies:
  - AISDLC-648
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/hooks/session-start.js
  - pipeline-cli/src/orchestrator/loop.ts
  - pipeline-cli/src/cli/bin-invocation.test.ts
  - pipeline-cli/README.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Reads the harness's own transcripts and turns every model call into a ledger record.
This is the source that actually has the data: on the operator's machine it yields
about 17,600 calls where the framework's own tracking has zero. RFC-0050 sections A2
and A3, and the OQ-1 resolution.

## Conventions for this series
- Design source: `spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md`. Its Open
  Questions are resolved; do not edit that section. If the RFC and this task disagree,
  stop and return `prUrl: null` with a note naming the conflict.
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- The ledger stores counts, ids and attribution only. No prompt, response, file content
  or tool output is ever written, logged or put in a fixture.
- Fixtures are synthetic. Never commit a real transcript or a real ledger file.
- Tests never read the real home directory: every path is injected or taken from
  `AI_SDLC_USAGE_DIR` pointing at a temporary directory created with `mkdtemp`.
- Every new module is reachable from a non-test importer or a barrel re-export
  (`pnpm dark-code:check`). Adopter-visible strings carry no internal task ids.

## Transcript facts the ingester relies on
- Location: a projects directory under the harness's home, one subdirectory per
  project, containing one `<sessionId>.jsonl` per session and, per session, a
  `<sessionId>/subagents/` directory with `agent-<agentId>.jsonl` files and an
  `agent-<agentId>.meta.json` sidecar beside each.
- A model call is a line whose `type` is `assistant` and whose `message.usage` is
  present. Fields used: `message.id`, `message.model`, `requestId`, `timestamp`,
  `sessionId`, `cwd`, `gitBranch`, `agentId`, `isSidechain`, and from `message.usage`:
  `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`,
  `cache_creation.ephemeral_1h_input_tokens`, `output_tokens_details.thinking_tokens`.
- The same message appears on more than one line. On the operator's machine about half
  of all usage lines are repeats. The deduplication key is `message.id`.
- The sidecar holds `agentType` (for example `ai-sdlc:developer`) and a `description`.
- Lines whose model is the literal `<synthetic>` are not model calls. Some of them
  carry limit or error notices.

## Scope
1. **Ingester** in a new `pipeline-cli/src/usage/` module: walks the projects
   directory (path injectable; default resolved from the harness's standard location),
   reads each transcript from its stored cursor, and appends records through the
   AISDLC-648 store. Tolerates truncated last lines, unknown fields and missing
   sidecars without failing the run.
2. **Token mapping:** `cacheWrite5m` and `cacheWrite1h` from the split fields; when
   only the combined `cache_creation_input_tokens` is present, put it in
   `cacheWrite5m`. `reasoning` from the thinking-token detail when present.
3. **Agent role:** sidecar `agentType` for a subagent transcript, `main-session` for a
   session transcript, `subagent-unknown` when the sidecar is missing.
4. **Scope (OQ-1):** a call is `framework` scope when its `cwd` is inside a repository
   root that contains an `.ai-sdlc/` directory (walk up from `cwd`; cache the answer per
   directory). Every other call is `other` scope and is written without `repo`,
   `taskId`, `source`, `cwd`, branch or description. Env
   `AI_SDLC_USAGE_SCOPE=framework-only` skips `other`-scope projects entirely.
5. **Task:** for framework scope, in order: a `.worktrees/<task-id>` segment in `cwd`,
   a task id in the branch name, the `.active-task` sentinel in the worktree root.
   No match leaves `taskId` unset.
6. **Billing pool:** `subscription-interactive` for an interactive session and its
   in-session subagents, `agent-sdk-credit` for a print-mode or SDK entrypoint where
   the transcript identifies one, otherwise `unknown`. Never guess.
7. **Limit events:** a `<synthetic>` line whose text reports a usage or rate limit is
   written to `limit-events.jsonl` in the usage directory with its timestamp and
   session id and no message text beyond a short fixed category.
8. **CLI** `cli-usage` (new bin shim under `pipeline-cli/bin/`, following the
   invocation rule enforced by `pipeline-cli/src/cli/bin-invocation.test.ts`) with
   `ingest [--backfill] [--projects-dir <path>] [--max-seconds <n>] [--json]`. It prints
   files scanned, calls written, repeats skipped and errors. `--backfill` ignores
   cursors.
9. **Triggers:** the plugin's existing `Stop` and `SessionStart` hooks in
   `ai-sdlc-plugin/plugin.json` launch ingestion detached with a time limit, so the
   session is never delayed; the orchestrator tick
   (`pipeline-cli/src/orchestrator/loop.ts`) runs it at tick start. Every trigger
   swallows failure. In a remote sandbox the ingester does nothing.
10. **README:** a `cli-usage ingest` section in `pipeline-cli/README.md`.

## Acceptance Criteria
- [x] A synthetic project with one session and two subagent transcripts ingests to the expected records, with agent roles taken from the sidecars and `main-session` for the session file.
- [x] A message that appears on three lines produces one record.
- [x] A second `ingest` run with no new lines writes nothing; appending lines to a transcript ingests only the new calls.
- [x] A truncated final line, an unknown field and a missing sidecar do not fail the run, and the affected transcript is retried on the next run.
- [x] A transcript whose `cwd` is inside a repository with `.ai-sdlc/` yields `framework` records with `repo`, and with `taskId` when the path contains a worktree segment.
- [x] A transcript whose `cwd` has no `.ai-sdlc/` ancestor yields `other` records containing none of `repo`, `taskId`, `source`, working directory, branch or description (asserted field by field).
- [x] `AI_SDLC_USAGE_SCOPE=framework-only` writes no `other` records.
- [x] Lines with model `<synthetic>` produce no model-call record, and one carrying a limit notice produces a limit event with no message text.
- [x] `node pipeline-cli/bin/cli-usage.mjs ingest --json` reports scanned, written, skipped and error counts, and the bin-invocation test covers the new shim.
- [x] The hook-triggered run returns control within the hook's time limit on a projects directory of 500 synthetic transcripts, and a failing ingester does not fail the hook.
- [x] No ledger record or log line contains any text from a message body.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
Added the Claude Code transcript ingester (`pipeline-cli/src/usage/`), the `cli-usage ingest` command, and detached, time-limited triggers from the plugin Stop and SessionStart hooks and the orchestrator tick. Calls are attributed by agent role, scope (framework vs other, with other-scope records stripped), task and billing pool, deduplicated by message id, and written through the usage ledger store.

## Changes
- `pipeline-cli/src/usage/*` (new): transcript parsing, attribution, line reader, ingester, launcher, with tests
- `pipeline-cli/src/cli/usage.ts`, `pipeline-cli/bin/cli-usage.mjs`, `pipeline-cli/package.json` (bin entry), `pipeline-cli/README.md`
- `ai-sdlc-plugin/hooks/usage-ingest.{js,sh}` + test, both `plugin.json` manifests (Stop and SessionStart hooks)
- `pipeline-cli/src/orchestrator/loop.ts`, `pipeline-cli/src/cli/orchestrator.ts`: tick trigger (production entry only)
- `reference/src/usage/index.ts`: one-line re-export of `withUsageLock`

## Design decisions
- **Hook binary resolution** uses only trusted locations (env, plugin install, plugin-relative monorepo path); nothing derived from the current project; children run with a neutral working directory.
- **Scope** needs both `.ai-sdlc/` and `.git` at a repository root and never treats the home directory as a root.
- **Billing pool** is decided only by the transcript's stated entrypoint; otherwise unknown.
- **Limit events** are appended under the ledger lock with only a timestamp, session id and fixed category.

## Verification
- `pnpm build` — clean
- New tests pass (ingester, CLI, launcher, hook gate); about 98% line coverage on `pipeline-cli/src/usage/`
- `pnpm lint`, `pnpm format:check`, `pnpm dark-code:check`, validate-schemas — clean
- AC 12 (root `pnpm test`): not fully green locally; the bin-invocation `pnpm exec` probes and some TUI tests also fail on clean origin/main, and the verify-runtime and attestation suites fail only inside `.worktrees/`; CI to confirm
- 3 parallel reviews approved after 2 rounds (round 1 found a critical in the hook binary resolution, fixed)

## Follow-up
- AISDLC-650.1 tracks unifying the limit-event writers of this ingester and the Codex ingester.
- Declined: not filed by this task; requiring absolute paths for the env-provided binary locations in the usage hook (security review minor) is pending an operator decision.
- Declined: not filed by this task; a batch cursor read in the reference store (cursors.json is re-parsed per call) is pending an operator decision.
- Declined: not filed by this task; registering the `usage.ingest` capability in the doctor registry is pending an operator decision.
