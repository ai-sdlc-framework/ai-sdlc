# Reviewer Signing Key Runbook (AISDLC-380)

This runbook documents how to manage per-reviewer signing keys for the
sub-attestation trust chain introduced in AISDLC-380.

## Background

The 2026-05-20 incident showed that dev subagents can write forged approval
entries in `.ai-sdlc/verdicts/<task-id>.json`. The pre-push hook
(`scripts/check-attestation-sign.sh`) trusted this file unconditionally and
signed the outer DSSE envelope with the operator's key — making the forgery
cryptographically indistinguishable from a real 3-reviewer run.

The fix (AISDLC-380) adds a **reviewer-side signature layer**:

- Each reviewer subagent signs its own verdict with a per-role private key.
- `scripts/check-attestation-sign.sh` verifies every sub-attestation's
  signature against `.ai-sdlc/trusted-reviewers.yaml` BEFORE calling
  `sign-attestation.mjs`.
- A dev subagent cannot mint a valid reviewer sub-attestation without
  access to the reviewer's private key.

### Trust chain (post-AISDLC-380)

```
reviewer key  →  sub-attestation  (reviewer ran + signed its verdict)
operator key  →  DSSE envelope    (operator signed the aggregate after
                                    sub-attestation verification passed)
CI            →  validates BOTH   (outer envelope + sub-attestations)
```

### Residual risk

Reviewer keys live at `~/.ai-sdlc/reviewer-keys/<reviewer-name>.pem`.
On a single-UID filesystem, a dev subagent with Bash access could in
principle read those files. The `agent-role.yaml` `blockedActions` list
denies Bash commands containing the path substring `reviewer-keys` to
raise the bar from "trivial accident" to "deliberate custom scripting".

**Full isolation** (separate UNIX users, subprocess privilege separation)
is out of scope. The practical defense is: a dev subagent that forks a
child process to bypass `blockedActions` is taking a deliberate, logged,
reviewable action that a human operator can detect in the hook logs.

---

## Onboarding a new reviewer signing key

### Step 1 — Generate the keypair

Run on the machine that will execute the reviewer subagent:

```bash
node ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs \
  --reviewer-name <name>
```

Valid `<name>` values: `code-reviewer`, `test-reviewer`, `security-reviewer`,
`code-reviewer-codex`, `test-reviewer-codex`.

This writes:
- `~/.ai-sdlc/reviewer-keys/<name>.pem`  (private, mode 0600)
- `~/.ai-sdlc/reviewer-keys/<name>.pub.pem`  (public, mode 0644)

It also prints a YAML block for the next step.

### Step 2 — Add the public key to trusted-reviewers.yaml

Copy the printed YAML block and append it under the `reviewers:` list in
`.ai-sdlc/trusted-reviewers.yaml`. The entry looks like:

```yaml
  - type: 'reviewer'
    reviewer: 'code-reviewer'
    machine: 'doms-macbook'
    addedAt: '2026-05-20'
    addedBy: 'REPLACE_WITH_YOUR_GITHUB_HANDLE'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      <base64 public key data>
      -----END PUBLIC KEY-----
```

**Format requirements** (enforced by the hand-rolled YAML loader in
`scripts/verify-reviewer-sub-attestations.mjs`):

- Every scalar value must be single-quoted.
- `pubkey:` must be a `|` block scalar with each PEM line indented exactly 6 spaces.
- No tab characters.
- Comments only at column 0.

### Step 3 — Open a PR with the YAML change

A maintainer reviews the entry and merges. After merge:

- `check-attestation-sign.sh` calls `verify-reviewer-sub-attestations.mjs`
  which verifies sub-attestations against the new registry entry.
- The reviewer subagent invokes `sign-reviewer-verdict.mjs` at the end
  of its review to produce the signed sub-attestation.

---

## Revoking a compromised reviewer signing key

If a reviewer key is compromised (machine stolen, key file leaked):

### Step 1 — Remove the registry entry

Open a PR deleting the `type: 'reviewer'` entry for the compromised key
from `.ai-sdlc/trusted-reviewers.yaml`. After merge:

- Any PR with sub-attestations signed by the old key is rejected by
  `verify-reviewer-sub-attestations.mjs` (signature lookup fails).
- CI's `verify-attestation.yml` will also reject (when AC #4 is implemented).

### Step 2 — Generate a new keypair

Run `init-reviewer-signing-key.mjs --reviewer-name <name> --force` on
a safe machine. Add the new public key via a PR (Step 2 above).

### Step 3 — Re-run affected reviewers

