/**
 * The production probe adapters and the file scope they enforce.
 *
 * Nothing here starts a model or a real `claude`/`codex` process: the process runner is
 * injected and inspects what the adapter hands it (the working directory it is started
 * in, and its argument vector), which is exactly where the scope is enforced.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { executePlan, type ProbeSpawnOpts } from '../review-plan/executor.js';
import type { Probe, ReviewPlan } from '../review-plan/types.js';
import { createEmptySandbox, createScopedSandbox, ProbeScopeError } from './probe-sandbox.js';
import {
  ClaudeProbeSpawner,
  CodexProbeSpawner,
  StagedProbeSpawner,
  codexCapabilitiesFromEnv,
  parseClaudeResult,
  parseCodexResult,
  probeProcessEnv,
  runProbeProcess,
  type ProbeProcessOpts,
  type ProbeProcessResult,
  type ProbeProcessRunner,
} from './probe-spawner.js';

const ENV_SECRET = 'fixture-env-secret-do-not-read';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A repository with committed files, a committed symlink, and a gitignored `.env`. */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'probe-spawner-')));
  roots.push(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, '.gitignore'), '.env\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const committed = 1;\n');
  writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
  symlinkSync('a.ts', join(dir, 'src', 'link.ts'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  writeFileSync(join(dir, '.env'), `API_TOKEN=${ENV_SECRET}\n`);
  // An uncommitted edit: the probe must see the committed content, not this.
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const uncommitted = 999;\n');
  writeFileSync(join(dir, 'untracked.ts'), 'export const untracked = 1;\n');
  return dir;
}

const okOutput = JSON.stringify({
  observations: ['seen'],
  excerpts: [],
  commands: [],
  answer: { text: 'yes', confidence: 'high' },
});
const claudeEnvelope = (result = okOutput) =>
  JSON.stringify({
    type: 'result',
    result,
    is_error: false,
    usage: { input_tokens: 12, output_tokens: 3 },
    modelUsage: { 'claude-haiku-x': {} },
  });
const ok = (stdout: string): ProbeProcessResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
});

interface Call {
  command: string;
  args: readonly string[];
  opts: ProbeProcessOpts;
  /** What the sandbox held at the moment the process started. */
  sandbox: string[];
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

function recorder(respond: (c: Call) => ProbeProcessResult = () => ok(claudeEnvelope())): {
  run: ProbeProcessRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command, args, opts) => {
      const call: Call = { command, args, opts, sandbox: listFiles(opts.cwd) };
      calls.push(call);
      return respond(call);
    },
  };
}

const spawnOpts = (over: Partial<ProbeSpawnOpts> = {}): ProbeSpawnOpts => ({
  agent: 'review-executor',
  harness: 'claude-code',
  probeId: 'p1',
  probeType: 'search',
  prompt: 'PROMPT TEXT',
  cwd: '',
  model: 'haiku',
  timeoutMs: 5000,
  tools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Write', 'Edit'],
  allowedPaths: ['src/a.ts', 'src/b.ts'],
  trackedOnly: true,
  ...over,
});

