---
id: AISDLC-1446
title: "Every question answered without the operator is shown on screen with a one-press veto"
status: To Do
priority: medium
labels:
  - governance
  - judgment
  - rfc-0049
dependencies:
  - AISDLC-1443
  - AISDLC-1444
assumes: [RFC-0049]
references:
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - pipeline-cli/src/decisions
  - pipeline-cli/src/hierarchy
  - docs/operations/decision-authority.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator 2026-11-26: questions answered without the operator (AISDLC-1443 checks 2 and 3 in enforce; later in-place answers by `operator-question.auto-answer`) must be visible so the operator can veto them, and rubber stamps must not accumulate unseen. RFC-0049 OQ-9 (DEC-0437, provisional until Product and Design sign the amendment) settled the shape: answers act at once as reversible decision records, and visibility is a delivered report the operator goes through in one sitting, not a live per-question surface ("a delay of waiting for an answer could be more costly than a wrong answer").
2. Delete: the earlier draft of this task (a live Claude Code mod with a prompt row, pane, toasts and a 30-second liveness heartbeat) is dropped. OQ-9 replaced "veto surface loaded in the session" with "a digest was delivered in the last 26 hours".
3. Simplify: reuse `cli-decisions operator-digest`, which already lists decisions since the last `--mark`. Add a producer, a renderer and a channel; no new store.
4. Accelerate: the producer runs on the dispatch tick, which already runs on a schedule and knows the 5-hour budget window (`budget.ts`, `fiveHour.resetsAt`).
5. Automate: delivery writes a record the judgment runtime reads (AISDLC-1445 AC #4), so in-place answering stops by itself when delivery stops.

**Delivery rule (OQ-9).** At the end of each 5-hour budget window, deliver when at least N entries have built up since the last delivery (`N` from config, default 10); otherwise deliver once a day at a configurable time. An entry is every decision settled without the operator: auto-answers (`--by judgment:*`) and records filed by a session under AISDLC-1443 check 3. An empty digest is not delivered.

**Report.** An interactive artifact report (one HTML file under `.ai-sdlc/artifacts/_operator-digest/<ts>.html`, plus the same data as JSON): one entry per decision with time, session, question, chosen option, basis (DEC id, judgment id, model and probability, or "session decided (class a)"), and a one-press reverse that runs the recorded `cli-decisions answer DEC-NNNN <other option> --rationale "operator veto"`, and an `OK` that marks the entry reviewed. For an AISDLC-1443 check-2 entry ("already decided by DEC-NNNN"), the reverse never touches the matched DEC; it messages the originating session with `cli-hierarchy send` ("operator veto: DEC-NNNN does not answer <question>; ask the operator") and logs a `veto:not-duplicate` label in the gate log.

**Channel.** Configurable (`decisions.digest.channel`): `pane` (default: a line typed into the planner tmux pane with the report link) or `notify` (the built-in notification system); the delivery line carries the count and the link.

**Delivery record.** `.ai-sdlc/state/operator-digest/last-delivery.json`: `{ "schema": 1, "deliveredAt": "<ISO-8601>", "entries": <n>, "report": "<path>", "channel": "<name>" }`. One exported reader `lastDigestDelivery(projectRoot)` returns it or `null` on a missing or malformed file; AISDLC-1445 treats `null` or an age over 26 hours as not delivered.

## Acceptance Criteria
- [ ] #1 The dispatch tick runs the producer and delivers per the rule above; tested with a fake clock: >= N entries at a window end delivers, fewer waits for the daily time, zero entries delivers nothing.
- [ ] #2 The report lists every entry since the last delivery with the fields above; reverse on an auto-answer or a check-3 record reverses that DEC (verified with `cli-decisions show`) and marks the entry vetoed only when every step succeeded; reverse on a check-2 entry leaves the matched DEC unchanged and messages the session; a failed step is shown in the report, never marked done.
- [ ] #3 `N`, the daily time and the channel are read from `.ai-sdlc/decisions-config` with defaults 10, a configured local time, and `pane`; each channel is tested with a recorded fixture.
- [ ] #4 Each delivery writes the delivery record and `operator-digest --mark`; `lastDigestDelivery` is exported and tested (fresh record, missing file, malformed file).
- [ ] #5 Planner orientation (`/ai-sdlc:planner` step 3) prints `N delivered, none reviewed` when delivered entries are still unreviewed, and nothing otherwise.
- [ ] #6 `docs/operations/decision-authority.md` describes the digest and the veto path.
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
