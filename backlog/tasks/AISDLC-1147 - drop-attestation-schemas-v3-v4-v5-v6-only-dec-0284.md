---
id: AISDLC-1147
title: 'Implement DEC-0284: drop attestation schemas v3/v4/v5 outright, v6 is the only schema signed and verified (supersedes the warn-only #2171)'
status: To Do
assignee: []
created_date: '2026-11-01'
labels:
  - attestation
  - governance
  - cleanup
dependencies: []
references:
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - ai-sdlc-plugin/scripts/sign-attestation.test.mjs
  - ai-sdlc-plugin/scripts/check-attestation-sign.sh
  - orchestrator/src/runtime/attestations.ts
  - orchestrator/src/runtime/attestations.test.ts
  - pipeline-cli/src/attestation/sign-v6.test.ts
  - pipeline-cli/src/cli/index.ts
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - CLAUDE.md
priority: high
dispatchable: true
---
## Description
DEC-0284 (operator ruling 2026-10-31, option `drop-legacy`) decided that attestation schema v6 is the only format signed and verified: no deprecation window, no backward compatibility, legacy v3/v4/v5 code paths, fixtures and tests deleted. Evidence recorded in the decision: every envelope under `.ai-sdlc/attestations` on main is v6; no v3/v4/v5 envelope exists.

PR #2171 (AISDLC-585) implemented the rejected `warn-only` option (warn on signing a legacy schema, verifier unchanged, removal planned via a later RFC-0042 amendment). It was held for a v6-only rewrite but landed on 2026-11-01 at 4d07dae9 through its pre-armed auto-merge after a dispatch re-entry re-signed it. Main therefore carries a deprecation warning and a CLAUDE.md note that contradict DEC-0284. This task replaces that warn-only code with the ruled behaviour.

**Five-step review (requirements first).**
1. Requirement questioned: must the verifier keep accepting v3/v4/v5? DEC-0284 says no, with evidence that none exist; this task implements the ruling and does not reopen it.
2. Delete: the v3/v4/v5 signing and verifying branches in `ai-sdlc-plugin/scripts/sign-attestation.mjs`, `orchestrator/src/runtime/attestations.ts` and any pipeline-cli verifier path; the legacy fixtures and their tests; the warn-on-sign deprecation added by #2171 (code, tests, CLAUDE.md lines).
3. Simplify: one schema constant (`v6`); the signer refuses any other `schemaVersion` with one clear error, the verifier refuses a non-v6 envelope with one clear error naming DEC-0284.
4. Accelerate: fewer branches in the sign and verify hot path; no deprecation clock to maintain.
5. Automate: a test asserts the signer and the verifier each refuse a v5 envelope; `pnpm dark-code:check` confirms no legacy module remains reachable.

Velocity impact: removes a dead compatibility surface and the contradicting deprecation note; no adopter break (no legacy envelope exists).

## Acceptance Criteria
- [ ] AC-1: The signer (`ai-sdlc-plugin/scripts/sign-attestation.mjs` and the pipeline-cli sign path) refuses any `schemaVersion` other than `v6` with a clear error; the #2171 warn-on-sign branch and its tests are removed.
- [ ] AC-2: Every verifier path (`orchestrator/src/runtime/attestations.ts`, pipeline-cli verification, `scripts/verify-attestation.mjs` if it holds a legacy branch) accepts only v6 and refuses an older envelope with an error that names DEC-0284; legacy v3/v4/v5 parsing code, fixtures and tests are deleted.
- [ ] AC-3: Tests cover refusal of a v5 envelope on sign and on verify; the existing v6 suites stay green; `pnpm dark-code:check` is green with no new baseline entry.
- [ ] AC-4: The CLAUDE.md lines added by #2171 about the v3/v4/v5 deprecation are replaced by one sentence stating v6 is the only schema (DEC-0284); the RFC-0042 OQ-7 amendment paragraph (landed by #2228) is kept and cited, no new `**Resolution:**` marker.
- [ ] AC-5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green; the task file records the test command and its summary line.

## Notes
Decision record: DEC-0284 (on main). Origin: planner 2026-11-01, once PR #2171 had merged with the rejected option. `scripts/verify-attestation.mjs` is a blocked path for the executor role; if a legacy branch lives there, the executor files a sub-task (`AISDLC-1147.1`) describing the exact change and returns the rest of the work; the planner routes that sub-task. The completed AISDLC-585 task file gets a one-line note that its warn-only outcome is superseded by this task.
