/**
 * ai-sdlc setup — the single first-run command (AISDLC-1178).
 *
 * After the plugin is installed and loaded, this one command runs init,
 * registers the MCP advisor for the detected clients and runs doctor, then
 * prints one report: each step is done, skipped (already present) or not
 * possible, with the reason and the exact next action. It is idempotent: a
 * second run touches only what is missing and says so.
 *
 * The signing key step is reported as skipped: RFC-0061 phase 3 removed the
 * signing keyring, so there is nothing to generate.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { detectAgentsDetailed, installMcpServer } from './mcp-setup.js';

export type SetupStatus = 'done' | 'skipped' | 'not-possible';

export interface SetupStep {
  id: 'signing-key' | 'init' | 'mcp' | 'doctor';
  status: SetupStatus;
  reason: string;
  /** Exact next action when the step did not complete. */
  nextAction?: string;
  /** True when this step wrote something to the repo. */
  changed: boolean;
}

export interface SetupAdapters {
  /** Run `ai-sdlc init --yes --skip-mcp` in `projectDir`. */
  runInit: (projectDir: string) => { exitCode: number; output: string };
  /** Run `ai-sdlc doctor` in `projectDir`. */
  runDoctor: (projectDir: string) => { exitCode: number; output: string };
  pinVersion?: string;
}

export interface SetupResult {
  steps: SetupStep[];
  /** True when no step wrote anything. */
  unchanged: boolean;
  /** True when every step is done or skipped. */
  ok: boolean;
}

function lastLines(text: string, n = 5): string {
  return text.trim().split('\n').slice(-n).join(' | ');
}

export function runSetup(projectDir: string, adapters: SetupAdapters): SetupResult {
  const steps: SetupStep[] = [];

  steps.push({
    id: 'signing-key',
    status: 'skipped',
    reason: 'no signing key is required: the merge gate reads the review verdict record (RFC-0061)',
    changed: false,
  });

  if (existsSync(join(projectDir, '.ai-sdlc', 'pipeline.yaml'))) {
    steps.push({
      id: 'init',
      status: 'skipped',
      reason: '.ai-sdlc/pipeline.yaml already present',
      changed: false,
    });
  } else {
    const r = adapters.runInit(projectDir);
    steps.push(
      r.exitCode === 0
        ? { id: 'init', status: 'done', reason: 'scaffolded .ai-sdlc/', changed: true }
        : {
            id: 'init',
            status: 'not-possible',
            reason: `init exited ${r.exitCode}: ${lastLines(r.output)}`,
            nextAction: 'fix the error above, then run `ai-sdlc setup` again',
            changed: false,
          },
    );
  }

  try {
    const { detected, skipped } = detectAgentsDetailed(projectDir, {
      pinVersion: adapters.pinVersion,
    });
    const written: string[] = [];
    const present: string[] = [];
    for (const agent of detected) {
      const status = installMcpServer(projectDir, agent, false);
      (status === 'skipped' ? present : written).push(`${agent.name} (${agent.configPath})`);
    }
    const notes = skipped.map((s) => `${s.name} not registered: ${s.reason}`);
    if (written.length > 0) {
      steps.push({
        id: 'mcp',
        status: 'done',
        reason: [`registered for ${written.join(', ')}`, ...notes].join('; '),
        changed: true,
      });
    } else {
      steps.push({
        id: 'mcp',
        status: 'skipped',
        reason: [`already registered for ${present.join(', ') || '(no clients)'}`, ...notes].join(
          '; ',
        ),
        changed: false,
      });
    }
  } catch (err) {
    steps.push({
      id: 'mcp',
      status: 'not-possible',
      reason: err instanceof Error ? err.message : String(err),
      nextAction: 'run `ai-sdlc init --skip-mcp=false` or edit the client MCP config by hand',
      changed: false,
    });
  }

  const d = adapters.runDoctor(projectDir);
  steps.push(
    d.exitCode === 0
      ? { id: 'doctor', status: 'done', reason: 'doctor reports no errors', changed: false }
      : {
          id: 'doctor',
          status: 'not-possible',
          reason: `doctor reported errors: ${lastLines(d.output)}`,
          nextAction: 'run `ai-sdlc doctor --fix`, then `ai-sdlc doctor`',
          changed: false,
        },
  );

  return {
    steps,
    unchanged: steps.every((s) => !s.changed),
    ok: steps.every((s) => s.status !== 'not-possible'),
  };
}

export function renderSetupReport(result: SetupResult): string[] {
  const lines = ['ai-sdlc setup report', ''];
  for (const s of result.steps) {
    lines.push(`  [${s.status}] ${s.id}: ${s.reason}`);
    if (s.nextAction) lines.push(`      next: ${s.nextAction}`);
  }
  lines.push('');
  if (result.unchanged) lines.push('Nothing changed: this repo was already set up.');
  lines.push(
    result.ok
      ? 'Setup complete. If /ai-sdlc commands are missing, run /reload-plugins once (Claude Code requires it after a plugin install).'
      : 'Setup incomplete: see the next actions above.',
  );
  return lines;
}

function spawnSelf(args: string[], cwd: string): { exitCode: number; output: string } {
  try {
    const out = execFileSync(process.execPath, [process.argv[1]!, ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { exitCode: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

export const productionSetupAdapters: SetupAdapters = {
  runInit: (dir) => spawnSelf(['init', '--yes', '--skip-mcp'], dir),
  runDoctor: (dir) => spawnSelf(['doctor'], dir),
};

export const setupCommand = new Command('setup')
  .description(
    'First-run setup: init, MCP advisor registration and doctor in one idempotent command',
  )
  .action(() => {
    const result = runSetup(process.cwd(), productionSetupAdapters);
    for (const line of renderSetupReport(result)) console.log(line);
    if (!result.ok) process.exitCode = 1;
  });
