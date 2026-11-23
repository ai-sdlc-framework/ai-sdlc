/**
 * AISDLC-1354: `/ai-sdlc:setup` (orchestrator `init`) and `/ai-sdlc:init` (`cli-init`)
 * write `pipeline.yaml` and `agent-role.yaml` from one template source, the config
 * manifest. Real filesystem and real git repos; the cli-init side runs the built bin.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { cleanGitEnv } from '../../runtime/git-env.js';

const CLI_INIT = fileURLToPath(
  new URL('../../../../pipeline-cli/bin/cli-init.mjs', import.meta.url),
);
const INIT_SRC = fileURLToPath(new URL('./init.ts', import.meta.url));

let root: string;
let cwd0: string;
let consoleSpy: ReturnType<typeof vi.spyOn>;
let prevCeiling: string | undefined;

beforeEach(() => {
  cwd0 = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'init-identity-')));
  prevCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.chdir(cwd0);
  if (prevCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
  else process.env.GIT_CEILING_DIRECTORIES = prevCeiling;
  rmSync(root, { recursive: true, force: true });
  consoleSpy.mockRestore();
  process.exitCode = undefined;
  vi.resetModules();
});

function git(dir: string, args: string[]): void {
  const r = spawnSync('git', ['-C', dir, ...args], { env: cleanGitEnv(), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

function makeRepo(name: string, remote?: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  if (remote) git(dir, ['remote', 'add', 'origin', remote]);
  return dir;
}

async function runOrchestratorInit(dir: string, extra: string[] = []): Promise<void> {
  vi.resetModules();
  process.chdir(dir);
  const { initCommand } = await import('./init.js');
  for (const k of ['dryRun', 'role', 'cursor', 'skipMcp', 'yes', 'add', 'workspace', 'force']) {
    initCommand.setOptionValue(k, undefined);
  }
  await initCommand.parseAsync(['--skip-mcp', '--yes', ...extra], { from: 'user' });
}

function runCliInit(dir: string): void {
  const r = spawnSync('node', [CLI_INIT, '--project-dir', dir, '--non-interactive'], {
    env: cleanGitEnv(),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`cli-init failed: ${r.stdout}${r.stderr}`);
}

const read = (dir: string, f: string): string => readFileSync(join(dir, '.ai-sdlc', f), 'utf8');

describe('setup and init write the same files (AISDLC-1354)', () => {
  it.each(['coding', 'research', 'meta'])(
    'writes byte-identical agent-role.yaml and pipeline.yaml for the %s tier',
    async (tier) => {
      const remote = 'https://github.com/acme/widgets.git';
      const a = makeRepo(`orch-${tier}`, remote);
      const b = makeRepo(`cli-${tier}`, remote);
      await runOrchestratorInit(a, ['--role', tier]);
      if (tier === 'coding') {
        runCliInit(b);
        expect(read(a, 'agent-role.yaml')).toBe(read(b, 'agent-role.yaml'));
        expect(read(a, 'pipeline.yaml')).toBe(read(b, 'pipeline.yaml'));
      } else {
        // cli-init has no tier flag: the tier reaches the shared template as a default.
        const { scaffoldConfig } = await import('@ai-sdlc/pipeline-cli/config-manifest');
        await scaffoldConfig({
          projectDir: b,
          defaults: { org: 'acme', repo: 'widgets', tier },
        });
        expect(read(a, 'agent-role.yaml')).toBe(read(b, 'agent-role.yaml'));
        expect(read(a, 'pipeline.yaml')).toBe(read(b, 'pipeline.yaml'));
        expect(read(a, 'agent-role.yaml')).toContain(`Tier: ${tier}-agent`);
      }
    },
  );

  it('keeps every key that existed in only one of the old sources', async () => {
    const dir = makeRepo('keys', 'git@github.com:acme/widgets.git');
    await runOrchestratorInit(dir);
    const p = parseYaml(read(dir, 'pipeline.yaml'));
    expect(p.spec.triggers).toEqual([{ event: 'issue.assigned' }]);
    expect(p.spec.providers.sourceControl.config).toEqual({ org: 'acme', repo: 'widgets' });
    expect(p.spec.backlog.branching).toEqual({
      pattern: 'ai-sdlc/{issueIdLower}-{slug}',
      targetBranch: 'main',
      cleanup: 'on-merge',
    });
    expect(p.spec.backlog.pullRequest.includeProvenance).toBe(true);
    expect(p.spec.backlog.pullRequest.closeKeyword).toBe('References');
    expect(p.spec.backlog.pullRequest.descriptionSections).toEqual([
      'summary',
      'changes',
      'closes',
    ]);

    const raw = read(dir, 'agent-role.yaml');
    const r = parseYaml(raw);
    expect(r.spec.role).toBe('developer');
    expect(r.spec.goal).toBe('Implement issue requirements with tests');
    expect(r.spec.backstory).toContain('You are an AI coding agent');
    for (const t of [
      'Edit',
      'Write',
      'Read',
      'Glob',
      'Grep',
      'Bash',
      'NotebookEdit',
      'code-editor',
      'terminal',
      'test-runner',
    ]) {
      expect(r.spec.tools).toContain(t);
    }
    expect(r.spec.constraints.maxFilesPerChange).toBe(15);
    expect(r.spec.constraints.requireTests).toBe(true);
    expect(r.spec.constraints.blockedPaths).toEqual(['.github/workflows/**', '.ai-sdlc/**']);
    expect(raw).toContain('# allowForcePush:');
  });

  it('init.ts holds no copy of either template and writes them only through the manifest', () => {
    const src = readFileSync(INIT_SRC, 'utf8');
    expect(src).not.toContain('PIPELINE_YAML');
    expect(src).not.toMatch(/AGENT_ROLE_YAML/);
    expect(src).not.toContain('getAgentRoleYaml');
    expect(src).not.toContain('apiVersion: ai-sdlc.io/v1alpha1\nkind: Pipeline');
    expect(src).not.toContain('kind: AgentRole');
    expect(src).toContain('scaffoldConfig');
  });

  it('uses the your-org / your-repo stand-ins in both paths when there is no remote', async () => {
    const a = makeRepo('noremote-orch');
    const b = makeRepo('noremote-cli');
    await runOrchestratorInit(a);
    runCliInit(b);
    expect(read(a, 'pipeline.yaml')).toBe(read(b, 'pipeline.yaml'));
    const p = parseYaml(read(a, 'pipeline.yaml'));
    expect(p.spec.providers.sourceControl.config).toEqual({ org: 'your-org', repo: 'your-repo' });
  });

  it('leaves an existing pipeline.yaml or agent-role.yaml unchanged in both paths', async () => {
    for (const via of ['orchestrator', 'cli'] as const) {
      const dir = makeRepo(`existing-${via}`, 'https://github.com/acme/widgets.git');
      mkdirSync(join(dir, '.ai-sdlc'));
      writeFileSync(join(dir, '.ai-sdlc', 'pipeline.yaml'), '# mine\n');
      writeFileSync(join(dir, '.ai-sdlc', 'agent-role.yaml'), '# mine too\n');
      if (via === 'orchestrator') await runOrchestratorInit(dir);
      else runCliInit(dir);
      expect(read(dir, 'pipeline.yaml')).toBe('# mine\n');
      expect(read(dir, 'agent-role.yaml')).toBe('# mine too\n');
    }
  });

  it('workspace mode writes each child pipeline.yaml with that child org and repo', async () => {
    mkdirSync(join(root, 'ws'));
    for (const [name, remote] of [
      ['repo-a', 'https://github.com/acme/alpha.git'],
      ['repo-b', 'git@github.com:globex/beta.git'],
    ]) {
      const d = join(root, 'ws', name);
      mkdirSync(d);
      git(d, ['init', '-q']);
      git(d, ['remote', 'add', 'origin', remote]);
    }
    await runOrchestratorInit(join(root, 'ws'), ['--role', 'research']);
    const a = parseYaml(read(join(root, 'ws', 'repo-a'), 'pipeline.yaml'));
    const b = parseYaml(read(join(root, 'ws', 'repo-b'), 'pipeline.yaml'));
    expect(a.spec.providers.sourceControl.config).toEqual({ org: 'acme', repo: 'alpha' });
    expect(b.spec.providers.sourceControl.config).toEqual({ org: 'globex', repo: 'beta' });
    expect(read(join(root, 'ws', 'repo-a'), 'agent-role.yaml')).toContain('Tier: research-agent');
  });

  it('writes both files into a custom --dir without touching .ai-sdlc/', async () => {
    const dir = makeRepo('custom', 'https://github.com/acme/widgets.git');
    await runOrchestratorInit(dir, ['--dir', '.custom-cfg']);
    expect(existsSync(join(dir, '.custom-cfg', 'pipeline.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.custom-cfg', 'agent-role.yaml'))).toBe(true);
    expect(existsSync(join(dir, '.ai-sdlc', 'config-version.yaml'))).toBe(false);
  });
});
