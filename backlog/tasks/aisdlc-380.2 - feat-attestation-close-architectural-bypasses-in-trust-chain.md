---
id: AISDLC-380.2
title: 'feat(attestation): close architectural bypasses in AISDLC-380 trust chain (caller-identity binding + Read-tool guard + nonce freshness)'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - attestation
  - governance
  - security
  - critical
dependencies:
  - AISDLC-380
priority: critical
references:
  - .claude/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/hooks/enforce-blocked-actions.js
  - ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs
  - scripts/verify-reviewer-sub-attestations.mjs
  - ai-sdlc-plugin/agents/security-reviewer.md
---

## Problem

AISDLC-380 shipped reviewer-side signed sub-attestations as a partial defense against the 2026-05-20 forgery incident. It raised the local-side forgery bar from "trivial accident" (write plain JSON) to "one bash command" (invoke the sign helper). It does NOT close the underlying trust-chain hole.

Three architectural bypasses remain open. A dev subagent on the operator's UID can still mint cryptographically-valid sub-attestations for code-reviewer + test-reviewer (and forge security-reviewer entirely via the documented Option B exemption):

### Bypass #1 — sign-helper invocation (security-reviewer finding from AISDLC-380 review)

`sign-reviewer-verdict.mjs` has zero caller-identity binding. Dev subagent runs:

```
node ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs \
  --reviewer-name code-reviewer \
  --task-id AISDLC-NNN \
  --verdict-json '{"approved":true,"findings":[],"summary":"LGTM"}'
```

The bash command contains no substring matching `agent-role.yaml` `blockedActions` patterns (`*reviewer-keys*` etc). Node process reads `~/.ai-sdlc/reviewer-keys/code-reviewer.pem` internally. Signs whatever verdict was passed. Output is cryptographically valid against the trusted-reviewers registry. Repeat for test-reviewer. Compose verdict file. Push. Forgery indistinguishable from real review.

### Bypass #2 — Read-tool unguarded (security-reviewer finding from AISDLC-380 review)

`.claude/hooks/enforce-blocked-actions.js` and `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` dispatch only on `Bash`, `Write`, and `Edit` tool names. The `Read` tool is never checked against `blockedActions` or `blockedPaths`. Dev subagent invokes:

```
Read(file_path="/Users/dominique/.ai-sdlc/reviewer-keys/code-reviewer.pem")
```

PEM contents returned. Dev signs locally with `node -e` or any inline crypto. No bash command issued. No path-pattern check fires.

### Bypass #3 — no nonce/freshness binding (security-reviewer finding from AISDLC-380 review)

The signed payload is `JSON.stringify({reviewerName, taskId, contentHash})` — three fields, no nonce, no signedAt-in-signature. Once a sub-attestation is signed for a given (reviewer, task, contentHash) tuple, it is forever valid. If a reviewer ever legitimately approves task X with verdict V, the resulting sub-attestation file (typically at `/tmp/<name>-sub-attestation.json`) can be REPLAYED for any future iteration of task X that produces the same contentHash. Dev subagent could observe a real sub-attestation on disk and re-use it.

### Bypass #4 — security-reviewer Option B exemption is unsigned (acknowledged gap)

AISDLC-380 Option B: security-reviewer cannot sign because its tool grant denies Bash. The verifier accepts unsigned-exempt entries when `reviewerName === 'security-reviewer'` AND `unsigned: true` AND `exemptReason: 'no-bash-tool'`. A dev subagent can mint a security-reviewer approval trivially — no signature required.

## Scope

Close all four bypasses. The fixes are interdependent and best landed together:

### Fix #1 — caller-identity binding via nonce challenge

The slash command body (the only place that legitimately invokes reviewer subagents) issues a per-review nonce challenge before spawning each reviewer. The nonce is a 32-byte random value the slash command body holds in memory. It is:

1. Passed to the reviewer subagent's prompt as part of the review context
2. Required by `sign-reviewer-verdict.mjs --nonce <hex>` (refuses to sign without it)
3. Recorded in the signed payload: `{reviewerName, taskId, contentHash, nonce}`
4. Verified by `verify-reviewer-sub-attestations.mjs` against the slash command body's nonce log at `<worktree>/.ai-sdlc/nonces/<task-id>.json`

A dev subagent cannot observe the nonce because the slash command body's session memory is isolated from subagent context. Replaying a stale sub-attestation fails because the nonce is per-review-session and the verifier checks it against the live nonce log.

### Fix #2 — Read-tool deny-list enforcement

Extend `.claude/hooks/enforce-blocked-actions.js` (and the plugin twin at `ai-sdlc-plugin/hooks/enforce-blocked-actions.js`) to dispatch on the `Read` tool. New behavior: for each `Read` invocation, check `file_path` against `agent-role.yaml` `blockedPaths` AND a NEW `blockedReadPaths` list. Reviewer key paths go in the new list.

