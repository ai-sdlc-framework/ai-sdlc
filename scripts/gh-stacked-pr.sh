#!/usr/bin/env bash
#
# AISDLC-129: Open a stacked (chained-base) GitHub PR via the REST API.
#
# Why this exists: `gh pr create --base <chain> --head <feature>` honors
# the flag correctly today (verified gh 2.72.0; see
# docs/operations/stacked-prs.md). But:
#   1. The orchestrator's Step 11 currently hardcodes `--base main`, so
#      until that's chain-aware, anyone needing a one-off stacked PR
#      had to reach for a manual `gh pr create` invocation that's easy
#      to typo (no validation of base/head existence).
#   2. `gh pr create --dry-run` does NOT validate that `--base` exists
#      on the remote; a typo silently passes.
#   3. The REST surface (`POST /repos/.../pulls`) is more stable than
#      the gh CLI's argument resolution (which has gained behaviors
#      like `gh-merge-base` git config in cli/cli#10088). For
#      orchestrator code paths, REST gives unambiguous intent.
#
# This wrapper:
#   - Validates --base and --head both exist on the remote (one
#     `gh api /repos/.../branches/<name>` call each).
#   - Posts the PR via `gh api -X POST /repos/<owner>/<repo>/pulls`.
#   - Prints the resulting `html_url` to stdout, gh-pr-create-compatible.
#
# Out of scope: wiring this into pipeline-cli/src/steps/11-push-and-pr.ts.
# That's a follow-up once the orchestrator gains a chained-PR mode.
#
# Usage:
#   scripts/gh-stacked-pr.sh \
#     --base <branch> \
#     --head <branch> \
#     --title <string> \
#     [--body <string> | --body-file <path>] \
#     [--repo <owner/repo>] \
#     [--draft]
#
# Exits 0 on success (PR URL on stdout), non-zero on validation or
# API failure (error on stderr).

set -euo pipefail

usage() {
  sed -n '2,/^# Exits/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-2}"
}

base=""
head=""
title=""
body=""
body_file=""
repo=""
draft=false

while [ $# -gt 0 ]; do
  case "$1" in
    --base)      base="$2"; shift 2 ;;
    --head)      head="$2"; shift 2 ;;
    --title)     title="$2"; shift 2 ;;
    --body)      body="$2"; shift 2 ;;
    --body-file) body_file="$2"; shift 2 ;;
    --repo)      repo="$2"; shift 2 ;;
    --draft)     draft=true; shift ;;
    -h|--help)   usage 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage 2
      ;;
  esac
done

# Validate required args.
if [ -z "$base" ] || [ -z "$head" ] || [ -z "$title" ]; then
  echo "error: --base, --head, and --title are required" >&2
  usage 2
fi
if [ -n "$body" ] && [ -n "$body_file" ]; then
  echo "error: --body and --body-file are mutually exclusive" >&2
  exit 2
fi

# Resolve the target repo. Prefer --repo; fall back to the current git
# checkout's `gh repo view` which respects gh's normal remote resolution.
if [ -z "$repo" ]; then
  if ! repo="$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null)"; then
    echo "error: could not resolve target repo. Pass --repo <owner/repo> or run from a checkout." >&2
    exit 2
  fi
fi

# Validate base + head exist on the remote. `gh api /repos/.../branches/<name>`
# returns 200 if the branch exists, 404 otherwise.
check_branch() {
  local label="$1" branch="$2"
  if ! gh api "/repos/${repo}/branches/${branch}" --silent 2>/dev/null; then
    echo "error: ${label} branch '${branch}' not found on ${repo}." >&2
    echo "       Push it first (git push -u origin ${branch}) and retry." >&2
    exit 1
  fi
}
check_branch base "$base"
check_branch head "$head"

# Resolve body source.
body_payload=""
if [ -n "$body_file" ]; then
  if [ ! -r "$body_file" ]; then
    echo "error: --body-file '${body_file}' is not readable" >&2
    exit 2
  fi
  body_payload="$(cat "$body_file")"
elif [ -n "$body" ]; then
  body_payload="$body"
else
  body_payload=""
fi

# Build the API call. `gh api -F` would interpret numbers; use `-f` for
# string fields. Booleans use `-F draft=true|false`.
draft_arg=()
if [ "$draft" = true ]; then
  draft_arg=(-F "draft=true")
else
  draft_arg=(-F "draft=false")
fi

# `gh api` reads multiline -f values fine, but we route the body through
# stdin via --input - to handle bodies with embedded newlines + quotes
# without shell-quoting hazards.
input_json="$(jq -n \
  --arg title "$title" \
  --arg body  "$body_payload" \
  --arg base  "$base" \
  --arg head  "$head" \
  --argjson draft "$draft" \
  '{title: $title, body: $body, base: $base, head: $head, draft: $draft}')"

response="$(echo "$input_json" | gh api -X POST "/repos/${repo}/pulls" --input -)"

# Extract html_url + verify the API actually persisted the chained base
# (defense in depth — if GitHub ever silently retargeted, we want to know).
pr_url="$(echo "$response" | jq -r '.html_url')"
actual_base="$(echo "$response" | jq -r '.base.ref')"

if [ "$actual_base" != "$base" ]; then
  echo "error: requested --base '${base}' but PR opened with base '${actual_base}'." >&2
  echo "       PR URL: ${pr_url}" >&2
  echo "       Investigate before closing — this is the AISDLC-129 fault mode." >&2
  exit 1
fi

echo "$pr_url"
