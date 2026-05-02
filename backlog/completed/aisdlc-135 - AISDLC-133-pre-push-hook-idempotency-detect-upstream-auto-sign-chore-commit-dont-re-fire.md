---
id: AISDLC-135
title: >-
  AISDLC-133 pre-push hook idempotency: detect upstream auto-sign chore commit,
  don't re-fire
status: Done
assignee: []
created_date: '2026-05-02 03:21'
labels:
  - husky
  - attestation
  - follow-up
  - ci
dependencies:
  - AISDLC-133
references:
  - scripts/check-attestation-sign.sh
  - scripts/check-attestation-sign.test.mjs
  - .husky/pre-push
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Caught during AISDLC-115.6 dispatch (PR #168).** The AISDLC-133 auto-sign hook keyed its idempotency check on `.ai-sdlc/attestations/<head-sha>.dsse.json` — "if envelope exists for HEAD, skip." That works for the second push of a normal cycle: hook signs against HEAD, adds a chore commit (new HEAD), exits 1 with "re-run git push"; second push sees envelope at the original HEAD and falls through.

**Failure mode observed:** when `git push` is invoked AGAIN (second cycle), HEAD has moved to the auto-sign chore commit. There's no envelope at this NEW HEAD. The hook re-fires, signs another envelope against the new HEAD, adds ANOTHER chore commit on top, and exits 1 again. Repeat indefinitely.

**Reproduction (PR #168):**
```
HEAD: 28cd50c chore: mark AISDLC-115.6 complete
push -> hook signs, commits 37d3a75 chore: auto-sign attestation for AISDLC-115.6 (AISDLC-133), exit 1
HEAD: 37d3a75
push -> hook re-fires, commits c98563a chore: auto-sign attestation for AISDLC-115.6 (AISDLC-133), exit 1
```

Operator broke the loop by `AI_SDLC_SKIP_ATTESTATION_SIGN=1 git push`. The first envelope is content-bound (`contentHashV3`), so the verifier accepts it against current HEAD regardless — but the loop is still wrong.

**Fix:**
Add an additional idempotency predicate that the hook checks BEFORE deciding to sign:

```bash
LAST_COMMIT_SUBJECT=$(git log -1 --format=%s HEAD 2>/dev/null)
if [[ "$LAST_COMMIT_SUBJECT" == "chore: auto-sign attestation for "* ]]; then
  echo "[attestation-sign] HEAD is already an auto-sign chore commit — falling through idempotently"
  exit 0
fi
```

Place this check after the existing `if [ -f "$ATT_FILE" ]; then exit 0; fi` line (~419). The combined check covers both cases:
- Same HEAD twice (existing envelope at HEAD → skip)
- Auto-sign chore on top of original HEAD (HEAD subject matches → skip)

**Threat model:** this is benign — the predicate matches commits the hook itself wrote. An attacker forging the commit subject would have already needed write access to the repo, at which point they can do worse things than skip an attestation gate.

**Tests to add to `scripts/check-attestation-sign.test.mjs`:**
- A "loop prevention" test that simulates two consecutive push attempts where HEAD moves after the first auto-sign — assert second invocation exits 0 without writing a new envelope or chore commit
- An idempotency test that the hook still fires correctly on a NEW dev commit even when there's a prior auto-sign chore commit somewhere in history (i.e., we don't accidentally suppress signing for new work)

**Verification:** dispatch a new task end-to-end and confirm only one auto-sign chore commit lands per dispatch cycle. PR #168 is the regression case to consult.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 check-attestation-sign.sh exits 0 (no-op) when HEAD's commit subject starts with 'chore: auto-sign attestation for '
- [x] #2 Existing envelope-exists-at-HEAD idempotency check still works (no regression)
- [x] #3 New test in check-attestation-sign.test.mjs proves loop prevention via two consecutive simulated pushes
- [x] #4 New test proves the hook STILL fires on a brand-new dev commit even when prior auto-sign chore commits exist in history
- [x] #5 End-to-end dispatch of one task results in at most one auto-sign chore commit (verifiable by git log on the resulting PR)
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Added a complementary subject-line predicate to `scripts/check-attestation-sign.sh` that detects when HEAD is itself an upstream auto-sign chore commit (subject starts with `chore: auto-sign attestation for `) and falls through with exit 0. Placed AFTER the existing envelope-exists-at-HEAD check so the two idempotency gates are complementary — first catches the normal second-push case, second catches the loop case where committing the envelope changed HEAD. Closes the PR #168 regression.

## Changes
- `scripts/check-attestation-sign.sh` — Step 4b chore-subject predicate (~10 lines after the existing Step 4 envelope-exists check)
- `scripts/check-attestation-sign.test.mjs` — 2 new hermetic tests: loop-prevention (two consecutive simulated pushes) + brand-new-dev-commit (3-commit history dev1 → chore1 → dev2, hook still fires for dev2)

## Design decisions
- **Predicate position AFTER envelope-exists check** — they're complementary: envelope-at-HEAD = "we already signed this exact commit"; subject-is-chore = "previous push triggered auto-sign and HEAD is now the chore". Order matters because envelope check is cheaper.
- **Bash `[[ == ]]` glob match anchored to literal prefix** — security-reviewed safe. Spoofing requires repo-write access; CI verifier remains the actual trust boundary regardless.
- **String constant duplication** between producer (Step 6 commit) and consumer (Step 4b match) — left as-is. Code-reviewer flagged but a shell constant adds indirection without locking the contract any tighter (still string equality).
- **AC #5 proven by unit test** rather than real /ai-sdlc dispatch — the loop-prevention test directly simulates the PR #168 reproduction.

## Verification
- `pnpm build` / `pnpm lint` / `pnpm format:check` — passed
- `node --test scripts/check-attestation-sign.test.mjs` — 14/14 pass (12 prior + 2 new)
- 3 parallel reviews APPROVED — 0 critical, 0 major, 2 minor, 3 suggestions across 3 reviewers (⚠ INDEPENDENCE NOT ENFORCED — codex unavailable)

## Follow-up (deferred)
- Code-reviewer minor: strengthen Step 4b docstring so a future reader doesn't classify it as removable corner-case code (it's the primary termination path for every normal sign cycle)
- Code-reviewer minor: shell constant for the `chore: auto-sign attestation for ` prefix to lock producer ↔ consumer
- Test-reviewer minor: rename loop-prevention test to better describe what it verifies (the PR #168 reproduction is the basic two-push cycle, not an amend/rewrite)
- Test-reviewer minor: replace `execFileSync('cat', [logPath])` with `readFileSync` (consistency with existing patterns)
<!-- SECTION:FINAL_SUMMARY:END -->
