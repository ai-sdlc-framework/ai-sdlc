---
id: AISDLC-1324
title: 'Promote RFC-0054 and RFC-0059 to Implemented'
status: To Do
assignee: []
created_date: '2026-11-18'
labels:
  - docs
  - rfc
dependencies:
  - AISDLC-1316
  - AISDLC-1318
references:
  - spec/rfcs/README.md
  - scripts/check-rfc-lifecycle-transitions.mjs
  - scripts/check-rfc-docs.mjs
  - scripts/check-rfc-registry.mjs
  - reference/src/capabilities/registry.ts
  - .ai-sdlc/dark-code-baseline.json
  - .claude/rules/rfcs.md
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - spec/rfcs/RFC-0059-ephemeral-executors.md
  - docs/concepts/session-hierarchy.md
  - docs/operations/cli-hierarchy.md
assumes:
  - RFC-0012
  - RFC-0035
  - RFC-0041
  - RFC-0042
  - RFC-0051
  - RFC-0054
  - RFC-0058
  - RFC-0059
  - RFC-0061
priority: medium
dispatchable: true
dispatchableReason: 'Operator order of 2026-11-18: every RFC is closed out, after the planner''s audit found built RFCs still labelled Signed Off. The two dependencies are tasks, not decisions: AISDLC-1318 writes the concept page that gives RFC-0054 a published page, and AISDLC-1316 adds the `concept` value of `requiresDocs` and the published-page rule that both RFCs must satisfy once `Implemented`. Frontmatter, plan tables and the two open tasks were read on `main` at 0c21bc11f on 2026-11-18.'
---

## Description

**Gap.** RFC-0054 (PR lifecycle as event-driven dispatch) and RFC-0059 (ephemeral executors) say `Signed Off` while their code runs by default: the reconciler writes `landing/<pr>.json` and acts per state, and `cli-hierarchy` spawns one executor per eligible claim and downs it on the verdict (ephemeral executors are the default; `AI_SDLC_EPHEMERAL_EXECUTORS=0` keeps standing ones). Both declare `requiresDocs: []` and have no `runtimeEvidence`, so neither can pass `Signed Off` to `Implemented` yet, and once the published-page rule of AISDLC-1316 is on `main`, neither may be `Implemented` without a published page.

**Why the two dependencies.**

- AISDLC-1318 (open) writes the pr-lifecycle concept page (file `pr-lifecycle.md` in the concepts docs folder) for RFC-0054. It states it will not edit either RFC, so RFC-0054's `requiresDocs` is left for this task.
- AISDLC-1316 (open) adds the value `concept` to `requiresDocs` (mapped to `docs/concepts/`) and the rule that every `Implemented` RFC names a published surface in `requiresDocs`, or is exempt, or is in its baseline. A baseline entry cannot be added by this task: the baseline only shrinks. So both RFCs must name `concept` and cite a real page. For RFC-0059 the page already exists: `docs/concepts/session-hierarchy.md` cites RFC-0059 in its status line.

**How this differs from other open tasks.** AISDLC-1323 promotes seven other RFCs and must land before AISDLC-1316; this task lands after it. AISDLC-1322 corrects other labels. AISDLC-1317 aligns Registry cells and body status lines. AISDLC-1318 writes the page and touches no RFC.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: is a built RFC promoted on sight? No: the lifecycle gate needs `runtimeEvidence`, the docs gate needs a published page, and a part of the design that is not built is not hidden by a label. 2. Deleted: nothing. 3. Simplified or optimised: the same five steps as AISDLC-1323, applied to two files. 4. Accelerated: not applicable. 5. Automated: `scripts/check-rfc-lifecycle-transitions.mjs`, `scripts/check-rfc-docs.mjs` and `pnpm rfc:check` check each step.

