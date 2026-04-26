#!/usr/bin/env node
/**
 * cli-status (RFC-0010 §17). Renders active orchestrator state for operator triage.
 *
 * Subcommands:
 *   cli-status                Active branches + their current stage + heartbeat freshness
 *   cli-status --all          Include completed/failed branches
 *   cli-status --subscriptions Subscription window utilization (Phase 4 surface — full
 *                              implementation lands when SubscriptionLedger has live state)
 *   cli-status --branches     Database branches (warm vs active) — Phase 6 wire-up
 *
 * Flags:
 *   --artifacts-dir <path>    Override (default: .ai-sdlc/artifacts)
 *   --json                    Machine-readable output
 */

import { listActiveStates, StateWriter } from '@ai-sdlc/orchestrator';

interface CliArgs {
  all: boolean;
  subscriptions: boolean;
  branches: boolean;
  artifactsDir: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    all: false,
    subscriptions: false,
    branches: false,
    artifactsDir: '.ai-sdlc/artifacts',
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--subscriptions') args.subscriptions = true;
    else if (a === '--branches') args.branches = true;
    else if (a === '--artifacts-dir') args.artifactsDir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: cli-status [--all] [--subscriptions] [--branches] [--json] [--artifacts-dir <p>]

Render active orchestrator state.

Flags:
  --all                 Include completed/failed branches
  --subscriptions       Subscription window utilization view
  --branches            Database branches view (Phase 6)
  --json                Machine-readable output
  --artifacts-dir <p>   Override artifacts dir (default: .ai-sdlc/artifacts)
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

  if (args.subscriptions) {
    console.log('cli-status --subscriptions: SubscriptionLedger view ships in a follow-up.');
    console.log('Inspect $ARTIFACTS_DIR/_ledger/ directly for current state.');
    return;
  }
  if (args.branches) {
    console.log('cli-status --branches: DatabaseBranchPool view ships in Phase 6 (AISDLC-70.9).');
    return;
  }

  const states = await listActiveStates(args.artifactsDir);
  if (args.json) {
    console.log(JSON.stringify(states, null, 2));
    return;
  }

  if (states.length === 0) {
    console.log('No active branches.');
    return;
  }

  console.log(`Active branches (${states.length}):\n`);
  console.log('Issue            Stage              Status     Heartbeat');
  console.log('───────────────  ─────────────────  ─────────  ──────────');
  for (const s of states) {
    if (!args.all && (s.status === 'success' || s.status === 'failure')) continue;
    const stale = StateWriter.isStale(s) ? ' (STALE)' : '';
    const ageMin = Math.floor((Date.now() - new Date(s.lastHeartbeat).getTime()) / 60000);
    console.log(
      `${s.issueId.padEnd(15)}  ${s.currentStage.padEnd(17)}  ${s.status.padEnd(9)}  ${ageMin}m ago${stale}`,
    );
  }
}

main().catch((err) => {
  console.error('cli-status failed:', (err as Error).message);
  process.exit(1);
});
