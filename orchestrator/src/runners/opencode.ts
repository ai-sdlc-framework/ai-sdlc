/**
 * OpenCode runner — drives the installed `opencode` CLI (v2) in
 * `run --standalone --format json` mode and collects the result via git diff.
 *
 * Contract (verified against the installed opencode v2.0.18 binary):
 *  - `opencode run --standalone --auto --format json --model <m> [--agent <a>] <message...>`
 *  - `--standalone` is REQUIRED: it starts a private server so the run never
 *    touches the operator's background service / desktop session.
 *  - `--auto` auto-approves permissions that are not explicitly denied.
 *    Deny rules (declarative opencode.json permission + the ai-sdlc
 *    governance plugin) remain in force and short-circuit `--auto`.
 *    `--auto` is NOT passed for read-only stages (an allowedTools list with
 *    no edit tool — reviewer/classifier-type stages); see buildToolPermission.
 *  - `--format json` emits NDJSON on stdout: step_start / text / tool_use /
 *    step_finish / error events, each with a top-level `sessionID`.
 *  - There is NO final "result" event. Authoritative token usage is read via
 *    `opencode session export --standalone <sessionID>` (fast local DB read,
 *    no model call); per-step `step_finish` tokens from the stream are the
 *    fallback when the export is unavailable.
 *
 * Model resolution (env read at call time): ctx.model → OPENCODE_MODEL →
 * AI_SDLC_MODEL. A model ref without a provider slash gets `anthropic/`
 * prefixed (opencode refs are `provider/model#variant`, split on first slash).
 * An unresolvable model fails the run loudly.
 *
 * Child env channels (set per dispatch in run()):
 *  - AI_SDLC_PROJECT_ROOT / AI_SDLC_ACTIVE_TASK_ID — consumed by the
 *    in-repo governance plugin (.opencode/plugins/ai-sdlc-governance.js)
 *    for worktree sentinel + permittedExternalPaths resolution.
 *  - OPENCODE_CONFIG_CONTENT — a per-dispatch virtual config document
 *    (opencode v2 merges it LAST, per-key): re-anchors the project's local
 *    MCP servers at the main clone's build artifacts and disables step
 *    snapshots. See buildDispatchConfig.
 */

import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentRunner,
  AgentContext,
  AgentResult,
  AgentProgressEvent,
  TokenUsage,
} from './types.js';
import {
  DEFAULT_RUNNER_TIMEOUT_MS,
  DEFAULT_COMMIT_MESSAGE_TEMPLATE,
  DEFAULT_COMMIT_CO_AUTHOR,
} from '../defaults.js';
import { buildPrompt } from './claude-code.js';
import {
  gitExec,
  detectChangedFiles,
  runAutoFix,
  snapshotWorktree,
  detectCrossRepoWrites,
} from './git-utils.js';

export { buildPrompt };

const execFileAsync = promisify(execFile);

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Resolve the opencode executable (env read at call time): explicit
 * `OPENCODE_BIN` → `opencode` on PATH → the default user install location
 * (`~/.opencode/bin/opencode`, where the standalone installer places it).
 */
export function resolveOpenCodeBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_BIN) return env.OPENCODE_BIN;
  try {
    const onPath = execFileSync('which', ['opencode'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (onPath) return onPath;
  } catch {
    // Not on PATH — fall through to the default install location.
  }
  return join(homedir(), '.opencode', 'bin', 'opencode');
}

/**
 * Resolve the `--model` ref (env read at call time): ctx.model →
 * OPENCODE_MODEL → AI_SDLC_MODEL. Returns undefined when none is set (the
 * caller fails loudly rather than letting opencode pick an unknown default).
 */
export function resolveOpenCodeModel(
  ctx: AgentContext,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = ctx.model ?? env.OPENCODE_MODEL ?? env.AI_SDLC_MODEL;
  if (!raw) return undefined;
  return raw.includes('/') ? raw : `anthropic/${raw}`;
}

/** Coerce a possibly-missing numeric field to 0. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Extract a file path / command from an opencode tool-call input object. */
function extractFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  return (
    (typeof i.path === 'string' ? i.path : undefined) ??
    (typeof i.file_path === 'string' ? i.file_path : undefined) ??
    (typeof i.pattern === 'string' ? i.pattern : undefined) ??
    (typeof i.command === 'string' ? i.command.slice(0, 80) : undefined) ??
    (typeof i.description === 'string' ? i.description.slice(0, 80) : undefined)
  );
}

