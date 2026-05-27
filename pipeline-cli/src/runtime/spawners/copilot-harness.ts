/**
 * `CopilotHarnessAdapter` — Phase 2 of the Copilot execution path (AISDLC-429.2).
 *
 * Implements the `SubagentSpawner` contract by bridging to a Copilot CLI's
 * `spawn_agent` host tool. Copilot does not expose Claude Code's plugin
 * `Agent` system, so this adapter centralises the developer + reviewer
 * dispatch contract:
 *
 *   1. Per-`SubagentType` role context — system-prompt strings derived from
 *      the plugin agent definitions in `ai-sdlc-plugin/agents/<type>.md`.
 *      Copilot's `spawn_agent` is generic, so the role contract has to come
 *      from the caller. The defaults here are minimal "behave like the
 *      ai-sdlc <type>" instructions; operators that want the full plugin
 *      agent body can pass `systemPrompts` overrides.
 *   2. A single injected `spawnAgent` callback that wraps the host's
 *      `spawn_agent` tool. Tests pass a mock; the real Copilot host bridge
 *      passes a thin wrapper that calls `spawn_agent`. Keeping this
 *      callback at the boundary means `pipeline-cli` does not need to know
 *      about Copilot CLI versions, transport, or auth.
 *   3. Response normalisation — the adapter returns `SubagentResult`
 *      envelopes whose `parsed` field is the canonical pipeline shape:
 *        - `developer`: `DeveloperReturn` extracted from the response.
 *          Step 6 (`parseDeveloperReturnWithRetry`) consumes this directly.
 *        - reviewers: `{ approved, findings, summary, harness: 'copilot' }`
 *          which `coerceReviewerVerdict` (Step 7b → Step 8) consumes
 *          without further reshaping.
 *
 * The unit tests for this adapter mock `spawnAgent` and never touch a real
 * Copilot CLI install, so the project's `pnpm test` runs in environments
 * without Copilot available (CI, contributor laptops, etc.).
 *
 * @see pipeline-cli/docs/spawner.md — design map
 * @see RFC-0012 §8 — SubagentSpawner contract
 * @module runtime/spawners/copilot-harness
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { SpawnOpts, SubagentResult, SubagentSpawner, SubagentType } from '../../types.js';

/** Default per-spawn timeout. Mirrors `ShellClaudePSpawner` (30 minutes). */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Request payload passed to the injected `spawnAgent` callback. The host
 * bridge translates this into a Copilot `spawn_agent` call.
 *
 * The shape is intentionally narrow: only the fields that vary per dispatch
 * (agentType, prompts, cwd, timeout) cross the boundary. Concerns like
 * model selection, tool permissions, and Copilot auth live on the host side.
 */
export interface CopilotSpawnAgentRequest {
  /**
   * Plugin role being dispatched. Maps 1:1 to `SubagentType`. The host
   * bridge can use this to pick a model, enforce per-role tool permissions,
   * or load the matching `ai-sdlc-plugin/agents/<type>.md` body.
   */
  agentType: SubagentType;
  /**
   * Role-specific system prompt. The adapter looks up
   * `options.systemPrompts[agentType]` and falls back to the built-in
   * default. Operators that want the full plugin agent body should pass
   * `systemPrompts: { developer: readFile('agents/developer.md'), … }`
   * at construction time.
   */
  systemPrompt: string;
  /**
   * The pipeline-built user prompt for this dispatch. For the developer
   * this is `buildDeveloperPrompt`'s output; for reviewers it's the
   * matching prompt from `buildReviewPrompts`.
   */
  userPrompt: string;
  /** Working directory the dispatched agent should operate in (worktree path). */
  cwd: string;
  /** Per-call timeout in ms. Defaults to 30 minutes. */
  timeoutMs: number;
}

/**
 * Response shape the host bridge returns. The adapter expects raw output
 * (so existing parsers can run) and optionally a pre-parsed payload when
 * the host already extracted JSON for us.
 */
export interface CopilotSpawnAgentResponse {
  /** Raw stdout/text emitted by the spawned agent. */
  output: string;
  /**
   * Pre-parsed JSON the host bridge extracted from `output`. When provided
   * the adapter trusts it; otherwise the adapter falls back to parsing
   * `output` itself.
   */
  parsed?: unknown;
}

/** Bridge function the adapter calls to dispatch an agent via Copilot. */
export type CopilotSpawnAgentFn = (
  request: CopilotSpawnAgentRequest,
) => Promise<CopilotSpawnAgentResponse>;

