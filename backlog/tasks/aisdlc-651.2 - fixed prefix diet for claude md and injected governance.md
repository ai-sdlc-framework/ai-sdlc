---
id: AISDLC-651.2
title: >-
  RFC-0050 follow-up: cut the fixed prefix every session and subagent re-reads (CLAUDE.md, injected governance), measured by cli-usage context
status: To Do
assignee: []
created_date: '2026-10-01'
labels:
  - rfc-0050
  - usage-ledger
  - cost
  - docs
  - plugin
dependencies:
  - AISDLC-651
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - CLAUDE.md
  - ai-sdlc-plugin/hooks/session-start.js
  - ai-sdlc-plugin/hooks/subagent-start.js
  - ai-sdlc-plugin/agents/developer.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Operator-approved follow-up, 2026-10-01. Cache reads are nearly all token volume, and
every turn re-reads the fixed prefix, so the size of `CLAUDE.md` and of the text the
hooks inject is paid on every turn of every session and subagent.

## Evidence (operator machine, transcripts 2026-06-12 to 2026-10-01, 17,635 calls)
Main sessions account for 60 percent of cache-read tokens, the developer agent for 29
percent, all reviewers for 10 percent. A developer run starts at about 25k tokens of
context before reading any project file, because the hooks inject `CLAUDE.md`
(57k characters, about 14k tokens), the agent definition and the governance block on
every subagent start; over a median run of 62 turns that fixed prefix alone is about
1.5M tokens, a fifth of the median run. The developer tail is long: p90 is 30M
cache-read tokens and the worst run is 80M over 203 turns.

## Scope
1. **Measure first.** Record the current first-call context for a fresh main session
   and a fresh developer subagent with `cli-usage context` (RFC-0050), and the token
   size of each injected block (`CLAUDE.md`, the governance block from
   `session-start.js` and `subagent-start.js`, the developer agent definition). Commit
   the numbers in the PR body.
2. **`CLAUDE.md` restructure.** Keep in `CLAUDE.md` only what changes agent behaviour
   in every session: the rules (git flow, never-merge, attestation requirement, OQ
   prohibition, scope-creep rule, backlog workflow essentials, the pre-push chain as a
   list of names). Move reference material (hook internals and incident history,
   attestation algorithm details and lockstep notes, spawner catalogue, remote-agent
   tables, Pattern C routing internals, release-please mechanics) into the existing
   `docs/operations/` runbooks, each linked from a one-line pointer. Target: at most
   15k characters. No rule is dropped; each moved section keeps a pointer.
3. **Injected governance block.** Render the hard rules as a compact block (one line
   per rule) in both hooks; the explanatory prose lives in the runbook the block links.
4. **Developer agent definition.** Trim `ai-sdlc-plugin/agents/developer.md` to the
   contract and the hard rules; move worked examples and history to a linked doc.
5. **Measure after.** Repeat step 1 and commit the before and after numbers.

## Acceptance Criteria
- [ ] `CLAUDE.md` is at most 15k characters, and every section moved out has a one-line pointer to its new location in `docs/operations/`.
- [ ] A test asserts `CLAUDE.md` stays under the size budget so it does not regrow silently.
- [ ] Both hooks render the governance block in the compact form, with the existing hook tests updated and passing.
- [ ] The developer agent definition is reduced and still carries its full return contract and hard rules.
- [ ] Before and after first-call context for a main session and a developer subagent are recorded in the PR body, with the developer prefix reduced by at least half.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass, including `pnpm dark-code:check`.
<!-- SECTION:DESCRIPTION:END -->
