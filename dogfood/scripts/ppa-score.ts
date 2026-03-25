#!/usr/bin/env tsx
/**
 * Dogfood script — score work items using the Product Priority Algorithm.
 *
 * Usage:
 *   pnpm --filter @ai-sdlc/dogfood ppa-score              # score sample backlog items
 *   pnpm --filter @ai-sdlc/dogfood ppa-score -- --github   # score live GitHub issues
 *   pnpm --filter @ai-sdlc/dogfood ppa-score -- --github --state open
 *   pnpm --filter @ai-sdlc/dogfood ppa-score -- --github --state all --limit 20
 */

import { execFileSync } from 'node:child_process';
import { computePriority, rankWorkItems, type PriorityInput } from '@ai-sdlc/orchestrator';

// ── Soul purpose from our pipeline config ────────────────────────────

const SOUL_PURPOSE =
  'Provide the open, vendor-neutral governance specification that enables enterprises to adopt AI coding agents with confidence, auditability, and predictability';

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const useGitHub = args.includes('--github');
const stateIdx = args.indexOf('--state');
const ghState = stateIdx !== -1 ? args[stateIdx + 1] : 'all';
const limitIdx = args.indexOf('--limit');
const ghLimit = limitIdx !== -1 ? Number(args[limitIdx + 1]) : 30;

// ── GitHub issue fetcher ─────────────────────────────────────────────

interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name: string }>;
  comments: Array<{ author: { login: string }; body: string }>;
  reactionGroups: Array<{ content: string; users: { totalCount: number } }>;
  createdAt: string;
}

function fetchGitHubIssues(): GitHubIssue[] {
  const json = execFileSync(
    'gh',
    [
      'issue',
      'list',
      '--state',
      ghState,
      '--limit',
      String(ghLimit),
      '--json',
      'number,title,body,state,labels,comments,reactionGroups,createdAt',
    ],
    { encoding: 'utf-8' },
  );
  return JSON.parse(json);
}

/**
 * Extract PriorityInput signals from a GitHub issue.
 *
 * Maps available GitHub data to PPA dimensions:
 * - Labels → bug severity, soul alignment hints
 * - Reactions (thumbsUp, heart) → team consensus / demand signal
 * - Comments count → demand signal
 * - Body "Complexity" section → complexity score
 * - Age → competitive drift (older issues drift)
 * - Label "ai-eligible" → builder conviction
 */
