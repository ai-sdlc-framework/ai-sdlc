---
id: AISDLC-1446
title: "Every question answered without the operator is shown on screen with a one-press veto"
status: To Do
priority: medium
labels:
  - governance
  - judgment
  - claude-code-mod
  - rfc-0049
dependencies:
  - AISDLC-1443
  - AISDLC-1444
references:
  - ai-sdlc-plugin/mods/context-meter
  - spec/rfcs/RFC-0049-system-one-judgment-layer.md
  - ai-sdlc-plugin/hooks/hooks.json
  - docs/operations/decision-authority.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator 2026-11-26: questions answered without the operator (today: denied with "DEC-NNNN already answered this" or "decide this yourself" by the AISDLC-1443 gate; later: answered in place by `operator-question.auto-answer` under the AISDLC-1444 amendment) must be visible at once so the operator can veto quickly; rubber stamps must not accumulate unseen. Today the only trace would be a judgment-log line and a DEC record in `operator-digest`, read hours later.
2. Delete: not now, defer. Until an AISDLC-1443 check or AISDLC-1445 is promoted to `enforce`, nothing is settled without the operator, so the surface has nothing to show; and the AISDLC-1444 amendment's OQ-B (veto window, loaded vs watched) decides the interaction. Hence the dependency on 1444 and medium priority (operator decision 2026-11-26, planner rubric review). Build to the amendment as resolved; if OQ-B is still open when claimed, stop and escalate (`cli-decisions escalate --scope rfc:RFC-0049`).
3. Simplify: a Claude Code hooks module (mod) shipped in `ai-sdlc-plugin/mods/<name>/` on the `context-meter` pattern (its own `hooks/hooks.json`, `types/index.d.ts`, `ui.render` on `AbovePrompt`), one surface per need, all fed by one list kept in `$.store` (across sessions) keyed by project:
   - **Row above the prompt** (`ui.render` on `AbovePrompt`): `N answered without you, M unreviewed` while M > 0; nothing otherwise.
   - **Pane** (`$.ui.open`, drawn by `ui.render` on `Pane`): one line per auto-handled question: time, session, question, what was decided and on what basis (DEC id, judgment probability or "session decided (class a)"), with `Veto` and `OK` buttons. `OK` marks it reviewed. `Veto` means a different thing per outcome kind, and the entry records which:
     - **"already decided" (check 2):** the veto says "that decision does not cover this question, ask me". It never touches the matched DEC (an older ruling stays as it is). It sends the originating session `cli-hierarchy send`: "operator veto: DEC-NNNN does not answer <question>; ask the operator", and logs a `veto:not-duplicate` label in the gate log (feeds `decision.duplicate` calibration).
     - **"decide this yourself" (check 3):** no DEC exists when the entry is written; the session files one afterwards. The entry is linked to it when a `cli-decisions add` from the same session (`--by` / session name) lands within 30 minutes; the pane shows "awaiting session's record" until then. Veto on a linked entry runs that DEC's recorded reverse command (`cli-decisions answer DEC-NNNN <other option> --rationale "operator veto"`) through `$.process.run` and messages the session; veto before linking messages the session "operator veto: do not proceed on <question>; ask the operator".
     - **in-place answer (AISDLC-1445 in enforce):** the answer is a DEC record (amendment), so veto runs its reverse command and messages the session.
   - **Toast / notification** (`$.ui.toast`, `$.ui.notify`) on each new entry, so the operator sees it even with the pane closed or the session in the background.
   - **Slash command** `/ai-sdlc:answered` opens the pane and lists unreviewed entries.
4. Accelerate: the entry is written by the same `tool.call` hook that handled the question, before the session proceeds; no polling.
5. Automate: the module writes a liveness heartbeat while it is loaded (the signal AISDLC-1445 checks), so in-place answering cannot run in a session where the surface is absent.

**Liveness signal (specified here; AISDLC-1445 reads it).** The judgment runtime runs in a separate Node process (the gate hook), so it cannot see the module's in-memory `$.state` or `$.store`. The signal is a file:

- **Path:** `.ai-sdlc/state/veto-surface/<session_id>.json` under the project root, where `<session_id>` is the Claude Code session id (the same `session_id` the `PreToolUse` hook input carries, so the gate can look up its own session without guessing). The directory is git-ignored.
- **Content:** `{ "schema": 1, "sessionId": "<id>", "moduleVersion": "<plugin version>", "pid": <claude pid>, "updatedAt": "<ISO-8601>" }`. No question text, no key material.
- **Writer:** the module, on load and then every 30 seconds while loaded (through `$.process.run` of a small `cli-judgment veto-surface beat --session <id>` subcommand if the mod API has no direct file write); it deletes the file on unload when it can.
- **Reader rule:** live only when the file exists, `sessionId` equals the caller's `session_id`, and `updatedAt` is no older than 90 seconds (three missed beats). Anything else, including a parse error, is not live. An unload that could not delete the file goes stale within 90 seconds, so a crashed or disabled module never keeps the signal up.
- **Known limit:** the signal proves the surface is loaded in that session, not that the operator is watching it (a detached tmux pane passes). Whether "loaded" is enough is the amendment's call (AISDLC-1444 OQ-B/OQ-C); this task does not decide it.

## Acceptance Criteria
- [ ] #1 The module loads from `ai-sdlc-plugin`, passes `claude plugin validate` and `claude plugin test`, and declares its `$.state` values in a `types/index.d.ts` contract.
- [ ] #2 Every gate outcome that settles a question without the operator (AISDLC-1443 checks 2 and 3 in enforce; any in-place answer later) adds one entry carrying: timestamp, session name, question text, options, outcome, basis (DEC id or judgment id, model and probability), and the reverse command.
- [ ] #3 The row above the prompt shows the unreviewed count and disappears at zero; the pane lists entries newest first with `Veto` and `OK`; a toast fires per new entry. Tested with the module test harness, including a seeded store from an earlier version.
- [ ] #4 `Veto` follows the per-kind semantics above: for check 2 it never modifies the matched DEC (test: `cli-decisions show` unchanged) and messages the session; for a linked check-3 entry or an in-place answer it reverses the DEC (verified by `cli-decisions show`) and messages the session; for an unlinked check-3 entry it messages the session only. The entry is marked vetoed only when every step succeeded; a failed reversal or send is shown in the pane and never marked done.
- [ ] #5 Entries persist across `/clear` and restarts (`$.store`); reviewed entries older than 7 days are pruned; unreviewed ones never are.
- [ ] #6 The heartbeat file `.ai-sdlc/state/veto-surface/<session_id>.json` is written on load and refreshed every 30 seconds with the schema above, and one exported reader `isVetoSurfaceLive(projectRoot, sessionId, now)` implements the reader rule (consumed by AISDLC-1445's enforce check). Tested: fresh file for the same session → live; another session's file → not live; `updatedAt` 91 seconds old → not live; missing or malformed file → not live; the path is git-ignored.
- [ ] #7 `docs/operations/decision-authority.md` describes the surface and the veto path.
- [ ] #8 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
