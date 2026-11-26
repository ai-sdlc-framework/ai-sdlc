---
id: AISDLC-1420
title: Record the acting principal on every knowledge-log event
status: In Progress
priority: high
labels:
  - pipeline-cli
  - knowledge
  - audit
  - enterprise
dependencies: []
references:
  - spec/rfcs/RFC-0053-just-in-time-context-engine.md
  - pipeline-cli/src/knowledge/log.ts
  - pipeline-cli/src/knowledge/promote.ts
  - pipeline-cli/src/knowledge/human.ts
  - pipeline-cli/src/knowledge/ingest-sources.ts
  - pipeline-cli/src/cli/context.ts
  - pipeline-cli/src/cli/capture.ts
  - pipeline-cli/src/hierarchy/caller-identity.ts
---

## Description

**Five-step review (requirements first).**
1. Question: the enterprise RFC-0002 (ENT-15/ENT-16) needs to know **who** acted on each knowledge-log event, not only whether it was a human or an agent. Today `KnowledgeEvent.by` (`log.ts:19-28`) holds only `Role = 'agent' | 'human'` (`promote.ts:190`), which `resolveRole()` computes (`cli/context.ts:91-96`). Two events record no actor at all: `reobserved` (`promote.ts:265`) and the `superseded` event from ingest (`ingest-sources.ts:255`). This adds an audit field. It loosens no control: `by` and every authority rule stay exactly as they are.
2. Delete: none. `by` keeps its meaning because `auditLines` (`log.ts:57-64`) and the promotion rules read it.
3. Simplify: add one optional field, `principal?: string`, to `KnowledgeEvent`. One resolver, `resolveKnowledgePrincipal(env, deps)`, reuses the existing sources and adds no new identity mechanism:
   - human: `human:<git config user.email>`, falling back to `$USER`, following `resolveOperatorIdentityReal` (`cli/capture.ts:366-375`). Extract it to a shared helper rather than copying it.
   - agent in a roster session: `agent:<session name>` from `resolveCaller` (`hierarchy/caller-identity.ts:63-81`).
   - agent outside the roster with `AI_SDLC_ACTIVE_TASK_ID`: `agent:task:<id>`.
   - otherwise: `agent:unknown`. The resolver never throws, and the engine stays fail-open.
4. Accelerate: none.
5. Automate: none added.

**Scope.**
- Every call to `appendKnowledgeEvent` passes `principal`:
  - `promote.ts`: :237, :265, :280
  - `human.ts`: :30, :54, :85
  - `ingest-sources.ts`: :255
- `reobserved` and the ingest `superseded` event also gain `by`.
- `cli-context audit` prints `principal=` next to `by=`.

**Not in scope.**
- Adding events for the writers that log nothing today (ingest-memory, `captureFact`, ingest-sections). If the enterprise side needs "created" events, raise that as a separate ask.
- Any change to who may promote.

**Note.** `knowledge-log.jsonl` sits next to the tracked root and is committed. A human principal therefore writes the git `user.email` into a tracked file. Every commit already carries the same value, so this exposes nothing new.

## Acceptance Criteria
- [ ] #1 `KnowledgeEvent` has `principal?: string`. Every event the framework writes carries a non-empty `principal` and a `by`. A test enumerates all seven emit sites.
- [ ] #2 The resolver is covered by unit tests: human with git email, human with no git email (falls back to `$USER`), roster agent, task agent, and unknown agent. It is injected so tests never spawn `git` or read the process table.
- [ ] #3 Older log lines without `principal` still parse. `readKnowledgeLog` and `auditLines` accept them, and a test covers this.
- [ ] #4 `resolveOperatorIdentityReal` is shared and not duplicated. `capture.ts` behaviour and its tests are unchanged.
- [ ] #5 `pnpm dark-code:check` passes with no growth in the baseline. `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