- **Start check.** Both dependencies must be on `main`: the `pr-lifecycle.md` concept page written by AISDLC-1318 exists in the concepts docs folder, and `scripts/check-rfc-docs.mjs` maps a `concept` surface to `docs/concepts/`. If either is missing, stop and report; change nothing.
- **Rules that apply** (`.claude/rules/rfcs.md`, `spec/rfcs/README.md`): no operator override marker; the ladder is not skipped; no Open Question is resolved and no `**Resolution:**` or `RESOLVED:` marker is added; `CHANGELOG.md` is never edited.
- **Per RFC.** (1) List the optional capabilities the RFC specifies (RFC-0059 specifies none that is model-backed; its fallback is the standing-executor mode behind `AI_SDLC_EPHEMERAL_EXECUTORS=0`, which is a kept option, not a degraded path; RFC-0054's webhook receiver is a fast path in front of a poll reconciler, so read what the RFC calls optional). Use only ids in `reference/src/capabilities/registry.ts`; an RFC with none declares `runtimeEvidence: []`. (2) Check each is live in this repository (evidence a reader can open; not shadow, not behind an off flag, not a module with no non-test importer per `node scripts/check-dark-code.mjs`). (3) Write `runtimeEvidence` with entries `live` or `not-applicable` only, `date: '2026-11-18'`. (4) Set `requiresDocs: [concept]`, and add the `pr-lifecycle.md` concept page from AISDLC-1318 (RFC-0054) or `docs/concepts/session-hierarchy.md` (RFC-0059) only by making sure the page cites the RFC id as text (both do or will); do not edit the pages. (5) Tick no box that is not done; set `lifecycle: Implemented`, `status: Implemented`, the body `**Lifecycle:**` line and the start of the `**Status:**` line (former text after "Previously:"); run `node scripts/check-rfc-registry.mjs --write` and fix a Notes cell that states a pending step.
- **RFC-0054: a designed part that is not built.** `docs/operations/cli-hierarchy.md` (the PR-state table, near the `behind-or-dirty` row) says the `land-prep` runner (RFC-0054 OQ-7, AISDLC-881) "is not built yet and is served by `reenter`", although the task AISDLC-881 is in `backlog/completed/` with `status: Done`: check `pipeline-cli/src/hierarchy/reconcile.ts` (`TASK_ACTIONS`) and say which is true in the PR body. The RFC also carries the note "Amended by RFC-0061" (the `content-hash-mismatch` state and re-sign path are gone). Promote RFC-0054 only if the RFC text or a decision record on `main` already records `land-prep` as deferred or replaced. If neither exists, leave RFC-0054 at `Signed Off`, change nothing in its file, and put in the PR body the RFC section, the doc line and the two ways out (record the deferral by decision, or build the runner) for the planner; do not choose between them. RFC-0059 does not depend on this.
- **RFC-0059.** Its plan table lists AISDLC-1073 to AISDLC-1076, all in `backlog/completed/`. Verify in the source that each row is built (`pipeline-cli/src/hierarchy/spawn.ts`, `ephemeral-tick.ts`, `dispatch-loop.ts`) before writing evidence. The Sign-Off table has Product and Design pending; the lifecycle is already `Signed Off` and the gate does not read the table, so list it in the PR body as an observation for the operator.
- **Stop rule.** If a promotion would need a code change, a new page, an exemption or the operator override, leave that RFC out and report it. One RFC promoted and one left out is a valid result.

Out of scope: writing or editing any concept page (AISDLC-1318); the docs gate itself (AISDLC-1316); the `land-prep` runner; RFC-0058 (a separate trace); other RFCs.

## Acceptance Criteria

- [ ] #1 For each RFC promoted, `lifecycle: Implemented`, `status: Implemented`, `runtimeEvidence` with only `live` or `not-applicable` entries (or `[]`) and `requiresDocs: [concept]` are set, and `node scripts/check-rfc-lifecycle-transitions.mjs` and `node scripts/check-rfc-docs.mjs` exit 0 with no operator override marker in the diff.
- [ ] #2 The page named in `requiresDocs` exists under `docs/concepts/` and contains the RFC id as text; no file under `docs/` is in the diff.
- [ ] #3 RFC-0054 is promoted only when the RFC text or a decision record on `main` already records `land-prep` as deferred or replaced; otherwise its file is unchanged and the PR body names the section, the doc line and the two ways out.
- [ ] #4 `node scripts/check-rfc-registry.mjs` and `node scripts/check-dark-code.mjs` exit 0; `pnpm rfc:check` and `pnpm rfc:test` pass; the Registry rows match the files.
- [ ] #5 The diff adds no line containing `**Resolution:**` or `RESOLVED:`, changes no text inside an Open Questions section, does not touch `CHANGELOG.md`, and has at most 15 files (expected: two RFC files and the README).
- [ ] #6 The PR body lists the evidence behind each `live` entry and the Product and Design sign-off observation for RFC-0059.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