/** Constructor options for `CopilotHarnessAdapter`. */
export interface CopilotHarnessAdapterOptions {
  /**
   * Bridge to Copilot's `spawn_agent` host tool. Required — the adapter
   * itself is host-agnostic. In tests, pass a mock that returns
   * deterministic JSON. In production, pass a wrapper that calls Copilot.
   */
  spawnAgent: CopilotSpawnAgentFn;
  /**
   * Per-call default timeout in ms. Falls back to 30 minutes (matches
   * `ShellClaudePSpawner`). Per-call `SpawnOpts.timeout` overrides this.
   */
  defaultTimeoutMs?: number;
  /**
   * Per-`SubagentType` system prompt overrides. When omitted for a given
   * type the built-in `DEFAULT_SYSTEM_PROMPTS` value is used. Pass the
   * full plugin agent body here when you want the dispatched Copilot agent
   * to honour the same JSON return contract that the Claude Code plugin
   * agents enforce.
   */
  systemPrompts?: Partial<Record<SubagentType, string>>;
}

/**
 * Built-in role context strings. Intentionally short — the pipeline-built
 * user prompts already carry the task spec, diff, AC list, and JSON
 * envelope contract. The system prompts here only reinforce role semantics
 * + the `harness: copilot` marker the verdict aggregator expects.
 *
 * Operators who want the full plugin body verbatim should pass it via
 * `options.systemPrompts` (e.g. `readFileSync('ai-sdlc-plugin/agents/developer.md')`).
 *
 * Exported for tests + downstream callers that want to compose with the
 * defaults.
 */
export const DEFAULT_SYSTEM_PROMPTS: Record<SubagentType, string> = {
  developer:
    'You are the AI-SDLC developer agent dispatched via Copilot CLI. ' +
    'Implement the task end-to-end inside the worktree, run verification, commit, push, and open a draft PR. ' +
    'Your FINAL message MUST be a single JSON object matching the developer return contract documented in ai-sdlc-plugin/agents/developer.md (summary, filesChanged, commitSha, verifications, acceptanceCriteriaMet, optional notes). ' +
    'No prose around the JSON envelope — the orchestrator parses your last assistant turn directly.',
  'code-reviewer':
    'You are the AI-SDLC code-reviewer agent dispatched via Copilot CLI. ' +
    'Review the diff against the task spec for correctness, design, and project conventions. ' +
    'Return a single JSON object: { "approved": boolean, "findings": [{severity, file?, line?, message}], "summary": string, "harness": "copilot" }. ' +
    'Severities: critical, major, minor, suggestion. Use the canonical reviewer verdict shape — no nesting, no prose around the JSON.',
  'test-reviewer':
    'You are the AI-SDLC test-reviewer agent dispatched via Copilot CLI. ' +
    'Review the diff for adequate test coverage, regression guards, and behavioural assertions on the new code. ' +
    'Return the same JSON shape as code-reviewer: { "approved", "findings", "summary", "harness": "copilot" }.',
  'security-reviewer':
    'You are the AI-SDLC security-reviewer agent dispatched via Copilot CLI. ' +
    'Review the diff for OWASP-class vulnerabilities, secret exposure, command-injection risk, and authn/authz regressions. ' +
    'Return the same JSON shape as code-reviewer: { "approved", "findings", "summary", "harness": "copilot" }.',
  'refinement-reviewer':
    'You are the AI-SDLC refinement-reviewer agent dispatched via Copilot CLI. ' +
    'Identify simplifications and consistency improvements without changing behaviour. ' +
    'Return the same JSON shape as code-reviewer: { "approved", "findings", "summary", "harness": "copilot" }.',
};

/** Reviewer types the adapter produces canonical verdict envelopes for. */
const REVIEWER_TYPES: ReadonlySet<SubagentType> = new Set<SubagentType>([
  'code-reviewer',
  'test-reviewer',
  'security-reviewer',
  'refinement-reviewer',
]);

/**
 * `CopilotHarnessAdapter` — `SubagentSpawner` over Copilot `spawn_agent`.
 *
 * Routes each `spawn(opts)` call through the injected bridge, normalises
 * the response into the pipeline's canonical envelope, and tags reviewer
 * verdicts with `harness: 'copilot'` so Step 8 attribution is unambiguous.
 */
export class CopilotHarnessAdapter implements SubagentSpawner {
  private readonly spawnAgent: CopilotSpawnAgentFn;
  private readonly defaultTimeoutMs: number;
  private readonly systemPrompts: Record<SubagentType, string>;

  constructor(options: CopilotHarnessAdapterOptions) {
    this.spawnAgent = options.spawnAgent;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.systemPrompts = { ...DEFAULT_SYSTEM_PROMPTS, ...(options.systemPrompts ?? {}) };
  }

