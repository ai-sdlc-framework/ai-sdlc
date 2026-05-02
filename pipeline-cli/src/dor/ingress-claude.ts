/**
 * Claude Code subagent ingress shim (RFC-0011 §5.2).
 *
 * Phase 3 (AISDLC-115.4) wires the rubric library function
 * (`evaluateIssueE2E()`) into the `/ai-sdlc execute` flow so that when a
 * backlog task transitions Draft → To Do (or is created in-session via
 * `mcp__backlog__task_create`) the DoR gate runs against the task body
 * before the developer subagent is spawned.
 *
 * The shim is responsible for:
 *
 *   1. Reading the backlog task file from disk.
 *   2. Calling `evaluateIssueE2E()` with `source: 'backlog'`.
 *   3. Persisting the verdict to the calibration log.
 *   4. Routing the verdict to the per-channel comment posters
 *      (Backlog file ⇒ append to a `## Clarifications Requested`
 *      section; optional Slack / GitHub team ⇒ same as the GitHub Action
 *      shim).
 *
 * Status transitions are NOT done by the shim — the orchestration layer
 * (`/ai-sdlc execute` slash command body) is responsible for them. This
 * shim returns a structured envelope the slash command body inspects to
 * decide whether to refuse execution (verdict = needs-clarification) or
 * proceed (verdict = admit).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyAutoPass } from './auto-pass.js';
import { evaluateIssueE2E, type EvaluateE2EOpts } from './composite.js';
import { appendCalibrationEntry } from './calibration-log.js';
import {
  fanoutPost,
  renderClarificationComment,
  type CommentPoster,
  type PostResult,
} from './comment-loop.js';
import {
  DOR_CONFIG_DEFAULTS,
  loadDorConfig,
  type DorConfig,
  type DorEvaluationMode,
} from './dor-config.js';
import type { IssueInput, RefinementVerdict } from './types.js';

export interface RefineBacklogTaskOpts {
  /** Project root. Defaults to `process.cwd()`. */
  workDir?: string;
  /** Override the loaded `DorConfig`. Tests inject a fixture; production reads from disk. */
  config?: DorConfig;
  /** Map of channel-keyed posters. Tests inject in-memory implementations. */
  posters?: Partial<Record<PostResult['channel'], CommentPoster>>;
  /** Forwarded to `evaluateIssueE2E()`. Tests can stub Stage B with a mock spawner. */
  evaluateOpts?: EvaluateE2EOpts;
  /** Optional override for the calibration log artifactsDir. */
  artifactsDir?: string;
  /** Override the on-disk task file path resolution (tests). */
  taskFilePathOverride?: string;
}

export interface RefineBacklogTaskResult {
  taskId: string;
  /** The verdict produced by `evaluateIssueE2E()`. */
  verdict: RefinementVerdict;
  /** Per-channel post outcomes. Empty when no posting was needed. */
  posts: PostResult[];
  /** Whether the orchestration layer should refuse execution. */
  shouldRefuseExecution: boolean;
  /** Mode the decision was made under (drives warn-only vs enforce). */
  evaluationMode: DorEvaluationMode;
  /** Path of the calibration log entry that was written. */
  calibrationLogPath?: string;
}

/**
 * Read the backlog task file at the canonical
 * `<workDir>/backlog/tasks/<task-id>-*.md` path. Returns `null` when no
 * file matches — the shim treats that as a hard error rather than a
 * silent skip so misconfigured calls fail loudly.
 */
