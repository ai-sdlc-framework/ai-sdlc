#!/usr/bin/env node
/**
 * CLI entry point for watch mode — drives one or more backlog tasks through
 * the shared `executePipeline()` composite from `@ai-sdlc/pipeline-cli`.
 *
 * Usage: pnpm --filter @ai-sdlc/dogfood watch --issue <id> [--issue <id> ...]
 *                                               [--spawner mock|shell|sdk|auto]
 *
 * RFC-0012 Phase 5 (AISDLC-100.5). The previous implementation wrapped
 * `@ai-sdlc/orchestrator`'s reconciler-driven `startWatch` + Pipeline-resource
 * `executePipeline`. This entry point now invokes the simpler, backlog-task-
 * centric Tier 2 composite from `@ai-sdlc/pipeline-cli` directly. Each
 * `--issue` runs the full Step 0-13 pipeline sequentially against the same
 * spawner; final results are reported on stdout.
 *
 * Spawner selection (RFC-0012 §8.3):
 *   - `--spawner shell` (or default `auto` when `claude` CLI is on PATH) →
 *     `ShellClaudePSpawner` (subscription billing, preferred per RFC §2.4).
 *   - `--spawner sdk`   (or `auto` falling back to `ANTHROPIC_API_KEY`) →
 *     `ClaudeCodeSDKSpawner` (API-key billing for unattended/CI runs).
 *   - `--spawner mock`  → `MockSpawner` (deterministic test fixture; intended
 *     for smoke tests + this file's own integration tests).
 *
 * Parity gaps vs the pre-migration orchestrator path are documented in the
 * task `notes` field (AISDLC-100.5) and listed near the bottom of this file.
 */

import {
  executePipeline,
  defaultSpawner,
  defaultRunner,
  MockSpawner,
  type PipelineOptions,
  type PipelineResult,
  type SubagentSpawner,
  type SubagentResult,
  type SubagentType,
} from '@ai-sdlc/pipeline-cli';

type SpawnerKind = 'auto' | 'shell' | 'sdk' | 'mock';

interface ParsedArgs {
  issueIds: string[];
  spawnerKind: SpawnerKind;
}

function parseArgs(argv: string[]): ParsedArgs {
  const issues: string[] = [];
  let spawnerKind: SpawnerKind = 'auto';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--issue' && i + 1 < argv.length) {
      const id = argv[i + 1].trim();
      if (!id) {
        console.error(`Invalid issue ID: ${argv[i + 1]}`);
        process.exit(1);
      }
      issues.push(id);
      i++;
    } else if (argv[i] === '--spawner' && i + 1 < argv.length) {
      const value = argv[i + 1].trim().toLowerCase();
      if (value !== 'auto' && value !== 'shell' && value !== 'sdk' && value !== 'mock') {
        console.error(
          `Invalid --spawner "${argv[i + 1]}" — expected one of: auto, shell, sdk, mock`,
        );
        process.exit(1);
      }
      spawnerKind = value as SpawnerKind;
      i++;
    }
  }
  if (issues.length === 0) {
    console.error('Usage: watch --issue <id> [--issue <id> ...] [--spawner auto|shell|sdk|mock]');
    process.exit(1);
  }
  return { issueIds: issues, spawnerKind };
}

/**
 * Build the `SubagentSpawner` matching the requested kind. Exported so tests
 * can inject `--spawner mock` and verify pipeline orchestration without
 * touching `claude` / the SDK.
 */
export async function resolveSpawner(kind: SpawnerKind): Promise<SubagentSpawner> {
  if (kind === 'mock') {
    return makeApprovingMockSpawner();
  }
  // shell / sdk / auto: defer to the pipeline-cli resolver. defaultSpawner()
  // prefers ShellClaudePSpawner when `claude` is on PATH and falls back to
  // ClaudeCodeSDKSpawner when ANTHROPIC_API_KEY is set. Explicit `--spawner`
  // overrides the auto-detection by short-circuiting one of the two probes.
  if (kind === 'shell') {
    // Force the shell branch: pretend env has no API key so we never fall
    // through to the SDK spawner if `claude` is missing.
    return defaultSpawner({ env: () => undefined });
  }
  if (kind === 'sdk') {
    // Force the SDK branch: pretend `claude` isn't on PATH so we skip it.
    return defaultSpawner({ which: async () => false });
  }
  return defaultSpawner();
}

/**
 * Default MockSpawner used by `--spawner mock` smoke tests. Returns an
 * "approving" verdict for every reviewer + a passing developer return so the
 * pipeline reaches the push-and-PR step without errors.
 */
