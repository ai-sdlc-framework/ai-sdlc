/**
 * Step 6 — Parse the developer subagent's return JSON and apply gates.
 *
 * Mirrors `execute-orchestrator.md` Step 6:
 *
 *  - If `commitSha` is null → developer-failed.
 *  - If any of `verifications.{build,test,lint,format}` is `failed` → developer-failed.
 *  - Otherwise the structured return is validated and returned.
 *
 * Inputs accepted as either a JSON string or an already-parsed object so
 * the same function works for Tier 1 (CLI receives a `--return <json>` flag)
 * and Tier 2 (TypeScript service hands in the parsed `SubagentResult.parsed`).
 *
 * AISDLC-176 — when the input cannot be parsed as JSON (or the parsed value
 * is not an object), the result carries `contractViolation: true`. Callers
 * that have access to the SubagentSpawner (Tier 2 / orchestrator) can use
 * `parseDeveloperReturnWithRetry()` to issue ONE follow-up spawn asking the
 * developer to re-emit the JSON envelope before falling through to the
 * `developer-json-contract-violated` outcome. Schema-violation failures
 * (missing required keys, wrong types, `commitSha: null`, `verifications.X
 * = failed`) are NOT contract violations — those are valid envelopes that
 * report a real failure and route through the `developer-failed` outcome.
 *
 * @module steps/06-parse-dev-return
 */

import type {
  DeveloperReturn,
  ParseDeveloperReturnResult,
  SubagentResult,
  SubagentSpawner,
  VerificationStatus,
} from '../types.js';

const VALID_VERIFICATION_STATUSES: VerificationStatus[] = ['passed', 'failed', 'skipped'];

export interface ParseDeveloperReturnOptions {
  /** Either a JSON string or a parsed object. */
  developerReturn: string | unknown;
}

export async function parseDeveloperReturn(
  opts: ParseDeveloperReturnOptions,
): Promise<ParseDeveloperReturnResult> {
  let parsed: unknown = opts.developerReturn;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      // AISDLC-176 — JSON.parse failure IS a contract violation; the dev
      // returned non-JSON prose. Surface the truncated raw text in the
      // reason so the operator gets actionable context (the previous
      // behaviour swallowed the raw output behind the JSON.parse error
      // message, leaving operators with "Unexpected token D in JSON at
      // position 0" and no clue what the dev actually said).
      const raw = typeof opts.developerReturn === 'string' ? opts.developerReturn : '';
      const preview = raw.length > 500 ? raw.slice(0, 500) + '… (truncated)' : raw;
      return {
        ok: false,
        reason:
          `failed to parse developer JSON: ${(err as Error).message} ` +
          `(raw output: ${JSON.stringify(preview)})`,
        contractViolation: true,
      };
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    // AISDLC-176 — a non-object return (number, string-after-parse,
    // boolean, null) violates the envelope contract. Treat it like a
    // JSON.parse failure for retry purposes.
    return {
      ok: false,
      reason: 'developer return is not an object',
      contractViolation: true,
    };
  }
  const obj = parsed as Record<string, unknown>;

  // Required keys
  for (const key of [
    'summary',
    'filesChanged',
    'commitSha',
    'verifications',
    'acceptanceCriteriaMet',
  ]) {
    if (!(key in obj)) {
      return { ok: false, reason: `developer return missing required key '${key}'` };
    }
  }

  if (!Array.isArray(obj.filesChanged)) {
    return { ok: false, reason: "developer return field 'filesChanged' must be an array" };
  }
  if (!Array.isArray(obj.acceptanceCriteriaMet)) {
    return { ok: false, reason: "developer return field 'acceptanceCriteriaMet' must be an array" };
  }
  const v = obj.verifications;
  if (!v || typeof v !== 'object') {
    return { ok: false, reason: "developer return field 'verifications' must be an object" };
  }
  const vObj = v as Record<string, unknown>;
  for (const key of ['build', 'test', 'lint', 'format']) {
    const val = vObj[key];
    if (
      typeof val !== 'string' ||
      !VALID_VERIFICATION_STATUSES.includes(val as VerificationStatus)
    ) {
      return {
        ok: false,
        reason: `developer return verifications.${key} must be one of ${VALID_VERIFICATION_STATUSES.join('/')}`,
      };
    }
  }

  // Treat null commitSha as developer failure (RFC §5.4 + execute-orchestrator Step 6).
  if (obj.commitSha === null || obj.commitSha === undefined) {
    return {
      ok: false,
      reason: `developer reported null commitSha — task could not be completed${
        typeof obj.notes === 'string' && obj.notes ? ': ' + obj.notes : ''
      }`,
      developer: obj as unknown as DeveloperReturn,
    };
  }

  for (const key of ['build', 'test', 'lint', 'format'] as const) {
    if (vObj[key] === 'failed') {
      return {
        ok: false,
        reason: `developer reported verifications.${key} = failed`,
        developer: obj as unknown as DeveloperReturn,
      };
    }
  }

  return { ok: true, developer: obj as unknown as DeveloperReturn };
}