function issueToInput(issue: GitHubIssue): PriorityInput {
  const labelNames = issue.labels.map((l) => l.name);

  // ── Complexity from issue body ───────────────────────────────────
  const complexityMatch = issue.body?.match(/###?\s*Complexity\s*\n+(\d+)/i);
  const complexity = complexityMatch ? Number(complexityMatch[1]) : undefined;

  // ── Bug severity from labels ─────────────────────────────────────
  let bugSeverity: number | undefined;
  if (labelNames.includes('critical') || labelNames.includes('P0')) bugSeverity = 5;
  else if (labelNames.includes('bug')) bugSeverity = 3;

  // ── Soul alignment heuristic from labels ─────────────────────────
  let soulAlignment = 0.5; // default
  if (labelNames.includes('security') || labelNames.includes('security-triage'))
    soulAlignment = 0.7;
  if (labelNames.includes('enhancement')) soulAlignment = 0.6;
  if (labelNames.includes('governance') || labelNames.includes('compliance')) soulAlignment = 0.85;
  if (labelNames.includes('spec') || labelNames.includes('rfc')) soulAlignment = 0.9;

  // ── Reactions → demand / consensus ───────────────────────────────
  const thumbsUp =
    issue.reactionGroups?.find((r) => r.content === 'THUMBS_UP')?.users?.totalCount ?? 0;
  const hearts = issue.reactionGroups?.find((r) => r.content === 'HEART')?.users?.totalCount ?? 0;
  const totalReactions = thumbsUp + hearts;
  const teamConsensus = Math.min(1, totalReactions / 5); // 5 reactions = full consensus

  // ── Comment count → demand signal ────────────────────────────────
  // Filter out bot comments
  const humanComments =
    issue.comments?.filter(
      (c) => c.author?.login !== 'github-actions' && !c.author?.login?.includes('[bot]'),
    ) ?? [];
  const demandSignal = Math.min(1, humanComments.length / 5);

  // ── Builder conviction from ai-eligible label ────────────────────
  const builderConviction = labelNames.includes('ai-eligible') ? 0.8 : 0.4;

  // ── Age → competitive drift (issues older than 90 days drift) ────
  const ageMs = Date.now() - new Date(issue.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const competitiveDrift = Math.min(1, Math.max(0, (ageDays - 30) / 180));

  // ── Override for security-rejected ───────────────────────────────
  const isSecurityRejected = labelNames.includes('security-rejected');
  if (isSecurityRejected) {
    return {
      itemId: `#${issue.number}`,
      title: issue.title,
      description: issue.body ?? '',
      labels: labelNames,
      soulAlignment: 0, // veto — rejected by security triage
    };
  }

  return {
    itemId: `#${issue.number}`,
    title: issue.title,
    description: issue.body ?? '',
    labels: labelNames,
    soulAlignment,
    bugSeverity,
    customerRequestCount: totalReactions,
    demandSignal,
    builderConviction,
    complexity,
    competitiveDrift,
    teamConsensus,
    explicitPriority: labelNames.includes('high')
      ? 0.8
      : labelNames.includes('low')
        ? 0.2
        : undefined,
  };
}

// ── Sample backlog items (fallback when not using --github) ──────────

const sampleItems: PriorityInput[] = [
  {
    itemId: 'AISDLC-8',
    title: 'Implement adapter health check monitoring dashboard',
    description: 'Add a dashboard panel showing real-time adapter health status.',
    soulAlignment: 0.7,
    customerRequestCount: 3,
    demandSignal: 0.4,
    builderConviction: 0.6,
    techInflection: 0.3,
    competitivePressure: 0.2,
    complexity: 5,
    budgetUtilization: 20,
    dependencyClearance: 0.9,
    explicitPriority: 0.5,
    teamConsensus: 0.4,
  },
  {
    itemId: 'AISDLC-9',
    title: 'Add v1beta1 schema versioning with migration path',
    description: 'Graduate spec from v1alpha1 to v1beta1 with migration utilities.',
    soulAlignment: 0.95,
    customerRequestCount: 8,
    demandSignal: 0.7,
    builderConviction: 0.9,
    techInflection: 0.2,
    competitivePressure: 0.5,
    regulatoryUrgency: 0.3,
    complexity: 7,
    budgetUtilization: 20,
    dependencyClearance: 0.6,
    explicitPriority: 0.8,
    teamConsensus: 0.7,
    meetingDecision: 0.8,
  },
  {
    itemId: 'AISDLC-10',
    title: 'Implement multi-repo orchestration for monorepo workspaces',
    description: 'Wire up service dependency graph analysis for monorepo pipelines.',
    soulAlignment: 0.8,
    customerRequestCount: 5,
    demandSignal: 0.5,
    builderConviction: 0.7,
    techInflection: 0.4,
    competitivePressure: 0.3,
    complexity: 8,
    budgetUtilization: 20,
    dependencyClearance: 0.4,
    explicitPriority: 0.6,
    teamConsensus: 0.5,
  },
  {
    itemId: 'AISDLC-11',
    title: 'Add EU AI Act compliance mapping for high-risk systems',
    description: 'Map AI-SDLC controls to EU AI Act requirements.',
    soulAlignment: 0.9,
    customerRequestCount: 6,
    demandSignal: 0.6,
    builderConviction: 0.5,
    regulatoryUrgency: 0.9,
    techInflection: 0.1,
    competitivePressure: 0.7,
    complexity: 4,
    budgetUtilization: 20,
    dependencyClearance: 0.8,
    explicitPriority: 0.7,
    teamConsensus: 0.6,
    meetingDecision: 0.5,
  },
];

// ── Render ────────────────────────────────────────────────────────────

function render(items: PriorityInput[], source: string): void {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║           Product Priority Algorithm — Dogfood Run              ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log();
  console.log(`Source:       ${source}`);
  console.log(`Soul Purpose: "${SOUL_PURPOSE.slice(0, 60)}..."`);
  console.log(`Items:        ${items.length}`);
  console.log();

  if (items.length === 0) {
    console.log('No items to score.');
    return;
  }

  const ranked = rankWorkItems(items);

  // Table header
  const idW = 14;
  const scoreW = 10;
  const confW = 8;
  const titleW = 49;
  console.log(
    `┌${'─'.repeat(idW)}┬${'─'.repeat(scoreW)}┬${'─'.repeat(confW)}┬${'─'.repeat(titleW)}┐`,
  );
  console.log(
    `│ ${'ID'.padEnd(idW - 2)} │ ${'Score'.padEnd(scoreW - 2)} │ ${'Conf.'.padEnd(confW - 2)} │ ${'Title'.padEnd(titleW - 2)} │`,
  );
  console.log(
    `├${'─'.repeat(idW)}┼${'─'.repeat(scoreW)}┼${'─'.repeat(confW)}┼${'─'.repeat(titleW)}┤`,
  );

  for (const item of ranked) {
    const id = item.itemId.padEnd(idW - 2);
    const score =
      item.score.composite === Infinity
        ? '    ∞   '
        : item.score.composite.toFixed(4).padStart(scoreW - 2);
    const conf = ((item.score.confidence * 100).toFixed(0) + '%').padStart(confW - 2);
    const maxTitle = titleW - 2;
    const title =
      item.title.length > maxTitle
        ? item.title.slice(0, maxTitle - 3) + '...'
        : item.title.padEnd(maxTitle);
    const flag = item.score.override
      ? ' ⚡ OVERRIDE'
      : item.score.composite === 0
        ? ' ✕ VETOED'
        : '';
    console.log(`│ ${id} │ ${score} │ ${conf} │ ${title} │${flag}`);
  }

  console.log(
    `└${'─'.repeat(idW)}┴${'─'.repeat(scoreW)}┴${'─'.repeat(confW)}┴${'─'.repeat(titleW)}┘`,
  );
  console.log();

  // Detail view for top items
  const topN = Math.min(5, ranked.length);
  console.log(`Top ${topN} — Dimension Breakdown:`);
  console.log();

  for (const item of ranked.slice(0, topN)) {
    const d = item.score.dimensions;
    console.log(`  ${item.itemId}: ${item.title}`);
    if (item.score.override) {
      console.log(`    ⚡ Override: ${item.score.override.reason}`);
    } else if (item.score.composite === 0) {
      console.log(
        `    ✕ Vetoed — zero in multiplicative dimension (Sa=${d.soulAlignment.toFixed(2)})`,
      );
    } else {
      console.log(
        `    Sa=${d.soulAlignment.toFixed(2)}  Dp=${d.demandPressure.toFixed(2)}  Mf=${d.marketForce.toFixed(2)}  Er=${d.executionReality.toFixed(2)}  Et=${d.entropyTax.toFixed(2)}  HC=${d.humanCurve.toFixed(2)}  Ck=${d.calibration.toFixed(2)}`,
      );
      console.log(
        `    Composite: ${item.score.composite.toFixed(4)}  Confidence: ${(item.score.confidence * 100).toFixed(0)}%`,
      );
    }
    // Show labels if present
    if (item.labels && item.labels.length > 0) {
      console.log(`    Labels: ${item.labels.join(', ')}`);
    }
    console.log();
  }
}

// ── Main ─────────────────────────────────────────────────────────────

if (useGitHub) {
  console.log(`Fetching GitHub issues (state=${ghState}, limit=${ghLimit})...`);
  console.log();
  const issues = fetchGitHubIssues();
  const inputs = issues.map(issueToInput);
  render(inputs, `GitHub Issues (state=${ghState}, ${issues.length} fetched)`);
} else {
  render(sampleItems, 'Sample backlog items');
}
