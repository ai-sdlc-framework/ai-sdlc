---
name: planner-is-exception-handler
description: Operator 2026-10-13: the planner must not act as operator-dispatch; it only answers what dispatch cannot, and its context is gated by delegating everything else
metadata:
  type: feedback
---

Operator (2026-10-13, during the PR drain): "You appear to be operating in the role of operator dispatch when your role should only be to answer specific questions operator dispatch can't handle. We need to gate your context and delegate to operator dispatch for most of these tasks."

**Why:** the planner runs on the large model; every per-event tick (landing, CI check, resume ruling, executor restart) spent planner context and budget on work the sonnet dispatch session can do by rule. In the 2026-10-12 drain this was a visible share of the weekly budget.

**How to apply:**
- Dispatch owns the drain end to end: ticks on its own loop, fast-forwards and rebuilds the parent after landings (discarding task-file debris first), chooses push-only vs normal resumes by the written rules, restarts idle executors, answers operational decisions (sequencing, environment, retries, mechanical failures) itself, and reports to the planner only on: a design or trust-chain decision, a refusal that needs a new task, or drain complete.
- The planner does not poll PRs or the board, does not post per-PR notes for mechanical steps, and does not run per-landing ticks. One standing order per phase, then silence until an exception arrives.
- When the planner catches itself handling a third mechanical event in a row, that is the signal to write the rule down and hand it to dispatch.
- Related: [[planner-delegates-not-executes]], [[dont-escalate-operational-decisions]].
