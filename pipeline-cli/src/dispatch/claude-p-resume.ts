/**
 * Phase 1.5 (RFC-0041 OQ-4 / AISDLC-377.2) — `claude -p` session-resume
 * helpers for the `claude-p-shell` Worker kind.
 *
 * The OQ-4 resolution mandates context-preserving resumption: instead of
 * re-emitting a fresh manifest (which would force the Worker to re-read the
 * task body, re-explore the codebase, etc.), the supervisor re-spawns the
 * SAME `claude -p` session with `--resume <session-id>` so the prior
 * conversation transcript carries over. This module ships the primitives
 * the supervisor (Phase 2 / AISDLC-377.3) will compose.
 *
 * Three primitives:
 *
 *   - `buildClaudePInitialArgv(opts)` — argv for the first-attempt spawn,
 *     including `--session-id <uuid>` so the supervisor knows the ID up
 *     front (rather than parsing it back out of the JSON envelope at
 *     completion).
 *   - `buildClaudePResumeArgv(opts)` — argv for the resume spawn, including
 *     `--resume <uuid>` + the conductor feedback as the positional prompt.
 *   - `extractSessionIdFromClaudeOutput(json)` — pull the session ID out of
 *     the `--output-format json` envelope as a defense-in-depth fallback
 *     when the supervisor wants to double-check the spawn-time ID matches
 *     what the CLI actually used.
 *
 * The supervisor (when AISDLC-377.3 lands) calls these from a small spawn
 * loop that resembles:
 *
 *   const sessionId = crypto.randomUUID();
 *   const argv1 = buildClaudePInitialArgv({ sessionId, prompt, agent: 'developer' });
 *   spawn('claude', argv1, { env: { ...env, CLAUDECODE: undefined } });
 *   // wait for verdict.outcome === 'iterate-needed' + resume-signal
 *   const argv2 = buildClaudePResumeArgv({ sessionId, feedback });
 *   spawn('claude', argv2, { env: { ...env, CLAUDECODE: undefined } });
 *
 * All argv values are passed as separate entries (no shell expansion); the
 * caller is responsible for the spawn options (`cwd`, `env`).
 */

import { randomUUID } from 'node:crypto';

/** Default subagent the supervisor invokes (`ai-sdlc-plugin/agents/developer.md`). */
export const DEFAULT_RESUME_AGENT = 'developer';

/** Options for `buildClaudePInitialArgv`. */
export interface BuildClaudePInitialArgvOpts {
  /**
   * Stable session identifier for the spawn. Pass an explicit UUID when the
   * supervisor wants to record the ID before the spawn returns; pass
   * `undefined` to let this helper mint a fresh UUID (returned alongside
   * the argv).
   */
  sessionId?: string;
  /** Positional prompt passed to `claude -p` (last argv entry). */
  prompt: string;
  /** Agent name (`--agent <agent>`). Defaults to `developer`. */
  agent?: string;
  /** Optional model override (`--model <model>`). */
  model?: string;
  /** Extra argv appended BEFORE the positional prompt. */
  extraArgs?: readonly string[];
}

/**
 * Build the initial-spawn argv for a `claude -p` Worker. Returns
 * `{argv, sessionId}` — the supervisor records `sessionId` on its inflight
 * tracking so it can later issue `--resume <sessionId>`.
 *
 * Argv shape:
 *   --print
 *   --output-format json
 *   --permission-mode bypassPermissions
 *   --session-id <uuid>
 *   --agent <agent>
 *   [--model <model>]
 *   [...extraArgs]
 *   <prompt>
 */
export function buildClaudePInitialArgv(opts: BuildClaudePInitialArgvOpts): {
  argv: string[];
  sessionId: string;
} {
  const sessionId = opts.sessionId ?? randomUUID();
  const agent = opts.agent ?? DEFAULT_RESUME_AGENT;
  const modelArgv = opts.model ? ['--model', opts.model] : [];
  const argv = [
    '--print',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--session-id',
    sessionId,
    '--agent',
    agent,
    ...modelArgv,
    ...(opts.extraArgs ?? []),
    opts.prompt,
  ];
  return { argv, sessionId };
}

/** Options for `buildClaudePResumeArgv`. */
export interface BuildClaudePResumeArgvOpts {
  /** Session ID captured from the first-attempt spawn. REQUIRED. */
  sessionId: string;
  /** Conductor-authored feedback prepended to the resumed conversation. */
  feedback: string;
  /** Optional extra argv (e.g. `--model` override on resume). */
  extraArgs?: readonly string[];
}

/**
 * Build the resume-spawn argv for a `claude -p` Worker. The `--resume <uuid>`
 * flag tells `claude -p` to load the prior conversation transcript; the
 * positional `feedback` is treated as the operator's next message in that
 * conversation.
 *
 * Argv shape:
 *   --print
 *   --output-format json
 *   --permission-mode bypassPermissions
 *   --resume <uuid>
 *   [...extraArgs]
 *   <feedback>
 *
 * Note: `--agent` is NOT included on resume — the prior session already
 * established the agent, and re-passing it is a no-op (and confusingly
 * implies the agent could change mid-conversation). `--model` similarly is
 * pinned by the prior session unless the caller explicitly overrides via
 * `extraArgs`.
 */
export function buildClaudePResumeArgv(opts: BuildClaudePResumeArgvOpts): string[] {
  return [
    '--print',
    '--output-format',
    'json',
    '--permission-mode',
    'bypassPermissions',
    '--resume',
    opts.sessionId,
    ...(opts.extraArgs ?? []),
    opts.feedback,
  ];
}

/**
 * Defense-in-depth: extract the session ID from a parsed `--output-format
 * json` envelope. The supervisor knows the session ID from its spawn-time
 * `--session-id` flag, but a sanity check against what the CLI actually
 * used helps surface upgrade-related drift (e.g. if a future `claude -p`
 * release changes the field name).
 *
 * The CLI's envelope shape (as of 2026-05-20) carries the session ID at
 * top-level as `session_id` (snake_case). We accept both `session_id` AND
 * `sessionId` (camel-case) defensively. Returns `undefined` when the field
 * is absent or the envelope is malformed.
 */
export function extractSessionIdFromClaudeOutput(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const fromSnake = obj['session_id'];
  if (typeof fromSnake === 'string' && fromSnake.length > 0) return fromSnake;
  const fromCamel = obj['sessionId'];
  if (typeof fromCamel === 'string' && fromCamel.length > 0) return fromCamel;
  return undefined;
}