describe('createScopedSandbox', () => {
  it('serves the committed content as fresh regular files, and nothing else', async () => {
    const repo = makeRepo();
    const sb = await createScopedSandbox(['src/a.ts', 'src/b.ts'], { repoRoot: repo });
    try {
      expect(listFiles(sb.root)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(readFileSync(join(sb.root, 'src', 'a.ts'), 'utf8')).toBe(
        'export const committed = 1;\n',
      );
      expect(existsSync(join(sb.root, '.env'))).toBe(false);
      expect(existsSync(join(sb.root, 'untracked.ts'))).toBe(false);
      const st = statSync(join(sb.root, 'src', 'a.ts'));
      expect(st.isFile()).toBe(true);
      expect(st.nlink).toBe(1);
      expect(st.mode & 0o222).toBe(0);
      expect(sb.files).toEqual(['src/a.ts', 'src/b.ts']);
    } finally {
      await sb.cleanup();
    }
    expect(existsSync(sb.root)).toBe(false);
  });

  it.each([
    ['a gitignored file', ['.env']],
    ['an untracked file', ['untracked.ts']],
    ['a committed symlink', ['src/link.ts']],
    ['a path that does not exist', ['src/nope.ts']],
    ['a directory', ['src']],
    ['a path outside the repository', ['../outside.txt']],
    ['an absolute path', ['/etc/passwd']],
    ['one bad path among good ones', ['src/a.ts', '.env']],
  ])('refuses %s, and writes nothing', async (_name, paths) => {
    const repo = makeRepo();
    const parent = mkdtempSync(join(tmpdir(), 'sandbox-parent-'));
    roots.push(parent);
    await expect(
      createScopedSandbox(paths, { repoRoot: repo, parentDir: parent }),
    ).rejects.toBeInstanceOf(ProbeScopeError);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('refuses a scope with too many paths', async () => {
    const repo = makeRepo();
    const paths = Array.from({ length: 5001 }, (_, i) => `f${i}.ts`);
    await expect(createScopedSandbox(paths, { repoRoot: repo })).rejects.toThrow(/over 5000/);
  });

  it('refuses when HEAD cannot be resolved', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'no-repo-')));
    roots.push(empty);
    await expect(createScopedSandbox(['a.ts'], { repoRoot: empty })).rejects.toThrow(/HEAD/);
  });

  it('refuses when the tree cannot be listed', async () => {
    const repo = makeRepo();
    let calls = 0;
    await expect(
      createScopedSandbox(['src/a.ts'], {
        repoRoot: repo,
        git: async (args) => {
          calls += 1;
          if (calls === 1) return { stdout: Buffer.from('a'.repeat(40) + '\n'), truncated: false };
          throw new Error(`boom ${args[0]}`);
        },
      }),
    ).rejects.toThrow(/could not be listed/);
  });

  it('removes the directory when a read fails part way', async () => {
    const repo = makeRepo();
    const parent = mkdtempSync(join(tmpdir(), 'sandbox-parent-'));
    roots.push(parent);
    const real = await import('../review-plan/executor-git.js');
    let cat = 0;
    await expect(
      createScopedSandbox(['src/a.ts', 'src/b.ts'], {
        repoRoot: repo,
        parentDir: parent,
        git: async (args, o) => {
          if (args[0] === 'cat-file' && ++cat === 2) throw new Error('read failed');
          return real.runGit(args, o);
        },
      }),
    ).rejects.toBeInstanceOf(ProbeScopeError);
    expect(readdirSync(parent)).toEqual([]);
  });

  it('createEmptySandbox makes an empty directory that cleanup removes', async () => {
    const sb = await createEmptySandbox();
    expect(listFiles(sb.root)).toEqual([]);
    await sb.cleanup();
    await sb.cleanup();
    expect(existsSync(sb.root)).toBe(false);
  });
});

