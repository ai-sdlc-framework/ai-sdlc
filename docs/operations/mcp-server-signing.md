# MCP Server Tarball Signing — Operator Runbook

> AISDLC-439 (DEC-0001) — supply-chain attestation for `@ai-sdlc/plugin-mcp-server`

## Overview

Every release of `@ai-sdlc/plugin-mcp-server` published to npm is accompanied by a
DSSE (Dead Simple Signing Envelope) attestation that signs the tarball's SHA-512.
The signed envelope is committed to `.ai-sdlc/attestations/mcp-server-<version>.dsse.json`
so install-time verifiers can fetch it via `git pull` without external infrastructure.

At every Claude Code SessionStart, `ai-sdlc-plugin/hooks/check-plugin-version.js`
verifies the installed MCP server binary's signature against this envelope. If the
signature is invalid or the SHA does not match, a red warning is printed to stderr.

**Trust root**: the same `~/.ai-sdlc/signing-key.pem` + `.ai-sdlc/trusted-reviewers.yaml`
pubkey set used by v6 review attestations (DEC-0001 rationale: ONE policy-stable trust
anchor, not GitHub OIDC, not npm provenance, not a new key).

## Release workflow (automatic)

`.github/workflows/release.yml` runs the sign step automatically after `pnpm -r publish`:

1. Resolves the published version from `ai-sdlc-plugin/mcp-server/package.json`.
2. Waits 15 seconds for npm registry propagation.
3. Runs `scripts/sign-mcp-tarball.mjs` which:
   - Fetches the tarball from `https://registry.npmjs.org`.
   - Computes SHA-512 of the tarball bytes.
   - Builds a DSSE predicate (`predicateType: https://ai-sdlc.io/mcp-server-tarball/v1`).
   - Signs it with the `AISDLC_SIGNING_KEY` repository secret (ed25519 private key).
   - Writes `.ai-sdlc/attestations/mcp-server-<version>.dsse.json`.
4. Commits the envelope back to `main`.

If `AISDLC_SIGNING_KEY` is not set, the step emits a `::warning::` and continues
(soft-fail). The npm publish still succeeds; you can re-run the sign step manually.

## Initial setup — repository secret

The `AISDLC_SIGNING_KEY` repository secret must contain the PEM-encoded ed25519
private key that corresponds to one of the public keys in
`.ai-sdlc/trusted-reviewers.yaml`.

```bash
# Generate a dedicated release signing key (if you don't already have one).
openssl genpkey -algorithm ed25519 -out release-signing-key.pem

# Extract the public key and format it for trusted-reviewers.yaml.
openssl pkey -in release-signing-key.pem -pubout

# Add to GitHub secrets.
gh secret set AISDLC_SIGNING_KEY < release-signing-key.pem

# Add the public key entry to .ai-sdlc/trusted-reviewers.yaml and open a PR.
```

The public key entry in `trusted-reviewers.yaml` uses the strict format:

```yaml
  - identity: 'release-bot@ai-sdlc.io'
    machine: 'ci-runner'
    addedAt: '2026-05-26'
    addedBy: 'deefactorial'
    pubkey: |
      -----BEGIN PUBLIC KEY-----
      <base64-encoded pubkey>
      -----END PUBLIC KEY-----
```

## Manual sign step (recovery)

If the automatic sign step failed or was skipped:

```bash
# 1. Set the signing key path (or export AISDLC_SIGNING_KEY_PATH).
export AISDLC_SIGNING_KEY_PATH=~/.ai-sdlc/signing-key.pem

# 2. Run the sign script.
node scripts/sign-mcp-tarball.mjs --version <VERSION>

# 3. Commit the envelope.
git add .ai-sdlc/attestations/mcp-server-<VERSION>.dsse.json
git commit -m "chore(release): sign @ai-sdlc/plugin-mcp-server@<VERSION> tarball DSSE envelope (AISDLC-439)"
git push origin main
```

## Manual verification

Use the standalone verifier to check an installed tarball end-to-end:

```bash
# 1. Download the tarball from npm (or use the one already installed).
npm pack @ai-sdlc/plugin-mcp-server@<VERSION> --pack-destination /tmp

# 2. Run the verifier.
node scripts/verify-mcp-tarball.mjs \
  --version <VERSION> \
  --tarball /tmp/ai-sdlc-plugin-mcp-server-<VERSION>.tgz \
  --envelope .ai-sdlc/attestations/mcp-server-<VERSION>.dsse.json \
  --trusted-reviewers .ai-sdlc/trusted-reviewers.yaml

# Expected output (success):
# [verify-mcp-tarball] attestation VALID for <VERSION> (signer: release-bot@ai-sdlc.io)
# status=valid
```

## Verification flow at SessionStart

`check-plugin-version.js` performs a fast local check on every SessionStart:

1. Reads the installed MCP server version from
   `$CLAUDE_PLUGIN_ROOT/node_modules/@ai-sdlc/plugin-mcp-server/package.json`.
2. Loads the envelope from
   `$CLAUDE_PLUGIN_ROOT/.ai-sdlc/attestations/mcp-server-<version>.dsse.json`.