// ── AISDLC-176 — retry-once-on-contract-violation helper ────────────────

export interface ParseDeveloperReturnWithRetryOptions {
  /** The first developer SubagentResult (raw + parsed from the Step 5b spawn). */
  initialResult: SubagentResult;
  /**
   * The cwd handed to the original developer spawn — re-used for the
   * follow-up spawn so the agent can `git rev-parse HEAD` inside the same
   * worktree to retrieve the commit SHA it landed on the first turn.
   */
  cwd: string;
  /** The SubagentSpawner — same instance used for the first spawn. */
  spawner: SubagentSpawner;
  /**
   * Per-spawn timeout for the retry, in ms. Optional — the spawner picks
   * its own default when unset (typically 30 minutes; the retry is
   * usually quicker since the work is already on disk).
   */
  timeoutMs?: number;
  /**
   * Optional hook fired when the retry succeeds (parse-then-good-envelope).
   * Used by callers (executePipeline, iterateReviewLoop) to emit the
   * `DeveloperContractRetry` observability event without coupling this
   * pure helper to the orchestrator events bus. Receives the original
   * raw output preview + the retry's raw output preview so consumers can
   * surface the diagnostic context.
   */
  onRetrySuccess?: (info: {
    initialOutputPreview: string;
    retryOutputPreview: string;
    durationMs: number;
  }) => void;
}

/**
 * AISDLC-176 — parse the developer subagent's return with at-most-one
 * retry on a JSON-contract violation.
 *
 * The retry mechanism:
 *
 *   1. Parse the original `initialResult` via `parseDeveloperReturn()`.
 *   2. If the parse succeeded OR failed with a NON-contract-violation
 *      reason (missing keys, `commitSha: null`, `verifications.X = failed`),
 *      return the result as-is — the dev followed the envelope contract;
 *      any failure is the dev reporting genuine work failure, not a
 *      protocol bug.
 *   3. If the parse failed with `contractViolation: true` (JSON.parse
 *      failure OR non-object root), fire ONE follow-up `spawner.spawn()`
 *      call with a re-emission prompt that includes the previous output
 *      and tells the agent to:
 *        - Re-emit the JSON envelope `{summary, filesChanged, commitSha,
 *          verifications, acceptanceCriteriaMet, prUrl, notes}`.
 *        - Populate `commitSha` from `git rev-parse HEAD` if it has
 *          already committed (the first-turn work is preserved on disk
 *          inside the worktree).
 *      Then parse the retry. On retry success, return the parsed envelope
 *      and fire `onRetrySuccess`. On retry failure (parse OR schema), the
 *      result carries `contractViolation: true` and a reason that includes
 *      both turns' raw output for forensic context — callers should map
 *      this to the `developer-json-contract-violated` outcome.
 *
 * The spawner contract (RFC-0012 §8) is one-shot per `spawn()` call (see
 * `pipeline-cli/docs/spawner.md`); the retry is therefore a fresh
 * subagent invocation with full context in the prompt, NOT a continued
 * conversation. That works because the dev's first-turn work has already
 * landed in the worktree (commit on the feature branch), so the retry
 * agent can rediscover state via `git rev-parse HEAD`.
 *
 * @see ai-sdlc-plugin/agents/developer.md — system prompt that documents
 *      the JSON envelope contract this helper enforces.
 */
