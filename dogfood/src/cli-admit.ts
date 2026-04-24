#!/usr/bin/env node
/**
 * CLI entry point for issue admission scoring.
 *
 * Scores a GitHub issue using the Product Priority Algorithm (RFC-0008
 * §A.6 admission-subset composite) and outputs a JSON verdict
 * indicating whether it should enter the pipeline.
 *
 * Usage:
 *   admit --title "..." --body-file /tmp/body.txt --issue-number 42 \
 *     --labels '["bug"]' --reactions 3 --comments 2 --created-at 2026-01-01T00:00:00Z
 *
 * Optional RFC-0008 flags (stateless by default):
 *   --enrich-from-state              Load .ai-sdlc/ config + state store,
 *                                     resolve refs, and populate enrichment
 *                                     context (C2/C3/C4/C5).
 *   --design-system-ref <name>        Override DSB selection by name.
 *   --autonomy-policy-ref <name>      Override AutonomyPolicy selection.
 *   --did-ref <name>                  Override DesignIntentDocument selection.
 *   --author-login <handle>           Issue author GitHub handle (C5 match).
 *   --code-area <path>                Code area identifier (C3 lookup).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG_DIR_NAME,
  loadConfigAsync,
  resolveRepoRoot,
  scoreIssueForAdmission,
  enrichAdmissionInput,
  StateStore,
  type AdmissionInput,
  type AdmissionThresholds,
  type EnrichmentContext,
} from '@ai-sdlc/orchestrator';
import type { AutonomyPolicy, DesignIntentDocument, DesignSystemBinding } from '@ai-sdlc/reference';

// ── Arg parsing ──────────────────────────────────────────────────────

function getArg(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.indexOf(flag) !== -1;
}

interface AdmitArgs {
  title: string;
  body: string;
  issueNumber: number;
  labels: string[];
  reactions: number;
  comments: number;
  createdAt: string;
  authorAssociation: string;
  authorLogin?: string;
  codeArea?: string;
  enrichFromState: boolean;
  designSystemRef?: string;
  autonomyPolicyRef?: string;
  didRef?: string;
}

function parseArgs(argv: string[]): AdmitArgs {
  const title = getArg(argv, '--title') ?? process.env.ISSUE_TITLE;
  const bodyFile = getArg(argv, '--body-file');
  const issueNumberStr = getArg(argv, '--issue-number');
  const labelsStr = getArg(argv, '--labels');
  const reactionsStr = getArg(argv, '--reactions');
  const commentsStr = getArg(argv, '--comments');
  const createdAt = getArg(argv, '--created-at');
  const authorAssociation = getArg(argv, '--author-association') ?? 'NONE';
  const authorLogin = getArg(argv, '--author-login');
  const codeArea = getArg(argv, '--code-area');
  const designSystemRef = getArg(argv, '--design-system-ref');
  const autonomyPolicyRef = getArg(argv, '--autonomy-policy-ref');
  const didRef = getArg(argv, '--did-ref');
  const enrichFromState = hasFlag(argv, '--enrich-from-state');

  if (!title || !issueNumberStr) {
    console.error('Usage: admit --title "..." --body-file /path --issue-number N');
    console.error(
      '       --labels \'["bug"]\' --reactions N --comments N --created-at ISO --author-association OWNER',
    );
    console.error(
      '       [--enrich-from-state] [--design-system-ref NAME] [--autonomy-policy-ref NAME] [--did-ref NAME]',
    );
    console.error('       [--author-login HANDLE] [--code-area PATH]');
    process.exit(1);
  }

  let body = '';
  if (bodyFile) {
    try {
      body = readFileSync(bodyFile, 'utf-8');
    } catch {
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
    authorAssociation,
    authorLogin,
    codeArea,
    enrichFromState,
    designSystemRef,
    autonomyPolicyRef,
    didRef,
  };
}

// ── Resource selection ───────────────────────────────────────────────

function selectDsb(
  list: DesignSystemBinding[] | undefined,
  ref: string | undefined,
): DesignSystemBinding | undefined {
  if (!list?.length) return undefined;
  if (ref) return list.find((d) => d.metadata.name === ref);
  return list[0];
}

function selectDid(
  list: DesignIntentDocument[] | undefined,
  ref: string | undefined,
): DesignIntentDocument | undefined {
  if (!list?.length) return undefined;
  if (ref) return list.find((d) => d.metadata.name === ref);
  return list[0];
}

function selectAutonomyPolicy(
  policy: AutonomyPolicy | undefined,
  ref: string | undefined,
): AutonomyPolicy | undefined {
  // AutonomyPolicy is a single-instance resource in AiSdlcConfig today;
  // accepting a ref for future-proofing lets the workflow name it
  // explicitly even when there's only one.
  if (!policy) return undefined;
  if (ref && policy.metadata.name !== ref) return undefined;
  return policy;
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
    authorAssociation: args.authorAssociation as AdmissionInput['authorAssociation'],
    ...(args.authorLogin ? { authorLogin: args.authorLogin } : {}),
  };

  // Load priority policy thresholds from pipeline.yaml
  let thresholds: AdmissionThresholds = {
    minimumScore: 0.05,
    minimumConfidence: 0.2,
  };

  let enrichedInput = input;

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

    if (args.enrichFromState) {
      const dsb = selectDsb(config.designSystemBindings, args.designSystemRef);
      const did = selectDid(config.designIntentDocuments, args.didRef);
      const autonomyPolicy = selectAutonomyPolicy(config.autonomyPolicy, args.autonomyPolicyRef);

      const stateDbPath = join(workDir, '.ai-sdlc', 'state.db');
      let stateStore: StateStore | undefined;
      try {
        stateStore = StateStore.open(stateDbPath);
      } catch {
        // State DB may not exist yet — enrichment degrades gracefully.
      }

      const ctx: EnrichmentContext = {
        ...(stateStore ? { stateStore } : {}),
        ...(dsb ? { designSystemBinding: dsb } : {}),
        ...(did ? { designIntentDocument: did } : {}),
        ...(autonomyPolicy ? { autonomyPolicy } : {}),
        ...(args.codeArea ? { codeArea: args.codeArea } : {}),
      };

      enrichedInput = enrichAdmissionInput(input, ctx);
      stateStore?.close();
    }
  } catch {
    console.error('Warning: could not load pipeline config, using default thresholds');
  }

  const result = scoreIssueForAdmission(enrichedInput, thresholds);

  // Output JSON on last line for the workflow to capture
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
