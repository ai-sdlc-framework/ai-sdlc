---
id: AISDLC-1436
title: Ingest a generated source of records from a JSON file
status: To Do
priority: low
labels:
  - pipeline-cli
  - knowledge
  - enterprise
dependencies: []
references:
  - pipeline-cli/src/knowledge/ingest-sources.ts
  - pipeline-cli/src/knowledge/ingest-sources.test.ts
  - pipeline-cli/src/knowledge/promote.ts
  - pipeline-cli/src/cli/context.ts
  - docs/operations/knowledge-store.md
---

## Description

**Five-step review (requirements first).**
1. Question: Requested by the enterprise planner (ai-sdlc-enterprise RFC-0002 remote knowledge backend, item 11) on 2026-11-26; operator ruled 2026-11-26 through the decision rubric (decision record filing; cite as 'the item-11 decision record'). Enterprise generators emit knowledge records (ai-sdlc-enterprise RFC-0002 D7) with no ingest path. Not an enterprise-gated feature: this source reads a file the operator names and is clearly outside the enterprise gate; it must be labelled so in the help text and docs.
2. Delete: nothing.
3. Simplify: a sixth source `generated` (`INGEST_SOURCES`, `ingest-sources.ts:19`; `ADAPTERS`, `:215`). Minimal input option: the existing `ingest` command (`cli/context.ts:391`) gains `--file <path>`, carried as a new `IngestOptions.generatedFile` (as `events-file`/`eventsFile` is, `:46`, `:169`); no config key. A missing `--file` with `--source generated` is an error. The file is a JSON array of `{id, trunk, type, value, source, proof}`. Each valid record becomes a `Candidate` and is written by the existing `ingestSource` loop, idempotent by `contentHash` (`:256`). `candidateFields` hardcodes authority `specialist` (`:232`); for this source authority is `specialist` only when `proof` is `allowlisted-command:<id>::<expected>` (`promote.ts:149-156`, `verifyCommand` `:123`) with `<id>` present in `config.allowlistedCommands` (the allowlist check only, the command is not run at ingest), otherwise `inferred`. Invalid records (missing or non-string field, entry fails `validateEntryFields`) are reported on stderr with their index and skipped; the run does not throw, unlike the other sources. Provisional: Product (RFC-0053 signer) reviews the RFC-0053 amendment; the change is additive to the DEC-0427 seam. Write interface shape (OQ-A: async writes) is undecided; this task changes no `put`/`update` signature and does not make any write sync or async.
4. Accelerate: none.
5. Automate: tests (AC #1 to #5).

## Acceptance Criteria
- [ ] #1 `generated` is in `INGEST_SOURCES` and `ADAPTERS`; `cli-context ingest --source generated --file <json>` writes the records; missing `--file` is a clear error.
- [ ] #2 Re-ingesting the same file reports `unchanged` (contentHash); a changed value writes `supersedes` as the other sources do.
- [ ] #3 A record with an allowlisted `allowlisted-command:` proof is `specialist`; any other proof (path, test-id, free text, command id absent from the allowlist) is `inferred`.
- [ ] #4 Invalid records are reported and skipped; valid ones in the same file are still written.
- [ ] #5 Help text and `docs/operations/knowledge-store.md` label the source as outside the enterprise gate; no write-signature change.
- [ ] #6 Targeted `pnpm --filter @ai-sdlc/pipeline-cli exec vitest run src/knowledge/ingest-sources.test.ts` and `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
