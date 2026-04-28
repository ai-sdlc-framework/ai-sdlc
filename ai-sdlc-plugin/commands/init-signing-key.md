---
name: init-signing-key
description: Generate this contributor's ed25519 signing key for review attestations. Run once per machine before /ai-sdlc execute.
argument-hint: '[--force]'
allowed-tools: Bash, Read
model: inherit
---

Generate a per-machine ed25519 signing key used by `/ai-sdlc execute` Step 10
to sign review attestations (DSSE envelopes). The matching public key gets
added to `.ai-sdlc/trusted-reviewers.yaml` via a follow-up onboarding PR — CI
verifies signatures against that committed file and skips its own duplicate
review when the attestation is valid (AISDLC-74).

## When to run this

You only need to run this **once per machine** before your first `/ai-sdlc
execute`. If `/ai-sdlc execute` errors out with `signing-key not found`, run
this command, open the suggested onboarding PR, and re-run `/ai-sdlc execute`
once that PR merges.

## What this does

1. Generates an ed25519 keypair via Node's built-in `crypto.generateKeyPairSync`.
2. Writes the **private** key to `~/.ai-sdlc/signing-key.pem` with mode `0600`.
   The private key never leaves your machine and is never committed.
3. Prints the **public** key in PEM format plus a copy-pasteable
   `.ai-sdlc/trusted-reviewers.yaml` entry that you commit to a follow-up PR.

If the file already exists, the command **refuses to overwrite** unless you
pass `--force`. Overwriting silently would invalidate every prior attestation
this machine signed (the matching pubkey in `trusted-reviewers.yaml` is now
stale and CI will reject new envelopes from this machine).

## Usage

```bash
/ai-sdlc init-signing-key
# Generates ~/.ai-sdlc/signing-key.pem (refuses if it already exists).

/ai-sdlc init-signing-key --force
# Replaces the existing key. You must then open a PR removing the old
# trusted-reviewers entry and adding the new one.
```

## Implementation contract

```bash
KEY_PATH="$HOME/.ai-sdlc/signing-key.pem"
PUB_PATH="$HOME/.ai-sdlc/signing-key.pub.pem"
FORCE_FLAG=""
if [ "$ARGUMENTS" = "--force" ]; then
  FORCE_FLAG="--force"
fi

mkdir -p "$HOME/.ai-sdlc"
chmod 700 "$HOME/.ai-sdlc"

if [ -f "$KEY_PATH" ] && [ -z "$FORCE_FLAG" ]; then
  echo "ERROR: $KEY_PATH already exists. Pass --force to overwrite (this will"
  echo "       invalidate every attestation signed by the existing key)."
  exit 1
fi

# Use Node's built-in crypto via the plugin's helper (no extra deps).
# The helper writes BOTH the private key (mode 0600) and the public key
# (mode 0644) and prints the trusted-reviewers entry to stdout.
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-signing-key.mjs" $FORCE_FLAG
```

When the helper exits cleanly, surface the printed onboarding-PR
instructions verbatim — the contributor needs the exact YAML block to paste
into `.ai-sdlc/trusted-reviewers.yaml`.

## Hard rules (NEVER violate)

1. **Never commit the private key.** `~/.ai-sdlc/signing-key.pem` lives outside
   any git repo; the helper refuses to write inside the repo.
2. **Never overwrite without `--force`.** Silent overwrite breaks every prior
   attestation. The error message must point at `--force` and explain the
   blast radius.
3. **Never print the private key to stdout.** Only the public key + onboarding
   instructions go to the operator's terminal.
4. **Never disable mode `0600` on the private key.** Other users on the machine
   should not be able to read it.
