/**
 * RFC-0061 Phase 1, Step 11: build the verdict commit for the head about to be pushed and name
 * the extra refspec for the atomic push (`git push --atomic origin <branch> <commit>:refs/ai-sdlc/verdicts/<head>`).
 *
 * Runs per push attempt, because the pre-push hook can add a commit and change the head. Never
 * throws and never blocks the push: any failure returns no refspec (the v6 envelope path still
 * gates during the shadow phase) with a note.
 *
 * @module next-step/verdict-ref-push
 */

import {
  finalizeVerdictRecord,
  verdictRefName,
  writeVerdictCommit,
} from '../attestation/verdict-record.js';
import type { Runner } from '../runtime/exec.js';
import type { VerdictRecordDraft } from '../attestation/verdict-record.js';

export interface VerdictRefspec {
  /** `<commit>:refs/ai-sdlc/verdicts/<head>`, or null when no verdict ref is pushed this attempt. */
  refspec: string | null;
  note?: string;
}

/** Parse `owner/name` from a GitHub remote URL (https or ssh form). */
export function repositoryFromRemoteUrl(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1]! : null;
}

export async function buildVerdictRefspec(
  runner: Runner,
  wt: string,
  draft: VerdictRecordDraft | undefined,
  baseRef: string,
  now?: Date,
  pullRequest = 0,
): Promise<VerdictRefspec> {
  if (!draft) {
    return {
      refspec: null,
      note: 'verdict ref not pushed: no verdict record draft for this round',
    };
  }
  try {
    const rev = async (args: string[]): Promise<string> => {
      const r = await runner('git', args, { cwd: wt, allowFailure: true });
      return r.code === 0 ? r.stdout.trim() : '';
    };
    const headSha = await rev(['rev-parse', 'HEAD']);
    const treeSha = await rev(['rev-parse', 'HEAD^{tree}']);
    const baseSha = await rev(['merge-base', 'HEAD', baseRef]);
    const repository = repositoryFromRemoteUrl(await rev(['config', '--get', 'remote.origin.url']));
    if (!headSha || !treeSha || !baseSha || !repository) {
      return {
        refspec: null,
        note: 'verdict ref not pushed: head, tree, base or repository unresolved',
      };
    }
    const ref = verdictRefName(headSha);
    const existing = await runner('git', ['ls-remote', 'origin', ref], {
      cwd: wt,
      allowFailure: true,
    });
    if (existing.code === 0 && existing.stdout.trim()) {
      return { refspec: null, note: `verdict ref ${ref} already issued; left unchanged` };
    }
    const { record, leavesJsonl } = finalizeVerdictRecord(draft, {
      subject: { headSha, treeSha, baseSha, repository, pullRequest },
      now,
    });
    const commit = await writeVerdictCommit(runner, wt, record, leavesJsonl);
    if (!commit) return { refspec: null, note: 'verdict ref not pushed: tree write failed' };
    return { refspec: `${commit}:${ref}` };
  } catch (err) {
    return { refspec: null, note: `verdict ref not pushed: ${(err as Error).message}` };
  }
}
