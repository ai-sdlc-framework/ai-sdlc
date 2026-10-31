---
name: dec-0187-reenqueue-failed-task-with-open-pr
description: DEC-0187 = remove-verdict --from failed + write-manifest re-enqueue when requeue hits the cap on a task with an open PR
metadata:
  type: reference
---

When `cli-dispatch requeue` refuses at the retry cap but the task has an open PR: (1) `cli-dispatch remove-verdict --task-id X --from failed`; (2) copy `.ai-sdlc/dispatch/failed/X.manifest.json` to scratchpad, set `resume.note`, add `prUrl`/`prNumber`, then `cli-dispatch write-manifest --json <file>`. Sanctioned on main (#1494). Used for 837/840/846/844/549 (549 on 2026-10-13, PR #1407).

**Why:** enqueue, not requeue, so the cap does not apply. The planner had to re-send this after a clear.
**How to apply:** use it for any later failed-with-open-PR case; keep it in the handoff.

**DEC-0200 (2026-10-13) local-verify waiver, standing until AISDLC-862 lands:** a test failure is waived when it is in the cli-usage/ingest family (pipeline-cli bin-invocation.test.ts, usage-views.test.ts, plugin hook usage-ingest.test.mjs) or the attestation adopter runtime-resolution family (sign/verify-attestation adopter subtests) AND it passes when re-run alone AND the task diff does not touch those sources. `not ok` lines go in the PR body; anything outside blocks; CI is the gate. Put it in every re-enqueue resume note; apply without asking the planner again. Supersedes DEC-0195/0197 per-test lists.
- **DEC-0202 (2026-10-13)** replaces DEC-0200's family list: ANY locally failing test is waived when it passes alone AND the diff does not touch it or its source; not ok lines in PR body; docs:check/rfc:check/dark-code:check never waivable. Recipe for 833/837/840/549/799/846/838 'flake + push refused' = DEC-0187 re-enqueue + DEC-0202 + two-call push.
