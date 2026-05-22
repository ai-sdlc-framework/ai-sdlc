---
id: AISDLC-391
title: 'chore: AISDLC-383.8 security minor followups — head-sha validation + transcript-path traversal hardening'
status: To Do
labels:
  - security
  - attestation
  - tech-debt
references:
  - pipeline-cli/src/cli/attestation.ts
  - pipeline-cli/src/attestation/merkle.ts
parentTaskId: AISDLC-383
---

## Description

Two minor security findings from the AISDLC-383.8 review (PR #602, MERGED 2026-05-22). Filed as a single follow-up since both are defense-in-depth hardenings to the same `emit-leaf` subcommand surface.

### Finding 1: `--head-sha` shape validation

The `cli-attestation emit-leaf --head-sha <sha>` argument is documented as "40-char hex git commit SHA" but no runtime validation enforces that shape. `generateNonce()` accepts any string and hashes it without complaint. A caller bug where `git rev-parse HEAD` fails silently (e.g. pipefail not active) could pass an empty string or multi-line value, weakening the nonce-binding invariant that RFC-0042 promises.

**Fix**: add `if (!/^[0-9a-f]{40}$/.test(headSha)) { stderr; exit(1); }` at the top of the emit-leaf handler.

### Finding 2: `--transcript-path` + `--verdict-path` traversal hardening

`emit-leaf`'s `--transcript-path` and `--verdict-path` accept arbitrary absolute paths (passed through `resolve()` which normalizes but doesn't constrain). There is no check that these paths fall under `<repo-root>/.ai-sdlc/`. In the trusted slash-command-body caller this is fine (paths are constructed from `$WORKTREE_PATH` + a known relative). But the CLI surface doesn't enforce the invariant, so a misconfigured caller OR an attacker who can influence the bash variables `$TASK_ID_LOWER` / `$AGENT_NAME` (with embedded `../`) could cause the CLI to hash arbitrary files into the Merkle tree.

**Fix**: validate that `transcript-path` and `verdict-path` resolve to paths inside `<repo-root>/.ai-sdlc/` before hashing. Exit non-zero if not.

## Acceptance criteria

- [ ] AC-1: `--head-sha` validation: reject non-40-hex-char input with clear error; exit 1
- [ ] AC-2: `--transcript-path` validation: reject paths outside `<repo-root>/.ai-sdlc/`; exit 1
- [ ] AC-3: `--verdict-path` validation: same as AC-2
- [ ] AC-4: Hermetic tests cover happy-path (valid inputs) + each rejection path
- [ ] AC-5: Existing tests still pass (no behavior change for legitimate callers)

## Estimated effort

1-2 hours including tests.

## References

- AISDLC-383.8 PR #602 — security review noted these as "worth filing as follow-ups before flipping AI_SDLC_V6_CUTOVER_ACTIVE=1"
- v6 cutover IS active now (since 2026-05-22) — these hardenings should land before the next v6 envelope-signing PR
