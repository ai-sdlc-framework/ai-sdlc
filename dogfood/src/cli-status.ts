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
 *   cli-status --orchestrator Recent autonomous-pipeline orchestrator events
 *                              (RFC-0015 Phase 4 / AISDLC-169.4)
 *
 * Flags:
 *   --artifacts-dir <path>    Override (default: .ai-sdlc/artifacts)
 *   --json                    Machine-readable output
 *   --limit <N>               Cap on events shown by --orchestrator (default 50)
 */

import { listActiveStates, StateWriter } from '@ai-sdlc/orchestrator';
import { readRecentEvents, type OrchestratorEvent } from '@ai-sdlc/pipeline-cli/orchestrator';

interface CliArgs {
  all: boolean;
  subscriptions: boolean;
  branches: boolean;
  orchestrator: boolean;
  artifactsDir: string;
  json: boolean;
  limit: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    all: false,
    subscriptions: false,
    branches: false,
    orchestrator: false,
    artifactsDir: '.ai-sdlc/artifacts',
    json: false,
    limit: 50,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') args.all = true;
    else if (a === '--subscriptions') args.subscriptions = true;
    else if (a === '--branches') args.branches = true;
    else if (a === '--orchestrator') args.orchestrator = true;
    else if (a === '--artifacts-dir') args.artifactsDir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: cli-status [--all] [--subscriptions] [--branches] [--orchestrator] [--json] [--artifacts-dir <p>] [--limit <N>]

Render active orchestrator state.

Flags:
  --all                 Include completed/failed branches
  --subscriptions       Subscription window utilization view
  --branches            Database branches view (Phase 6)
  --orchestrator        Recent autonomous-pipeline orchestrator events (RFC-0015 Phase 4)
  --json                Machine-readable output
  --artifacts-dir <p>   Override artifacts dir (default: .ai-sdlc/artifacts)
  --limit <N>           Cap on events shown by --orchestrator (default 50)
  -h, --help            Show this help.
`);
}

// ── ANSI color codes (single source so renderer + tests agree) ───────

/**
 * RFC-0015 Phase 4 — color palette for the orchestrator events view.
 * Kept in one place so the renderer + tests reference the same map.
 *
 * - green = OrchestratorCompleted / OrchestratorRecovered (terminal success)
 * - red = OrchestratorFailed (escalation surface)
 * - yellow = OrchestratorAwaitingExternal (Phase 3 admission filter — task held)
 * - cyan = OrchestratorDispatched (worker started)
 * - magenta = WorkerStateTransition (in-flight forensic trail)
 * - gray = OrchestratorTick (loop heartbeat — low-information by design)
 */
const ORCHESTRATOR_COLORS: Record<string, string> = {
  OrchestratorCompleted: '\x1b[32m', // green
  OrchestratorRecovered: '\x1b[32m', // green
  OrchestratorFailed: '\x1b[31m', // red
  OrchestratorAwaitingExternal: '\x1b[33m', // yellow
  OrchestratorDispatched: '\x1b[36m', // cyan
  WorkerStateTransition: '\x1b[35m', // magenta
  OrchestratorTick: '\x1b[90m', // gray (bright black)
};
const RESET = '\x1b[0m';

function colorize(type: string, line: string, useColor: boolean): string {
  if (!useColor) return line;
  const code = ORCHESTRATOR_COLORS[type] ?? '';
  return code ? `${code}${line}${RESET}` : line;
}

/**
 * Render the orchestrator events panel. Exported via the module shape
 * that vitest can re-import; tests assert per-line color coding +
 * formatting without invoking the full main().
 */
export function renderOrchestratorEvents(
  events: readonly OrchestratorEvent[],
  opts: { useColor?: boolean } = {},
): string[] {
  const useColor = opts.useColor ?? false;
  if (events.length === 0) {
    return ['No orchestrator events found.'];
  }
  const out: string[] = [`Recent orchestrator events (${events.length}):`, ''];
  for (const ev of events) {
    const ts = String(ev.ts ?? '');
    const type = String(ev.type ?? 'Unknown');
    const taskId = ev.taskId ? `taskId=${ev.taskId}` : 'taskId=-';
    const runId = ev.runId ? `runId=${shortenRunId(String(ev.runId))}` : 'runId=-';
    const line = `${ts} ${type.padEnd(28)} ${taskId.padEnd(22)} ${runId}`;
    out.push(colorize(type, line, useColor));
  }
  return out;
}

function shortenRunId(runId: string): string {
  // Display the first 8 chars — enough to disambiguate concurrent
  // sessions without burning a full UUID's worth of column width.
  return runId.length <= 8 ? runId : runId.slice(0, 8);
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

  if (args.orchestrator) {
    const events = readRecentEvents({ artifactsDir: args.artifactsDir, limit: args.limit });
    if (args.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    const useColor = process.stdout.isTTY === true;
    for (const line of renderOrchestratorEvents(events, { useColor })) {
      console.log(line);
    }
    return;
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

// Skip auto-execution under vitest so the test file can import
// `renderOrchestratorEvents` without the file walking process.argv.
const isTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
if (!isTest) {
  main().catch((err) => {
    console.error('cli-status failed:', (err as Error).message);
    process.exit(1);
  });
}