describe('ClaudeProbeSpawner', () => {
  it('declares what it enforces', () => {
    const s = new ClaudeProbeSpawner();
    expect(s.enforcesFileScope).toEqual({ 'claude-code': true, codex: false });
    expect(s.honoursEmptyToolList).toEqual({ 'claude-code': true, codex: false });
  });

  it('runs a search probe in a sandbox holding only the committed allowed paths', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const s = new ClaudeProbeSpawner({ run, env: () => ({ PATH: '/bin' }) });
    const result = await s.spawnProbe(spawnOpts({ cwd: repo }));

    expect(result).toMatchObject({
      status: 'success',
      output: okOutput,
      model: 'claude-haiku-x',
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // The gitignored .env, the untracked file and the uncommitted edit are not there.
    expect(call.sandbox).toEqual(['src/a.ts', 'src/b.ts']);
    expect(call.opts.cwd).not.toBe(repo);
    expect(relative(repo, call.opts.cwd).startsWith('..')).toBe(true);
    expect(call.opts.input).toBe('PROMPT TEXT');
    expect(call.opts.env).toEqual({ PATH: '/bin' });
    // The sandbox is gone once the probe returns.
    expect(existsSync(call.opts.cwd)).toBe(false);
  });

  it('builds an argument vector that denies by default', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    await new ClaudeProbeSpawner({ run }).spawnProbe(spawnOpts({ cwd: repo }));
    const args = calls[0]!.args;
    const after = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(after('--tools')).toBe('Read,Grep,Glob');
    expect(after('--disallowedTools')).toBe('Bash,Write,Edit');
    expect(after('--permission-mode')).toBe('dontAsk');
    expect(after('--permission-prompts')).toBe('none');
    expect(after('--model')).toBe('haiku');
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--no-session-persistence');
    // Nothing that would widen the scope.
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('bypassPermissions');
    // The prompt travels on stdin, not in the argument list.
    expect(args).not.toContain('PROMPT TEXT');
    expect(args.join(' ')).not.toContain(repo);
  });

  it('runs a probe with no file tools with an empty tool list in an empty directory', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const s = new ClaudeProbeSpawner({ run });
    const result = await s.spawnProbe(
      spawnOpts({
        cwd: repo,
        probeType: 'read',
        tools: [],
        allowedPaths: undefined,
        trackedOnly: undefined,
      }),
    );
    expect(result.status).toBe('success');
    const call = calls[0]!;
    expect(call.args[call.args.indexOf('--tools') + 1]).toBe('');
    expect(call.sandbox).toEqual([]);
    expect(call.opts.cwd).not.toBe(repo);
  });

  it('leaves out --model when none is given and extra args come first', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    await new ClaudeProbeSpawner({ run, extraArgs: ['--foo'] }).spawnProbe(
      spawnOpts({ cwd: repo, model: undefined }),
    );
    expect(calls[0]!.args[0]).toBe('--foo');
    expect(calls[0]!.args).not.toContain('--model');
  });

  it.each([
    ['trackedOnly is missing', { trackedOnly: undefined }],
    ['allowedPaths is missing', { allowedPaths: undefined }],
    ['allowedPaths is empty', { allowedPaths: [] }],
    ['the scope names a gitignored file', { allowedPaths: ['src/a.ts', '.env'] }],
    ['the scope names an untracked file', { allowedPaths: ['untracked.ts'] }],
    ['the scope names a symlink', { allowedPaths: ['src/link.ts'] }],
    ['the harness is not claude-code', { harness: 'codex' as const }],
  ])('refuses a probe with file tools when %s, and starts no process', async (_n, over) => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const result = await new ClaudeProbeSpawner({ run }).spawnProbe(
      spawnOpts({ cwd: repo, ...over }),
    );
    expect(result.status).toBe('error');
    expect(result.output).toMatch(/^probe not run:/);
    expect(calls).toEqual([]);
  });

  it('removes the sandbox even when the process fails', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'x',
      timedOut: false,
    }));
    const result = await new ClaudeProbeSpawner({ run }).spawnProbe(spawnOpts({ cwd: repo }));
    expect(result).toEqual({ status: 'error', output: '' });
    expect(existsSync(calls[0]!.opts.cwd)).toBe(false);
  });
});

describe('parseClaudeResult', () => {
  const base = { exitCode: 0, stderr: '', timedOut: false };
  it('maps a timeout, a failure and malformed output to errors with no output', () => {
    expect(parseClaudeResult({ ...base, stdout: '', timedOut: true })).toEqual({
      status: 'timeout',
      output: '',
    });
    expect(parseClaudeResult({ ...base, stdout: '{}', exitCode: 2 }).status).toBe('error');
    expect(parseClaudeResult({ ...base, stdout: 'not json' }).status).toBe('error');
    expect(parseClaudeResult({ ...base, stdout: '[]' }).status).toBe('error');
    expect(parseClaudeResult({ ...base, stdout: JSON.stringify({ result: 5 }) }).status).toBe(
      'error',
    );
    expect(
      parseClaudeResult({ ...base, stdout: JSON.stringify({ result: 'x', is_error: true }) })
        .status,
    ).toBe('error');
  });
  it('omits token counts and model the CLI did not report', () => {
    expect(parseClaudeResult({ ...base, stdout: JSON.stringify({ result: 'x' }) })).toEqual({
      status: 'success',
      output: 'x',
    });
    expect(
      parseClaudeResult({
        ...base,
        stdout: JSON.stringify({ result: 'x', usage: { input_tokens: -1, output_tokens: 1.5 } }),
      }),
    ).toEqual({ status: 'success', output: 'x' });
  });
});

