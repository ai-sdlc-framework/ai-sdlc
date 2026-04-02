#!/usr/bin/env node
/**
 * CLI entry point for PR review agents.
 *
 * Runs a single review agent (testing, critic, or security) against a PR diff
 * and outputs a JSON verdict to stdout.
 *
 * Usage:
 *   review --pr 42 --diff-file /tmp/pr-diff.txt --issue-file /tmp/issue.json --type testing
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  executeReview,
  resolveRepoRoot,
  analyzeDiff,
  type ReviewContext,
} from '@ai-sdlc/orchestrator';
import type { ReviewType } from '@ai-sdlc/orchestrator';

// ── Arg parsing ──────────────────────────────────────────────────────

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

const VALID_TYPES: ReviewType[] = ['testing', 'critic', 'security'];

interface ReviewArgs {
  prNumber: number;
  diff: string;
  issueTitle: string;
  issueBody: string;
  reviewType: ReviewType;
}

function parseArgs(argv: string[]): ReviewArgs {
  const prStr = getArg(argv, '--pr');
  const diffFile = getArg(argv, '--diff-file');
  const issueFile = getArg(argv, '--issue-file');
  const typeStr = getArg(argv, '--type');

  if (!prStr || !diffFile || !typeStr) {
    console.error(
      'Usage: review --pr <number> --diff-file <path> --type <testing|critic|security>',
    );
    console.error('       [--issue-file <path>]');
    process.exit(1);
  }

  const prNumber = Number(prStr);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error(`Invalid PR number: ${prStr}`);
    process.exit(1);
  }

  if (!VALID_TYPES.includes(typeStr as ReviewType)) {
    console.error(`Invalid review type: ${typeStr}. Must be one of: ${VALID_TYPES.join(', ')}`);
    process.exit(1);
  }

  let diff: string;
  try {
    diff = readFileSync(diffFile, 'utf-8');
  } catch {
    console.error(`Failed to read diff file: ${diffFile}`);
    process.exit(1);
  }

  // Read linked issue context if provided
  let issueTitle = '';
  let issueBody = '';
  if (issueFile) {
    try {
      const issueJson = JSON.parse(readFileSync(issueFile, 'utf-8'));
      issueTitle = issueJson.title ?? '';
      issueBody = issueJson.body ?? '';
    } catch {
      // Issue context is optional — continue without it
    }
  }

  return {
    prNumber,
    diff,
    issueTitle,
    issueBody,
    reviewType: typeStr as ReviewType,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  // Extract acceptance criteria from issue body
  const acMatch = args.issueBody.match(
    /###?\s*Acceptance Criteria\s*\n([\s\S]*?)(?=\n###?\s|\n$|$)/i,
  );
  const acceptanceCriteria = acMatch ? acMatch[1].trim() : undefined;

  const context: ReviewContext = {
    issueTitle: args.issueTitle,
    issueBody: args.issueBody,
    acceptanceCriteria,
  };

  // Load review policy, principles, and exemplars
  let reviewPolicy: string | undefined;
  let workDir: string;
  try {
    workDir = await resolveRepoRoot();
    const configDir = join(workDir, '.ai-sdlc');

    // Assemble calibration context: policy + principles + exemplars
    const parts: string[] = [];

    const policyPath = join(configDir, 'review-policy.md');
    if (existsSync(policyPath)) {
      parts.push(readFileSync(policyPath, 'utf-8'));
    }

    const principlesPath = join(configDir, 'review-principles.md');
    if (existsSync(principlesPath)) {
      parts.push(readFileSync(principlesPath, 'utf-8'));
    }

    const exemplarsPath = join(configDir, 'review-exemplars.yaml');
    if (existsSync(exemplarsPath)) {
      parts.push(
        '## Review Exemplars (labeled examples)\n\n```yaml\n' +
          readFileSync(exemplarsPath, 'utf-8') +
          '\n```',
      );
    }

    if (parts.length > 0) {
      reviewPolicy = parts.join('\n\n---\n\n');
    }
  } catch {
    workDir = process.cwd();
  }

  // Run deterministic structural analysis on changed files before LLM review
  try {
    const diffAnalysis = await analyzeDiff(args.diff, workDir);
    if (diffAnalysis.summary) {
      // Prepend structural findings to the review policy so agents see them
      reviewPolicy = reviewPolicy
        ? `${diffAnalysis.summary}\n\n---\n\n${reviewPolicy}`
        : diffAnalysis.summary;
    }
  } catch {
    // Structural analysis is best-effort — continue without it
  }

  const verdict = await executeReview(args.prNumber, args.diff, args.reviewType, context, {
    apiConfig: reviewPolicy ? { reviewPolicy } : undefined,
  });

  // Output JSON on last line for the workflow to capture
  console.log(JSON.stringify(verdict));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