/** Accumulated state from the `run --format json` NDJSON stream. */
export interface OpenCodeStreamState {
  sessionID?: string;
  /** Last non-empty assistant text part (the final response). */
  summaryText?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Message of the last stream-level `error` event, if any. */
  streamError?: string;
}

/**
 * Consume one NDJSON line from `opencode run --format json` output: update the
 * accumulated stream state and emit a progress event when there is something
 * useful for the caller. Non-JSON lines are ignored (opencode may print
 * status text outside JSON mode, and --print-logs goes to stderr anyway).
 */
export function parseOpenCodeLine(
  line: string,
  state: OpenCodeStreamState,
  onProgress?: (e: AgentProgressEvent) => void,
): void {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof parsed.sessionID === 'string' && !state.sessionID) {
    state.sessionID = parsed.sessionID;
  }
  const type = parsed.type as string;
  const part = parsed.part as Record<string, unknown> | undefined;

  if (type === 'text' && part) {
    const text = typeof part.text === 'string' ? part.text : '';
    if (text.trim()) {
      state.summaryText = text;
      onProgress?.({ type: 'text', message: text.slice(0, 200) });
    }
  } else if (type === 'tool_use' && part) {
    const tool = typeof part.tool === 'string' ? part.tool : 'tool';
    const toolState = part.state as Record<string, unknown> | undefined;
    const file = extractFilePath(toolState?.input);
    onProgress?.({ type: 'tool_start', tool, file, message: file ? `${tool}: ${file}` : tool });
  } else if (type === 'step_finish' && part) {
    const tokens = part.tokens as Record<string, unknown> | undefined;
    if (tokens && typeof tokens === 'object') {
      const cache = tokens.cache as Record<string, unknown> | undefined;
      state.inputTokens += num(tokens.input);
      state.outputTokens += num(tokens.output) + num(tokens.reasoning);
      state.cacheReadTokens += num(cache?.read);
    }
    const cost = num(part.cost);
    if (cost > 0) {
      state.costUsd += cost;
      onProgress?.({
        type: 'cost',
        costUsd: state.costUsd,
        message: `Total cost: $${state.costUsd.toFixed(4)}`,
      });
    }
  } else if (type === 'error') {
    const message = (parsed.error as Record<string, unknown> | undefined)?.message;
    state.streamError = typeof message === 'string' ? message : 'unknown stream error';
    onProgress?.({ type: 'error', message: state.streamError.slice(0, 200) });
  }
}

export interface RunOpenCodeOptions {
  workDir: string;
  prompt: string;
  model: string;
  /** Optional agent name (`--agent`); e.g. the repo's `developer` agent. */
  agent?: string;
  timeoutMs: number;
  onProgress?: (e: AgentProgressEvent) => void;
  /** Binary to spawn (defaults to resolveOpenCodeBin). */
  bin?: string;
  /** Extra env for the child process (governance channels, etc.). */
  extraEnv?: Record<string, string | undefined>;
  /** Injectable spawn for tests. */
  spawnFn?: typeof spawn;
  /** Pass `--auto` (default true). Read-only stages set this false. */
  auto?: boolean;
}

export interface RunOpenCodeResult {
  /** Last non-empty assistant text from the stream (summary). */
  stdout: string;
  stderr: string;
  sessionID?: string;
  model: string;
  costUsd?: number;
  /** Tokens accumulated from step_finish events (fallback usage source). */
  tokenUsage: TokenUsage | undefined;
  /** Stream-level error event was observed. */
  streamError?: string;
}

/**
 * Spawn one `opencode run --standalone` session and stream its NDJSON output.
 * Resolves on process close (exit 0 or non-zero); the caller maps the result
 * onto an AgentResult. The prompt is passed as a positional argument —
 * opencode run has no stdin prompt mode.
 */
