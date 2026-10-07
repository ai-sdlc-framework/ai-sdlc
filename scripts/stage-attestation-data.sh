#!/usr/bin/env bash
# stage-attestation-data.sh (AISDLC-704.6)
#
# Materialise the attestation DATA files of a PR head commit into the current
# working tree WITHOUT checking the head out. Used by verify-attestation.yml's
# pull_request_target path: the head commit objects are already in the local git
# store (fetched by the workflow), and this script reads blobs with
# `git ls-tree` / `git show`. No GitHub API calls, no directory listing cap.
#
# Staged (regular blobs only, mode 100644/100755 -- never symlinks/submodules):
#   .ai-sdlc/attestations/<40hex>[.v6].dsse.json
#   .ai-sdlc/transcript-leaves/<40hex>.jsonl
#   .ai-sdlc/transcript-leaves.jsonl
# The strict filename regexes are the path-traversal guard; signature
# verification by the downstream verifier remains the trust boundary. Nothing
# staged is ever executed.
#
# Env: HEAD_SHA (required, 40 lowercase hex). Run from the repo root.
# Exit non-zero (with ::error::) when the head commit is not present locally
# or a blob cannot be read; an absent directory is fine.
set -euo pipefail

if ! [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::unexpected head sha"
  exit 1
fi
if ! git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
  echo "::error::head commit ${HEAD_SHA} is not present in the local git store"
  exit 1
fi

# stage_blob <repo-path> <dest-path>
stage_blob() {
  local src="$1" dest="$2"
  mkdir -p -- "$(dirname -- "$dest")"
  if ! git show "${HEAD_SHA}:${src}" > "${dest}.tmp"; then
    rm -f -- "${dest}.tmp"
    echo "::error::failed to read ${src} at ${HEAD_SHA}"
    exit 1
  fi
  mv -- "${dest}.tmp" "$dest"
}

# stage_dir <repo-dir> <filename-regex>; prints the staged count on stdout.
stage_dir() {
  local rdir="$1" re="$2" count=0 entry meta path name mode type
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    mode="${meta%% *}"
    type="${meta#* }"; type="${type%% *}"
    name="${path#"${rdir}/"}"
    [[ "$type" == "blob" ]] || continue
    [[ "$mode" == "100644" || "$mode" == "100755" ]] || continue
    [[ "$name" =~ $re ]] || continue
    stage_blob "$path" "$path"
    count=$((count + 1))
  done < <(git ls-tree -z "${HEAD_SHA}" -- "${rdir}/")
  echo "$count"
}

ENVELOPES=$(stage_dir ".ai-sdlc/attestations" '^[0-9a-f]{40}(\.v6)?\.dsse\.json$')
echo "[verify-attestation] staged ${ENVELOPES} envelope(s) from PR head via git objects" >&2
if [ "$ENVELOPES" = "0" ]; then
  echo "[verify-attestation] no envelopes in .ai-sdlc/attestations at PR head -- verifier will report missing" >&2
fi

# Legacy shared transcript-leaves.jsonl (pre-AISDLC-421 fallback).
LEGACY=$(git ls-tree -z "${HEAD_SHA}" -- ".ai-sdlc/transcript-leaves.jsonl" | tr '\0' '\n')
if [[ "$LEGACY" =~ ^(100644|100755)\ blob\  ]]; then
  stage_blob ".ai-sdlc/transcript-leaves.jsonl" ".ai-sdlc/transcript-leaves.jsonl"
  echo "[verify-attestation] staged transcript-leaves.jsonl from PR head" >&2
fi

LEAVES=$(stage_dir ".ai-sdlc/transcript-leaves" '^[0-9a-f]{40}\.jsonl$')
if [ "$LEAVES" != "0" ]; then
  echo "[verify-attestation] staged ${LEAVES} per-patch-id transcript-leaves file(s) from PR head" >&2
fi