describe('CodexProbeSpawner', () => {
  it('declares nothing unless the operator states it', () => {
    const s = new CodexProbeSpawner({ bridgeBin: '/bridge' });
    expect(s.enforcesFileScope).toEqual({ 'claude-code': false, codex: false });
    expect(s.honoursEmptyToolList).toEqual({ 'claude-code': false, codex: false });
    const t = new CodexProbeSpawner({
      bridgeBin: '/bridge',
      capabilities: { enforcesFileScope: true, honoursEmptyToolList: true },
    });
    expect(t.enforcesFileScope.codex).toBe(true);
    expect(t.honoursEmptyToolList.codex).toBe(true);
  });

  it('refuses a probe the bridge has not declared it can run, whatever the caller decided', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const s = new CodexProbeSpawner({ bridgeBin: '/bridge', run });
    const scoped = await s.spawnProbe(
      spawnOpts({ cwd: repo, harness: 'codex', agent: 'review-executor-codex' }),
    );
    const bare = await s.spawnProbe(
      spawnOpts({
        cwd: repo,
        harness: 'codex',
        agent: 'review-executor-codex',
        probeType: 'read',
        tools: [],
        allowedPaths: undefined,
        trackedOnly: undefined,
      }),
    );
    expect(scoped.output).toMatch(/does not declare that it enforces the file scope/);
    expect(bare.output).toMatch(/does not declare that it honours an empty tool list/);
    expect(calls).toEqual([]);
  });

  it('sends the scope and the sandbox to a bridge that declares it, with the same sandbox', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder(() => ok(JSON.stringify({ output: okOutput, model: 'gpt-x' })));
    const s = new CodexProbeSpawner({
      bridgeBin: '/bridge',
      run,
      capabilities: { enforcesFileScope: true, honoursEmptyToolList: true },
    });
    const result = await s.spawnProbe(
      spawnOpts({ cwd: repo, harness: 'codex', agent: 'review-executor-codex' }),
    );
    expect(result).toEqual({ status: 'success', output: okOutput, model: 'gpt-x' });
    const call = calls[0]!;
    expect(call.command).toBe('/bridge');
    expect(call.sandbox).toEqual(['src/a.ts', 'src/b.ts']);
    const request = JSON.parse(call.opts.input) as Record<string, unknown>;
    expect(request).toMatchObject({
      agentType: 'review-executor-codex',
      probeId: 'p1',
      cwd: call.opts.cwd,
      tools: ['Read', 'Grep', 'Glob'],
      allowedPaths: ['src/a.ts', 'src/b.ts'],
      trackedOnly: true,
    });
    expect(call.opts.input.endsWith('\n')).toBe(true);

    const bare = await s.spawnProbe(
      spawnOpts({
        cwd: repo,
        harness: 'codex',
        probeType: 'read',
        tools: [],
        allowedPaths: undefined,
        trackedOnly: undefined,
      }),
    );
    expect(bare.status).toBe('success');
    const sent = JSON.parse(calls[1]!.opts.input) as Record<string, unknown>;
    expect(sent.tools).toEqual([]);
    expect(sent).not.toHaveProperty('allowedPaths');
    expect(calls[1]!.sandbox).toEqual([]);
  });

  it('refuses a scope that cannot be served even when the bridge declares enforcement', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const s = new CodexProbeSpawner({
      bridgeBin: '/bridge',
      run,
      capabilities: { enforcesFileScope: true },
    });
    const result = await s.spawnProbe(
      spawnOpts({ cwd: repo, harness: 'codex', allowedPaths: ['.env'] }),
    );
    expect(result.status).toBe('error');
    expect(calls).toEqual([]);
  });

  it('refuses a claude-code probe', async () => {
    const { run } = recorder();
    const r = await new CodexProbeSpawner({ bridgeBin: '/b', run }).spawnProbe(spawnOpts());
    expect(r.output).toMatch(/is not codex/);
  });
});

describe('parseCodexResult and capabilities', () => {
  const base = { exitCode: 0, stderr: '', timedOut: false };
  it('reads an envelope, raw text, and failures', () => {
    expect(parseCodexResult({ ...base, stdout: JSON.stringify({ output: 'x' }) })).toEqual({
      status: 'success',
      output: 'x',
    });
    expect(parseCodexResult({ ...base, stdout: 'raw answer' })).toEqual({
      status: 'success',
      output: 'raw answer',
    });
    expect(parseCodexResult({ ...base, stdout: JSON.stringify({ nope: 1 }) }).output).toBe(
      '{"nope":1}',
    );
    expect(parseCodexResult({ ...base, stdout: '  ' }).status).toBe('error');
    expect(parseCodexResult({ ...base, stdout: 'x', exitCode: 1 }).status).toBe('error');
    expect(parseCodexResult({ ...base, stdout: 'x', timedOut: true }).status).toBe('timeout');
  });

  it('reads the operator statement from the environment, and nothing else counts', () => {
    expect(codexCapabilitiesFromEnv({})).toEqual({
      enforcesFileScope: false,
      honoursEmptyToolList: false,
    });
    expect(
      codexCapabilitiesFromEnv({ CODEX_SPAWN_AGENT_CAPABILITIES: 'file-scope, empty-tool-list' }),
    ).toEqual({ enforcesFileScope: true, honoursEmptyToolList: true });
    expect(codexCapabilitiesFromEnv({ CODEX_SPAWN_AGENT_CAPABILITIES: 'true,yes,1' })).toEqual({
      enforcesFileScope: false,
      honoursEmptyToolList: false,
    });
  });
});

