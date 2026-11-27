---
id: AISDLC-1443
title: "An operator question is gated: answered from a decision already on main, decided by the session for class (a)/(b), refused in unattended sessions, and rubric-framed otherwise"
status: Done
priority: high
labels:
  - governance
  - judgment
  - rfc-0049
  - hooks
dependencies: []
assumes: [RFC-0049]
references:
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - pipeline-cli/src/decisions/judged.ts
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - reference/src/judgment/catalog/decision-duplicate.ts
  - reference/src/judgment/catalog/decision-reversibility.ts
  - ai-sdlc-plugin/hooks/hooks.json
  - ai-sdlc-plugin/skills/decision-rubric
  - docs/operations/decision-authority.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator 2026-11-26: too many simple questions reach the operator through `AskUserQuestion` that the repository already answers. Three rules exist only as prompt text: a decision record on `main` is authority for classes (a) and (b) (DEC-0039); no session opens `AskUserQuestion` while the operator is away; a non-trivial question goes through the decision-rubric skill. Nothing enforces any of them at the tool call.
2. Delete: nothing.
3. Simplify: one `PreToolUse` gate on `AskUserQuestion` (a classic plugin hook script; see AC #6 for the mod variant), four checks in order, each falling through on abstain:
   1. **Unattended session:** the hierarchy role is executor or dispatch → deny with "no operator here: `cli-decisions escalate --task-id ... --option ...`".
   - **RFC Open Question exemption (deterministic, before checks 2 and 3):** a question that resolves an RFC Open Question is never denied by checks 2 or 3 and never offered to a judgment; it goes straight to check 4. Open Questions are resolved only by the operator through the rubric (AISDLC-298; planner hard rule), so neither "already answered" nor "decide this yourself" may apply to one. The question counts as an Open Question when any of these holds: the question text, `header` or an option label matches `\bOQ[-‑ ]?[A-Z0-9]+\b` or the phrase "open question" (case-insensitive); or the current turn's transcript contains a `Skill` call for `ai-sdlc:rfc-oq-walkthrough` or `rfc-oq-walkthrough`. The detector is one exported function, reused by AISDLC-1445 for its RFC-OQ exclusion.
   2. **Already decided:** shortlist answered decision records on `main` by edit distance against the question text (`shortlistDuplicates`, `pipeline-cli/src/decisions/judged.ts:72`, reused, not copied), confirm with the existing Group A judgment `decision.duplicate`; on a confirmed match deny with "DEC-NNNN already answered this (option `<x>`: `<summary>`). Proceed on it." Deterministic shortlist first; the judgment only confirms (RFC-0049 section 1 ordering).
   3. **Session's own class:** `decision.reversibility` (Group A) plus the deterministic class-(c) markers in `decision-authority.md` (legal, money, credentials, operator-identity actions). Class (a) or (b) with an act outcome → deny with "decide this yourself: `cli-decisions add ... --file --pr` and proceed". Class (c), escalate or abstain → fall through.
   4. **Rubric framing:** the current turn's transcript must contain a `Skill` call for `ai-sdlc:decision-rubric`, or the question must be trivial (every option label ≤ 5 words and no option description, or `header` in an allowlist kept in the hook); otherwise deny with "run the ai-sdlc:decision-rubric skill first, then ask again".
4. Accelerate: checks 2 and 3 are one judgment request (same state), about 100–200 ms; on provider error or no key they abstain and the gate costs nothing. Checks 1 and 4 are deterministic and need no provider key. Both `decision.duplicate` and `decision.reversibility` are in `shadow` today with no promotion record, so checks 2 and 3 only log until promoted.
5. Automate: every gate outcome (allow, each deny kind, abstain, shadow would-deny) is one JSONL record in the gate's own log, `.ai-sdlc/artifacts/_question-gate/log-YYYY-MM-DD.jsonl` (the judgment log record has no consumer field and is not extended; the judgment calls checks 2 and 3 make are logged there as usual). Record: `ts`, `sessionId`, `role`, `questionId` (hash of question text plus options plus session id), `check`, `outcome`, `basis` (DEC id or judgment id), `mode`. This is the shadow corpus AISDLC-1445 joins against.

**Check 4 goes live only after a replay** (operator decision 2026-11-26, planner rubric review): before check 4 may deny, the gate is run offline over every `AskUserQuestion` call in the last 30 days of local session transcripts (`~/.claude/projects/<this project>/*.jsonl`), and the PR reports how many it would deny and a hand-labelled false-deny rate on the denied set. Check 4 ships in `warn` (allow, log would-deny) and is switched to deny only if that rate is under 5%; otherwise the PR adjusts the triviality rule or the allowlist and replays again.

Checks 2 and 3 deny the question and tell the session what to do; they never answer on the operator's behalf. Answering in place is separate later work under an RFC-0049 amendment (AISDLC-1444, AISDLC-1445, AISDLC-1446), out of scope here.

## Acceptance Criteria
- [ ] #1 A `PreToolUse` command hook matching `AskUserQuestion` is registered in `ai-sdlc-plugin/.claude-plugin/plugin.json` (where the other command hooks live; `hooks/hooks.json` lists only modules) with a `node --test` suite covering each check, each deny message, and the fall-through order.
- [ ] #2 Check 1 denies in executor and dispatch sessions (role read the same way the other hierarchy hooks read it) and allows in the planner and in sessions outside the hierarchy.
- [ ] #3 Check 2 denies only on a `decision.duplicate` `act` outcome in `enforce` mode; in `shadow` (the default until its promotion record exists) it allows and logs what it would have done. The deny names the DEC id, chosen option and summary. Only decisions with status `answered` on `origin/main` are candidates.
- [ ] #3a Check 3, like check 2, denies only on an `act` outcome in `enforce` mode; in `shadow` it allows and logs the would-deny.
- [ ] #4 Check 3 never denies a question carrying a class-(c) marker, whatever the judgment says; tested with a money question and a credentials question that the fake provider labels reversible.
- [ ] #4a An RFC Open Question is never denied by checks 2 or 3 and no judgment request is made for it, whatever the judgment would say; tested with (i) a question whose header is `OQ-3` that the fake provider labels a confirmed duplicate and reversible, (ii) a question with no OQ marker asked in a turn that invoked `rfc-oq-walkthrough`, and (iii) a plain question that mentions neither (checks 2 and 3 still run). Check 4 still applies to Open Questions.
- [ ] #5 Check 4 reads `transcript_path` from the hook input, scoped to the current turn; a rubric `Skill` call in an earlier turn does not count.
- [ ] #5a Replay: a script runs the gate over the last 30 days of local transcripts; the PR body reports total `AskUserQuestion` calls, would-deny count per check, and the false-deny rate on a hand-labelled check-4 denied set. Check 4 defaults to `warn` and its deny is enabled in the same PR only if that rate is under 5%.
- [ ] #5b Every outcome writes one record to `.ai-sdlc/artifacts/_question-gate/log-YYYY-MM-DD.jsonl` with the fields above; the question text is stored as a hash plus the first 200 characters, never the session transcript.
- [ ] #6 The PR body records whether the gate was built as a classic hook or as a hooks module (mod) and why; if a mod, it is the same module AISDLC-1446 extends.
- [ ] #7 Kill switch: `AI_SDLC_QUESTION_GATE=off` allows every question; documented in `docs/operations/decision-authority.md` next to the rules it enforces.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
