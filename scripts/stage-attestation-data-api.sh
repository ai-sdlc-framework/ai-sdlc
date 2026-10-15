#!/usr/bin/env bash
# stage-attestation-data-api.sh (AISDLC-833)
#
# Materialise the attestation DATA files of a PR head commit into the current
# working tree using ONLY the GitHub REST API (git trees + blobs). The head is
# never fetched into the local git store and never checked out, so a privileged
# workflow_run job holds no untrusted code (CodeQL actions/untrusted-checkout).
# Same file set and strict filename regexes as stage-attestation-data.sh; only
# regular blobs are written; nothing staged is ever executed.
#
# Env: HEAD_SHA (40 lowercase hex), REPO (owner/name of the base repo; fork
# commits resolve through the base repo's object network), GH_TOKEN.
set -euo pipefail

if ! [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::unexpected head sha"; exit 1
fi
if ! [[ "${REPO:-}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "::error::unexpected repository name"; exit 1
fi

TREE=$(gh api "repos/${REPO}/git/trees/${HEAD_SHA}?recursive=1") \
  || { echo "::error::failed to read tree of ${HEAD_SHA}"; exit 1; }

count=0
while IFS=$'\t' read -r path blob; do
  [ -n "$path" ] || continue
  mkdir -p -- "$(dirname -- "$path")"
  gh api "repos/${REPO}/git/blobs/${blob}" --jq '.content' | base64 -d > "${path}.tmp" \
    || { rm -f -- "${path}.tmp"; echo "::error::failed to read ${path}"; exit 1; }
  mv -- "${path}.tmp" "$path"
  count=$((count + 1))
done < <(printf '%s' "$TREE" | jq -r '
  .tree[]
  | select(.type == "blob" and (.mode == "100644" or .mode == "100755"))
  | select(.path | test("^\\.ai-sdlc/attestations/[0-9a-f]{40}(\\.v6)?\\.dsse\\.json$")
      or test("^\\.ai-sdlc/transcript-leaves/[0-9a-f]{40}\\.jsonl$")
      or . == ".ai-sdlc/transcript-leaves.jsonl")
  | [.path, .sha] | @tsv')
echo "[verify-attestation] staged ${count} data file(s) from PR head via API" >&2
