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

Store the **key content** (the PEM itself) as a GitHub Actions secret named
`AISDLC_SIGNING_KEY_CONTENT`. The bundled `untrusted-pr-gate.yml` materializes it into
a `0600` temp file inside the clean-room (Stage 4) job and passes that path to the
signer — so you store the key once and the workflow handles the rest.

```bash
# Using GitHub CLI to set the secret (reads the PEM content from the file):
gh secret set AISDLC_SIGNING_KEY_CONTENT < aisdlc-signing-key.pem
```

The workflow's clean-room job already contains this materialization step (no edit
needed — shown here so you can audit it). Note the **secure pattern**: the secret is
passed via `env:` (never interpolated into the shell body, which would leak it to the
build log / shell-metacharacter surface), written with `printf` (preserves PEM
newlines, unlike `echo`), and the file is created `0600`:

```yaml
- name: Materialize signing key (clean room only)
  env:
    AISDLC_SIGNING_KEY_CONTENT: ${{ secrets.AISDLC_SIGNING_KEY_CONTENT }}
  run: |
    KEYFILE="$(mktemp)"
    chmod 600 "$KEYFILE"
    printf '%s' "$AISDLC_SIGNING_KEY_CONTENT" > "$KEYFILE"
    echo "AISDLC_SIGNING_KEY_PATH=$KEYFILE" >> "$GITHUB_ENV"
```

> **Why content, not a path:** a GitHub Secret holding a filesystem *path* is useless on
> an ephemeral runner (the key file isn't there). Store the PEM content; the workflow
> writes it to the `AISDLC_SIGNING_KEY_PATH` env at run time, materialized ONLY in the
> clean-room job — never in the sandbox job (RFC-0043 §Stage 4 boundary).
>
> **Never** `echo "${{ secrets.* }}"` a private key into a file or interpolate a secret
> directly into a `run:` script body — use the `env:`-passing + `printf` pattern above.

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