3. Validates the DSSE signature against all pubkeys in
   `$CLAUDE_PLUGIN_ROOT/.ai-sdlc/trusted-reviewers.yaml`.
4. On success: silent (logs to stderr in debug mode only).
5. On failure: prints a red operator-actionable error and hints at recovery.

**Soft-fail by default**: SessionStart is never blocked. Use
`AI_SDLC_TARBALL_VERIFY_HARD_FAIL=1` for strict mode (exits 1 on failure).

**Skip verification**: `AI_SDLC_SKIP_TARBALL_VERIFY=1` (local dev, unsigned builds).

## Error messages and recovery

### Envelope missing

```
⚠ ai-sdlc: MCP server tarball attestation missing for v<VERSION>.
  Expected: .ai-sdlc/attestations/mcp-server-<VERSION>.dsse.json
  Run: git -C "$CLAUDE_PLUGIN_ROOT" pull --ff-only  to refresh.
```

The signed envelope was not committed. Recovery:

```bash
git -C "$CLAUDE_PLUGIN_ROOT" pull --ff-only
```

If still missing, run the manual sign step above.

### SHA mismatch

```
SECURITY WARNING: ai-sdlc MCP server tarball signature INVALID for v<VERSION>.
  Signed SHA-512:    <expected>
  Installed SHA-512: <actual>
```

The installed tarball differs from what was signed. This indicates either:
- The npm registry served a different tarball (possible tamper — **investigate**).
- A local file was corrupted during installation.

Recovery:
```bash
# Re-install from the registry.
npm install @ai-sdlc/plugin-mcp-server@<VERSION> --registry https://registry.npmjs.org

# Verify the registry's own integrity record.
npm view @ai-sdlc/plugin-mcp-server@<VERSION> dist.integrity

# If the SHA still does not match the envelope, open a security issue.
```

### Signature invalid (pubkey-not-trusted)

```
SECURITY WARNING: ai-sdlc MCP server tarball signature INVALID for v<VERSION>.
  No trusted key matched the DSSE signature.
```

The envelope was signed by a key not in `trusted-reviewers.yaml`. Recovery:

1. Check whether the signing key was recently rotated:
   ```bash
   git log --oneline -- .ai-sdlc/trusted-reviewers.yaml
   ```
2. If the key was rotated, fetch the new envelope signed by the current key:
   ```bash
   git -C "$CLAUDE_PLUGIN_ROOT" pull --ff-only
   ```
3. If you believe this is a false positive, open an issue at
   https://github.com/ai-sdlc-framework/ai-sdlc/issues.

## Key rotation

When rotating the release signing key:

1. Generate a new key pair:
   ```bash
   openssl genpkey -algorithm ed25519 -out new-release-signing-key.pem
   openssl pkey -in new-release-signing-key.pem -pubout
   ```

2. Add the new public key to `.ai-sdlc/trusted-reviewers.yaml` (keep the old
   one in place during the transition window).

3. Update the `AISDLC_SIGNING_KEY` GitHub secret to the new private key.

4. Open a PR with the `trusted-reviewers.yaml` change. After it merges, existing
   envelopes signed by the old key remain valid (they still verify against the
   old pubkey which is still in the file).

5. On the NEXT release, the new key signs the envelope. After one full release
   cycle, you can remove the old pubkey entry in a follow-up PR.

**Do NOT** remove the old pubkey entry until at least one release has been signed
by the new key and operators have had time to pull the updated attestation file.

## Predicate schema

The DSSE payload is a JSON document with the following structure:

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [
    {
      "name": "@ai-sdlc/plugin-mcp-server@<version>",
      "digest": { "sha512": "<hex>" }
    }
  ],
  "predicateType": "https://ai-sdlc.io/mcp-server-tarball/v1",
  "predicate": {
    "schemaVersion": "v1",
    "packageName": "@ai-sdlc/plugin-mcp-server",
    "version": "<semver>",
    "registry": "https://registry.npmjs.org",
    "tarballUrl": "https://registry.npmjs.org/@ai-sdlc/plugin-mcp-server/-/...",
    "sha512": "<lowercase hex SHA-512 of tarball bytes>",
    "signedAt": "<ISO 8601 timestamp>",
    "signerIdentity": "<email or username>",
    "machine": "<hostname>"
  }
}
```

The DSSE envelope wraps this as:
```json
{
  "payload": "<base64(JSON predicate)>",
  "payloadType": "https://ai-sdlc.io/mcp-server-tarball/v1",
  "signatures": [{ "keyid": "<identity:machine>", "sig": "<base64(ed25519 sig of PAE)>" }]
}
```

PAE (Pre-Authentication Encoding):
`DSSEv1 <len(payloadType)> <payloadType> <len(payload)> <payload>`

## Non-goals

- Signing other npm packages (only `@ai-sdlc/plugin-mcp-server` in AISDLC-439;
  `@ai-sdlc/pipeline-cli` etc. are tracked as follow-up tasks).
- Replacing npm registry trust — this layer ADDS to it for defense-in-depth.
- Migrating away from `trusted-reviewers.yaml` — it is the single trust anchor
  for all AI-SDLC attestations per DEC-0001.
