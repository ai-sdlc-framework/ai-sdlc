/**
 * Production {@link ProbeSpawner} adapters for the staged review's execute stage.
 *
 * The executor (`review-plan/executor.ts`) decides what a probe may see and builds its
 * prompt. These adapters are what actually run one probe on a harness:
 *
 *   - {@link ClaudeProbeSpawner} runs `claude -p` as a subprocess.
 *   - {@link CodexProbeSpawner} runs the Codex bridge binary the operator configures
 *     (`CODEX_SPAWN_AGENT_BIN`).
 *   - {@link StagedProbeSpawner} routes a probe to one of them by the harness the
 *     executor chose, and publishes both adapters' declarations to the executor.
 *
 * FILE SCOPE IS ENFORCED HERE, NOT BY A TOOL LIST. A probe that is given Read, Grep or
 * Glob may open only its `allowedPaths`, as committed. Each adapter refuses such a probe
 * unless it carries both `allowedPaths` and `trackedOnly`, copies exactly those paths from
 * the head commit into a throwaway directory (`probe-sandbox.ts`), and runs the probe with
 * that directory as its working directory. Anything else (a gitignored `.env`, an
 * untracked file, a symlink, the working tree) is simply not there, and the Claude
 * adapter additionally confines the harness's file tools to that directory. It denies by
 * default: a path it cannot serve from the commit makes the probe refuse before a process
 * starts.
 *
 * Each adapter declares what it enforces, per harness, and the executor reads the
 * declaration: `enforcesFileScope` (a harness that does not declare `true` gets no probe
 * with file tools) and `honoursEmptyToolList` (a harness that does not declare `true` gets
 * no probe with an empty tool list, so those stay on the Claude harness). The Claude
 * adapter declares both because the code below implements them. The Codex adapter
 * declares each only when the operator states that the bridge honours it, because the
 * bridge is theirs and this repository cannot see inside it.
 *
 * The child process gets an environment built from an allowlist. In particular it never
 * gets `ANTHROPIC_API_KEY` or any other credential from the parent, so a probe never
 * silently bills an API key.
 *
 * @module review-staged/probe-spawner
 */

import { spawn } from 'node:child_process';
import type {
  ExecutorHarness,
  ProbeSpawner,
  ProbeSpawnOpts,
  ProbeSpawnResult,
} from '../review-plan/executor.js';
import type { GitRunner } from '../review-plan/executor-git.js';
import {
  createEmptySandbox,
  createScopedSandbox,
  ProbeScopeError,
  type ProbeSandbox,
} from './probe-sandbox.js';

/** Tools that read files. A probe holding any of them is a scope-bearing probe. */
const FILE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob'];

/** Largest output kept from a probe process, per stream. */
const MAX_PROCESS_BYTES = 4 * 1024 * 1024;

// ── Process runner ───────────────────────────────────────────────────────

export interface ProbeProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProbeProcessOpts {
  cwd: string;
  env: Record<string, string>;
  /** Written to the process's standard input, then it is closed. */
  input: string;
  timeoutMs: number;
}

/** Runs one command with no shell. Never rejects. */
export type ProbeProcessRunner = (
  command: string,
  args: readonly string[],
  opts: ProbeProcessOpts,
) => Promise<ProbeProcessResult>;

/** Runs the command with `child_process.spawn`, bounded in time and output. */
export const runProbeProcess: ProbeProcessRunner = (command, args, opts) =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: out, stderr: err, timedOut });
    };
    try {
      child = spawn(command, [...args], {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      resolve({ exitCode: null, stdout: '', stderr: err, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      settle(null);
    }, opts.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < MAX_PROCESS_BYTES) out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < MAX_PROCESS_BYTES) err += c.toString('utf8');
    });
    child.on('error', (e) => {
      err += e.message;
      settle(null);
    });
    child.on('close', (code) => settle(code));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input);
  });

/**
 * The environment a probe process receives: an allowlist, never a copy. The user's home
 * and their Claude configuration stay reachable so the subscription login works, but no
 * API key, token or `GIT_*` variable is passed on.
 */
export function probeProcessEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'LANG',
    'TMPDIR',
    'SHELL',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'CLAUDE_CONFIG_DIR',
  ]);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    if (allowed.has(k) || k.startsWith('LC_')) env[k] = v;
  }
  return env;
}

// ── Shared checks ────────────────────────────────────────────────────────

function holdsFileTools(opts: ProbeSpawnOpts): boolean {
  return opts.tools.some((t) => FILE_TOOLS.includes(t));
}

