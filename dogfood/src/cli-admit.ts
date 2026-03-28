#!/usr/bin/env node
/**
 * CLI entry point for issue admission scoring.
 *
 * Scores a GitHub issue using the Product Priority Algorithm and outputs
 * a JSON verdict indicating whether it should enter the pipeline.
 *
 * Usage:
 *   admit --title "..." --body-file /tmp/body.txt --issue-number 42 \
 *     --labels '["bug"]' --reactions 3 --comments 2 --created-at 2026-01-01T00:00:00Z
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  scoreIssueForAdmission,
  resolveRepoRoot,
  loadConfigAsync,
  type AdmissionInput,
  type AdmissionThresholds,
} from '@ai-sdlc/orchestrator';
import { DEFAULT_CONFIG_DIR_NAME } from '@ai-sdlc/orchestrator';

// ── Arg parsing ──────────────────────────────────────────────────────

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

interface AdmitArgs {
  title: string;
  body: string;
  issueNumber: number;
  labels: string[];
  reactions: number;
  comments: number;
  createdAt: string;
}

function parseArgs(argv: string[]): AdmitArgs {
  const title = getArg(argv, '--title') ?? process.env.ISSUE_TITLE;
  const bodyFile = getArg(argv, '--body-file');
  const issueNumberStr = getArg(argv, '--issue-number');
  const labelsStr = getArg(argv, '--labels');
  const reactionsStr = getArg(argv, '--reactions');
  const commentsStr = getArg(argv, '--comments');
  const createdAt = getArg(argv, '--created-at');

  if (!title || !issueNumberStr) {
    console.error('Usage: admit --title "..." --body-file /path --issue-number N');
    console.error('       --labels \'["bug"]\' --reactions N --comments N --created-at ISO');
    process.exit(1);
  }

  let body = '';
  if (bodyFile) {
    try {
      body = readFileSync(bodyFile, 'utf-8');
    } catch {
      // Body file may not exist for issues with no body
      body = '';
    }
  }

  let labels: string[] = [];
  if (labelsStr) {
    try {
      labels = JSON.parse(labelsStr);
    } catch {
      labels = [];
    }
  }

  return {
    title,
    body,
    issueNumber: Number(issueNumberStr),
    labels,
    reactions: Number(reactionsStr ?? '0'),
    comments: Number(commentsStr ?? '0'),
    createdAt: createdAt ?? new Date().toISOString(),
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const input: AdmissionInput = {
    issueNumber: args.issueNumber,
    title: args.title,
    body: args.body,
    labels: args.labels,
    reactionCount: args.reactions,
    commentCount: args.comments,
    createdAt: args.createdAt,
  };

  // Load priority policy thresholds from pipeline.yaml
  let thresholds: AdmissionThresholds = {
    minimumScore: 0.05,
    minimumConfidence: 0.2,
  };

  try {
    const workDir = await resolveRepoRoot();
    const configDir = join(workDir, DEFAULT_CONFIG_DIR_NAME);
    const config = await loadConfigAsync(configDir);
    const policy = config.pipeline?.spec?.priorityPolicy;
    if (policy) {
      thresholds = {
        minimumScore: policy.minimumScore ?? thresholds.minimumScore,
        minimumConfidence: policy.minimumConfidence ?? thresholds.minimumConfidence,
      };
    }
  } catch {
    // Fall back to defaults if config can't be loaded
    console.error('Warning: could not load pipeline config, using default thresholds');
  }

  const result = scoreIssueForAdmission(input, thresholds);

  // Output JSON on last line for the workflow to capture
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
