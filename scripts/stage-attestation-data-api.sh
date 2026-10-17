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
# Env: HEAD_SHA and BASE_SHA (40 lowercase hex), REPO (owner/name of the base repo; fork
# commits resolve through the base repo's object network), GH_TOKEN.
set -euo pipefail

if ! [[ "${HEAD_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::unexpected head sha"; exit 1
fi
if ! [[ "${BASE_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::unexpected base sha"; exit 1
fi
if ! [[ "${REPO:-}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "::error::unexpected repository name"; exit 1
fi

# AISDLC-954: the Actions token allows 1,000 requests/hour/repo, so the staged
# set is the minimum the verifier reads: the envelope(s) the PR adds (present
# in the head tree, absent from the base tree), the shared leaf index, and the
# per-patch-id leaf file named like each added envelope. Two tree reads plus one
# blob read per selected file; the rest of the repository's attestations are
# never fetched.
HEAD_TREE=$(gh api "repos/${REPO}/git/trees/${HEAD_SHA}?recursive=1") \
  || { echo "::error::failed to read tree of ${HEAD_SHA}"; exit 1; }
BASE_TREE=$(gh api "repos/${REPO}/git/trees/${BASE_SHA}?recursive=1") \
  || { echo "::error::failed to read tree of ${BASE_SHA}"; exit 1; }
if [ "$(printf '%s' "$HEAD_TREE" | jq -r '.truncated // false')" = "true" ]; then
  echo "::error::tree of ${HEAD_SHA} is truncated"; exit 1
fi

TMP_BASE=$(mktemp)
trap 'rm -f -- "$TMP_BASE"' EXIT
printf '%s' "$BASE_TREE" | jq '[.tree[].path]' > "$TMP_BASE"

count=0
while IFS=$'\t' read -r path blob; do
  [ -n "$path" ] || continue
  mkdir -p -- "$(dirname -- "$path")"
  gh api "repos/${REPO}/git/blobs/${blob}" --jq '.content' | base64 -d > "${path}.tmp" \
    || { rm -f -- "${path}.tmp"; echo "::error::failed to read ${path}"; exit 1; }
  mv -- "${path}.tmp" "$path"
  count=$((count + 1))
done < <(printf '%s' "$HEAD_TREE" | jq -r --slurpfile base "$TMP_BASE" '
  def regular: select(.type == "blob" and (.mode == "100644" or .mode == "100755"));
  ([.tree[] | regular] | map({key: .path, value: .sha}) | from_entries) as $files
  | ([$files | keys[]
      | select(test("^\\.ai-sdlc/attestations/[0-9a-f]{40}(\\.v6)?\\.dsse\\.json$"))
      | select(. as $p | ($base[0] | any(. == $p)) | not)]) as $envs
  | ($envs
      | map(capture("^\\.ai-sdlc/attestations/(?<id>[0-9a-f]{40})") | ".ai-sdlc/transcript-leaves/\(.id).jsonl")
      | map(select($files[.] != null))) as $leaves
  | (if $files[".ai-sdlc/transcript-leaves.jsonl"] != null then [".ai-sdlc/transcript-leaves.jsonl"] else [] end) as $index
  | ($envs + $index + $leaves) | unique[]
  | [., $files[.]] | @tsv')
echo "[verify-attestation] staged ${count} data file(s) from PR head via API" >&2