describe('probeProcessEnv', () => {
  it('passes an allowlist and never a credential', () => {
    const env = probeProcessEnv({
      PATH: '/bin',
      HOME: '/home/u',
      LC_ALL: 'C',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      GITHUB_TOKEN: 'ghp_x',
      GIT_DIR: '/x',
      AWS_SECRET_ACCESS_KEY: 'x',
      CLAUDE_CONFIG_DIR: '/c',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', LC_ALL: 'C', CLAUDE_CONFIG_DIR: '/c' });
  });
});

describe('runProbeProcess', () => {
  it('runs a command, feeds stdin, and captures stdout', async () => {
    const r = await runProbeProcess(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? '' },
        input: 'hello',
        timeoutMs: 10_000,
      },
    );
    expect(r).toMatchObject({ exitCode: 0, stdout: 'hello', timedOut: false });
  });

  it('reports a timeout', async () => {
    const r = await runProbeProcess(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      cwd: tmpdir(),
      env: {},
      input: '',
      timeoutMs: 100,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  it('reports a command that does not exist', async () => {
    const r = await runProbeProcess('definitely-not-a-command-xyz', [], {
      cwd: tmpdir(),
      env: {},
      input: '',
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBeNull();
    expect(r.timedOut).toBe(false);
  });

  it('reports a nonzero exit and keeps stderr', async () => {
    const r = await runProbeProcess(
      process.execPath,
      ['-e', 'console.error("bad");process.exit(3)'],
      {
        cwd: tmpdir(),
        env: {},
        input: '',
        timeoutMs: 10_000,
      },
    );
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('bad');
  });
});

// ── Through the executor: the acceptance scenarios ───────────────────────

const search = (id: string, files?: string[]): Probe => ({
  id,
  type: 'search',
  target: { query: 'API_TOKEN', ...(files ? { files: files.map((path) => ({ path })) } : {}) },
  question: 'Is a credential read anywhere?',
  covers: [],
});
const readProbe = (id: string): Probe => ({
  id,
  type: 'read',
  target: { files: [{ path: 'src/b.ts' }] },
  question: 'What is in this file?',
  covers: [],
});
const plan = (probes: Probe[]): ReviewPlan => ({ schemaVersion: 1, baselineVersion: '1', probes });
const limits = (repo: string, over = {}) => ({
  repoRoot: repo,
  commandAllowlist: ['pnpm test'],
  ...over,
});

describe('a search probe through the production adapter', () => {
  it('cannot read the gitignored .env: it is not in what the probe is handed', async () => {
    const repo = makeRepo();
    const seen: string[] = [];
    const { run } = recorder((call) => {
      // Everything a probe process could open without leaving its working directory.
      for (const f of call.sandbox) seen.push(readFileSync(join(call.opts.cwd, f), 'utf8'));
      return ok(claudeEnvelope());
    });
    const spawner = new StagedProbeSpawner({ claude: { run }, codex: false });
    const bundle = await executePlan(plan([search('s1')]), spawner, limits(repo));

    expect(bundle.entries[0]!.status).toBe('ok');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join('\n')).not.toContain(ENV_SECRET);
    expect(seen.join('\n')).not.toContain('uncommitted');
  });

  it('refuses a search probe that names the .env, before anything starts', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const spawner = new StagedProbeSpawner({ claude: { run }, codex: false });
    const bundle = await executePlan(plan([search('s1', ['.env'])]), spawner, limits(repo));
    expect(bundle.entries[0]).toMatchObject({ status: 'refused' });
    expect(calls).toEqual([]);
  });

  it('is refused when the adapter cannot enforce file scope', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    // No Claude adapter and no Codex bridge: nothing declares the scope.
    const none = new StagedProbeSpawner({ claude: false, codex: false });
    expect(none.enforcesFileScope).toEqual({ 'claude-code': false, codex: false });
    const bundle = await executePlan(plan([search('s1')]), none, limits(repo));
    expect(bundle.entries[0]).toMatchObject({
      status: 'refused',
      refusals: [{ reason: 'file-scope-not-enforced' }],
    });

    // A Codex bridge with no declared capabilities does not make a Codex probe scope-bearing.
    const codexOnly = new StagedProbeSpawner({
      claude: false,
      codex: { bridgeBin: '/bridge', run, capabilities: {} },
    });
    const refused = await executePlan(
      plan([search('s2')]),
      codexOnly,
      limits(repo, { codex: { available: true, trusted: true } }),
    );
    expect(refused.entries[0]).toMatchObject({ status: 'refused' });
    expect(calls).toEqual([]);
  });

  it('moves a scope-bearing probe to Claude when Codex does not declare the scope', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const spawner = new StagedProbeSpawner({
      claude: { run },
      codex: { bridgeBin: '/bridge', run, capabilities: {} },
    });
    const bundle = await executePlan(
      plan([search('s1')]),
      spawner,
      limits(repo, { codex: { available: true, trusted: true } }),
    );
    expect(bundle.entries[0]).toMatchObject({ status: 'ok', harness: 'claude-code' });
    expect(calls[0]!.command).toBe('claude');
  });
});

describe('probes with no file tools and the Codex bridge', () => {
  it('stay on Claude until the bridge declares it honours an empty tool list', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder(() => ok(claudeEnvelope()));
    const undeclared = new StagedProbeSpawner({
      claude: { run },
      codex: { bridgeBin: '/bridge', run, capabilities: { enforcesFileScope: true } },
    });
    const first = await executePlan(
      plan([readProbe('r1')]),
      undeclared,
      limits(repo, { codex: { available: true, trusted: true } }),
    );
    expect(first.entries[0]!.harness).toBe('claude-code');
    expect(calls.map((c) => c.command)).toEqual(['claude']);

    const declared = new StagedProbeSpawner({
      claude: { run },
      codex: {
        bridgeBin: '/bridge',
        run: async () => ok(JSON.stringify({ output: okOutput })),
        capabilities: { honoursEmptyToolList: true },
      },
    });
    const second = await executePlan(
      plan([readProbe('r2')]),
      declared,
      limits(repo, { codex: { available: true, trusted: true } }),
    );
    expect(second.entries[0]!.harness).toBe('codex');
  });
});