```yaml
blockedReadPaths:
  - '~/.ai-sdlc/reviewer-keys/**'
  - '/Users/*/.ai-sdlc/reviewer-keys/**'
  - '/home/*/.ai-sdlc/reviewer-keys/**'
```

Path-pattern matching must handle `~` expansion AND absolute-path equivalents to defeat the "evade by absolute path" trick. Use the same glob semantics as the existing `blockedPaths`.

### Fix #3 — sign-helper privilege gate

`sign-reviewer-verdict.mjs` refuses to sign unless invoked from a process whose parent process is the reviewer subagent's harness wrapper. Implementation options:

- **(a)** Detect parent process via `process.ppid` + cross-reference with a per-session token the slash command body writes to a path only the harness reads (file ownership/mode based gate)
- **(b)** Cryptographic challenge: slash command body issues a short-lived JWT/HMAC token with the nonce; sign helper requires `--auth-token <hex>` matching the token; verifier checks against the nonce log
- **(c)** Sign-helper only callable via MCP server method (not bash CLI); MCP server distinguishes caller agent type

(b) composes naturally with Fix #1. Recommend (b).

### Fix #4 — security-reviewer signing path

Either:
- **(a)** Grant security-reviewer narrowly-scoped Bash limited to `node ai-sdlc-plugin/scripts/sign-reviewer-verdict.mjs` (check whether Claude Code plugin frontmatter supports per-command Bash allowlists)
- **(b)** Move security-reviewer's sub-attestation signing to a privileged MCP server method that security-reviewer (and only security-reviewer) can invoke via tool

(a) is simpler if supported. (b) is more isolated. Implementer decides during design.

### Fix #5 — CI cross-validation (rolls in AISDLC-380.1)

Update `.github/workflows/verify-attestation.yml` to cross-validate sub-attestation signatures + nonce binding against the registry. Update `.github/workflows/ai-sdlc-review.yml` to skip CI-side reviewers ONLY when sub-attestations pass registry verification AND nonce binding. (This is what AISDLC-380 deferred as #4 + #5.)

## Acceptance criteria

- [ ] #1 Slash command body issues a per-review nonce and persists it to `<worktree>/.ai-sdlc/nonces/<task-id>.json` before spawning reviewer subagents.
- [ ] #2 `sign-reviewer-verdict.mjs` requires `--nonce <hex>` AND `--auth-token <hex>` AND refuses to sign when either is missing or invalid.
- [ ] #3 Signed payload includes nonce: `{reviewerName, taskId, contentHash, nonce}`. Verifier cross-validates nonce against the live nonce log; rejects when nonce is unknown, already-consumed, or expired.
- [ ] #4 `.claude/hooks/enforce-blocked-actions.js` AND `ai-sdlc-plugin/hooks/enforce-blocked-actions.js` dispatch on the Read tool. New `blockedReadPaths` config key in agent-role.yaml is honored.
- [ ] #5 Reviewer key paths (`~/.ai-sdlc/reviewer-keys/**` + absolute-path equivalents) are denied to the dev subagent's Read invocations.
- [ ] #6 Security-reviewer can sign its sub-attestation (Option (a) per-command Bash allowlist OR Option (b) privileged MCP method). The unsigned-exempt Option B path from AISDLC-380 is REMOVED.
- [ ] #7 `.github/workflows/verify-attestation.yml` cross-validates sub-attestation signatures + nonce binding against the registry. Regression test fakes a forged verdict (sign-helper invocation without nonce) → workflow REJECTS.
- [ ] #8 `.github/workflows/ai-sdlc-review.yml` skips CI-side reviewers ONLY when registry verification + nonce binding succeed.
- [ ] #9 Hermetic regression test: dev subagent attempts (a) Read on reviewer key path → denied, (b) `node sign-reviewer-verdict.mjs ...` without nonce → refuses, (c) `node sign-reviewer-verdict.mjs --nonce <stale>` → verifier rejects.
- [ ] #10 Operator runbook updated: how the nonce challenge works, how to debug nonce-mismatch errors, how to onboard the new sign-helper auth-token flow.
- [ ] #11 New code reaches 80%+ patch coverage.

## Out of scope

- Full OS-level isolation (separate UNIX users for each subagent, sandbox-exec/seccomp). Future RFC scope.
- Hardware token / sigstore / TUF migration.
- Replacing local signing entirely with CI-side mandatory reviewer fanout (the operator declined this on 2026-05-20).

## Source

Three reviewer findings on PR AISDLC-380 (security-reviewer findings #1, #2, #5) + the Option B documented gap. The operator explicitly chose ship-AISDLC-380-as-partial on 2026-05-20 with this follow-up to be filed.

Reviewer findings reproduced here for traceability:
- security #1: `sign-reviewer-verdict.mjs` has zero caller-identity binding → bypass via direct node invocation
- security #2: `Read` tool isn't checked against `blockedActions` → bypass via direct key file read
- security #5: no nonce/freshness binding in signed payload → replay across sessions
- security #4 (Option B): security-reviewer Bash disallowed → either workflow break OR unsigned exemption (chosen for partial ship)