function refused(reason: string): ProbeSpawnResult {
  return { status: 'error', output: `probe not run: ${reason}` };
}

/**
 * Build the directory the probe runs in, or say why it must not run. A probe that holds
 * file tools needs a complete scope; one that holds none gets an empty directory.
 */
async function sandboxFor(
  opts: ProbeSpawnOpts,
  git: GitRunner | undefined,
  parentDir: string | undefined,
): Promise<{ sandbox: ProbeSandbox } | { refusal: ProbeSpawnResult }> {
  if (!holdsFileTools(opts)) {
    return { sandbox: await createEmptySandbox({ ...(parentDir ? { parentDir } : {}) }) };
  }
  if (opts.trackedOnly !== true || !opts.allowedPaths || opts.allowedPaths.length === 0) {
    return {
      refusal: refused('a probe with file tools needs trackedOnly and a non-empty allowedPaths'),
    };
  }
  try {
    return {
      sandbox: await createScopedSandbox(opts.allowedPaths, {
        repoRoot: opts.cwd,
        ...(git ? { git } : {}),
        ...(parentDir ? { parentDir } : {}),
      }),
    };
  } catch (err) {
    return {
      refusal: refused(err instanceof ProbeScopeError ? err.message : 'the file scope failed'),
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonNegInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// ── Claude ───────────────────────────────────────────────────────────────

export interface ClaudeProbeSpawnerOptions {
  /** The CLI to run. Default `claude`. */
  binary?: string;
  /** Extra arguments placed before the fixed ones, for flags this repository does not know. */
  extraArgs?: readonly string[];
  /** Test injection. Defaults to {@link runProbeProcess}. */
  run?: ProbeProcessRunner;
  /** Test injection for the git reads that build the file scope. */
  git?: GitRunner;
  /** Where sandboxes are created. Defaults to the OS temp directory. */
  sandboxParentDir?: string;
  /** Test injection. Defaults to {@link probeProcessEnv}. */
  env?: () => Record<string, string>;
}

/**
 * Runs a probe through `claude -p`. The prompt goes in on standard input, so its size is
 * not limited by the argument list. The argument vector is built so that:
 *
 *   - `--tools` is exactly the probe's tool list (empty means no tools at all),
 *   - `--disallowedTools` carries the executor's deny list, which always includes Bash,
 *   - `--restricted` ignores user, project and local settings (so no allow rule or extra
 *     directory from them applies) and confines the file tools to the working directory,
 *   - `--permission-mode dontAsk` with `--permission-prompts none` denies anything that
 *     is not already allowed, and no `--allowedTools` or `--add-dir` widens it,
 *   - the working directory is the sandbox, never the repository.
 */
export class ClaudeProbeSpawner implements ProbeSpawner {
  readonly enforcesFileScope = { 'claude-code': true, codex: false } as const;
  readonly honoursEmptyToolList = { 'claude-code': true, codex: false } as const;

  private readonly binary: string;
  private readonly extraArgs: readonly string[];
  private readonly run: ProbeProcessRunner;
  private readonly git: GitRunner | undefined;
  private readonly parentDir: string | undefined;
  private readonly envFor: () => Record<string, string>;

  constructor(options: ClaudeProbeSpawnerOptions = {}) {
    this.binary = options.binary ?? 'claude';
    this.extraArgs = options.extraArgs ?? [];
    this.run = options.run ?? runProbeProcess;
    this.git = options.git;
    this.parentDir = options.sandboxParentDir;
    this.envFor = options.env ?? (() => probeProcessEnv());
  }

  /** The argument vector for one probe. Public so the policy it encodes can be asserted. */
  buildArgs(opts: ProbeSpawnOpts): string[] {
    return [
      ...this.extraArgs,
      '--print',
      '--output-format',
      'json',
      ...(opts.model ? ['--model', opts.model] : []),
      '--tools',
      opts.tools.join(','),
      ...(opts.disallowedTools.length > 0
        ? ['--disallowedTools', opts.disallowedTools.join(',')]
        : []),
      '--restricted',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--strict-mcp-config',
      '--no-session-persistence',
    ];
  }

  async spawnProbe(opts: ProbeSpawnOpts): Promise<ProbeSpawnResult> {
    if (opts.harness !== 'claude-code')
      return refused(`harness ${opts.harness} is not claude-code`);
    const made = await sandboxFor(opts, this.git, this.parentDir);
    if ('refusal' in made) return made.refusal;
    const { sandbox } = made;
    try {
      const result = await this.run(this.binary, this.buildArgs(opts), {
        cwd: sandbox.root,
        env: this.envFor(),
        input: opts.prompt,
        timeoutMs: opts.timeoutMs,
      });
      return parseClaudeResult(result);
    } finally {
      await sandbox.cleanup();
    }
  }
}

/** Turn the CLI's `--output-format json` envelope into a probe result. */
export function parseClaudeResult(result: ProbeProcessResult): ProbeSpawnResult {
  if (result.timedOut) return { status: 'timeout', output: '' };
  if (result.exitCode !== 0) return { status: 'error', output: '' };
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = asRecord(JSON.parse(result.stdout.trim()));
  } catch {
    envelope = undefined;
  }
  if (!envelope) return { status: 'error', output: '' };
  if (envelope.is_error === true || typeof envelope.result !== 'string') {
    return { status: 'error', output: '' };
  }
  const usage = asRecord(envelope.usage);
  const input = nonNegInt(usage?.input_tokens);
  const output = nonNegInt(usage?.output_tokens);
  const modelUsage = asRecord(envelope.modelUsage);
  const model = modelUsage ? Object.keys(modelUsage)[0] : undefined;
  return {
    status: 'success',
    output: envelope.result,
    ...(model ? { model } : {}),
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
  };
}

// ── Codex ────────────────────────────────────────────────────────────────

/** What the operator states the Codex bridge does. Absent means it is not declared. */
export interface CodexBridgeCapabilities {
  /** The bridge confines the probe to the directory it is started in, serving that only. */
  enforcesFileScope?: boolean;
  /** The bridge runs a probe with no tools when given an empty tool list. */
  honoursEmptyToolList?: boolean;
}

export const CODEX_CAPABILITIES_ENV = 'CODEX_SPAWN_AGENT_CAPABILITIES';

/**
 * Read the operator's statement about the bridge from the environment: a comma list of
 * `file-scope` and `empty-tool-list`. Anything else, or nothing, declares nothing.
 */
export function codexCapabilitiesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CodexBridgeCapabilities {
  const items = (env[CODEX_CAPABILITIES_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    enforcesFileScope: items.includes('file-scope'),
    honoursEmptyToolList: items.includes('empty-tool-list'),
  };
}

export interface CodexProbeSpawnerOptions {
  /** Path of the bridge binary. Defaults to `CODEX_SPAWN_AGENT_BIN`. */
  bridgeBin: string;
  capabilities?: CodexBridgeCapabilities;
  run?: ProbeProcessRunner;
  git?: GitRunner;
  sandboxParentDir?: string;
  env?: () => Record<string, string>;
}

/**
 * Runs a probe through the Codex bridge. The request is one JSON line on standard input:
 * the probe's prompt, the tool list and deny list, `allowedPaths` and `trackedOnly`, and
 * the sandbox as `cwd`. Whether the bridge honours the file scope and the empty tool list
 * is the operator's statement ({@link CodexBridgeCapabilities}); with none made, the
 * executor sends no scope-bearing probe and no tool-less probe here.
 */
export class CodexProbeSpawner implements ProbeSpawner {
  readonly enforcesFileScope: { readonly 'claude-code': boolean; readonly codex: boolean };
  readonly honoursEmptyToolList: { readonly 'claude-code': boolean; readonly codex: boolean };

  private readonly bridgeBin: string;
  private readonly run: ProbeProcessRunner;
  private readonly git: GitRunner | undefined;
  private readonly parentDir: string | undefined;
  private readonly envFor: () => Record<string, string>;

  constructor(options: CodexProbeSpawnerOptions) {
    this.bridgeBin = options.bridgeBin;
    this.run = options.run ?? runProbeProcess;
    this.git = options.git;
    this.parentDir = options.sandboxParentDir;
    this.envFor = options.env ?? (() => probeProcessEnv());
    const caps = options.capabilities ?? {};
    this.enforcesFileScope = { 'claude-code': false, codex: caps.enforcesFileScope === true };
    this.honoursEmptyToolList = { 'claude-code': false, codex: caps.honoursEmptyToolList === true };
  }

  async spawnProbe(opts: ProbeSpawnOpts): Promise<ProbeSpawnResult> {
    if (opts.harness !== 'codex') return refused(`harness ${opts.harness} is not codex`);
    // Fail closed on the declaration too: never start a probe the bridge has not said it
    // can confine, whatever the caller decided.
    if (holdsFileTools(opts) && !this.enforcesFileScope.codex) {
      return refused('the Codex bridge does not declare that it enforces the file scope');
    }
    if (!holdsFileTools(opts) && !this.honoursEmptyToolList.codex) {
      return refused('the Codex bridge does not declare that it honours an empty tool list');
    }
    const made = await sandboxFor(opts, this.git, this.parentDir);
    if ('refusal' in made) return made.refusal;
    const { sandbox } = made;
    try {
      const request =
        JSON.stringify({
          agentType: opts.agent,
          probeId: opts.probeId,
          probeType: opts.probeType,
          userPrompt: opts.prompt,
          cwd: sandbox.root,
          timeoutMs: opts.timeoutMs,
          tools: [...opts.tools],
          disallowedTools: [...opts.disallowedTools],
          ...(opts.allowedPaths ? { allowedPaths: [...opts.allowedPaths] } : {}),
          ...(opts.trackedOnly === true ? { trackedOnly: true } : {}),
        }) + '\n';
      const result = await this.run(this.bridgeBin, [], {
        cwd: sandbox.root,
        env: this.envFor(),
        input: request,
        timeoutMs: opts.timeoutMs,
      });
      return parseCodexResult(result);
    } finally {
      await sandbox.cleanup();
    }
  }
}

/** The bridge answers with `{ output, parsed? }`, or with the raw text of the answer. */
export function parseCodexResult(result: ProbeProcessResult): ProbeSpawnResult {
  if (result.timedOut) return { status: 'timeout', output: '' };
  if (result.exitCode !== 0) return { status: 'error', output: '' };
  const text = result.stdout.trim();
  if (text === '') return { status: 'error', output: '' };
  try {
    const envelope = asRecord(JSON.parse(text));
    if (envelope && typeof envelope.output === 'string') {
      const model = typeof envelope.model === 'string' ? envelope.model : undefined;
      return { status: 'success', output: envelope.output, ...(model ? { model } : {}) };
    }
  } catch {
    /* not an envelope: the whole text is the answer */
  }
  return { status: 'success', output: text };
}

// ── Router ───────────────────────────────────────────────────────────────

export interface StagedProbeSpawnerOptions {
  claude?: ClaudeProbeSpawnerOptions | false;
  /** `false`, or no bridge binary, leaves Codex undeclared and unused. */
  codex?: (Omit<CodexProbeSpawnerOptions, 'bridgeBin'> & { bridgeBin?: string }) | false;
}

/**
 * The spawner the staged review hands to the executor. It runs a probe on the harness the
 * executor chose, and declares per harness exactly what the adapter behind it declares, so
 * the executor's refusals and moves follow the real capabilities.
 */
export class StagedProbeSpawner implements ProbeSpawner {
  readonly enforcesFileScope: { readonly 'claude-code': boolean; readonly codex: boolean };
  readonly honoursEmptyToolList: { readonly 'claude-code': boolean; readonly codex: boolean };

  private readonly claude: ClaudeProbeSpawner | undefined;
  private readonly codex: CodexProbeSpawner | undefined;

  constructor(options: StagedProbeSpawnerOptions = {}) {
    this.claude = options.claude === false ? undefined : new ClaudeProbeSpawner(options.claude);
    const codexOpts = options.codex === false ? undefined : (options.codex ?? {});
    const bridgeBin = codexOpts?.bridgeBin ?? process.env.CODEX_SPAWN_AGENT_BIN;
    this.codex =
      codexOpts && bridgeBin
        ? new CodexProbeSpawner({
            capabilities: codexCapabilitiesFromEnv(),
            ...codexOpts,
            bridgeBin,
          })
        : undefined;
    this.enforcesFileScope = {
      'claude-code': this.claude?.enforcesFileScope['claude-code'] === true,
      codex: this.codex?.enforcesFileScope.codex === true,
    };
    this.honoursEmptyToolList = {
      'claude-code': this.claude?.honoursEmptyToolList['claude-code'] === true,
      codex: this.codex?.honoursEmptyToolList.codex === true,
    };
  }

  /** True when a Codex bridge is configured, so the caller can offer Codex to the executor. */
  get codexConfigured(): boolean {
    return this.codex !== undefined;
  }

  spawnProbe(opts: ProbeSpawnOpts): Promise<ProbeSpawnResult> {
    const harness: ExecutorHarness = opts.harness;
    const adapter = harness === 'codex' ? this.codex : this.claude;
    if (!adapter) return Promise.resolve(refused(`no adapter is configured for ${harness}`));
    return adapter.spawnProbe(opts);
  }
}