export async function parseDeveloperReturnWithRetry(
  opts: ParseDeveloperReturnWithRetryOptions,
): Promise<ParseDeveloperReturnResult> {
  const initial = await parseDeveloperReturn({
    developerReturn: opts.initialResult.parsed ?? opts.initialResult.output,
  });
  if (initial.ok || !initial.contractViolation) return initial;

  const initialPreview = previewOutput(opts.initialResult.output);
  const retryPrompt = buildRetryPrompt(initialPreview);

  const start = Date.now();
  const retryResult = await opts.spawner.spawn({
    type: 'developer',
    prompt: retryPrompt,
    cwd: opts.cwd,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  const durationMs = Date.now() - start;

  const retryParsed = await parseDeveloperReturn({
    developerReturn: retryResult.parsed ?? retryResult.output,
  });

  if (retryParsed.ok) {
    opts.onRetrySuccess?.({
      initialOutputPreview: initialPreview,
      retryOutputPreview: previewOutput(retryResult.output),
      durationMs,
    });
    return retryParsed;
  }

  // Retry also failed — return a contract violation that surfaces BOTH
  // turns' raw output so the operator gets the full forensic context.
  return {
    ok: false,
    contractViolation: true,
    reason:
      `developer subagent violated JSON envelope contract on both turns. ` +
      `initial (${initial.reason ?? 'parse failed'}); ` +
      `retry (${retryParsed.reason ?? 'parse failed'})`,
  };
}

/**
 * Truncate the raw subagent output for inclusion in error messages /
 * retry prompts. Keeps the cap at 1000 chars — large enough to capture
 * the agent's intent (typically a one-paragraph summary), small enough
 * to fit comfortably in a retry prompt + an operator log line.
 */
function previewOutput(raw: string | undefined): string {
  if (!raw) return '<empty>';
  return raw.length > 1000 ? raw.slice(0, 1000) + '… (truncated)' : raw;
}

/**
 * Build the one-shot re-emission prompt sent to the retry developer
 * subagent. The prompt:
 *
 *   - Quotes the original (non-JSON) output so the agent can see what
 *     it produced and self-correct.
 *   - States the JSON envelope shape unambiguously.
 *   - Tells the agent to populate `commitSha` from `git rev-parse HEAD`
 *     when the work is already committed (which it usually is by this
 *     point — the witnessed AISDLC-70 case had a valid commit but a
 *     prose return).
 *   - Forbids ALL surrounding prose so the parse on the next turn is
 *     guaranteed to succeed.
 */
function buildRetryPrompt(initialOutputPreview: string): string {
  return [
    'Your previous response was not a valid JSON envelope. The orchestrator',
    'parses your final assistant message as a JSON object; any prose,',
    'markdown, or commentary in that turn fails the dispatch.',
    '',
    'Your previous output (truncated to 1000 chars):',
    '---',
    initialOutputPreview,
    '---',
    '',
    'RE-EMIT the JSON envelope NOW. Your entire response MUST be a single',
    'JSON object — no surrounding prose, no markdown fences, no preamble.',
    '',
    'Required shape:',
    '',
    '{',
    '  "summary": "<1-3 sentence description>",',
    '  "filesChanged": ["<paths>"],',
    '  "commitSha": "<7+ char SHA>",',
    '  "prUrl": "<https URL or null>",',
    '  "verifications": {',
    '    "build": "passed | failed | skipped",',
    '    "test":  "passed | failed | skipped",',
    '    "lint":  "passed | failed | skipped",',
    '    "format":"passed | failed | skipped"',
    '  },',
    '  "acceptanceCriteriaMet": [1, 2, 3],',
    '  "notes": "<optional>"',
    '}',
    '',
    'If you have already committed the work, populate `commitSha` from',
    '`git rev-parse HEAD` inside this worktree — do NOT redo the commit.',
    'If you have already pushed and opened a PR, populate `prUrl` from the',
    'PR you opened; otherwise set it to null.',
    '',
    'Return the JSON object and NOTHING else.',
  ].join('\n');
}
