/**
 * Post-agent output validation — enforces guardrails before push.
 *
 * Pure validation module with no side effects (fully testable).
 */

import { execFile } from 'node:child_process';

export interface ValidationContext {
  filesChanged: string[];
  workDir: string;
  constraints: {
    maxFilesPerChange: number;
    requireTests: boolean;
    blockedPaths: string[];
  };
  guardrails: {
    maxLinesPerPR?: number;
  };
}

export interface ValidationViolation {
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationResult {
  passed: boolean;
  violations: ValidationViolation[];
}

/**
 * Match a file path against a blocked-path pattern.
 * Supports simple glob suffixes: `foo/**` matches anything under `foo/`.
 */
function matchesBlockedPath(filePath: string, pattern: string): boolean {
  const base = pattern.replace(/\/?\*\*$/, '');
  return filePath === base || filePath.startsWith(base.endsWith('/') ? base : `${base}/`);
}

/**
 * Parse total changed lines from `git diff --stat` output.
 * The last line looks like: ` 3 files changed, 40 insertions(+), 12 deletions(-)`
 */
function parseDiffStatLines(diffStat: string): number {
  const match = diffStat.match(/(\d+)\s+insertions?\(\+\)(?:,\s*(\d+)\s+deletions?\(-\))?/);
  if (!match) {
    // Try deletions-only format: `1 file changed, 5 deletions(-)`
    const delOnly = diffStat.match(/(\d+)\s+deletions?\(-\)/);
    return delOnly ? Number(delOnly[1]) : 0;
  }
  return Number(match[1]) + (match[2] ? Number(match[2]) : 0);
}

/**
 * Validate agent output against guardrails and constraints.
 */
export async function validateAgentOutput(ctx: ValidationContext): Promise<ValidationResult> {
  const violations: ValidationViolation[] = [];

  // 1. Blocked paths
  for (const file of ctx.filesChanged) {
    for (const pattern of ctx.constraints.blockedPaths) {
      if (matchesBlockedPath(file, pattern)) {
        violations.push({
          rule: 'blocked-path',
          message: `File \`${file}\` matches blocked path \`${pattern}\` — this change will be rejected. Remove modifications to this file.`,
          severity: 'error',
        });
      }
    }
  }

  // 2. File count
  if (ctx.filesChanged.length > ctx.constraints.maxFilesPerChange) {
    violations.push({
      rule: 'max-files',
      message: `Changed ${ctx.filesChanged.length} files (max ${ctx.constraints.maxFilesPerChange}). Split this change into smaller PRs.`,
      severity: 'warning',
    });
  }

  // 3. Max lines per PR
  if (ctx.guardrails.maxLinesPerPR !== undefined) {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('git', ['diff', '--stat', 'HEAD~1'], { cwd: ctx.workDir }, (err, out) => {
        if (err) reject(err);
        else resolve(out);
      });
    });
    const totalLines = parseDiffStatLines(stdout);
    if (totalLines > ctx.guardrails.maxLinesPerPR) {
      violations.push({
        rule: 'max-lines',
        message: `Changed ${totalLines} lines (max ${ctx.guardrails.maxLinesPerPR}). Consider breaking this into smaller incremental changes.`,
        severity: 'warning',
      });
    }
  }

  // 4. Require tests
  if (ctx.constraints.requireTests) {
    const hasTestFile = ctx.filesChanged.some((f) => /\.test\./.test(f) || /\.spec\./.test(f));
    if (!hasTestFile) {
      violations.push({
        rule: 'require-tests',
        message: 'No test file found in changed files. Add or update tests to cover your changes.',
        severity: 'error',
      });
    }
  }

  return { passed: violations.length === 0, violations };
}
