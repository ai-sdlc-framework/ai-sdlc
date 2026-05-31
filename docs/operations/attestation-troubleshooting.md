# Attestation troubleshooting

This runbook covers common `ai-sdlc/attestation` check failures and how to diagnose and resolve them.

---

## Symptom: `v6: rootSignature did not match any trusted reviewer pubkey`

The `verify-attestation.yml` workflow posts this failure when the Merkle root reconstructed from the transcript leaves does not match the signature in the DSSE envelope.

### Common cause: per-patch-id leaves file missing from the commit tree (fixed by AISDLC-471)

**Root cause (pre-AISDLC-471):** `scripts/check-attestation-sign.sh` created the auto-sign chore commit with only `git add .ai-sdlc/attestations/`, leaving `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` untracked. CI checks out the branch tree, finds the envelope but not the per-patch-id leaves file, and falls back to the legacy shared `.ai-sdlc/transcript-leaves.jsonl` — which contains leaves from OTHER PRs. The verifier recomputes the Merkle root from the wrong leaves and the signature check fails.

**Why local passes:** the local verifier reads the per-patch-id leaves file directly from the filesystem (it exists there, even if untracked). CI only sees committed files.

**How to confirm:** run the following in the worktree, or grep the CI log for the
verifier's `leaves source:` line. The verifier (`scripts/verify-attestation.mjs`)
emits exactly one such line per run, prefixed `[v6-verifier] leaves source:`:

```bash
# In the CI log for the verify-attestation job, grep the verifier's source line:
#   grep 'leaves source:' <ci-log>
#
# A healthy v6 PR prints the per-patch-id source, e.g.:
#   [v6-verifier] leaves source: per-patch-id (.ai-sdlc/transcript-leaves/<patch-id>.jsonl)
#
# The bug manifests as the shared legacy-fallback source instead, e.g.:
#   [v6-verifier] leaves source: shared (.ai-sdlc/transcript-leaves.jsonl) [AISDLC-421 legacy fallback, filtered by taskId=<task-id>]
# (or "..., full file]" when no taskId filter applied) — the verifier fell back
# to the shared file because the per-patch-id leaves file was not committed.
```

```bash
# Should print one line with the current patch-id's .jsonl file.
# If the output is empty, the file was not committed — this is the bug.
git ls-tree HEAD -- .ai-sdlc/transcript-leaves/
```

**Fix (AISDLC-471, shipped):** `scripts/check-attestation-sign.sh` now stages `.ai-sdlc/transcript-leaves/` alongside `.ai-sdlc/attestations/` in the chore commit. All new auto-sign chore commits include the per-patch-id leaves file.

**Manual workaround for open PRs that already shipped without the fix:**

```bash
cd .worktrees/<task-id>

# Confirm the per-patch-id leaves file exists on disk (it should — it's just not committed).
ls .ai-sdlc/transcript-leaves/

# Stage the leaves file and amend the auto-sign chore commit.
git add .ai-sdlc/transcript-leaves/<patch-id>.jsonl
git commit --amend --no-edit

# Force-push the amended commit (lease-protected).
git push --force-with-lease
```

Replace `<patch-id>` with the filename shown by `ls .ai-sdlc/transcript-leaves/`. If the directory is empty or does not exist, the issue is elsewhere — see below.

---

## Symptom: `v6: transcript leaves file not found`

The verifier could not locate any transcript leaves file — neither the per-patch-id file nor the legacy shared file.

**Likely cause:** the PR was signed before `cli-attestation.mjs emit-leaf` was wired into the reviewer fan-out (pre-AISDLC-421). Use the v5 opt-out:

```bash
AI_SDLC_V5_LEGACY=1 git push
```

Or re-sign with the v5 schema explicitly:

```bash
node ai-sdlc-plugin/scripts/sign-attestation.mjs \
  --review-verdicts .ai-sdlc/verdicts/<task-id-lower>.json \
  --schema-version v5
git add .ai-sdlc/attestations/
git commit --amend --no-edit
git push --force-with-lease
```

---

## Symptom: `v6: rootSignature did not match any trusted reviewer pubkey` after a rebase

A rebase changes the commit SHA but not the patch-id (for conflict-free rebases). AISDLC-398 content-addressed envelopes should survive this automatically.

**Confirm:** check that the envelope filename matches the current patch-id:

```bash
# Compute current patch-id.
MERGE_BASE=$(git merge-base origin/main HEAD)
git diff-tree --no-color -p "${MERGE_BASE}..HEAD" -- \
  ':!.ai-sdlc/attestations/' ':!.ai-sdlc/transcript-leaves/' \
  | git patch-id --stable | head -1 | cut -c1-40
```

If the envelope file in `.ai-sdlc/attestations/` does not match this patch-id, re-sign:

```bash
# Remove stale envelope, re-sign.
rm .ai-sdlc/attestations/*.v6.dsse.json
git add .ai-sdlc/attestations/
git commit --amend --no-edit
git push --force-with-lease
# Then re-push to trigger the auto-sign hook.
git push
```

---

## Diagnostic checklist

1. `git ls-tree HEAD -- .ai-sdlc/attestations/` — confirms an envelope is committed.
2. `git ls-tree HEAD -- .ai-sdlc/transcript-leaves/` — confirms the per-patch-id leaves file is committed (if empty, apply the AISDLC-471 manual workaround above).
3. Check the `verify-attestation.yml` CI log for `leaves source:` — `per-patch-id` is correct; `shared (legacy fallback)` means the per-patch-id file is missing from the commit tree.
4. `cat .ai-sdlc/attestations/*.v6.dsse.json | jq .payload | base64 -d | jq .` — inspect the envelope payload to verify `subject.digest.sha1` and confirm the signed merge-base.

---

## References

- AISDLC-471 — root cause analysis + fix for the 2026-05-28 PR #752 incident
- AISDLC-421 — introduced per-patch-id transcript-leaves files
- AISDLC-398 — content-addressed envelope filenames (patch-id based)
- `scripts/check-attestation-sign.sh` — the pre-push hook that creates the auto-sign chore commit
- `scripts/verify-attestation.mjs` — the verifier that prefers per-patch-id leaves and falls back to legacy shared leaves
