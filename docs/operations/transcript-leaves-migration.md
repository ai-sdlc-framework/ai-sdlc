# Transcript-leaves migration (AISDLC-421)

## TL;DR

Each PR's transcript leaves now live in their own file at `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` instead of the shared `.ai-sdlc/transcript-leaves.jsonl`. **No operator action is required.** The signer and verifier both read both layouts transparently during the one-release migration window. The shared file is retained read-only for legacy envelopes signed before this change.

## What changed

| Surface | Before AISDLC-421 | After AISDLC-421 |
|---|---|---|
| Write target for `cli-attestation emit-leaf` | shared `.ai-sdlc/transcript-leaves.jsonl` | per-patch-id `.ai-sdlc/transcript-leaves/<patch-id>.jsonl` |
| Signer source (`sign-attestation.mjs` v6 path) | shared file filtered by taskId | per-patch-id file first; shared file fallback |
| Verifier source (`verify-attestation.mjs` v6 path) | shared file | per-patch-id file first; directory scan-by-leaf-hash; shared file fallback |
| Merkle tree scope | full shared-file leaf set (cross-PR root) | per-PR leaf set only (per-PR root) |
| `.gitattributes` | (none) | `.ai-sdlc/transcript-leaves/* merge=binary` |

## Why it changed

The shared append-only file produced a 100%-rate rebase conflict between sibling PRs: when one PR merged to main, every other open PR's branch held its own appended leaves on overlapping line ranges, so `git rebase` reported a conflict on every rebase. AISDLC-420's auto-rebase workflow could not complete cleanly without operator intervention on every cycle.

Each PR writing to a disjoint per-patch-id file eliminates the cross-PR overlap by construction.

## What the operator does

**Nothing, during the migration window.** Both layouts are read transparently. New envelopes use the per-patch-id layout; legacy envelopes (signed against the shared file) continue to verify via the shared-file fallback.

After the soak completes, a follow-up task will delete the shared-file fallback code and the shared file itself. The operator action at that point will be limited to merging the cleanup PR.

## How the resolver picks the leaves

The verifier resolves leaves in this order:

1. **Per-patch-id direct hit** — when the envelope's filename is patch-id-named (`<40-hex>.v6.dsse.json` and the hex ≠ headSha), extract the patch-id and read `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`.
2. **Directory scan + hash-superset match** — if (1) doesn't hit, scan every `.ai-sdlc/transcript-leaves/*.jsonl` file and return the one whose transcript-hash set is a superset of the envelope's `transcriptLeaves[].transcriptHash`. This handles SHA-named legacy envelopes whose leaves moved to a per-patch-id file post-AISDLC-421.
3. **Shared-file fallback** — for pre-AISDLC-421 envelopes signed against `.ai-sdlc/transcript-leaves.jsonl`. The full shared-file leaf set is returned (no per-task filter at the resolver level; the envelope's own `transcriptLeaves[]` array still pins which leaves the Merkle root is over).

The verifier logs the leaf source on every run: `[v6-verifier] leaves source: per-patch-id (.ai-sdlc/transcript-leaves/<patch-id>.jsonl)` (or whichever path resolved). This is useful when investigating verification failures during the migration window.

The signer follows the same per-patch-id-first / shared-file-fallback contract and logs: `[sign-v6] leaves source: per-patch-id (.ai-sdlc/transcript-leaves/<patch-id>.jsonl) (3 leaves)`.

## `.gitattributes` merge driver

```
.ai-sdlc/transcript-leaves/*.jsonl merge=binary
```

`merge=binary` is defense-in-depth. Because every PR has a distinct patch-id, two PRs writing to the same per-patch-id file is essentially impossible by construction (it would require two PRs with identical diffs). If it DOES happen (cherry-pick across branches, manual writes, hypothetical patch-id collision), the rebase MUST surface a hard conflict rather than silently union-merging — union-merge would reorder leaves and invalidate the signed Merkle root because `rootHash` is computed over a specific leaf sequence.

The alternative driver (`merge=union`) was rejected after hermetic testing demonstrated that reordering leaves changes the Merkle root (see `pipeline-cli/src/attestation/per-patch-id-rebase.test.ts`).

## Troubleshooting

### "v6: no transcript leaves found" verification failure

The verifier could not find leaves via any of the three resolution paths. Check:

1. **Per-patch-id file present?** `ls .ai-sdlc/transcript-leaves/` should show a `<patch-id>.jsonl` matching the envelope's filename. Missing → re-run `cli-attestation emit-leaf` for each reviewer.
2. **Envelope SHA-named without per-patch-id leaves?** If the envelope is `<head-sha>.v6.dsse.json` (legacy filename) AND no shared file exists AND no per-patch-id file matches the envelope's leaf hashes, the verifier has nothing to resolve. Move leaves to the canonical per-patch-id path or re-emit them.

### "v6: leaf with leafIndex=N not found"

The on-disk leaves don't include the leafIndex the envelope claims. Most likely cause: the per-patch-id file was overwritten or pruned after signing. Re-emit the leaves and re-sign.

### Rebase conflict on `.ai-sdlc/transcript-leaves/<patch-id>.jsonl`

This should NEVER happen in production — different PRs have different patch-ids, so different file names. If it DOES surface, the only mechanically valid explanation is two PRs that produced the same patch-id (i.e. their diffs are byte-identical after the attestation exclusion). Escalate — this signals an upstream design failure, NOT a routine merge.

The `merge=binary` driver correctly refuses to silently resolve this case; the operator must investigate which PR is duplicating the other.

## References

- [RFC-0042 §Per-PR transcript-leaf storage (AISDLC-421 amendment)](../../spec/rfcs/RFC-0042-proof-of-execution-attestation.md)
- AISDLC-398 — content-addressed envelope filenames (same patch-id algorithm)
- AISDLC-420 — auto-rebase workflow (the consumer that surfaced the friction)
- Hermetic tests: `pipeline-cli/src/attestation/per-patch-id-rebase.test.ts`, `pipeline-cli/src/attestation/legacy-shared-fallback.test.ts`, and the `verifyV6Envelope (AISDLC-421 …)` describe block in `scripts/verify-attestation.test.mjs`
