/** First-run smoke test for `ai-sdlc setup` on a fresh repository (AISDLC-1178). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSetup, renderSetupReport, type SetupAdapters } from './setup.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-test-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function adapters(over: Partial<SetupAdapters> = {}): SetupAdapters {
  return {
    runInit: (d) => {
      mkdirSync(join(d, '.ai-sdlc'), { recursive: true });
      writeFileSync(join(d, '.ai-sdlc', 'pipeline.yaml'), 'x');
      mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(d, '.github', 'workflows', 'ai-sdlc-gate.yml'), 'x');
      return { exitCode: 0, output: '' };
    },
    runInitAdd: () => ({ exitCode: 0, output: '' }),
    runCommand: () => ({ stdout: '', exitCode: 1 }),
    env: {},
    runDoctor: () => ({ exitCode: 0, output: '' }),
    ...over,
  };
}

describe('ai-sdlc setup', () => {
  it('first run on a fresh repo inits, registers MCP and runs doctor', () => {
    const r = runSetup(dir, adapters());
    const byId = Object.fromEntries(r.steps.map((s) => [s.id, s]));
    expect(byId.init.status).toBe('done');
    expect(byId.mcp.status).toBe('done');
    expect(byId.doctor.status).toBe('done');
    expect(byId['signing-key'].status).toBe('skipped');
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(false);
  });

  it('second run changes nothing and says so', () => {
    runSetup(dir, adapters());
    const r = runSetup(
      dir,
      adapters({
        runInit: () => {
          throw new Error('init must not rerun');
        },
      }),
    );
    expect(r.unchanged).toBe(true);
    expect(r.steps.find((s) => s.id === 'init')?.status).toBe('skipped');
    expect(r.steps.find((s) => s.id === 'mcp')?.status).toBe('skipped');
    expect(renderSetupReport(r).join('\n')).toContain('Nothing changed');
    expect(renderSetupReport(r).join('\n')).toContain(
      'first pull request that adds .ai-sdlc/ is merged by a person',
    );
  });

  it('reports not-possible steps with a next action', () => {
    const r = runSetup(
      dir,
      adapters({
        runInit: () => ({ exitCode: 2, output: 'boom' }),
        runDoctor: () => ({ exitCode: 1, output: 'fail' }),
      }),
    );
    expect(r.ok).toBe(false);
    const bad = r.steps.filter((s) => s.status === 'not-possible');
    expect(bad.map((s) => s.id)).toEqual(['init', 'doctor']);
    expect(bad.every((s) => s.nextAction)).toBe(true);
    const text = renderSetupReport(r).join('\n');
    expect(text).toContain('next:');
    expect(text).toContain('Setup incomplete');
  });

  it('reports an MCP failure as not-possible', () => {
    writeFileSync(join(dir, '.mcp.json'), '{"mcpServers": 5}');
    const r = runSetup(dir, adapters());
    expect(r.steps.find((s) => s.id === 'mcp')?.status).toBe('not-possible');
  });

  it('prints init output (next steps, pnpm note) in the report', () => {
    const r = runSetup(
      dir,
      adapters({
        runInit: (d) => {
          mkdirSync(join(d, '.ai-sdlc'), { recursive: true });
          writeFileSync(join(d, '.ai-sdlc', 'pipeline.yaml'), 'x');
          return {
            exitCode: 0,
            output: 'Warning: no package.json; workflows will fail\n\nNext steps:\n  1. push\n',
          };
        },
      }),
    );
    const text = renderSetupReport(r).join('\n');
    expect(text).toContain('Next steps:');
    expect(text).toContain('no package.json');
  });

  describe('retry on re-run', () => {
    const ghRead =
      (protection: { stdout: string; exitCode: number; stderr?: string }) =>
      (cmd: string, args: string[]) => {
        if (args[0] === 'repo') return { stdout: 'o/r main', exitCode: 0 };
        if (args[0] === 'api' && args[1].endsWith('/protection')) return protection;
        return { stdout: '', exitCode: 1 };
      };
    const seed = () => {
      runSetup(dir, adapters());
    };

    it('runs init --add branch-protection after a failed first init and reports it', () => {
      const first = runSetup(
        dir,
        adapters({
          runInit: (d) => {
            mkdirSync(join(d, '.ai-sdlc'), { recursive: true });
            writeFileSync(join(d, '.ai-sdlc', 'pipeline.yaml'), 'x');
            mkdirSync(join(d, '.github', 'workflows'), { recursive: true });
            writeFileSync(join(d, '.github', 'workflows', 'ai-sdlc-gate.yml'), 'x');
            return { exitCode: 1, output: 'branch protection failed' };
          },
        }),
      );
      expect(first.ok).toBe(false);
      const added: string[] = [];
      const r = runSetup(
        dir,
        adapters({
          runCommand: ghRead({ stdout: 'Not Found', exitCode: 1, stderr: 'HTTP 404' }),
          runInitAdd: (_d, f) => {
            added.push(f);
            return { exitCode: 0, output: 'applied' };
          },
        }),
      );
      expect(added).toEqual(['branch-protection']);
      const bp = r.steps.find((s) => s.id === 'branch-protection')!;
      expect(bp.status).toBe('done');
      expect(renderSetupReport(r).join('\n')).toContain('applied');
    });

    it('reports a failed retry as not-possible', () => {
      seed();
      const r = runSetup(
        dir,
        adapters({
          runCommand: ghRead({ stdout: '', exitCode: 1, stderr: 'HTTP 404' }),
          runInitAdd: () => ({ exitCode: 3, output: 'nope' }),
        }),
      );
      expect(r.steps.find((s) => s.id === 'branch-protection')?.status).toBe('not-possible');
    });

    it('does not retry when a rule exists', () => {
      seed();
      const r = runSetup(
        dir,
        adapters({
          runCommand: ghRead({ stdout: '{"required_status_checks":{"contexts":[]}}', exitCode: 0 }),
          runInitAdd: () => {
            throw new Error('must not run');
          },
        }),
      );
      expect(r.steps.find((s) => s.id === 'branch-protection')?.status).toBe('skipped');
    });

    it('does not retry when the plan returns HTTP 403', () => {
      seed();
      const r = runSetup(
        dir,
        adapters({
          runCommand: ghRead({ stdout: '', exitCode: 1, stderr: 'gh: Upgrade (HTTP 403)' }),
          runInitAdd: () => {
            throw new Error('must not run');
          },
        }),
      );
      const bp = r.steps.find((s) => s.id === 'branch-protection')!;
      expect(bp.status).toBe('skipped');
      expect(bp.reason).toContain('403');
    });

    it('re-adds a missing gate workflow', () => {
      seed();
      rmSync(join(dir, '.github'), { recursive: true });
      const added: string[] = [];
      runSetup(
        dir,
        adapters({
          runInitAdd: (_d, f) => {
            added.push(f);
            return { exitCode: 0, output: '' };
          },
        }),
      );
      expect(added).toEqual(['workflows']);
    });

    it('reports a failed workflows retry', () => {
      seed();
      rmSync(join(dir, '.github'), { recursive: true });
      const r = runSetup(dir, adapters({ runInitAdd: () => ({ exitCode: 2, output: 'x' }) }));
      expect(r.steps.find((s) => s.id === 'workflows')?.status).toBe('not-possible');
    });
  });

  describe('backlog folders', () => {
    it('creates backlog/tasks and completed, then reports them present', () => {
      const r = runSetup(dir, adapters());
      expect(existsSync(join(dir, 'backlog', 'tasks'))).toBe(true);
      expect(existsSync(join(dir, 'backlog', 'completed'))).toBe(true);
      expect(r.steps.find((s) => s.id === 'backlog')?.status).toBe('done');
      const r2 = runSetup(dir, adapters());
      const b = r2.steps.find((s) => s.id === 'backlog')!;
      expect(b.status).toBe('skipped');
      expect(b.reason).toContain('present');
      expect(b.nextAction).toContain('backlog init');
    });

    it('runs backlog init when the CLI exists and config is absent', () => {
      const calls: string[][] = [];
      const r = runSetup(
        dir,
        adapters({
          runCommand: (cmd, args) => {
            calls.push([cmd, ...args]);
            return cmd === 'backlog' ? { stdout: '1', exitCode: 0 } : { stdout: '', exitCode: 1 };
          },
        }),
      );
      expect(calls.some((c) => c[0] === 'backlog' && c[1] === 'init')).toBe(true);
      expect(r.steps.find((s) => s.id === 'backlog')?.reason).toContain('backlog init');
    });

    it('lists the command when backlog init fails', () => {
      const r = runSetup(
        dir,
        adapters({
          runCommand: (cmd, args) =>
            cmd === 'backlog' && args[0] === '--version'
              ? { stdout: '1', exitCode: 0 }
              : { stdout: '', exitCode: 1 },
        }),
      );
      expect(r.steps.find((s) => s.id === 'backlog')?.nextAction).toContain('it failed');
    });
  });

  describe('operator steps', () => {
    const gh =
      (over: Record<string, { stdout: string; exitCode: number }>) =>
      (cmd: string, args: string[]) =>
        over[`${cmd} ${args.join(' ')}`] ?? { stdout: '', exitCode: 1 };

    it('prints done for every step when all are set', () => {
      const r = runSetup(
        dir,
        adapters({
          env: { AI_SDLC_WEBHOOK_SECRET: 's' },
          runCommand: gh({
            'gh auth status': { stdout: '', exitCode: 0 },
            'gh api repos/{owner}/{repo}': { stdout: '{"allow_auto_merge":true}', exitCode: 0 },
            'gh secret list': { stdout: 'AI_SDLC_PAT\t2026\n', exitCode: 0 },
          }),
        }),
      );
      expect(r.operatorSteps.map((o) => o.state)).toEqual(['done', 'done', 'done', 'done']);
    });

    it('prints not done with the exact command or settings page', () => {
      const r = runSetup(
        dir,
        adapters({
          runCommand: gh({
            'gh auth status': { stdout: '', exitCode: 0 },
            'gh api repos/{owner}/{repo}': { stdout: '{"allow_auto_merge":false}', exitCode: 0 },
            'gh secret list': { stdout: 'OTHER\t2026\n', exitCode: 0 },
          }),
        }),
      );
      expect(r.operatorSteps.map((o) => o.state)).toEqual([
        'done',
        'not-done',
        'not-done',
        'not-done',
      ]);
      const text = renderSetupReport(r).join('\n');
      expect(text).toContain('Settings > General > Allow auto-merge');
      expect(text).toContain('gh secret set AI_SDLC_PAT');
      expect(text).toContain('export AI_SDLC_WEBHOOK_SECRET=');
    });

    it('prints unknown when a call fails or gh is signed out', () => {
      const failing = runSetup(
        dir,
        adapters({
          runCommand: gh({ 'gh auth status': { stdout: '', exitCode: 0 } }),
        }),
      );
      const states = Object.fromEntries(failing.operatorSteps.map((o) => [o.id, o.state]));
      expect(states['auto-merge']).toBe('unknown');
      expect(states['pat-secret']).toBe('unknown');
      const out = runSetup(dir, adapters());
      expect(out.operatorSteps.map((o) => o.state)).toEqual([
        'not-done',
        'unknown',
        'unknown',
        'not-done',
      ]);
      expect(out.operatorSteps[0].action).toBe('gh auth login');
    });

    it('never runs a write command', () => {
      const calls: string[][] = [];
      runSetup(
        dir,
        adapters({
          runCommand: (cmd, args) => {
            calls.push([cmd, ...args]);
            return { stdout: '{}', exitCode: 0 };
          },
        }),
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.slice(0, 3).join(' ')).not.toContain('secret set');
        if (c[0] === 'gh' && c[1] === 'api') {
          expect(c.some((a) => a === '-X' || a === '--method' || a === '-f' || a === '-F')).toBe(
            false,
          );
        }
      }
    });
  });
});