Any open PRs whose verdict files contain sub-attestations from the
compromised key must be re-reviewed. The hook will refuse to sign those
PRs until valid sub-attestations replace the compromised ones.

Use the emergency escape hatch (temporary, one-time) if you need to push
before re-review is complete:

```bash
AI_SDLC_LEGACY_VERDICTS=1 git push
```

This bypasses sub-attestation verification with a warning in the pre-push
output. Remove this flag immediately after re-review completes.

---

## How the trust chain composes

```
┌─────────────────────────────────────────────────────────────────────┐
│                         REVIEWER SUBAGENT                           │
│  1. Runs review (code/test/security) → produces verdict JSON        │
│  2. Invokes sign-reviewer-verdict.mjs with:                         │
│       --reviewer-name <name>                                         │
│       --task-id <AISDLC-NNN>                                        │
│       --verdict-json <json>                                          │
│  3. Script reads ~/.ai-sdlc/reviewer-keys/<name>.pem               │
│  4. Signs: ed25519({ reviewerName, taskId, contentHash })           │
│  5. Writes sub-attestation JSON to /tmp/<name>-sub-attestation.json │
└─────────────────────────────────────────────────────────────────────┘
                              │
                 slash command body reads sub-attestation path
                 composes aggregate verdict file:
                 .ai-sdlc/verdicts/<task-id>.json = { taskId, subAttestations: [...] }
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      PRE-PUSH HOOK                                  │
│  (.husky/pre-push → scripts/check-attestation-sign.sh)             │
│                                                                     │
│  Step 4d: verify-reviewer-sub-attestations.mjs                     │
│    for each subAttestation:                                         │
│      1. Look up reviewer in trusted-reviewers.yaml                  │
│      2. Verify ed25519 signature against pubkey                     │
│      3. Verify contentHash matches verdict JSON                     │
│      4. Verify taskId binding matches active task                   │
│    If ANY fails → exit 2 (hook refuses to sign)                     │
│                                                                     │
│  Step 5: sign-attestation.mjs                                       │
│    Reads ~/.ai-sdlc/signing-key.pem (OPERATOR key)                 │
│    Signs the DSSE envelope                                          │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                            CI                                       │
│  verify-attestation.yml                                             │
│    Validates outer DSSE envelope signature (operator key)           │
│    (AC #4: will also verify sub-attestations — AISDLC-380.1)       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Backward compatibility

Teams that haven't yet onboarded reviewer signing keys can use the
**legacy escape hatch** to continue pushing during the transition:

```bash
AI_SDLC_LEGACY_VERDICTS=1 git push
```

This:
- Accepts plain-JSON verdict files (no sub-attestation block)
- Emits a warning naming the transition steps
- Adds a `legacy: true` marker in the hook's stderr (visible to the operator)
- Does NOT add any marker to the commit or DSSE envelope

**Timeline for legacy support:**
- Available until maintainers explicitly remove the `AI_SDLC_LEGACY_VERDICTS`
  check from `verify-reviewer-sub-attestations.mjs`.
- Recommended transition: onboard reviewer keys for your 3 canonical reviewers,
  then remove the env-var from any CI or push scripts.

---

## Troubleshooting

### "sub-attestation for 'code-reviewer' has no matching entry"

The public key for this reviewer is not in `.ai-sdlc/trusted-reviewers.yaml`.
Run `init-reviewer-signing-key.mjs` and add the entry.

### "sub-attestation for 'code-reviewer' signature does not match any trusted pubkey"

Either the verdict was tampered after signing, or the reviewer key on
disk doesn't match the registry. Check that `~/.ai-sdlc/reviewer-keys/code-reviewer.pem`
matches the pubkey in the YAML. If the machine rotated keys, the old PR's
sub-attestations may need to be re-generated.

### "verdict file uses legacy plain-JSON shape"

The reviewer subagents that ran haven't been updated to emit sub-attestations
(AISDLC-380), or they ran before the signing key was set up. Options:

1. Re-run the reviewer subagents (they will now emit sub-attestations).
2. Use `AI_SDLC_LEGACY_VERDICTS=1 git push` as a one-time escape.

### "code-reviewer signing key not found"

The reviewer subagent printed this error during its review. The private key
at `~/.ai-sdlc/reviewer-keys/code-reviewer.pem` is missing. Run:

```bash
node ai-sdlc-plugin/scripts/init-reviewer-signing-key.mjs --reviewer-name code-reviewer
```

Then add the public key to `.ai-sdlc/trusted-reviewers.yaml` and merge the PR.