export function runOpenCode(opts: RunOpenCodeOptions): Promise<RunOpenCodeResult> {
  const bin = opts.bin ?? resolveOpenCodeBin();
  const args = ['run', '--standalone'];
  if (opts.auto !== false) args.push('--auto');
  args.push('--format', 'json', '--model', opts.model);
  if (opts.agent) {
    args.push('--agent', opts.agent);
  }
  // `--` ends option parsing so a prompt starting with `-` is never read as a flag.
  args.push('--', opts.prompt);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const logPrefix = '[ai-sdlc:opencode]';
    process.stderr.write(
      `${logPrefix} spawning: ${bin} ${args.filter((a) => a !== opts.prompt).join(' ')} (prompt ${opts.prompt.length} chars)\n`,
    );
    process.stderr.write(`${logPrefix} workDir: ${opts.workDir}\n`);

    let child: ChildProcess;
    try {
      child = (opts.spawnFn ?? spawn)(bin, args, {
        cwd: opts.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...opts.extraEnv },
        timeout: opts.timeoutMs,
      });
    } catch (err) {
      reject(
        new Error(`failed to spawn opencode: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    const state: OpenCodeStreamState = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
    let lastActivity = Date.now();
    let lineBuf = '';
    const errBuf: Buffer[] = [];

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const idle = Math.round((Date.now() - lastActivity) / 1000);
      process.stderr.write(`${logPrefix} heartbeat: ${elapsed}s elapsed, ${idle}s idle\n`);
      opts.onProgress?.({ type: 'text', message: `heartbeat: ${elapsed}s elapsed` });
    }, HEARTBEAT_INTERVAL_MS);

    child.stdout?.on('data', (data: Buffer) => {
      lastActivity = Date.now();
      lineBuf += data.toString('utf-8');
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) parseOpenCodeLine(trimmed, state, opts.onProgress);
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      lastActivity = Date.now();
      errBuf.push(data);
      process.stderr.write(data);
    });

    child.on('close', (code, signal) => {
      clearInterval(heartbeat);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const stderr = Buffer.concat(errBuf).toString('utf-8');
      process.stderr.write(
        `${logPrefix} exited: code=${code} signal=${signal ?? '-'} elapsed=${elapsed}s\n`,
      );
      if (lineBuf.trim()) parseOpenCodeLine(lineBuf.trim(), state, opts.onProgress);
      if (code === 0) {
        resolve({
          stdout: state.summaryText ?? '',
          stderr,
          sessionID: state.sessionID,
          model: opts.model,
          costUsd: state.costUsd > 0 ? state.costUsd : undefined,
          tokenUsage: stateToTokenUsage(state, opts.model),
          streamError: state.streamError,
        });
      } else {
        reject(
          new Error(
            `opencode exited with code ${code}${signal ? ` (signal ${signal})` : ''}: ${stderr.slice(-1000) || state.streamError || state.summaryText || ''}`,
          ),
        );
      }
    });

    child.on('error', (err) => {
      clearInterval(heartbeat);
      reject(new Error(`opencode spawn error: ${err.message}`));
    });
  });
}

function stateToTokenUsage(state: OpenCodeStreamState, model: string): TokenUsage | undefined {
  if (state.inputTokens === 0 && state.outputTokens === 0) return undefined;
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens || undefined,
    model,
  };
}

/**
 * Read authoritative session token totals from the session DB via
 * `opencode session export --standalone` (fast local read — no model call).
 * Returns undefined when the session cannot be found (e.g. the run died
 * before the session was persisted); the stream-accumulated fallback then
 * applies.
 */
export async function fetchSessionTokens(
  sessionID: string,
  workDir: string,
  model: string,
  bin: string = resolveOpenCodeBin(),
): Promise<TokenUsage | undefined> {
  try {
    const { stdout } = await execFileAsync(bin, ['session', 'export', '--standalone', sessionID], {
      cwd: workDir,
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const info = (JSON.parse(stdout) as { info?: { tokens?: Record<string, unknown> } })?.info;
    const t = info?.tokens;
    if (!t || typeof t !== 'object') return undefined;
    const cache = t.cache as Record<string, unknown> | undefined;
    return {
      inputTokens: num(t.input),
      outputTokens: num(t.output) + num(t.reasoning),
      cacheReadTokens: num(cache?.read) || undefined,
      model,
    };
  } catch {
    return undefined;
  }
}

/**
 * Parse a JSONC document (JSON plus `//` line and block comments).
 * opencode loads the project's opencode.json as JSONC, so the file a
 * dispatched run sees may legitimately contain comments; our re-anchoring
 * rewrite must read it too.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return JSON.parse(out);
}

interface McpServerEntry {
  type?: string;
  command?: unknown;
  [key: string]: unknown;
}

/** Read the project's opencode config (opencode.json, falling back to .jsonc). */
function readProjectConfigText(workDir: string): string | undefined {
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    try {
      return readFileSync(join(workDir, name), 'utf-8');
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/**
 * Re-anchor local MCP server script paths at the main clone's root.
 *
 * Dispatched runs execute from `.worktrees/<id>/` checkouts, but local MCP
 * servers are usually built artifacts (git-ignored) and their relative
 * script path in the project's opencode.json does not resolve there.
 * Re-rooted at the main clone it does.
 *
 * Only an arg that is a relative path resolving to an EXISTING file under
 * the main clone is re-anchored; everything else (`npx`/`uvx`/`docker run`
 * invocations, `@scope/pkg`, URLs, `owner/repo`, `--flag=a/b`, plain words)
 * is left byte-for-byte untouched. The only entry ever dropped is one whose
 * script-position arg (the first non-flag arg after an interpreter such as
 * `node`) looks like a relative script file path (has a script extension)
 * but exists in neither the worktree nor the main clone: it is a dead
 * entry, and it would only add a failed spawn to every run.
 */
const SCRIPT_EXT_RE = /\.(?:[cm]?js|ts|py|sh|rb)$/i;
const INTERPRETERS = new Set([
  'node',
  'bun',
  'deno',
  'python',
  'python3',
  'tsx',
  'ruby',
  'bash',
  'sh',
]);

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isRelativePathArg(part: string): boolean {
  return !part.startsWith('-') && !isAbsolute(part) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(part);
}

export function remapMcpTable(
  table: Record<string, McpServerEntry>,
  mainRoot: string,
  workDir?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(table)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      out[name] = entry;
      continue;
    }
    if (entry.type === 'remote' || !Array.isArray(entry.command)) {
      out[name] = entry;
      continue;
    }
    const original = entry.command as unknown[];
    const exe = typeof original[0] === 'string' ? (original[0].split(/[\\/]/).pop() ?? '') : '';
    const script = original[1];
    if (
      INTERPRETERS.has(exe) &&
      typeof script === 'string' &&
      isRelativePathArg(script) &&
      SCRIPT_EXT_RE.test(script) &&
      !existsSync(resolve(mainRoot, script)) &&
      !(workDir && existsSync(resolve(workDir, script)))
    ) {
      continue; // unbuilt everywhere — drop rather than dangle
    }
    const command = original.map((part, idx) => {
      if (idx === 0 || typeof part !== 'string' || !isRelativePathArg(part)) return part;
      const anchored = resolve(mainRoot, part);
      return isFile(anchored) ? anchored : part;
    });
    out[name] = { ...entry, command };
  }
  return out;
}

/**
 * Resolve the main clone's root from a (possibly linked worktree) checkout,
 * via `git rev-parse --git-common-dir` (returns the main repo's `.git` even
 * from a linked worktree, relative or absolute). Undefined when workDir is
 * not a git checkout — then no re-anchoring is possible and the dispatch
 * proceeds without MCP remapping.
 */
export async function resolveMainCloneRoot(workDir: string): Promise<string | undefined> {
  try {
    const out = await gitExec(workDir, ['rev-parse', '--git-common-dir']);
    if (!out) return undefined;
    return dirname(isAbsolute(out) ? out : resolve(workDir, out));
  } catch {
    return undefined;
  }
}

export interface OpenCodeToolPermission {
  /** `permission` block to merge into the dispatch config. */
  permission: Record<string, unknown>;
  /**
   * True when the stage may not modify the worktree (an explicit allowedTools
   * list with no edit-capable tool). Read-only stages run WITHOUT `--auto`.
   */
  readOnly: boolean;
}

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'patch']);