  async spawn(opts: SpawnOpts): Promise<SubagentResult> {
    const start = Date.now();
    const timeoutMs = opts.timeout ?? this.defaultTimeoutMs;

    let response: CopilotSpawnAgentResponse;
    try {
      response = await this.spawnAgent({
        agentType: opts.type,
        systemPrompt: this.systemPrompts[opts.type] ?? '',
        userPrompt: opts.prompt,
        cwd: opts.cwd,
        timeoutMs,
      });
    } catch (err) {
      return {
        type: opts.type,
        output: '',
        status: 'error',
        error: `copilot spawn_agent threw: ${stringifyError(err)}`,
        durationMs: Date.now() - start,
      };
    }

    const output = typeof response.output === 'string' ? response.output : '';
    const parsed = response.parsed !== undefined ? response.parsed : tryParseJson(output);
    const isReviewer = REVIEWER_TYPES.has(opts.type);
    const finalParsed = isReviewer ? normalizeReviewerVerdict(parsed) : parsed;

    return {
      type: opts.type,
      output,
      ...(finalParsed !== undefined ? { parsed: finalParsed } : {}),
      status: 'success',
      durationMs: Date.now() - start,
    };
  }

  /**
   * Copilot `spawn_agent` is single-task per call but cheap to invoke
   * concurrently — fan out the three reviewers via `Promise.all` so
   * Step 7b sees the same parallel-dispatch latency as the Claude Code
   * path. If a host bridge needs serial fallback (e.g. rate limits) it
   * can implement that internally inside its `spawnAgent` callback.
   */
  async spawnParallel(opts: SpawnOpts[]): Promise<SubagentResult[]> {
    return Promise.all(opts.map((o) => this.spawn(o)));
  }
}

/**
 * Best-effort JSON parse over the agent's raw output. Returns `undefined`
 * when the output is not valid JSON so the caller can decide whether to
 * fall through to a prose-output handler.
 *
 * Exported for tests and for downstream callers that want the same
 * lenient extraction behaviour.
 */
export function tryParseJson(output: string): unknown | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate JSON wrapped in markdown fences (Copilot agents sometimes
    // emit ```json … ``` despite system prompts asking for raw JSON).
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    if (fenced && fenced[1]) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Normalize whatever the Copilot reviewer returned into the canonical
 * `ReviewerVerdict`-shaped object that `coerceReviewerVerdict` consumes.
 *
 * Behaviour:
 *  - Stamps `harness: 'copilot'` so Step 8's verdict attribution is correct
 *    even when the agent forgot to include the field.
 *  - Coerces `approved` to a boolean.
 *  - Defaults `findings` to `[]` if missing or non-array.
 *  - Preserves `summary` when present and a string.
 *  - Returns `undefined` for shapes that aren't an object — the caller
 *    falls through to `coerceReviewerVerdict`'s "no parseable verdict"
 *    branch, which surfaces the failure with a critical finding.
 *
 * Exported for tests.
 */
export function normalizeReviewerVerdict(raw: unknown): unknown | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as {
    approved?: unknown;
    findings?: unknown;
    summary?: unknown;
    harness?: unknown;
  };
  return {
    approved: !!obj.approved,
    findings: Array.isArray(obj.findings) ? obj.findings : [],
    ...(typeof obj.summary === 'string' ? { summary: obj.summary } : {}),
    harness: typeof obj.harness === 'string' && obj.harness ? obj.harness : 'copilot',
  };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ── Subprocess bridge ────────────────────────────────────────────────
//
// Default `spawnAgent` implementation for the `--spawner copilot` CLI flag.
// Shells out to a Copilot bridge binary configured via the
// `COPILOT_SPAWN_AGENT_BIN` env var. The bridge is the operator's own thin
// wrapper around Copilot's `spawn_agent` host tool — typically a small
// shell or Node script the Copilot CLI session installs on PATH.
//
// Wire protocol (kept minimal so any host can implement it):
//   1. The adapter spawns the bridge bin with no positional args.
//   2. The adapter writes the request envelope to the bridge's STDIN as
//      a single JSON line:
//        { "agentType", "systemPrompt", "userPrompt", "cwd", "timeoutMs" }
//   3. The bridge invokes Copilot's spawn_agent and writes the response
//      to STDOUT as a single JSON envelope:
//        { "output": "<raw>", "parsed": <optional pre-extracted JSON> }
//   4. The bridge exits zero on success; non-zero exit is treated as
//      an error and surfaced via the SubagentResult `error` field.
//
// This keeps the `pipeline-cli` package free of any Copilot CLI version
// coupling — the bridge is the operator's contract surface.

/**
 * Subset of `child_process.spawn` we depend on. Tests inject a fake to
 * assert the JSON-line protocol without spawning a real subprocess.
 */
export type CopilotProcessSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd?: string },
) => ChildProcess;

