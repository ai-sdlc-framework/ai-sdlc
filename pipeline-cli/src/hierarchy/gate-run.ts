/**
 * The one lookup of the `ai-sdlc-gate.yml` run for a head commit (AISDLC-983).
 * `gh run rerun` takes a run id, not a commit, so every rerun path resolves the id
 * here first; `reconcile.ts` and `reenter.ts` share it so they cannot diverge.
 */
import type { CommandRunner } from './types.js';

/** The `gh` argv that prints the newest gate run id for a head SHA. */
export function gateRunListArgs(headSha: string): string[] {
  return [
    'run',
    'list',
    '--commit',
    headSha,
    '--workflow',
    'ai-sdlc-gate.yml',
    '--json',
    'databaseId',
    '--jq',
    '.[0].databaseId',
  ];
}

/** A run id from `gh run list` stdout, or undefined for empty, `null` or non-numeric output. */
export function parseGateRunId(stdout: string | undefined): string | undefined {
  const id = (stdout ?? '').trim();
  return /^\d+$/.test(id) ? id : undefined;
}

/** Resolve the gate run id for a head, or undefined when none resolves. */
export function resolveGateRunId(
  run: CommandRunner,
  cwd: string,
  headSha: string,
): string | undefined {
  const out = run('gh', gateRunListArgs(headSha), { cwd });
  return out.status === 0 ? parseGateRunId(out.stdout) : undefined;
}
