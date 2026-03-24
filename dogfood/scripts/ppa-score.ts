#!/usr/bin/env tsx
/**
 * Dogfood script — score backlog items using the Product Priority Algorithm.
 *
 * Usage:
 *   pnpm --filter @ai-sdlc/dogfood ppa-score
 */

import { computePriority, rankWorkItems, type PriorityInput } from '@ai-sdlc/orchestrator';

// ── Soul purpose from our pipeline config ────────────────────────────

const SOUL_PURPOSE =
  'Provide the open, vendor-neutral governance specification that enables enterprises to adopt AI coding agents with confidence, auditability, and predictability';

// ── Sample backlog items (real items from the project) ───────────────

const backlogItems: PriorityInput[] = [
  {
    itemId: 'AISDLC-8',
    title: 'Implement adapter health check monitoring dashboard',
    description:
      'Add a dashboard panel showing real-time adapter health status, latency, and error rates. Platform engineers need visibility into adapter connectivity.',
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
    description:
      'Graduate the spec from v1alpha1 to v1beta1 with automated migration utilities. Required for production stability guarantees.',
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
    description:
      'Wire up service dependency graph analysis and impact-based ordering for monorepo pipelines. Enables coordinated changes across packages.',
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
    description:
      'Map AI-SDLC controls to EU AI Act requirements for high-risk AI systems. Enterprises need this for regulatory compliance.',
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
  {
    itemId: 'AISDLC-12',
    title: 'Implement real-time cost dashboard with budget alerts',
    description:
      'Add live cost tracking visualization to the dashboard with configurable alert thresholds. Engineering managers need spending visibility.',
    soulAlignment: 0.75,
    customerRequestCount: 4,
    demandSignal: 0.5,
    builderConviction: 0.6,
    complexity: 5,
    budgetUtilization: 20,
    dependencyClearance: 0.9,
    explicitPriority: 0.4,
    teamConsensus: 0.3,
  },
  {
    itemId: 'AISDLC-13',
    title: 'Critical: Fix agent sandbox escape in Docker provider',
    description:
      'Security audit found a path traversal that allows agent to read files outside sandbox. Production blocker.',
    soulAlignment: 0.6,
    bugSeverity: 5,
    demandSignal: 0.9,
    builderConviction: 1.0,
    regulatoryUrgency: 0.8,
    complexity: 3,
    budgetUtilization: 20,
    dependencyClearance: 1.0,
    override: true,
    overrideReason: 'Security vulnerability — production blocker',
  },
  {
    itemId: 'AISDLC-14',
    title: 'Add OpenTelemetry Collector adapter for metrics export',
    description:
      'Create an adapter that exports AI-SDLC metrics to any OpenTelemetry Collector endpoint for integration with existing observability stacks.',
    soulAlignment: 0.65,
    customerRequestCount: 2,
    demandSignal: 0.3,
    techInflection: 0.6,
    competitivePressure: 0.4,
    complexity: 4,
    budgetUtilization: 20,
    dependencyClearance: 0.7,
    explicitPriority: 0.3,
  },
];

// ── Run PPA ──────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║           Product Priority Algorithm — Dogfood Run              ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log();
console.log(`Soul Purpose: "${SOUL_PURPOSE.slice(0, 70)}..."`);
console.log();

const ranked = rankWorkItems(backlogItems);

console.log(
  '┌──────────────┬──────────┬────────┬─────────────────────────────────────────────────┐',
);
console.log(
  '│ ID           │ Score    │ Conf.  │ Title                                           │',
);
console.log(
  '├──────────────┼──────────┼────────┼─────────────────────────────────────────────────┤',
);

for (const item of ranked) {
  const id = item.itemId.padEnd(12);
  const score =
    item.score.composite === Infinity ? '    ∞   ' : item.score.composite.toFixed(4).padStart(8);
  const conf = (item.score.confidence * 100).toFixed(0).padStart(4) + '%';
  const title = item.title.length > 47 ? item.title.slice(0, 44) + '...' : item.title.padEnd(47);
  const override = item.score.override ? ' ⚡ OVERRIDE' : '';
  console.log(`│ ${id} │ ${score} │ ${conf}  │ ${title} │${override}`);
}

console.log(
  '└──────────────┴──────────┴────────┴─────────────────────────────────────────────────┘',
);
console.log();

// ── Detail view for top 3 ────────────────────────────────────────────

console.log('Top 3 — Dimension Breakdown:');
console.log();

for (const item of ranked.slice(0, 3)) {
  const d = item.score.dimensions;
  console.log(`  ${item.itemId}: ${item.title}`);
  if (item.score.override) {
    console.log(`    ⚡ Override: ${item.score.override.reason}`);
  } else {
    console.log(
      `    Sa=${d.soulAlignment.toFixed(2)}  Dp=${d.demandPressure.toFixed(2)}  Mf=${d.marketForce.toFixed(2)}  Er=${d.executionReality.toFixed(2)}  Et=${d.entropyTax.toFixed(2)}  HC=${d.humanCurve.toFixed(2)}  Ck=${d.calibration.toFixed(2)}`,
    );
    console.log(
      `    Composite: ${item.score.composite.toFixed(4)}  Confidence: ${(item.score.confidence * 100).toFixed(0)}%`,
    );
  }
  console.log();
}
