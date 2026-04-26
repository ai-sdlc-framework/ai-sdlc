#!/usr/bin/env node
/**
 * cli-tier-recommendation (RFC-0010 §14.13 / Q13).
 *
 * Renders the most recent TierAnalysis records from $ARTIFACTS_DIR/_ledger/tier-analysis.jsonl
 * to give operators an upgrade/downgrade recommendation grounded in observed contention.
 *
 * Usage:
 *   cli-tier-recommendation [--last <N>] [--details] [--all-tenants] [--artifacts-dir <path>]
 *
 * Flags:
 *   --last <N>            Show the last N records per ledger key (default 1).
 *   --details             Include per-event contention breakdown.
 *   --all-tenants         Show all (harness, accountId, tenant) keys.
 *   --artifacts-dir <p>   Override artifacts dir (default: .ai-sdlc/artifacts).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface CliArgs {
  last: number;
  details: boolean;
  allTenants: boolean;
  artifactsDir: string;
}

interface TierAnalysisRecord {
  billingPeriod: string;
  ledgerKey: { harness: string; accountId: string; tenant: string };
  currentPlan: string;
  currentPlanCostUsd: number;
  contentionEvents: number;
  cumulativeContentionDurationMs: number;
  recommendedPlan: string;
  recommendedPlanCostUsd: number;
  projectedTimeSavedMs: number;
  projectedAdditionalIssuesProcessed: number;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    last: 1,
    details: false,
    allTenants: false,
    artifactsDir: '.ai-sdlc/artifacts',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last') {
      args.last = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(args.last) || args.last < 1)
        throw new Error('--last must be a positive integer');
    } else if (a === '--details') args.details = true;
    else if (a === '--all-tenants') args.allTenants = true;
    else if (a === '--artifacts-dir') args.artifactsDir = argv[++i];
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: cli-tier-recommendation [--last <N>] [--details] [--all-tenants] [--artifacts-dir <p>]

Render TierAnalysis records from the calibration ledger.

Flags:
  --last <N>            Show last N records per ledger key (default 1).
  --details             Include per-event contention breakdown.
  --all-tenants         Show all (harness, accountId, tenant) keys (default: current pipeline only).
  --artifacts-dir <p>   Override artifacts dir (default: .ai-sdlc/artifacts).
  -h, --help            Show this help.
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

  const path = join(args.artifactsDir, '_ledger', 'tier-analysis.jsonl');
  let records: TierAnalysisRecord[] = [];
  try {
    const raw = await readFile(path, 'utf8');
    records = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TierAnalysisRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(
        'No TierAnalysis records yet. Recommendations appear after the first weekly aggregation.',
      );
      console.log(`(expected at ${path})`);
      return;
    }
    throw err;
  }

  // Group by ledger key, take last N.
  const byKey = new Map<string, TierAnalysisRecord[]>();
  for (const r of records) {
    const k = `${r.ledgerKey.harness}|${r.ledgerKey.accountId}|${r.ledgerKey.tenant}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  for (const [key, rs] of byKey) {
    const latest = rs.slice(-args.last);
    console.log(`\n── ${key} ──`);
    for (const r of latest) {
      const action =
        r.recommendedPlan !== r.currentPlan ? '↑ RECOMMEND CHANGE' : '✓ stay on current';
      console.log(`  ${r.billingPeriod}  ${action}`);
      console.log(`    Current:     ${r.currentPlan} ($${r.currentPlanCostUsd}/period)`);
      console.log(`    Recommended: ${r.recommendedPlan} ($${r.recommendedPlanCostUsd}/period)`);
      console.log(
        `    Contention:  ${r.contentionEvents} events / ${(r.cumulativeContentionDurationMs / 3600000).toFixed(1)}h cumulative`,
      );
      console.log(`    Confidence:  ${r.confidence}`);
      if (args.details) {
        console.log(`    Projected time saved: ${(r.projectedTimeSavedMs / 3600000).toFixed(1)}h`);
        console.log(`    Projected additional issues: ${r.projectedAdditionalIssuesProcessed}`);
        console.log(`    Reasoning: ${r.reasoning}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('cli-tier-recommendation failed:', (err as Error).message);
  process.exit(1);
});