export function locateBacklogTaskFile(workDir: string, taskId: string): string | null {
  const tasksDir = join(workDir, 'backlog', 'tasks');
  if (!existsSync(tasksDir)) return null;
  // Backlog convention: `<id-lower>-*.md`. Cheap glob via readdir.
  // Avoid pulling in a glob dependency for this single use.
  const id = taskId.toLowerCase();
  const candidates = readdirOrEmpty(tasksDir).filter(
    (name) => name.toLowerCase().startsWith(id) && name.endsWith('.md'),
  );
  if (candidates.length === 0) return null;
  return join(tasksDir, candidates[0]!);
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Strip Backlog.md frontmatter to get just the task body. The DoR rubric
 * scores the body, not the YAML preamble. Returns the input unchanged if
 * no frontmatter is present.
 *
 * Also extracts `created_by` (the Backlog.md authorship marker) so the
 * auto-pass dispatcher can match rules whose `sources` reference the
 * generator identity (e.g. `ai-sdlc/signal-pipeline`) — RFC §6.4 + Phase 4.
 */
export function stripFrontmatter(raw: string): {
  title: string;
  body: string;
  createdBy?: string;
} {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { title: '', body: raw };
  const fm = fmMatch[1] ?? '';
  const body = fmMatch[2] ?? '';
  const titleMatch = fm.match(/^title:\s*(.+?)\s*$/m);
  const titleRaw = titleMatch?.[1] ?? '';
  // Strip surrounding single/double quotes.
  const title = titleRaw.replace(/^['"]|['"]$/g, '');
  const createdByMatch = fm.match(/^created_by:\s*(.+?)\s*$/m);
  const createdByRaw = createdByMatch?.[1]?.replace(/^['"]|['"]$/g, '');
  const out: { title: string; body: string; createdBy?: string } = { title, body };
  if (createdByRaw) out.createdBy = createdByRaw;
  return out;
}

/**
 * Run the DoR gate against a backlog task. The orchestration layer
 * (`/ai-sdlc execute`) calls this BEFORE Step 4 (begin-task) and short-
 * circuits on `shouldRefuseExecution`.
 *
 * The shim is intentionally side-effect-free except for:
 *   - The calibration log append (always — RFC §5.5).
 *   - Comment posting through the injected posters (only when the
 *     verdict is needs-clarification AND a poster is provided).
 */
export async function refineBacklogTask(
  taskId: string,
  opts: RefineBacklogTaskOpts = {},
): Promise<RefineBacklogTaskResult> {
  const workDir = opts.workDir ?? process.cwd();
  const taskFile = opts.taskFilePathOverride ?? locateBacklogTaskFile(workDir, taskId);
  if (!taskFile || !existsSync(taskFile)) {
    throw new Error(
      `[ai-sdlc/dor] Could not locate backlog task file for ${taskId} under ${join(workDir, 'backlog', 'tasks')}`,
    );
  }
  const raw = readFileSync(taskFile, 'utf8');
  const { title, body, createdBy } = stripFrontmatter(raw);

  const config = opts.config ?? loadDorConfig({ workDir });

  const input: IssueInput = {
    source: 'backlog',
    id: taskId,
    title: title || taskId,
    body,
    workDir,
  };
  if (createdBy) input.authorIdentity = createdBy;

  // Phase 4 (RFC-0011 §6.4 + AISDLC-115.5) — resolve the auto-pass match
  // against the project's configured rules. When a rule matches, fold its
  // `gatesSkipped` set into `evaluateIssueE2E()` opts so the corresponding
  // gates short-circuit to `verdict: 'skip'` with the matched rule kind
  // surfaced in the finding text.
  const autoPass = applyAutoPass(input, config.autoPassRules ?? []);
  const evaluateOpts: EvaluateE2EOpts = { ...(opts.evaluateOpts ?? {}) };
  if (autoPass.gatesSkipped.length > 0) {
    evaluateOpts.gatesSkipped = autoPass.gatesSkipped;
    evaluateOpts.autoPassReason = `auto-pass: ${autoPass.matched?.kind ?? 'matched'}`;
  }

  const verdict = await evaluateIssueE2E(input, evaluateOpts);

  // Calibration log — always written, regardless of mode (RFC §5.5).
  // Author plumbed through (AISDLC-115.6) so `cli-dor-stats --by-author`
  // can attribute admit / needs-clarification rates without spelunking the
  // issue snapshot. `created_by` is the Backlog frontmatter field; absent
  // entries land in the `(unknown)` bucket — that's fine.
  const calib = appendCalibrationEntry(
    {
      issue: { id: taskId, source: 'backlog', title: input.title, body },
      verdict,
      outcome: verdict.overallVerdict,
      ...(createdBy ? { author: createdBy } : {}),
    },
    opts.artifactsDir ? { artifactsDir: opts.artifactsDir } : {},
  );

  const posts: PostResult[] = [];
  if (verdict.overallVerdict === 'needs-clarification' && opts.posters) {
    const composed = renderClarificationComment(verdict);
    posts.push(...(await fanoutPost(opts.posters, composed, config.notifications)));
  }

  // Per RFC §10 evaluation modes: 'warn-only' posts comments + flags
  // but does NOT block execution; 'enforce' refuses execution on a
  // needs-clarification verdict.
  const shouldRefuseExecution =
    config.evaluationMode === 'enforce' && verdict.overallVerdict === 'needs-clarification';

  return {
    taskId,
    verdict,
    posts,
    shouldRefuseExecution,
    evaluationMode: config.evaluationMode,
    calibrationLogPath: calib.path,
  };
}

/**
 * Compose the human-readable refusal message printed by `/ai-sdlc execute`
 * when the shim returns `shouldRefuseExecution: true` (per RFC §7.3 + Phase
 * 4 / AISDLC-115.5). The message MUST name the offending gates AND point
 * the operator at the DoR clarification comment so they can resolve
 * without spelunking through the task file.
 *
 * `commentLink` is optional so callers without a known link (Backlog
 * shim renders the comment inline; GitHub shim has a permalink) can omit
 * it and surface the marker fallback.
 */
export function refusalMessage(
  taskId: string,
  verdict: RefinementVerdict,
  opts: { commentLink?: string } = {},
): string {
  const failed = verdict.gates
    .filter((g) => g.verdict === 'fail' && g.severity === 'block')
    .map((g) => `Gate ${g.gateId}`)
    .join(', ');
  const link =
    opts.commentLink ??
    `the DoR clarification comment in this issue (look for the '<!-- ai-sdlc:dor-comment -->' marker)`;
  return [
    `Refused: ${taskId} is in Needs Clarification (blocks: ${failed || 'unknown'}).`,
    `Address the questions in ${link}, then re-run.`,
  ].join('\n');
}

/** Re-export defaults so callers don't need a second import path. */
export { DOR_CONFIG_DEFAULTS };
