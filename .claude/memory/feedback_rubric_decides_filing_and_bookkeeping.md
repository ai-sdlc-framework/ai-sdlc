---
name: rubric-decides-filing-and-bookkeeping
description: Operator 2026-10-22 - filing task candidates and retroactive/bookkeeping decision answers are rubric calls, not operator questions; run the rubric, take the recommendation, record it, report in the summary
metadata:
  type: feedback
---

Operator 2026-10-22, when asked which of three task candidates to file and how to answer three retroactive trust-chain records whose restoring work had already landed: "just run the rubric on the question and choose the recommended answer. those don't look like questions that need a decision from me."

**Why:** the planner was treating "candidate task, not filed until the operator confirms" and "trust-chain scope" as automatic AskUserQuestion triggers. Filing a task is reversible and cheap (class a); a retroactive acceptance of a weakening whose restoring control is already on main applies nothing. Both are rubric calls with an obvious recommendation. Asking them costs the operator attention for no change in outcome (see [[feedback_timebox_operator_decisions]], [[feedback_decisions_not_work]]).

**How to apply:** when a question surfaces, derive the class first. Class (a), or a class (b) whose "weakening" is already restored on main: run the rubric, pick the recommendation, record it (`cli-file task` / `cli-file decision --answer`), and report the choice in the summary with its reversal path. Reserve AskUserQuestion for class (c), for a live weakening, or when the options lead to materially different work and the rubric gives no clear recommendation. "Candidate tasks for the operator" lists are a smell: file them.
