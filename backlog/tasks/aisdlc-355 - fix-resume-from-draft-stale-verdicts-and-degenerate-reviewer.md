---
id: AISDLC-355
title: 'fix(orchestrator): resume-from-draft stale verdict reuse + verdict-shape mismatch + degenerate-reviewer retry'
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - orchestrator
  - pipeline-friction
  - resume-from-draft
  - critical
dependencies: []
priority: critical
references:
  - pipeline-cli/src/cli/resume-from-draft.ts
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - pipeline-cli/src/steps/09-iterate.ts
---

## Three related resume-from-draft bugs hit during 282/286/323 finalization

All three centre on the verdict-file lifecycle. Grouping because the fixes touch the same file (`pipeline-cli/src/cli/resume-from-draft.ts`).

## Bug 1 — Stale verdict file blocks reviewer re-run

**Symptom**: `runResumeFromDraft` checks `hasVerdictFile`. When the verdict file exists (even if it's a broken synthetic-critical placeholder from a prior failed run), the resume skips the reviewer phase and tries to push the stale verdict. No `--force-reviewers` flag exists.

**Repro**: hit on AISDLC-282 and AISDLC-286. Prior pipeline run (pre-AISDLC-351 parser fix) wrote `.ai-sdlc/verdicts/<task-id>.json` with `decision: CHANGES_REQUESTED, counts.critical: 3, verdicts: [{approved: false, findings: [{severity: critical, message: "<role> returned no parseable verdict (status=success)"}]}]`. Workaround: manually `rm .ai-sdlc/verdicts/<task-id>.json` before each retry.

**Fix**: 
- (a) Add `--force-reviewers` flag that deletes the existing verdict file before re-running, OR
- (b) Auto-detect synthetic-critical placeholders (`message.includes("returned no parseable verdict")`) and treat them as "verdict file effectively absent — re-run reviewers."

Option (b) is more operator-friendly (no manual cleanup needed).

## Bug 2 — Verdict file shape mismatch (nested vs flat array)

**Symptom**: `runResumeFromDraft`'s post-review output writes the `AggregatedVerdict` shape to disk:
```json
{
  "taskId": "AISDLC-282",
  "decision": "APPROVED",
  "counts": {"critical": 0, "major": 0, "minor": 4, "suggestion": 2},
  "verdicts": [{"agentId": "code-reviewer", "approved": true, "findings": [...]}]
}
```

`ai-sdlc-plugin/scripts/sign-attestation.mjs` expects the FLAT shape:
```json
[
  {"agentId": "code-reviewer", "harness": "claude-code", "approved": true, "findings": {"critical": 0, "major": 0, "minor": 3, "suggestion": 2}}
]
```

Sign fails silently with `ERROR: .ai-sdlc/verdicts/<task-id>.json must contain a JSON array of reviewer verdicts`. The orchestrator surfaces this as the unhelpful `re-push failed: unknown error` (covered by AISDLC-354 Bug 1).

**Workaround**: manual python flatten before push (did this 3× on 282/286/323).

**Fix**:
- (a) Standardize on ONE shape (flat array) and have `runResumeFromDraft` write the flat shape, OR
- (b) `sign-attestation.mjs` accepts BOTH shapes — if it gets the nested AggregatedVerdict, flattens internally before signing.

Option (a) is cleaner; option (b) is more backward-compatible.

## Bug 3 — Code-reviewer occasionally returns degenerate parsed output

**Symptom**: for AISDLC-282 the first via-pipeline code-reviewer returned `{approved: false, findings: [], summary: ""}`. The reviewer subagent's output parsed fine (no markdown-fence issue), but the LLM produced effectively empty content. Pipeline shipped it as CHANGES_REQUESTED → blocked the PR.

**Repro**: AISDLC-282 only; AISDLC-286 + AISDLC-323 didn't hit this. Operator-requested manual re-run via `Agent` tool produced a substantive APPROVED verdict (3 minor + 2 suggestions).

**Fix**: in `coerceReviewerVerdict`, detect "suspicious" output and retry once:
- `approved === false` AND `findings.length === 0` AND `(summary === undefined || summary.trim() === '')` → emit `WARNING: reviewer returned approved=false with no findings/summary; retrying once` + invoke spawner.spawn again with the same args.
- After retry, accept whatever comes back. If still degenerate, escalate as CHANGES_REQUESTED with a `pipeline-degenerate-reviewer` finding (clearly distinguishable from a real reviewer rejection).

## Acceptance criteria

- [ ] **Bug 1**: `runResumeFromDraft` auto-skips stale verdict files when the file contains synthetic-critical placeholders. Test: pre-populate verdicts file with `[{approved: false, findings: [{severity: critical, message: "code-reviewer returned no parseable verdict (status=success)"}]}]`; assert resume re-runs reviewers.
- [ ] **Bug 2**: verdicts file shape is unified — either always flat OR signer accepts both. Test: write nested AggregatedVerdict shape; assert sign succeeds. Write flat shape; assert sign succeeds.
- [ ] **Bug 3**: `coerceReviewerVerdict` retries once on degenerate output. Test: inject a spawner returning `approved=false, findings=[], summary=""` on first call + substantive verdict on second; assert the second is used + warning is logged.

## Source

Operator session 2026-05-17. Bug 1+2 hit on all 3 of AISDLC-282/286/323; Bug 3 hit on AISDLC-282 specifically (operator manually re-ran code-reviewer via Agent).
