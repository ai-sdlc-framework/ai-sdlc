/**
 * AISDLC-1016 — the review artifacts a run writes into the worktree: signed
 * envelopes, transcript leaves (the Merkle leaf index and its per-leaf files)
 * and review records. Step 10 commits them in the attestation chore commit, and
 * the dispatch playbook does not count a tree that holds only these as dirty.
 */
export const ATTESTATION_ARTIFACT_PATHS: readonly string[] = [
  '.ai-sdlc/attestations',
  '.ai-sdlc/transcript-leaves',
  '.ai-sdlc/transcript-leaves.jsonl',
  '.ai-sdlc/reviews',
];

/** True when every `git status --porcelain` entry is an attestation artifact. */
export function onlyAttestationArtifacts(porcelain: string): boolean {
  const lines = porcelain.split('\n').filter((l) => l.trim() !== '');
  return lines.every((line) => {
    const path = line.slice(3).replace(/^"|"$/g, '');
    return ATTESTATION_ARTIFACT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  });
}
