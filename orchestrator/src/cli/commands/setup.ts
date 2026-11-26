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

import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { Command } from 'commander';
import { detectAgentsDetailed, installMcpServer } from './mcp-setup.js';
import { fetchBranchProtectionStatus } from './branch-protection-shared.js';
import { writeRuntimeGitignore } from '../../runtime-gitignore.js';

export type SetupStatus = 'done' | 'skipped' | 'not-possible';

export interface SetupStep {
  id:
    | 'signing-key'
    | 'init'
    | 'workflows'
    | 'branch-protection'
    | 'gitignore'
    | 'backlog'
    | 'mcp'
    | 'doctor';
  status: SetupStatus;
  reason: string;
  /** Exact next action when the step did not complete. */
  nextAction?: string;
  /** Extra lines printed under the step (for example init's own output). */
  details?: string[];
  /** True when this step wrote something to the repo. */
  changed: boolean;
}

export interface SetupAdapters {
  /** Run `ai-sdlc init --yes --skip-mcp` in `projectDir`. */
  runInit: (projectDir: string) => { exitCode: number; output: string };
  /** Run `ai-sdlc init --add <feature> --yes --skip-mcp` in `projectDir`. */
  runInitAdd: (projectDir: string, feature: string) => { exitCode: number; output: string };
  /** Run `ai-sdlc doctor` in `projectDir`. */
  runDoctor: (projectDir: string) => { exitCode: number; output: string };
  /** Run an external command (read-only calls only: gh reads, `backlog`). Never throws. */
  runCommand: (
    cmd: string,
    args: string[],
  ) => { stdout: string; exitCode: number; stderr?: string };
  /** Environment used for the webhook secret check. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  pinVersion?: string;
}

export type OperatorState = 'done' | 'not-done' | 'unknown';

/** A step only the operator can do (credentials, repository settings). Setup reads, never writes. */
export interface OperatorStep {
  id: 'gh-auth' | 'auto-merge' | 'pat-secret' | 'webhook-secret';
  label: string;
  state: OperatorState;
  reason: string;
  /** Exact command or settings page, present when the state is not `done`. */
  action?: string;
}

export interface SetupResult {
  steps: SetupStep[];
  operatorSteps: OperatorStep[];
  /** True when no step wrote anything. */
  unchanged: boolean;
  /** True when every step is done or skipped. */
  ok: boolean;
}

function lastLines(text: string, n = 5): string {
  return text.trim().split('\n').slice(-n).join(' | ');
}

function outputLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
}

/**
 * A re-run after an init that did not finish: test live state and apply only
 * the missing parts through `init --add` (AISDLC-1355).
 */
function repairSteps(projectDir: string, adapters: SetupAdapters): SetupStep[] {
  const out: SetupStep[] = [];
  const retry = (id: SetupStep['id'], feature: string, label: string): SetupStep => {
    const r = adapters.runInitAdd(projectDir, feature);
    return r.exitCode === 0
      ? {
          id,
          status: 'done',
          reason: `${label} was missing; ran \`init --add ${feature}\``,
          details: outputLines(r.output),
          changed: true,
        }
      : {
          id,
          status: 'not-possible',
          reason: `\`init --add ${feature}\` exited ${r.exitCode}: ${lastLines(r.output)}`,
          nextAction: `fix the error above, then run \`ai-sdlc init --add ${feature}\``,
          changed: false,
        };
  };

  if (existsSync(join(projectDir, '.github', 'workflows', 'ai-sdlc-gate.yml'))) {
    out.push({
      id: 'workflows',
      status: 'skipped',
      reason: 'ai-sdlc-gate.yml already present',
      changed: false,
    });
  } else {
    out.push(retry('workflows', 'workflows', 'the gate workflow'));
  }

  const bp = fetchBranchProtectionStatus(adapters, projectDir);
  if (bp.checked) {
    out.push({
      id: 'branch-protection',
      status: 'skipped',
      reason: `branch protection already present on ${bp.branch}; left as is`,
      changed: false,
    });
  } else if (bp.apiUnavailable) {
    out.push({
      id: 'branch-protection',
      status: 'skipped',
      reason:
        'the plan does not offer branch protection (HTTP 403): only the client-side merge gate applies',
      changed: false,
    });
  } else if (bp.branch) {
    out.push(retry('branch-protection', 'branch-protection', 'branch protection'));
  } else {
    out.push({
      id: 'branch-protection',
      status: 'skipped',
      reason: `could not read branch protection, so it was not retried: ${bp.error ?? 'unknown error'}`,
      changed: false,
    });
  }
  return out;
}