function makeApprovingMockSpawner(): MockSpawner {
  const developer: SubagentResult = {
    type: 'developer',
    output: '',
    parsed: {
      summary: '[mock] watch.ts smoke test — no real changes',
      filesChanged: [],
      commitSha: null,
      verifications: { build: 'skipped', test: 'skipped', lint: 'skipped', format: 'skipped' },
      acceptanceCriteriaMet: [],
      notes: 'mock spawner — no actual code was produced',
    },
    status: 'success',
    durationMs: 0,
  };
  const approver = (type: SubagentType): SubagentResult => ({
    type,
    output: '',
    parsed: { approved: true, findings: [], summary: '[mock] auto-approved' },
    status: 'success',
    durationMs: 0,
  });
  return new MockSpawner({
    developer,
    'code-reviewer': approver('code-reviewer'),
    'test-reviewer': approver('test-reviewer'),
    'security-reviewer': approver('security-reviewer'),
  });
}

/**
 * Run a single task through `executePipeline()` and pretty-print its outcome.
 * Exported so tests can call it directly without spinning up a full process.
 */
export async function runOneIssue(
  issueId: string,
  spawner: SubagentSpawner,
  workDir: string = process.cwd(),
  overrides: Partial<PipelineOptions> = {},
): Promise<PipelineResult> {
  console.log(`[watch] dispatching ${issueId} via executePipeline()`);
  const result = await executePipeline({
    taskId: issueId,
    workDir,
    spawner,
    runner: defaultRunner,
    ...overrides,
  });
  if (result.outcome === 'approved') {
    console.log(
      `[watch] ${issueId}: approved → ${result.prUrl ?? '(no PR url)'} ` +
        `(iterations=${result.iterations})`,
    );
  } else if (result.outcome === 'needs-human-attention') {
    console.warn(
      `[watch] ${issueId}: needs human attention → ${result.prUrl ?? '(no PR url)'} ` +
        `(iterations=${result.iterations})`,
    );
  } else if (result.outcome === 'developer-failed') {
    console.error(
      `[watch] ${issueId}: developer failed — ${result.notes ?? '(no reason)'} ` +
        `(iterations=${result.iterations})`,
    );
  } else {
    console.error(
      `[watch] ${issueId}: aborted — ${result.notes ?? '(no reason)'} ` +
        `(iterations=${result.iterations})`,
    );
  }
  return result;
}

async function main(): Promise<void> {
  const { issueIds, spawnerKind } = parseArgs(process.argv);
  const spawner = await resolveSpawner(spawnerKind);

  const results: PipelineResult[] = [];
  for (const issueId of issueIds) {
    try {
      const result = await runOneIssue(issueId, spawner);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[watch] ${issueId}: unhandled error — ${message}`);
    }
  }

  const failures = results.filter(
    (r) => r.outcome === 'aborted' || r.outcome === 'developer-failed',
  );
  console.log(
    `[watch] processed ${results.length}/${issueIds.length} issues — ` +
      `${results.length - failures.length} ok, ${failures.length} failed`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

// ── Phase 5 / 6 parity follow-ups ──────────────────────────────────────────
//
// `executePipeline()` from `@ai-sdlc/pipeline-cli` is the simpler Tier 2
// composite from RFC-0012 §7. Behaviors the previous orchestrator-driven
// path supported that this entry point intentionally NO LONGER wires up
// (pipeline-cli does not yet expose them):
//
//   - Reconciler retry/backoff loop (`ReconcilerLoop`, `createResourceCache`,
//     priority scoring). Each `--issue` here runs once and sequentially.
//   - Pipeline resource selection (the auto-route to
//     `dogfood-backlog-pipeline` for AISDLC-* IDs) — pipeline-cli is
//     backlog-task-centric and does not consume `Pipeline` YAML resources.
//     The orchestrator-driven `pnpm --filter @ai-sdlc/dogfood execute` CLI
//     remains for that surface (cli.ts is unchanged).
//   - Admission gating (RFC-0008), autonomy policy enforcement, audit log
//     writes, OTEL instrumentation, structured logger, agent discovery,
//     provenance attestation. These were composed by `@ai-sdlc/orchestrator`
//     around the inner pipeline loop; pipeline-cli's Step 10 finalize signs
//     a DSSE attestation but does not run admission/autonomy gates.
//   - Multi-resource queue (`enqueueGate`, `enqueueAutonomy`).
//
// Restoring those behaviors is tracked as Phase 6 follow-up: either by
// re-introducing a thin reconciler shell around `executePipeline()` or by
// surfacing the missing primitives through `@ai-sdlc/pipeline-cli`. See
// RFC-0012 §11 Phase 5/6.

// Only invoke main when this file is the script entry point (not when imported
// from a test). vitest imports the module to spy on its exports; without this
// gate, `main()` would fire during test setup and call `process.exit`.
const invokedAsScript =
  Boolean(process.argv[1]) &&
  (process.argv[1].endsWith('cli-watch.ts') || process.argv[1].endsWith('cli-watch.js'));
if (invokedAsScript) {
  void main();
}
