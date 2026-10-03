#!/usr/bin/env bash
# AISDLC-687: pre-push dark-code gate. Runs `node scripts/check-dark-code.mjs` (the same
# static scan CI runs through `pnpm test`) so a newly dark module (no non-test importer and no
# barrel re-export), a grown dark baseline, or a new test double in production code blocks the
# push locally instead of failing CI. Cheap (static scan, no build), so it runs BEFORE the
# coverage gate.
#
# Skip with AI_SDLC_SKIP_DARK_CODE_GATE=1. Emergency: AI_SDLC_BYPASS_ALL_GATES=1.

set -euo pipefail

if [ "${AI_SDLC_BYPASS_ALL_GATES:-0}" = "1" ]; then
  echo "[dark-code-gate] AI_SDLC_BYPASS_ALL_GATES=1 — skipping" >&2
  exit 0
fi

if [ "${AI_SDLC_SKIP_DARK_CODE_GATE:-}" = "1" ]; then
  echo "[dark-code-gate] AI_SDLC_SKIP_DARK_CODE_GATE=1 — skipping" >&2
  exit 0
fi

# The checker scans relative to the working tree root.
cd "$(git rev-parse --show-toplevel)"

if [ ! -f scripts/check-dark-code.mjs ]; then
  exit 0
fi

if ! node scripts/check-dark-code.mjs; then
  echo "" >&2
  echo "[dark-code-gate] Push blocked: a module is newly unwired (or the baseline grew)." >&2
  echo "  Wire the module (import it from non-test code or a barrel), or see CLAUDE.md" >&2
  echo "  \"Dark-code gate (AISDLC-552)\". Escape: AI_SDLC_SKIP_DARK_CODE_GATE=1 git push" >&2
  exit 1
fi