/**
 * Add any runtime entry the .gitignore lacks, on every run (AISDLC-1407): a repository
 * set up by an older version gains the entries added since, which the init skip on a
 * re-run would otherwise never write.
 */
function gitignoreStep(projectDir: string): SetupStep {
  try {
    const added = writeRuntimeGitignore(projectDir);
    return added.length > 0
      ? {
          id: 'gitignore',
          status: 'done',
          reason: `added ${added.length} runtime entr${added.length === 1 ? 'y' : 'ies'} to .gitignore`,
          details: added,
          changed: true,
        }
      : {
          id: 'gitignore',
          status: 'skipped',
          reason: '.gitignore already ignores every runtime path',
          changed: false,
        };
  } catch (err) {
    return {
      id: 'gitignore',
      status: 'not-possible',
      reason: `could not update .gitignore: ${(err as Error).message}`,
      nextAction: 'fix the error above, then run `ai-sdlc doctor --fix`',
      changed: false,
    };
  }
}

/** Create the folders tasks live in; run `backlog init` only when its config is absent and the CLI exists. */
function backlogStep(projectDir: string, adapters: SetupAdapters): SetupStep {
  const created: string[] = [];
  for (const sub of ['tasks', 'completed']) {
    const p = join(projectDir, 'backlog', sub);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      created.push(`backlog/${sub}/`);
    }
  }
  let nextAction: string | undefined;
  let initRan = false;
  if (!existsSync(join(projectDir, 'backlog', 'config.yml'))) {
    const have = adapters.runCommand('backlog', ['--version']);
    if (have.exitCode === 0) {
      const r = adapters.runCommand('backlog', [
        'init',
        basename(projectDir),
        '--agent-instructions',
        'none',
        '--integration-mode',
        'none',
      ]);
      if (r.exitCode === 0) initRan = true;
      else nextAction = 'run `backlog init` in the repository root (it failed here)';
    } else {
      nextAction = 'install the backlog CLI and run `backlog init` in the repository root';
    }
  }
  const parts = [
    created.length > 0
      ? `created ${created.join(', ')}`
      : 'backlog/tasks/ and backlog/completed/ present',
  ];
  if (initRan) parts.push('ran `backlog init` (task prefix: task)');
  if (nextAction) parts.push('backlog/config.yml is missing');
  return {
    id: 'backlog',
    status: created.length > 0 || initRan ? 'done' : 'skipped',
    reason: parts.join('; '),
    ...(nextAction ? { nextAction } : {}),
    changed: created.length > 0 || initRan,
  };
}

