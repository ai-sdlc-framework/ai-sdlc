---
name: feedback_class_c_requires_no_api_path
description: operator 2026-10-17 — before escalating a repo/org setting as class (c), check for a gh/API path; if one exists the rubric decides it (class a or b) and an agent applies it
metadata:
  type: feedback
---

Asked the operator on 2026-10-17 to enable the repo Dependency graph (Dependency review gate red on every workflow PR) as a class (c) question. He answered: "Don't we have levels of questions on what can be answered automatically by the decision rubric skill and what needs my attention?" The setting had an API path (`PUT /repos/{o}/{r}/vulnerability-alerts`), so it was class (a): tightening, reversible, small blast radius.

**Why:** class (c) is for actions ONLY the operator's identity can perform (money, legal, credentials, merging the release PR, closing PRs). A repo setting reachable with the repo token is an ordinary rubric decision; asking him is the decision fatigue he has pushed back on repeatedly ([[feedback_timebox_operator_decisions]], [[feedback_decisions_not_work]], [[feedback_dont_escalate_operational_decisions]]).

**How to apply:** before opening AskUserQuestion for any GitHub setting, branch protection, label, secret-free workflow toggle or similar: look for a `gh api` / `gh repo edit` / CLI path first. If one exists, run the rubric, record with `cli-decisions add` + `answer` (tightening = class a; loosening beyond a recorded decision = class b timeboxed), apply, and tell the operator in the digest. Open the question only when the action truly needs his login (org billing, secrets, GitHub App installs, the release PR).
