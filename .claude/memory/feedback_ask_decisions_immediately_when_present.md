---
name: ask-decisions-immediately-when-present
description: "operator 2026-10-14: when the operator is present, ask a class (c) or rubric question the moment it surfaces via AskUserQuestion; never report 'there are questions' and wait to be told to ask"
metadata:
  type: feedback
---

Operator, 2026-10-14: "why do I have to ask you to ask me questions ... just ask me them as soon as they come up." The planner had reported twice that the AISDLC-859 PAT scope and the executor count were "with the operator" instead of asking them.

**Why:** a question mentioned in a status line costs the operator two round trips (read, then say "ask me"). The away rule only forbids `AskUserQuestion` while the operator is away; when they have just typed, they are present.

**How to apply:**
- A class (c) item or any decision the rubric cannot settle: open `AskUserQuestion` in the same turn it surfaces, with the rubric options and a recommendation. Do not park it in a report.
- Operator 2026-10-15: "You don't need to ask me to run the rubric, just run it whenever a question comes up." Never end a turn with "do you want me to run the rubric on X?"; when a question surfaces (a failed verdict needing a resume-or-withdraw ruling, an OQ, a policy choice), gather the facts and open the rubric question directly in that turn.
- While the operator is away, route to the planner and the decision catalog as before; the first time they return, ask the parked questions before anything else.
- Record the answer with `cli-decisions add` + `answer --by <operator>` so dispatch and executors get repository authority, not a relayed message. See [[hold-limits-actions-not-reporting]] and [[feedback_timebox_operator_decisions]].
- Operator 2026-10-16 (reinforced): "things that are owned by me that aren't asked to me become stale until I notice them; it's better to ask me right away with the decision rubric." An owed operator item (a candidate task to file, a held PR that needs their call, a setting, a landing only they may perform) is NEVER left in an "owed by you" list at the end of a turn: open the rubric question in the turn it arrives, including during cron drives when the operator is present. An "owed" list is only for items genuinely blocked on something else (e.g. a release PR waiting for its unblocker to land).
