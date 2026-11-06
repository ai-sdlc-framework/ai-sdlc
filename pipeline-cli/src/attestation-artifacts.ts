/**
 * AISDLC-1016 — the review artifacts a run writes into the worktree: review
 * records. Step 10 commits them in the chore commit, and
 * the dispatch playbook does not count a tree that holds only these as dirty.
 */
export const ATTESTATION_ARTIFACT_PATHS: readonly string[] = ['.ai-sdlc/reviews'];

/** True when every `git status --porcelain` entry is an attestation artifact. */
export function onlyAttestationArtifacts(porcelain: string): boolean {
  const lines = porcelain.split('\n').filter((l) => l.trim() !== '');
  return lines.every((line) => {
    const path = line.slice(3).replace(/^"|"$/g, '');
    return ATTESTATION_ARTIFACT_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  });
}
