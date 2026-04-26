#!/usr/bin/env node
/**
 * cli-model-bump (RFC-0010 §11.6 / Q5 resolution).
 *
 * Operator-facing command for previewing what model alias resolution would look like
 * after vendor deprecation. Only --dry-run is supported in v1 — this command does NOT
 * mutate state. Operators bump models by restarting the orchestrator after updating
 * the registry; the dry-run shows the diff before that happens.
 *
 * Usage:
 *   cli-model-bump --dry-run [--stages stage1,stage2,...]
 *
 * Flags:
 *   --dry-run               Required in v1. Prints the bump plan and exits 0.
 *   --stages <csv>          Comma-separated stage:alias pairs to evaluate
 *                           (e.g., 'triage:haiku,plan:sonnet,implement:opus[1m]').
 *                           Defaults to the canonical dogfood routing.
 *   --json                  Emit the plan as JSON instead of a human-readable table.
 */

import { ModelRegistry } from '@ai-sdlc/orchestrator';

interface CliArgs {
  dryRun: boolean;
  stages: Array<{ stage: string; alias: string }>;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: false,
    stages: [
      { stage: 'triage', alias: 'haiku' },
      { stage: 'review-classify', alias: 'haiku' },
      { stage: 'plan', alias: 'sonnet' },
      { stage: 'implement', alias: 'opus[1m]' },
      { stage: 'validate', alias: 'sonnet' },
      { stage: 'review-testing', alias: 'sonnet' },
      { stage: 'review-critic', alias: 'sonnet' },
      { stage: 'review-security', alias: 'sonnet' },
      { stage: 'fix-pr', alias: 'sonnet' },
      { stage: 'simplify', alias: 'sonnet' },
    ],
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--stages') {
      const csv = argv[++i];
      if (!csv) throw new Error('--stages requires a comma-separated list');
      args.stages = csv.split(',').map((pair) => {
        const [stage, alias] = pair.split(':');
        if (!stage || !alias) throw new Error(`malformed --stages entry: ${pair}`);
        return { stage: stage.trim(), alias: alias.trim() };
      });
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`Usage: cli-model-bump --dry-run [--stages <csv>] [--json]

Preview model alias resolution after vendor deprecation. Does not mutate state;
restart the orchestrator after updating the registry to pick up the bump.

Flags:
  --dry-run               Required. Prints the bump plan and exits 0.
  --stages <csv>          Comma-separated stage:alias pairs to evaluate
                          (e.g., 'triage:haiku,plan:sonnet').
                          Defaults to the canonical dogfood routing.
  --json                  Emit the plan as JSON instead of a human-readable table.
  -h, --help              Show this help.
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

  if (!args.dryRun) {
    console.error('cli-model-bump requires --dry-run in v1.');
    console.error('There is no in-place bump operation; restart the orchestrator after editing');
    console.error('orchestrator/src/models/registry.ts to pick up new resolutions.');
    process.exit(2);
  }

  const reg = new ModelRegistry();
  const plan = reg.bumpPlan(args.stages);

  if (args.json) {
    console.log(JSON.stringify({ plan, stagesEvaluated: args.stages.length }, null, 2));
    return;
  }

  if (plan.length === 0) {
    console.log('No deprecated aliases in the dogfood routing — nothing to bump.');
    console.log(`(Evaluated ${args.stages.length} stage:alias pairs against the registry.)`);
    return;
  }

  console.log('Bump plan:\n');
  for (const item of plan) {
    const grace = item.inGracePeriod ? ' [GRACE PERIOD]' : '';
    console.log(`  Stage: ${item.stage}`);
    console.log(`    Alias:        ${item.alias}`);
    console.log(`    Current ID:   ${item.currentModelId}`);
    console.log(`    Deprecated:   ${item.deprecatedAt}${grace}`);
    if (item.removedAt) console.log(`    Removal date: ${item.removedAt}`);
    if (item.replacementAlias) {
      console.log(
        `    Replacement:  ${item.replacementAlias} → ${item.replacementModelId ?? '(unknown alias)'}`,
      );
    } else {
      console.log(`    Replacement:  (none declared — registry maintainer fix required)`);
    }
    console.log('');
  }
  console.log(`To apply: edit orchestrator/src/models/registry.ts to set the new`);
  console.log(`replacementAlias as the active alias, then restart the orchestrator.`);
}

main().catch((err) => {
  console.error('cli-model-bump failed:', (err as Error).message);
  process.exit(1);
});