/** Claude-style tool name → opencode permission key (undefined = unmapped). */
function toolPermissionKey(tool: string): string | undefined {
  const name = tool.split('(')[0].trim().toLowerCase();
  if (EDIT_TOOLS.has(name)) return 'edit';
  switch (name) {
    case 'read':
      return 'read';
    case 'grep':
      return 'grep';
    case 'glob':
      return 'glob';
    case 'bash':
    case 'shell':
      return 'bash';
    case 'webfetch':
      return 'webfetch';
    case 'websearch':
      return 'websearch';
    case 'task':
    case 'agent':
      return 'task';
    default:
      return undefined;
  }
}

/**
 * Map a stage's tool policy onto the per-dispatch opencode `permission` block.
 *
 *  - `allowedTools` undefined (developer stage): web + external_directory are
 *    denied; everything else keeps the project's rules and `--auto` behavior.
 *  - `allowedTools` given: edit / bash / task / web* / external_directory are
 *    denied unless an allowed tool maps onto them; allowed read-class tools
 *    are explicitly allowed (no `--auto` to lean on); scoped `Bash(pat)`
 *    entries become `bash` pattern allows. A bare `Bash` keeps only the
 *    project's deny/ask bash rules. Project `allow` entries are NEVER
 *    inherited by these stages. `readOnly` = no edit-capable tool allowed.
 *
 * `baseline` is the project's parsed `permission` block: the result is
 * merged on top of it so project deny rules survive regardless of whether
 * opencode deep- or shallow-merges the env config document.
 */
