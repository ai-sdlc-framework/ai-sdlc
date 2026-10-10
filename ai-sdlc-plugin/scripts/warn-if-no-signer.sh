#!/usr/bin/env bash
#
# AISDLC-556: `/ai-sdlc execute` Step 10 — warn (never block) when reviewer
# verdicts were written but no attestation signer is reachable.
#
# Problem: Step 10 writes `.ai-sdlc/verdicts/<task-id-lower>.json` and returns.
# In a repo where nothing ever invokes signing (no pre-push hook, no signing
# runtime) the PR silently carries no attestation. AISDLC-554 makes the signer
# fail loudly WHEN INVOKED; this closes the window where it is never invoked.
#
# Probe: `sign-attestation.mjs --print-content-hash` resolves the same
# attestation runtime the real signer uses and needs NO signing key. If the
# script is absent, or the runtime cannot be located, no signer is reachable.
# Any other probe failure (e.g. no origin/main yet) says nothing about signer
# availability, so it is treated as reachable (no warning).
#
# Usage: bash warn-if-no-signer.sh <verdict-file-path>
#
# FAIL OPEN: always exits 0. A missing signer must never block the pipeline.
#
# Test override: AI_SDLC_SIGNER_SCRIPT_DIR — directory holding
# sign-attestation.mjs (defaults to this script's own directory).

set -uo pipefail

VERDICT_PATH="${1:-<verdict file>}"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNER_DIR="${AI_SDLC_SIGNER_SCRIPT_DIR:-$SELF_DIR}"
SIGNER="$SIGNER_DIR/sign-attestation.mjs"

warn() {
  echo "[warn-if-no-signer] WARNING: verdicts written to $VERDICT_PATH, but no attestation signer is available in this repo ($1) - the PR will carry no attestation." >&2
  echo "[warn-if-no-signer]   verify-attestation CI cannot pass without a signer. See ai-sdlc-plugin/README.md \"Attestation prerequisites\"." >&2
}

if [ ! -f "$SIGNER" ]; then
  warn "sign-attestation.mjs not found at $SIGNER"
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  warn "node not found on PATH"
  exit 0
fi

PROBE_OUT="$(node "$SIGNER" --print-content-hash 2>&1)"
if printf '%s' "$PROBE_OUT" | grep -q "Cannot locate the AI-SDLC"; then
  warn "attestation runtime not installed"
fi

exit 0
