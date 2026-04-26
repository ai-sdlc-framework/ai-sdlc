#!/usr/bin/env node
/**
 * cli-classifier-feedback (RFC-0010 §12.3 / Q4 resolution).
 *
 * Operator-facing command for back-filling the calibration log with ground truth
 * after a PR merges. When a human reviewer adds a missing reviewer to a PR (e.g.,
 * security caught something the classifier skipped), the operator runs this command
 * to attribute the miss back to the classifier output, feeding the calibration loop.
 *
 * Usage:
 *   cli-classifier-feedback <pr-number> --add-reviewer <reviewer> --reason "<text>" [--artifacts-dir <path>]
 *
 * Flags:
 *   --add-reviewer <name>     One of testing|critic|security; the reviewer that should
 *                             have been included by the classifier.
 *   --reason "<text>"         One-line explanation that will live in calibration.jsonl.
 *   --artifacts-dir <path>    Override the artifacts directory (defaults to .ai-sdlc/artifacts).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ALL_REVIEWERS, type ReviewerName } from '@ai-sdlc/orchestrator';

interface CliArgs {
  prNumber: string;
  addReviewer: ReviewerName;
  reason: string;
  artifactsDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { artifactsDir: '.ai-sdlc/artifacts' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--add-reviewer') {
      const v = argv[++i];
      if (!v || !ALL_REVIEWERS.includes(v as ReviewerName)) {
        throw new Error(`--add-reviewer must be one of: ${ALL_REVIEWERS.join('|')}`);
      }
      args.addReviewer = v as ReviewerName;
    } else if (a === '--reason') {
      args.reason = argv[++i];
    } else if (a === '--artifacts-dir') {
      args.artifactsDir = argv[++i];
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('--') && !args.prNumber) {
      args.prNumber = a;
    } else {
      throw new Error(`unknown flag or positional: ${a}`);
    }
  }
  if (!args.prNumber) throw new Error('PR number is required');
  if (!args.addReviewer) throw new Error('--add-reviewer is required');
  if (!args.reason) throw new Error('--reason is required');
  return args as CliArgs;
}

function printHelp(): void {
  console.log(`Usage: cli-classifier-feedback <pr-number> --add-reviewer <name> --reason "<text>" [--artifacts-dir <path>]

Back-fill the classifier calibration log with ground truth after a PR merges. Used
to attribute missed reviewers (a human added security-review post-merge that the
classifier skipped) so the calibration loop can detect overconfident classifier
prompts and tune them.

Flags:
  --add-reviewer <name>     One of: ${ALL_REVIEWERS.join(', ')}
  --reason "<text>"         One-line explanation persisted to calibration.jsonl
  --artifacts-dir <path>    Override artifacts dir (default: .ai-sdlc/artifacts)
  -h, --help                Show this help.
`);
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    printHelp();
    process.exit(2);
  }

  const path = join(args.artifactsDir, '_classifier', 'calibration.jsonl');
  let lines: string[] = [];
  try {
    const content = await readFile(path, 'utf8');
    lines = content.split('\n').filter((l) => l.trim().length > 0);
  } catch (err) {
    console.error(`Failed to read ${path}: ${(err as Error).message}`);
    console.error('No calibration log found — nothing to back-fill.');
    process.exit(1);
  }

  // Find the most recent entry matching this PR's issue (best-effort: search by issueId
  // suffix since calibration entries are keyed by issueId, and the operator only knows
  // the PR number). For v1 we mark the most recent entry that has not yet been overridden.
  let foundIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]) as {
        issueId?: string;
        humanOverrideAfterMerge?: unknown;
      };
      if (entry.humanOverrideAfterMerge == null) {
        foundIndex = i;
        break;
      }
    } catch {
      // Skip malformed lines.
    }
  }
  if (foundIndex < 0) {
    console.error('No un-overridden calibration entry found in the log.');
    process.exit(1);
  }

  const entry = JSON.parse(lines[foundIndex]) as Record<string, unknown>;
  entry.humanOverrideAfterMerge = {
    addedReviewer: args.addReviewer,
    reason: args.reason,
    prNumber: args.prNumber,
    attributedAt: new Date().toISOString(),
  };
  lines[foundIndex] = JSON.stringify(entry);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join('\n') + '\n', 'utf8');

  console.log(`Updated calibration entry for issue ${entry.issueId ?? '(unknown)'}:`);
  console.log(`  PR: ${args.prNumber}`);
  console.log(`  Added reviewer: ${args.addReviewer}`);
  console.log(`  Reason: ${args.reason}`);
  console.log('');
  console.log('Calibration log updated. The classifier prompt may benefit from review if');
  console.log('this attribution recurs across multiple PRs.');
}

main().catch((err) => {
  console.error('cli-classifier-feedback failed:', (err as Error).message);
  process.exit(1);
});
