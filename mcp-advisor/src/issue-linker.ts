/**
 * 4-tier issue resolution chain.
 * Attempts to link a session to an issue number via:
 *   1. Branch name pattern
 *   2. Explicit declaration
 *   3. Git log context
 *   4. Unattributed fallback
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractIssueNumber, BRANCH_PATTERN } from '@ai-sdlc/orchestrator';
import type { IssueLinkMethod } from './session.js';

const execFileAsync = promisify(execFile);

export interface IssueResolution {
  issueNumber: number | null;
  method: IssueLinkMethod;
  confidence: number;
}

/** Loose pattern for branch names like `issue-42`, `issue_42`, `issue#42`. */
const LOOSE_BRANCH_PATTERN = /issue[- _]?#?(\d+)/i;

/** Pattern for `#N` or `fixes #N` in commit messages. */
const COMMIT_ISSUE_PATTERN = /(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\s+#(\d+)|#(\d+)/gi;

/**
 * Resolve the current git branch name.
 */
async function getCurrentBranch(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Parse recent git log for issue references.
 */
async function getIssueFromGitLog(repoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', '-20'], { cwd: repoPath });
    const counts = new Map<number, number>();

    for (const line of stdout.split('\n')) {
      let match: RegExpExecArray | null;
      COMMIT_ISSUE_PATTERN.lastIndex = 0;
      while ((match = COMMIT_ISSUE_PATTERN.exec(line)) !== null) {
        const num = parseInt(match[1] ?? match[2], 10);
        if (!isNaN(num)) {
          counts.set(num, (counts.get(num) ?? 0) + 1);
        }
      }
    }

    if (counts.size === 0) return null;

    // Return the most frequently referenced issue
    let best: number | null = null;
    let bestCount = 0;
    for (const [num, count] of counts) {
      if (count > bestCount) {
        best = num;
        bestCount = count;
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Resolve issue number through the 4-tier chain.
 */
export async function resolveIssue(
  repoPath: string,
  explicitIssue?: number,
): Promise<IssueResolution> {
  // Tier 1: Branch name
  const branch = await getCurrentBranch(repoPath);
  if (branch) {
    const strict = extractIssueNumber(branch);
    if (strict !== null) {
      return { issueNumber: strict, method: 'branch', confidence: 1.0 };
    }
    const loose = branch.match(LOOSE_BRANCH_PATTERN);
    if (loose) {
      return { issueNumber: parseInt(loose[1], 10), method: 'branch', confidence: 0.8 };
    }
  }

  // Tier 2: Explicit declaration
  if (explicitIssue != null) {
    return { issueNumber: explicitIssue, method: 'explicit', confidence: 1.0 };
  }

  // Tier 3: Git context
  const gitIssue = await getIssueFromGitLog(repoPath);
  if (gitIssue !== null) {
    return { issueNumber: gitIssue, method: 'git-context', confidence: 0.6 };
  }

  // Tier 4: Unattributed
  return { issueNumber: null, method: 'unattributed', confidence: 0 };
}
