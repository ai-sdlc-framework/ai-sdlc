# Signing Key Setup for UCVG (Stage 4 Clean-Room Attestation)

The Stage 4 clean-room signer uses an ed25519 key to sign the attestation envelope
(RFC-0042 v6 Merkle attestation). The key must be generated once and wired as a
GitHub Actions secret. It is never present in the sandbox environment.

## Prerequisites

- OpenSSL 3.x or newer (`openssl version` to check)
- Write access to your repository's GitHub Secrets

## Step 1 — Generate the ed25519 key pair

```bash
# Generate the private key (PEM format)
openssl genpkey -algorithm ed25519 -out aisdlc-signing-key.pem

# Extract the public key (for verification)
openssl pkey -in aisdlc-signing-key.pem -pubout -out aisdlc-signing-key.pub.pem

# Verify the key pair
openssl pkey -in aisdlc-signing-key.pem -text -noout
```

## Step 2 — Wire the private key as a GitHub secret

The private key must be stored as a GitHub Actions secret named `AISDLC_SIGNING_KEY_PATH`.

> **IMPORTANT**: The workflow passes `AISDLC_SIGNING_KEY_PATH` as the path to the key
> file — the secret contains the PATH, not the key content itself. The key content is
> written to a temp file by the workflow and the path is passed to the CLI.

Alternative: store the key content as `AISDLC_SIGNING_KEY_CONTENT` and write it to a
temp file in a workflow step before calling the signer.

```bash
# Using GitHub CLI to set the secret:
gh secret set AISDLC_SIGNING_KEY_CONTENT < aisdlc-signing-key.pem
```

Then in the clean-room-sign workflow step:
```yaml
- name: Write signing key to temp file
  run: |
    KEYFILE=$(mktemp)
    echo "${{ secrets.AISDLC_SIGNING_KEY_CONTENT }}" > "$KEYFILE"
    echo "AISDLC_SIGNING_KEY_PATH=$KEYFILE" >> "$GITHUB_ENV"
```

## Step 3 — Store the public key in .ai-sdlc/trusted-reviewers.yaml

The public key is needed by the verifier (`verify-attestation.yml`). Add it to your
repository's `.ai-sdlc/trusted-reviewers.yaml`:

```yaml
signingKeys:
  - name: 'primary-signing-key'
    publicKeyPem: |
      -----BEGIN PUBLIC KEY-----
      <paste the content of aisdlc-signing-key.pub.pem here>
      -----END PUBLIC KEY-----
```

## Step 4 — Set the feature flag

In your repository's GitHub settings, set a repository variable (not secret):

```
Name:  AI_SDLC_UNTRUSTED_PR_GATE
Value: 1
```

This enables the gate. Without this variable, the gate is in `off` mode and posts
a neutral success status (skipped).

## Security considerations

- **Never commit the private key file.** Add `aisdlc-signing-key.pem` to `.gitignore`.
- The signing key is only available in Stage 4 (clean-room job). It is never injected
  into the Stage 2/3 sandbox environment (RFC-0043 §Stage 4 trust boundary).
- Rotate the key annually or when team membership changes significantly.
- The public key in `trusted-reviewers.yaml` can be changed via a normal PR; the
  private key rotation only requires updating the GitHub Secret.