export function buildToolPermission(
  allowedTools: string[] | undefined,
  baseline: Record<string, unknown> = {},
): OpenCodeToolPermission {
  if (!allowedTools) {
    // Developer default stage: the project's rules (including its allows,
    // e.g. the DoD-required force-with-lease push) are kept as-is.
    return {
      permission: {
        ...baseline,
        webfetch: 'deny',
        websearch: 'deny',
        external_directory: 'deny',
      },
      readOnly: false,
    };
  }

  // Non-developer stages never inherit project `allow` entries: an allow in
  // the project's map (last match wins) would otherwise re-grant, e.g., the
  // lease-push allow to a review stage that only asked for `Bash(pnpm test*)`.
  const inherited = denyOnly(baseline);
  const permission: Record<string, unknown> = { ...inherited };

  const allowed = new Set<string>();
  const bashPatterns: string[] = [];
  let bareBash = false;
  for (const tool of allowedTools) {
    const key = toolPermissionKey(tool);
    if (!key) continue;
    allowed.add(key);
    if (key === 'bash') {
      const scoped = tool.match(/^[^(]+\((.*)\)$/s);
      if (scoped) bashPatterns.push(scoped[1].trim());
      else bareBash = true;
    }
  }

  // Allowing a read-class tool must not replace the project's own deny
  // patterns for it (e.g. `*.env`): plain allow only when the project has no
  // rule for the key, else `{'*':'allow', ...projectDenies}` (last match wins).
  for (const key of ['read', 'grep', 'glob']) {
    if (!allowed.has(key)) continue;
    const existing = inherited[key];
    if (existing === undefined) permission[key] = 'allow';
    else if (existing && typeof existing === 'object')
      permission[key] = { '*': 'allow', ...existing };
    // else: a plain deny/ask string is kept — never weakened
  }
  for (const key of ['edit', 'task', 'webfetch', 'websearch']) {
    if (!allowed.has(key)) permission[key] = 'deny';
  }
  permission.external_directory = 'deny';

  // The project's own bash `allow` keys (e.g. the DoD lease-push allow) are
  // dropped above; additionally emit an explicit DENY for each so that an
  // opencode deep-merge of the project config cannot resurrect them.
  const projectAllowKeys =
    baseline.bash && typeof baseline.bash === 'object' && !Array.isArray(baseline.bash)
      ? Object.entries(baseline.bash as Record<string, unknown>)
          .filter(([, v]) => v === 'allow')
          .map(([k]) => k)
      : [];
  const explicitDenies: Record<string, string> = {};
  for (const key of projectAllowKeys) {
    if (!bashPatterns.includes(key)) explicitDenies[key] = 'deny';
  }
  const projectBash =
    inherited.bash && typeof inherited.bash === 'object' && !Array.isArray(inherited.bash)
      ? (inherited.bash as Record<string, unknown>)
      : {};

  if (!allowed.has('bash')) {
    permission.bash = 'deny';
  } else if (!bareBash) {
    const allows: Record<string, string> = {};
    for (const pat of bashPatterns) allows[pat] = 'allow';
    // Last match wins: default-deny, then the scoped allows, then the
    // project's deny/ask rules and explicit denies of its allows.
    permission.bash = { '*': 'deny', ...allows, ...projectBash, ...explicitDenies };
  } else if (Object.keys(explicitDenies).length > 0) {
    permission.bash = { ...projectBash, ...explicitDenies };
  }

  return { permission, readOnly: !allowed.has('edit') };
}

/** The deny/ask-only subset of a project permission block (drops every `allow`). */
function denyOnly(baseline: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(baseline)) {
    if (value === 'allow') continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const kept = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== 'allow',
      );
      out[key] = Object.fromEntries(kept);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build the per-dispatch `OPENCODE_CONFIG_CONTENT` value.
 *
 * opencode v2 reads this env var as a virtual config document that merges
 * LAST, per key (verified empirically against the installed 2.0.18 binary —
 * keys we omit here, such as `agent`, survive from the project's
 * opencode.json). We use it to fix what breaks when the dispatched
 * run's cwd is a worktree checkout:
 *   - `mcp` — relative local-server paths re-anchored at the main clone
 *   - `snapshot` — v2 step snapshots default ON (interactive undo); a
 *     throwaway worktree the runner commits itself does not need them.
 *     The project's opencode.json keeps the default for interactive sessions.
 *   - `autoupdate: false` — the binary must not self-update between the run
 *     and the `session export` that follows it.
 *   - `permission` — the per-stage tool policy (see buildToolPermission),
 *     layered over the project's own permission block.
 */
export function buildDispatchConfig(
  workDir: string,
  mainRoot: string | undefined,
  allowedTools?: string[],
): string {
  const config: Record<string, unknown> = { autoupdate: false, snapshot: false };
  let baseline: Record<string, unknown> = {};
  const raw = readProjectConfigText(workDir);
  if (raw) {
    try {
      const parsed = parseJsonc(raw) as {
        mcp?: Record<string, McpServerEntry>;
        permission?: unknown;
      };
      if (parsed && typeof parsed === 'object') {
        if (
          parsed.permission &&
          typeof parsed.permission === 'object' &&
          !Array.isArray(parsed.permission)
        ) {
          baseline = parsed.permission as Record<string, unknown>;
        }
        if (mainRoot && parsed.mcp && typeof parsed.mcp === 'object') {
          config.mcp = remapMcpTable(parsed.mcp, mainRoot, workDir);
        }
      }
    } catch {
      // Malformed project config — dispatch without MCP remapping.
    }
  }
  config.permission = buildToolPermission(allowedTools, baseline).permission;
  return JSON.stringify(config);
}

/**
 * OpenCodeRunner — dispatches an issue to the opencode CLI and commits the
 * resulting changes. Mirrors ClaudeCodeRunner's git flow (baseline snapshot,
 * changed-file detection, targeted staging, auto-fix, commit, cross-repo
 * write warnings) so behavior is consistent across runners.
 */
export class OpenCodeRunner implements AgentRunner {
  async run(ctx: AgentContext): Promise<AgentResult> {
    const prompt = buildPrompt(ctx);
    const timeoutMs = ctx.timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
    const model = resolveOpenCodeModel(ctx);

    if (!model) {
      return {
        success: false,
        filesChanged: [],
        summary: 'Agent execution failed',
        error:
          'OpenCode runner requires a model — set ctx.model, OPENCODE_MODEL, or AI_SDLC_MODEL ' +
          '(provider/model format; a bare model id gets an anthropic/ prefix).',
      };
    }

    try {
      // Snapshot BEFORE the run so pre-existing untracked noise is excluded
      // from the agent's commit (same rationale as ClaudeCodeRunner).
      const baseline = await snapshotWorktree(ctx.workDir);

      // Channel the active task + project root into the child so the in-repo
      // governance plugin (loaded from the project's .opencode/plugins) can
      // resolve worktree sentinels and permittedExternalPaths.
      const extraEnv: Record<string, string | undefined> = {
        AI_SDLC_PROJECT_ROOT: ctx.workDir,
        AI_SDLC_ACTIVE_TASK_ID: ctx.issueId,
      };

      // Per-dispatch virtual config (opencode v2 merges it LAST, per-key):
      // re-anchor the project's local MCP servers at the main clone's build
      // artifacts (dist/ is git-ignored, so relative paths dangle in
      // worktrees) and disable step snapshots for the throwaway worktree.
      extraEnv.OPENCODE_CONFIG_CONTENT = buildDispatchConfig(
        ctx.workDir,
        await resolveMainCloneRoot(ctx.workDir),
        ctx.allowedTools,
      );
      const { readOnly } = buildToolPermission(ctx.allowedTools);

      const result = await runOpenCode({
        workDir: ctx.workDir,
        prompt,
        model,
        agent: process.env.OPENCODE_AGENT,
        timeoutMs,
        extraEnv,
        auto: !readOnly,
        onProgress: ctx.onProgress,
      });

      // A run that exited 0 but hit a stream-level transport error mid-session
      // (e.g. LM Studio socket drop) with no final text is a failure, not a
      // success — otherwise an empty diff would silently read as "no changes".
      if (result.streamError && !result.stdout.trim()) {
        return {
          success: false,
          filesChanged: [],
          summary: 'Agent execution failed',
          error: `opencode session ended in a stream error: ${result.streamError}`,
          tokenUsage: result.tokenUsage,
        };
      }

      // Authoritative tokens from the session DB (falls back to stream sum).
      const tokenUsage =
        (result.sessionID
          ? await fetchSessionTokens(result.sessionID, ctx.workDir, result.model)
          : undefined) ?? result.tokenUsage;

      const { filesChanged, agentAlreadyCommitted } = await detectChangedFiles(
        ctx.workDir,
        baseline,
      );

      if (filesChanged.length === 0) {
        return {
          success: false,
          filesChanged: [],
          summary: 'Agent made no changes',
          error: 'No files were modified',
          tokenUsage,
        };
      }

      if (agentAlreadyCommitted) {
        return {
          success: true,
          filesChanged,
          summary: (result.stdout || '').slice(0, 2000),
          tokenUsage,
        };
      }

      await gitExec(ctx.workDir, ['add', '--', ...filesChanged]);
      const lintCmd = process.env.AI_SDLC_LINT_COMMAND;
      const fmtCmd = process.env.AI_SDLC_FORMAT_COMMAND;
      await runAutoFix(ctx.workDir, lintCmd, fmtCmd);
      await gitExec(ctx.workDir, ['add', '--', ...filesChanged]);

      const tmpl = ctx.commitMessageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE;
      const coAuthor = ctx.commitCoAuthor ?? DEFAULT_COMMIT_CO_AUTHOR;
      const commitMsg = tmpl
        .replace(/\{issueNumber\}/g, ctx.issueId)
        .replace(/\{issueTitle\}/g, ctx.issueTitle);

      try {
        await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
      } catch {
        await runAutoFix(ctx.workDir, lintCmd, fmtCmd);
        await gitExec(ctx.workDir, ['add', '--', ...filesChanged]);
        await gitExec(ctx.workDir, ['commit', '-m', `${commitMsg}\n\nCo-Authored-By: ${coAuthor}`]);
      }

      const crossRepoWrites = await detectCrossRepoWrites(ctx.workDir);
      for (const write of crossRepoWrites) {
        process.stderr.write(
          `[ai-sdlc:runner] WARNING: agent wrote ${write.files.length} file(s) into sibling repo ` +
            `${write.repoPath} — those changes are NOT in this PR. ` +
            `Files: ${write.files.slice(0, 5).join(', ')}${write.files.length > 5 ? ` (+${write.files.length - 5} more)` : ''}\n`,
        );
      }

      return {
        success: true,
        filesChanged,
        summary: (result.stdout || '').slice(0, 2000),
        tokenUsage,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        filesChanged: [],
        summary: 'Agent execution failed',
        error: message,
      };
    }
  }
}