/** Read-only live checks of the steps only the operator can do. Every call is a GET or a list. */
function checkOperatorSteps(adapters: SetupAdapters): OperatorStep[] {
  const env = adapters.env ?? process.env;
  const out: OperatorStep[] = [];
  const auth = adapters.runCommand('gh', ['auth', 'status']);
  const authed = auth.exitCode === 0;
  out.push(
    authed
      ? { id: 'gh-auth', label: 'GitHub CLI signed in', state: 'done', reason: 'gh auth status ok' }
      : {
          id: 'gh-auth',
          label: 'GitHub CLI signed in',
          state: 'not-done',
          reason: 'gh auth status failed',
          action: 'gh auth login',
        },
  );

  const unknown = (
    id: OperatorStep['id'],
    label: string,
    why: string,
    action: string,
  ): OperatorStep => ({ id, label, state: 'unknown', reason: why, action });

  const autoLabel = 'Auto-merge allowed on the repository';
  const autoAction = 'Settings > General > Allow auto-merge (turn it on)';
  if (!authed) {
    out.push(unknown('auto-merge', autoLabel, 'gh is not signed in', autoAction));
  } else {
    const r = adapters.runCommand('gh', ['api', 'repos/{owner}/{repo}']);
    let value: unknown;
    try {
      value = (JSON.parse(r.stdout) as { allow_auto_merge?: unknown }).allow_auto_merge;
    } catch {
      value = undefined;
    }
    if (r.exitCode !== 0 || typeof value !== 'boolean') {
      out.push(
        unknown(
          'auto-merge',
          autoLabel,
          'could not read the setting (it is shown to repository admins only)',
          autoAction,
        ),
      );
    } else if (value) {
      out.push({
        id: 'auto-merge',
        label: autoLabel,
        state: 'done',
        reason: 'allow_auto_merge is on',
      });
    } else {
      out.push({
        id: 'auto-merge',
        label: autoLabel,
        state: 'not-done',
        reason: 'allow_auto_merge is off',
        action: autoAction,
      });
    }
  }

  const patLabel = 'AI_SDLC_PAT repository secret';
  const patAction = 'gh secret set AI_SDLC_PAT';
  if (!authed) {
    out.push(unknown('pat-secret', patLabel, 'gh is not signed in', patAction));
  } else {
    const r = adapters.runCommand('gh', ['secret', 'list']);
    if (r.exitCode !== 0) {
      out.push(unknown('pat-secret', patLabel, 'gh secret list failed', patAction));
    } else if (r.stdout.split('\n').some((l) => l.trim().split(/\s+/)[0] === 'AI_SDLC_PAT')) {
      out.push({ id: 'pat-secret', label: patLabel, state: 'done', reason: 'secret is set' });
    } else {
      out.push({
        id: 'pat-secret',
        label: patLabel,
        state: 'not-done',
        reason: 'secret is not set',
        action: patAction,
      });
    }
  }

  const hookLabel = 'AI_SDLC_WEBHOOK_SECRET set where the board runs';
  out.push(
    env.AI_SDLC_WEBHOOK_SECRET
      ? { id: 'webhook-secret', label: hookLabel, state: 'done', reason: 'variable is set' }
      : {
          id: 'webhook-secret',
          label: hookLabel,
          state: 'not-done',
          reason: 'variable is unset: the board polls only and the webhook receiver stays off',
          action:
            'export AI_SDLC_WEBHOOK_SECRET=<secret> and use the same value in Settings > Webhooks',
        },
  );
  return out;
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
    steps.push(...repairSteps(projectDir, adapters));
  } else {
    const r = adapters.runInit(projectDir);
    steps.push(
      r.exitCode === 0
        ? {
            id: 'init',
            status: 'done',
            reason: 'scaffolded .ai-sdlc/',
            details: outputLines(r.output),
            changed: true,
          }
        : {
            id: 'init',
            status: 'not-possible',
            reason: `init exited ${r.exitCode}: ${lastLines(r.output)}`,
            nextAction: 'fix the error above, then run `ai-sdlc setup` again',
            changed: false,
          },
    );
  }

  steps.push(gitignoreStep(projectDir));
  steps.push(backlogStep(projectDir, adapters));

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
        reason: [
          present.length > 0
            ? `already registered for ${present.join(', ')}`
            : 'no MCP client was found, so nothing was registered',
          ...notes,
        ].join('; '),
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
    operatorSteps: checkOperatorSteps(adapters),
    unchanged: steps.every((s) => !s.changed),
    ok: steps.every((s) => s.status !== 'not-possible'),
  };
}

export function renderSetupReport(result: SetupResult): string[] {
  const lines = ['ai-sdlc setup report', ''];
  for (const s of result.steps) {
    lines.push(`  [${s.status}] ${s.id}: ${s.reason}`);
    for (const d of s.details ?? []) lines.push(`      ${d}`);
    if (s.nextAction) lines.push(`      next: ${s.nextAction}`);
  }
  lines.push('');
  lines.push('Steps only you can do (setup reads these and never changes them):');
  for (const o of result.operatorSteps) {
    lines.push(`  [${o.state}] ${o.label}: ${o.reason}`);
    if (o.state !== 'done' && o.action) lines.push(`      do: ${o.action}`);
  }
  lines.push('');
  lines.push(
    'Note: the first pull request that adds .ai-sdlc/ is merged by a person (the merge policy is read only from the default branch); every later pull request goes through cli-merge-if-eligible.',
  );
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

function runExternal(
  cmd: string,
  args: string[],
): { stdout: string; exitCode: number; stderr?: string } {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.status ?? 1 };
  }
}

export const productionSetupAdapters: SetupAdapters = {
  runInit: (dir) => spawnSelf(['init', '--yes', '--skip-mcp'], dir),
  runInitAdd: (dir, feature) => spawnSelf(['init', '--add', feature, '--yes', '--skip-mcp'], dir),
  runCommand: runExternal,
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