describe('run probes and trust', () => {
  it('are refused unless the caller asserts trusted work', async () => {
    const repo = makeRepo();
    const { run, calls } = recorder();
    const spawner = new StagedProbeSpawner({ claude: { run }, codex: false });
    const runProbe: Probe = {
      id: 'run1',
      type: 'run',
      target: { command: 'pnpm test' },
      question: 'Do the tests pass?',
      covers: [],
    };
    const refused = await executePlan(plan([runProbe]), spawner, limits(repo));
    expect(refused.entries[0]).toMatchObject({
      status: 'refused',
      refusals: [{ reason: 'run-not-trusted' }],
    });
    expect(calls).toEqual([]);
  });
});

describe('StagedProbeSpawner', () => {
  it('reports whether a Codex bridge is configured and what it declares', () => {
    expect(new StagedProbeSpawner({ codex: false }).codexConfigured).toBe(false);
    const prior = process.env.CODEX_SPAWN_AGENT_BIN;
    delete process.env.CODEX_SPAWN_AGENT_BIN;
    try {
      expect(new StagedProbeSpawner().codexConfigured).toBe(false);
      process.env.CODEX_SPAWN_AGENT_BIN = '/bridge';
      const s = new StagedProbeSpawner();
      expect(s.codexConfigured).toBe(true);
      expect(s.enforcesFileScope).toEqual({ 'claude-code': true, codex: false });
    } finally {
      if (prior === undefined) delete process.env.CODEX_SPAWN_AGENT_BIN;
      else process.env.CODEX_SPAWN_AGENT_BIN = prior;
    }
  });

  it('refuses a probe for a harness it has no adapter for', async () => {
    const s = new StagedProbeSpawner({ claude: false, codex: false });
    const r = await s.spawnProbe(spawnOpts({ harness: 'codex' }));
    expect(r).toEqual({
      status: 'error',
      output: 'probe not run: no adapter is configured for codex',
    });
  });
});
