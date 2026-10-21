#!/usr/bin/env bash
# drop-attestation-chores.sh — drop this task's earlier attestation chore
# commits non-interactively (AISDLC-999).
#
# A retried ship leaves `chore: sign attestation` and
# `chore: commit pending transcript leaves` commits from the previous attempt in
# the stack; signing on top of them yields an envelope whose subject sha is no
# longer in history. This is the plugin-shipped copy of
# pipeline-cli/src/attestation/drop-chores.ts (`cli-attestation reset-stack`);
# keep the identification rule identical in both:
#   a commit is ours when its subject is one of the two chore subjects AND it
#   touches only .ai-sdlc/attestations/, .ai-sdlc/transcript-leaves.jsonl,
#   .ai-sdlc/transcript-leaves/ (or the task's own .ai-sdlc/reviews/<id>.jsonl).
#
# Usage: drop-attestation-chores.sh [--if-stale] [--base <ref>] [--task-id <id>]
#   --if-stale   only act when an envelope added by a candidate commit names a
#                subject sha that is no longer an ancestor of HEAD (safe to run
#                on every sign: a healthy stack is left alone).
#   --base       ref the stack is measured against (default origin/main).
# The sequence editor is scripted; no editor ever opens.
#
# Exit codes: 0 = nothing to do or dropped; 1 = refused or git error.

set -euo pipefail

IF_STALE=0
BASE_REF="origin/main"
TASK_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --if-stale) IF_STALE=1 ;;
    --base) BASE_REF="$2"; shift ;;
    --task-id) TASK_ID="$2"; shift ;;
    *) echo "[drop-attestation-chores] unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

SUBJECT_RE='^(chore(\(.*\))?: (sign|auto-sign) (v5 |review )?attestation|chore: commit pending transcript leaves)'

BASE=$(git merge-base "$BASE_REF" HEAD 2>/dev/null || echo '')
[ -n "$BASE" ] || exit 0

CANDIDATES=()
while IFS=$'\t' read -r SHA SUBJ; do
  [ -n "$SHA" ] || continue
  if printf '%s' "$SUBJ" | grep -qE "$SUBJECT_RE"; then CANDIDATES+=("$SHA"); fi
done < <(git log --reverse --format='%H%x09%s' "${BASE}..HEAD")
[ "${#CANDIDATES[@]}" -gt 0 ] || exit 0

RESTORE=()
ENVELOPES=()
for SHA in "${CANDIDATES[@]}"; do
  while IFS= read -r F; do
    [ -n "$F" ] || continue
    case "$F" in
      .ai-sdlc/attestations/*) ENVELOPES+=("$F") ;;
      .ai-sdlc/transcript-leaves.jsonl|.ai-sdlc/transcript-leaves/*) RESTORE+=("$F") ;;
      *)
        if [ -n "$TASK_ID" ] && [ "$F" = ".ai-sdlc/reviews/${TASK_ID}.jsonl" ]; then
          RESTORE+=("$F")
        else
          echo "[drop-attestation-chores] refused: ${SHA:0:7} touches ${F}" >&2
          exit 1
        fi
        ;;
    esac
  done < <(git diff-tree --root --no-commit-id --name-only -r "$SHA")
done

if [ "$IF_STALE" = "1" ]; then
  STALE=0
  for ENV_PATH in "${ENVELOPES[@]:-}"; do
    case "$ENV_PATH" in *.dsse.json) ;; *) continue ;; esac
    SUBJECT_SHA=$(git show "HEAD:${ENV_PATH}" 2>/dev/null | node -e '
      let d = "";
      process.stdin.on("data", (c) => (d += c)).on("end", () => {
        try {
          const e = JSON.parse(d);
          const s = e && e.subject && e.subject.digest && e.subject.digest.sha1;
          if (typeof s === "string") process.stdout.write(s);
        } catch {}
      });
    ' 2>/dev/null || true)
    if [ -n "$SUBJECT_SHA" ] && ! git merge-base --is-ancestor "$SUBJECT_SHA" HEAD 2>/dev/null; then
      STALE=1
    fi
  done
  [ "$STALE" = "1" ] || exit 0
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "[drop-attestation-chores] the worktree has uncommitted changes; not rewriting" >&2
  exit 1
fi

OLD_HEAD=$(git rev-parse HEAD)
ALT=""
for SHA in "${CANDIDATES[@]}"; do ALT="${ALT:+$ALT|}${SHA:0:7}"; done
EDITOR_CMD="sh -c 'grep -v -E \"^(pick|p) (${ALT})\" \"\$1\" > \"\$1.new\"; mv \"\$1.new\" \"\$1\"' sh"

if ! git -c "sequence.editor=${EDITOR_CMD}" -c core.editor=true rebase --interactive --empty=drop "$BASE" >/dev/null 2>&1; then
  git rebase --abort >/dev/null 2>&1 || true
  echo "[drop-attestation-chores] ERROR: dropping the chore commits failed; rebase aborted" >&2
  exit 1
fi

for F in "${RESTORE[@]:-}"; do
  [ -n "$F" ] || continue
  if git cat-file -e "${OLD_HEAD}:${F}" 2>/dev/null; then git checkout "$OLD_HEAD" -- "$F"; fi
done

echo "[drop-attestation-chores] dropped ${#CANDIDATES[@]} earlier attestation chore commit(s)" >&2
exit 0