/** Constructor options for `subprocessCopilotSpawnAgent()`. */
export interface SubprocessCopilotSpawnAgentOptions {
  /**
   * Path to the bridge binary. Defaults to `process.env.COPILOT_SPAWN_AGENT_BIN`.
   * The factory throws when both the option and the env var are absent —
   * the CLI flag wires this so the operator gets a clear "configure
   * COPILOT_SPAWN_AGENT_BIN" message rather than a silent dispatch failure.
   */
  bridgeBin?: string;
  /** Inject a stub `child_process.spawn` for tests. */
  spawn?: CopilotProcessSpawner;
  /**
   * Per-spawn timeout fallback if the request envelope omits one. The
   * adapter normally always supplies `timeoutMs`, so this only fires
   * for callers that bypass the adapter and use the bridge directly.
   */
  defaultTimeoutMs?: number;
}

/** Sentinel error message thrown when the bridge env var is unset. */
export const COPILOT_BRIDGE_MISSING_MESSAGE =
  '`--spawner copilot` requires COPILOT_SPAWN_AGENT_BIN in the environment ' +
  "(path to a script wrapping Copilot's spawn_agent host tool). " +
  'Install GitHub Copilot CLI and set COPILOT_SPAWN_AGENT_BIN to the path of your bridge script. ' +
  'For programmatic use, construct CopilotHarnessAdapter directly with a ' +
  'custom CopilotSpawnAgentFn injected.';

/**
 * Build a `CopilotSpawnAgentFn` that shells out to the Copilot bridge bin.
 *
 * Throws synchronously when the bridge bin is not configured — the CLI
 * `--spawner copilot` resolver awaits this factory so the error surfaces
 * to the operator before any pipeline mutation runs.
 */
export function subprocessCopilotSpawnAgent(
  options: SubprocessCopilotSpawnAgentOptions = {},
): CopilotSpawnAgentFn {
  const bridgeBin = options.bridgeBin ?? process.env.COPILOT_SPAWN_AGENT_BIN;
  if (!bridgeBin) {
    throw new Error(COPILOT_BRIDGE_MISSING_MESSAGE);
  }
  const spawnImpl = options.spawn ?? (nodeSpawn as CopilotProcessSpawner);
  const fallbackTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (request: CopilotSpawnAgentRequest): Promise<CopilotSpawnAgentResponse> => {
    return new Promise<CopilotSpawnAgentResponse>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnImpl(bridgeBin, [], { cwd: request.cwd });
      } catch (err) {
        reject(new Error(`failed to spawn bridge ${bridgeBin}: ${stringifyError(err)}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timeoutMs = request.timeoutMs ?? fallbackTimeoutMs;

      const settle = (next: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        next();
      };

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        settle(() =>
          reject(new Error(`copilot spawn_agent bridge timed out after ${timeoutMs}ms`)),
        );
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on('error', (err) => {
        settle(() =>
          reject(new Error(`copilot spawn_agent bridge errored: ${stringifyError(err)}`)),
        );
      });

      child.on('close', (code: number | null) => {
        if (code !== 0) {
          settle(() =>
            reject(
              new Error(
                `copilot spawn_agent bridge exited ${code ?? 'null'}: ${stderr.trim() || 'no stderr'}`,
              ),
            ),
          );
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          settle(() =>
            reject(
              new Error(
                'copilot spawn_agent bridge exited 0 with empty stdout; expected JSON envelope ' +
                  '{ output: string, parsed?: unknown }. Check COPILOT_SPAWN_AGENT_BIN and ' +
                  'the bridge/copilot exec diagnostics.',
              ),
            ),
          );
          return;
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(trimmed);
        } catch {
          // Bridge returned non-JSON — treat the entire stdout as raw output.
          settle(() => resolve({ output: stdout }));
          return;
        }
        if (envelope && typeof envelope === 'object') {
          const e = envelope as { output?: unknown; parsed?: unknown };
          const output = typeof e.output === 'string' ? e.output : stdout;
          settle(() => resolve(e.parsed !== undefined ? { output, parsed: e.parsed } : { output }));
          return;
        }
        settle(() => resolve({ output: stdout }));
      });

      // Write the request envelope as a single JSON line + close stdin.
      try {
        const payload =
          JSON.stringify({
            agentType: request.agentType,
            systemPrompt: request.systemPrompt,
            userPrompt: request.userPrompt,
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
          }) + '\n';
        child.stdin?.end(payload);
      } catch (err) {
        settle(() =>
          reject(new Error(`failed to write request to copilot bridge: ${stringifyError(err)}`)),
        );
      }
    });
  };
}
