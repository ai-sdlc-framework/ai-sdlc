/**
 * `cli-capture` — RFC-0024 emergent issue capture CLI.
 *
 * Provides operator and AI-agent surfaces for filing, listing, redacting,
 * and querying capture records.
 *
 * **State machine (OQ-1 / AISDLC-320 Refit Phase 1):**
 *   Draft → `.ai-sdlc/captures-drafts/<id>.md`   (operator-local, gitignored)
 *   Submitted → `backlog/captures/<id>.md`        (team-shared, tracked in git)
 *   Legacy → `$ARTIFACTS_DIR/_captures/<id>.jsonl` (pre-refit, backward-compat)
 *
 * Subcommands:
 *   file                    — record a new draft capture (the primary path)
 *   submit <id>             — promote a draft to team-shared
 *   submit-all              — bulk promote all drafts
 *   discard <id>            — hard-delete a draft (refuses on submitted captures)
 *   list                    — list captures across all sources
 *   redact <id>             — scrub finding text (preserve audit trail)
 *   against-current-pr      — file a draft auto-detecting the current PR
 *   triage <id>             — apply a triage decision to a legacy pending capture
 *   migrate-legacy          — move legacy JSONL captures to backlog/captures/
 *   parse-pr-comments <pr>  — scan a PR's review comments for capture markers
 *   lint-file <path>        — scan a source file for in-code capture markers
 *   help-triage             — print the triage rubric table
 *
 * Feature flag: `AI_SDLC_EMERGENT_CAPTURE`. When unset, the CLI exits with a
 * "not enabled" message and instructions to set the flag. Set to any truthy
 * value (`1`, `true`, `yes`, `on`, `experimental`) to enable.
 *
 * @module cli/capture
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';

import {
  VALID_SEVERITIES,
  VALID_TRIAGE_VALUES,
  generateCaptureId,
  isTerminalTriage,
  validateCaptureRecord,
  type AgentRole,
  type AuditEntry,
  type CaptureRecord,
  type CaptureSeverity,
  type CaptureTriageValue,
} from '../capture/capture-record.js';
import { loadCaptures } from '../capture/capture-reader.js';
import { applyTriageUpdate, redactCapture } from '../capture/capture-writer.js';
import {
  autoTriageCapture,
  autoInferSeverity,
  decorateCapturedAuditEntry,
} from '../capture/auto-triage.js';
import { loadConfiguredInvoker } from '../capture/invoker-loader.js';
import {
  writeDraftCaptureFile,
  writeSubmittedCaptureFile,
  submitDraft,
  submitAllDrafts,
  discardDraft,
  loadDraftCaptures,
  loadSubmittedCaptures,
  migrateLegacyCaptures,
  redactSubmittedCapture,
  SubmittedCaptureNotFoundError,
  getAutoSubmitThreshold,
  resolveRepoRoot,
} from '../capture/draft-capture.js';
import { findCaptureComments } from '../capture/pr-comment-parser.js';
import {
  appendCaptureMarkerToComment,
  classifyPrCommentsBatch,
  PR_COMMENT_DEFAULT_THRESHOLD,
  type ClassifyPrCommentsBatchResult,
} from '../capture/pr-comment-classifier.js';
import {
  parseIncodeMarkers,
  markersToWarnings,
  renderLinterWarnings,
} from '../capture/incode-linter.js';
import { renderRubricTable, getRubricEntry } from '../capture/triage-rubric.js';

// ── Feature flag ──────────────────────────────────────────────────────────────

const TRUTHY_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on', 'experimental']);

function isFeatureFlagEnabled(): boolean {
  const val = process.env.AI_SDLC_EMERGENT_CAPTURE ?? '';
  return TRUTHY_FLAG_VALUES.has(val.toLowerCase());
}

function requireFeatureFlag(): void {
  if (!isFeatureFlagEnabled()) {
    process.stderr.write(
      '[cli-capture] emergent capture is not enabled.\n' +
        'Set AI_SDLC_EMERGENT_CAPTURE=experimental to enable.\n' +
        'See spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md §14 for details.\n',
    );
    process.exit(1);
  }
}

// ── Output helpers ────────────────────────────────────────────────────────────

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

// ── Render classifier batch (RFC-0024 Refit Phase 4) ─────────────────────────

/**
 * Render a batch of `classifyPrCommentsBatch` results to stdout. Exported
 * so the post-stdin orchestration helpers + tests can drive the renderer
 * directly without rebuilding the yargs argv envelope.
 */
export function renderClassifierBatch(
  batch: readonly ClassifyPrCommentsBatchResult[],
  format: string,
): void {
  if (format === 'table') {
    if (batch.length === 0) {
      emitText('(no comments to classify)');
      return;
    }
    for (const { comment, decision } of batch) {
      const author = comment.author?.login ?? 'unknown';
      const url = comment.url ?? '(no url)';
      const headline =
        decision.kind === 'marker'
          ? `marker (severity=${decision.severity ?? '(unset)'}, triage=${decision.triage ?? '(unset)'})`
          : decision.kind === 'ai-agent'
            ? 'ai-agent bypass'
            : decision.kind === 'classified-capture'
              ? `classified-capture (confidence=${decision.decision.confidence})`
              : decision.kind === 'classified-skip'
                ? `classified-skip (${decision.reason})`
                : `already-linked (${decision.existingCaptureId})`;
      emitText(`${headline}\n  author: ${author}\n  url: ${url}\n`);
    }
    return;
  }
  emit({
    results: batch.map(({ comment, decision }) => ({
      comment: {
        author: comment.author?.login,
        url: comment.url,
        prNumber: comment.prNumber,
      },
      decision,
    })),
  });
}

// ── Stdin reader (shared by stdin-driven subcommands) ───────────────────────

/**
 * Read all available bytes from stdin synchronously and return them as a
 * utf-8 string. Used by `parse-pr-comments` and `append-capture-marker`
 * (both of which consume a JSON document piped via stdin).
 *
 * Uses `readSync(fd=0)` rather than the streaming `process.stdin` API so the
 * yargs handler can `await` a single result instead of attaching a `data`
 * listener — the latter races with the yargs handler's own resolution and
 * loses input on small payloads.
 *
 * **Hermetic-test caveat**: `readSync(0,...)` blocks on the TTY inherited
 * into vitest worker_threads. This function is therefore only exercised by
 * the bin-shim subprocess path in production / `bin/cli-capture.mjs`. The
 * post-stdin orchestration (parse JSON, call helpers, emit) is in the
 * exported `runParsePrCommentsHandler` / `runAppendCaptureMarkerHandler`
 * functions below — drive those directly to test the orchestration.
 *
 * Tests may inject a stub via `setStdinReaderForTesting()`.
 */
export async function readAllStdinSync(): Promise<string> {
  const { readSync } = await import('node:fs');
  const fd0 = 0;
  const chunks: Buffer[] = [];
  const chunkBuf = Buffer.alloc(65536);
  let bytesRead: number;
  do {
    try {
      bytesRead = readSync(fd0, chunkBuf, 0, chunkBuf.length, null);
      if (bytesRead > 0) chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
    } catch {
      break;
    }
  } while (bytesRead > 0);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Module-level stdin reader pointer. The yargs subcommand handlers call
 * `stdinReader()` rather than `readAllStdinSync()` directly so tests can
 * inject a deterministic fake. Production code paths leave it pointing at
 * the real `readAllStdinSync`.
 */
let stdinReader: () => Promise<string> = readAllStdinSync;

/**
 * Test hook — override the stdin reader the yargs subcommands use. Pass
 * `null` to restore the production default. Exposed so the in-process
 * vitest suite can drive the full yargs argv path through
 * `parse-pr-comments` / `append-capture-marker` without blocking on the
 * inherited TTY.
 */
export function setStdinReaderForTesting(reader: (() => Promise<string>) | null): void {
  stdinReader = reader ?? readAllStdinSync;
}

// ── Post-stdin handlers (RFC-0024 Refit Phase 4) ─────────────────────────────
//
// The two subcommands `parse-pr-comments` and `append-capture-marker` read
// their input from stdin in production. The stdin-read uses `readSync(fd=0)`
// from `node:fs`, which blocks on the inherited TTY in vitest worker_threads
// and can't be stubbed (the property is non-configurable). The handlers
// below take the already-read JSON string, do the parse + orchestration,
// and emit to stdout/stderr — that's the surface tests can drive.

/**
 * Post-stdin orchestration for `parse-pr-comments`. Parses the JSON,
 * routes to the legacy `findCaptureComments` path or the RFC-0024 Refit
 * Phase 4 `classifyPrCommentsBatch` path based on `classify`, and renders.
 *
 * Exits the process via `process.exit(1)` on invalid JSON (matches the
 * inline handler's behavior so the CLI semantics are unchanged).
 */
export async function runParsePrCommentsHandler(opts: {
  input: string;
  classify: boolean;
  threshold?: number;
  format: string;
}): Promise<void> {
  let comments: Array<{
    body: string;
    author?: { login: string };
    url?: string;
    prNumber?: number;
    databaseId?: number;
  }>;
  try {
    comments = JSON.parse(opts.input.trim());
  } catch {
    process.stderr.write('[cli-capture] parse-pr-comments: invalid JSON on stdin\n');
    process.exit(1);
  }

  if (opts.classify === true) {
    const batch = await classifyPrCommentsBatch(comments, {
      threshold: opts.threshold,
      // Pass repoRoot so the classifier's corpus writes land under the
      // $CAPTURE_REPO_ROOT-scoped dir rather than process.cwd() (AISDLC-518).
      repoRoot: resolveRepoRoot(),
    });
    renderClassifierBatch(batch, opts.format);
    return;
  }

  const found = findCaptureComments(comments);

  if (opts.format === 'table') {
    if (found.length === 0) {
      emitText('(no ai-sdlc:capture markers found in PR comments)');
    } else {
      for (const { comment, marker } of found) {
        emitText(
          `marker found:\n` +
            `  author: ${comment.author?.login ?? 'unknown'}\n` +
            `  severity: ${marker.severity ?? '(not set)'}\n` +
            `  triage: ${marker.triage ?? '(not set)'}\n` +
            `  finding: ${marker.finding}\n`,
        );
      }
    }
  } else {
    emit({ found: found.map(({ comment, marker }) => ({ comment, marker })) });
  }
}

/**
 * Post-stdin orchestration for `append-capture-marker`. Parses the JSON,
 * validates the `{body, captureId}` shape, calls
 * `appendCaptureMarkerToComment`, and renders.
 *
 * Exits the process via `process.exit(1)` on invalid JSON or shape (matches
 * the inline handler's behavior).
 */
export function runAppendCaptureMarkerHandler(opts: { input: string; format: string }): void {
  let payload: { body?: unknown; captureId?: unknown };
  try {
    payload = JSON.parse(opts.input.trim());
  } catch {
    process.stderr.write('[cli-capture] append-capture-marker: invalid JSON on stdin\n');
    process.exit(1);
  }

  if (typeof payload.body !== 'string' || typeof payload.captureId !== 'string') {
    process.stderr.write(
      '[cli-capture] append-capture-marker: stdin must be {body:string, captureId:string}\n',
    );
    process.exit(1);
  }

  const result = appendCaptureMarkerToComment(payload.body, payload.captureId);

  if (opts.format === 'text') {
    process.stdout.write(result.body);
  } else {
    emit(result);
  }
}

// ── Detect current PR number from git branch + gh CLI ─────────────────────────

async function detectCurrentPrNumberReal(): Promise<number | null> {
  try {
    const { spawnSync } = await import('node:child_process');
    const branchResult = spawnSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const branch = branchResult.stdout?.trim();
    if (!branch) return null;

    const prResult = spawnSync(
      'gh',
      ['pr', 'list', '--head', branch, '--json', 'number', '--limit', '1'],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    if (prResult.status !== 0) return null;
    const parsed = JSON.parse(prResult.stdout.trim()) as Array<{ number: number }>;
    return parsed[0]?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * Module-level PR detector pointer. The `against-current-pr` handler calls
 * `prDetector()` rather than `detectCurrentPrNumberReal()` directly so tests
 * can inject a deterministic stub. Production code leaves it pointing at the
 * real implementation.
 */
let prDetector: () => Promise<number | null> = detectCurrentPrNumberReal;

/**
 * Test hook — override the PR detector the `against-current-pr` subcommand
 * uses. Pass `null` to restore the production default.
 */
export function setPrDetectorForTesting(detector: (() => Promise<number | null>) | null): void {
  prDetector = detector ?? detectCurrentPrNumberReal;
}

async function detectCurrentPrNumber(): Promise<number | null> {
  return prDetector();
}

// ── Resolve operator identity ─────────────────────────────────────────────────

async function resolveOperatorIdentityReal(override?: string): Promise<string> {
  if (override) return override;
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: 'pipe' });
    return r.stdout?.trim() || process.env.USER || 'unknown';
  } catch {
    return process.env.USER || 'unknown';
  }
}

/**
 * Module-level operator identity resolver pointer. The yargs subcommand
 * handlers call `operatorResolver(override)` rather than
 * `resolveOperatorIdentityReal()` directly so tests can inject a
 * deterministic stub without spawning a real `git` process.
 * Production code leaves it pointing at the real implementation.
 */
let operatorResolver: (override?: string) => Promise<string> = resolveOperatorIdentityReal;

/**
 * Test hook — override the operator identity resolver. Pass `null` to restore
 * the production default.
 */
export function setOperatorResolverForTesting(
  resolver: ((override?: string) => Promise<string>) | null,
): void {
  operatorResolver = resolver ?? resolveOperatorIdentityReal;
}

async function resolveOperatorIdentity(override?: string): Promise<string> {
  return operatorResolver(override);
}

// ── Render table ──────────────────────────────────────────────────────────────

function renderCaptureTable(records: CaptureRecord[], skippedFiles: number): void {
  if (records.length === 0) {
    emitText('(no captures found)');
    return;
  }

  const rows = records.map((r) => ({
    id: r.id.slice(0, 24),
    timestamp: r.timestamp.slice(0, 10),
    severity: r.severity,
    triage: r.triage,
    finding: r.finding.length > 60 ? r.finding.slice(0, 57) + '...' : r.finding,
  }));
  const headers = ['id', 'timestamp', 'severity', 'triage', 'finding'] as const;
  const widths = headers.map((h) => Math.max(h.length, ...rows.map((r) => (r[h] ?? '').length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const lines = [
    fmt(headers as unknown as string[]),
    sep,
    ...rows.map((r) => fmt(headers.map((h) => r[h]))),
  ];
  emitText(lines.join('\n'));
  if (skippedFiles > 0) {
    emitText(`\n(${skippedFiles} file(s) skipped — corrupt or unreadable)`);
  }
}

// ── CLI builder ───────────────────────────────────────────────────────────────

export function buildCaptureCli(): Argv {
  return (
    yargs(hideBin(process.argv))
      .scriptName('cli-capture')
      .usage('Usage: $0 <command> [options]\n\nRFC-0024 emergent issue capture CLI.')
      // ── file ──────────────────────────────────────────────────────────────────
      .command(
        'file <finding>',
        'Record a new draft capture (primary operator path). Writes to .ai-sdlc/captures-drafts/ by default.',
        (y) =>
          y
            .positional('finding', {
              type: 'string',
              demandOption: true,
              describe: 'One-line description of the emergent issue.',
            })
            .option('severity', {
              alias: 's',
              type: 'string',
              choices: VALID_SEVERITIES as unknown as string[],
              default: 'unknown',
              describe: 'Severity estimate at capture time.',
            })
            .option('triage', {
              alias: 't',
              type: 'string',
              choices: VALID_TRIAGE_VALUES as unknown as string[],
              default: 'tbd',
              describe: 'Initial triage disposition. Default: tbd (decide later in TUI).',
            })
            .option('context', {
              alias: 'c',
              type: 'string',
              describe: 'Free-text context: what you were doing when this surfaced.',
            })
            .option('file-path', {
              type: 'string',
              describe: 'Repo-relative path to the file where the finding was observed.',
            })
            .option('line', {
              type: 'number',
              describe: '1-based line number within --file-path.',
            })
            .option('pr', {
              type: 'number',
              describe: 'GitHub PR number if the finding originated in a PR.',
            })
            .option('blocks-issue', {
              type: 'string',
              describe:
                'Issue ID gated by this finding (triggers decision-deferred handoff in orchestrator).',
            })
            .option('related-issue', {
              type: 'string',
              describe: 'Adapter-native issue ID this capture is filed against.',
            })
            .option('json', {
              type: 'string',
              describe:
                'Machine-readable JSON input for AI-agent direct-capture path (AC#4). ' +
                'Pass a JSON string with the same fields. Other flags are ignored when this is set. ' +
                'Include "confidence" (0–1) for OQ-2 auto-submit gate. ' +
                'Set "autoClassify": true to invoke the classifier substrate for missing triage/severity ' +
                '(AISDLC-275; requires AI_SDLC_CLASSIFIER_INVOKER_MODULE).',
            })
            .option('operator', {
              type: 'string',
              describe: 'Operator email/login. Defaults to $USER or git config user.email.',
            })
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'json',
            }),
        async (argv) => {
          requireFeatureFlag();
          const repoRoot = resolveRepoRoot();

          // AC#4 — AI-agent direct-capture path via --json.
          if (argv.json) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(String(argv.json));
            } catch {
              process.stderr.write('[cli-capture] --json: invalid JSON\n');
              process.exit(1);
            }
            const finding = typeof parsed.finding === 'string' ? parsed.finding : '';
            if (!finding) {
              process.stderr.write('[cli-capture] --json: "finding" field is required\n');
              process.exit(1);
            }

            const now = new Date();
            const id = generateCaptureId(now);
            const timestamp = now.toISOString();
            const explicitTriage = parsed.triage as CaptureTriageValue | undefined;
            const explicitSeverity = parsed.severity as CaptureSeverity | undefined;
            const agentRoleVal = (parsed.agentRole as AgentRole) ?? null;

            // AISDLC-275 (RFC-0024 Refit Phase 3) — threshold-gated
            // auto-triage + auto-severity. Only fires when (a) the
            // caller opted in via `autoClassify: true`, (b) the field
            // wasn't already supplied, and (c) the substrate's invoker
            // module is resolvable. Each step falls open gracefully
            // (silent no-op) so this never breaks the existing CLI
            // contract.
            let autoTriageVal: CaptureTriageValue | null = null;
            let autoSeverityVal: CaptureSeverity | null = null;
            let triageCorpusEntryId: string | null = null;
            let severityCorpusEntryId: string | null = null;
            let triageConfidence: number | null = null;
            let severityConfidence: number | null = null;

            if (parsed.autoClassify === true) {
              const invoker = await loadConfiguredInvoker({ repoRoot });
              if (invoker) {
                // Triage arc: only run when no explicit triage was supplied.
                if (!explicitTriage) {
                  try {
                    const triageResult = await autoTriageCapture({
                      finding,
                      agentRole: agentRoleVal,
                      repoRoot,
                      invoker,
                      context:
                        typeof parsed.context === 'string'
                          ? { sourceContext: parsed.context }
                          : undefined,
                    });
                    triageCorpusEntryId = triageResult.corpusEntryId;
                    triageConfidence = triageResult.confidence;
                    if (triageResult.metBehindThreshold && triageResult.recommendedTriage) {
                      autoTriageVal = triageResult.recommendedTriage;
                    }
                  } catch (err) {
                    // autoTriageCapture never throws in practice (substrate
                    // falls open), but defensively swallow here so a bug in
                    // a future invoker doesn't break capture filing.
                    process.stderr.write(
                      `[cli-capture] auto-triage skipped: ${(err as Error).message}\n`,
                    );
                  }
                }
                // Severity arc: only run when severity is unset or 'unknown'.
                if (!explicitSeverity || explicitSeverity === 'unknown') {
                  try {
                    const sevResult = await autoInferSeverity({
                      finding,
                      agentRole: agentRoleVal,
                      repoRoot,
                      invoker,
                      context:
                        typeof parsed.context === 'string'
                          ? { sourceContext: parsed.context }
                          : undefined,
                    });
                    severityCorpusEntryId = sevResult.corpusEntryId;
                    severityConfidence = sevResult.confidence;
                    if (sevResult.metBehindThreshold && sevResult.recommendedSeverity) {
                      autoSeverityVal = sevResult.recommendedSeverity;
                    }
                  } catch (err) {
                    process.stderr.write(
                      `[cli-capture] auto-severity skipped: ${(err as Error).message}\n`,
                    );
                  }
                }
              }
            }

            const triageVal: CaptureTriageValue = explicitTriage ?? autoTriageVal ?? 'tbd';
            const severityVal: CaptureSeverity = explicitSeverity ?? autoSeverityVal ?? 'unknown';

            const capturedEntry: AuditEntry = {
              action: 'captured',
              by: (parsed.agentRole as string) ?? 'unknown',
              at: timestamp,
            };
            decorateCapturedAuditEntry(capturedEntry, {
              triageCorpusEntryId,
              severityCorpusEntryId,
            });
            if (triageConfidence !== null) {
              capturedEntry.triageConfidence = triageConfidence;
            }
            if (severityConfidence !== null) {
              capturedEntry.severityConfidence = severityConfidence;
            }
            if (autoTriageVal) capturedEntry.triageAutoApplied = true;
            if (autoSeverityVal) capturedEntry.severityAutoApplied = true;

            const record: CaptureRecord = {
              id,
              schemaVersion: 'v1',
              timestamp,
              finding,
              severity: severityVal,
              triage: triageVal,
              source: {
                type: 'ai-agent',
                agentRole: agentRoleVal,
                operator: null,
                context: typeof parsed.context === 'string' ? parsed.context : undefined,
              },
              evidence: {
                filePath: typeof parsed.evidenceFile === 'string' ? parsed.evidenceFile : null,
                line: typeof parsed.evidenceLine === 'number' ? parsed.evidenceLine : null,
                prNumber: typeof parsed.prNumber === 'number' ? parsed.prNumber : null,
                additionalContext:
                  typeof parsed.additionalContext === 'string'
                    ? parsed.additionalContext
                    : undefined,
              },
              relatedIssueId:
                typeof parsed.relatedIssueId === 'string' ? parsed.relatedIssueId : null,
              extensionTargetIssueId: null,
              featureIssueCarveRef: null,
              blocksIssueId: typeof parsed.blocksIssueId === 'string' ? parsed.blocksIssueId : null,
              createdIssueId: null,
              createdFeatureIssueId: null,
              resolvedAt: isTerminalTriage(triageVal) ? timestamp : null,
              resolvedBy: isTerminalTriage(triageVal)
                ? ((parsed.agentRole as string) ?? 'unknown')
                : null,
              auditTrail: [capturedEntry],
            };

            const validErr = validateCaptureRecord(record);
            if (validErr) {
              process.stderr.write(`[cli-capture] invalid record: ${validErr}\n`);
              process.exit(1);
            }

            // OQ-2 gate (legacy `confidence` field): if the caller
            // supplied an explicit numeric confidence, that drives
            // auto-submit. When auto-classify is on AND the triage
            // recommendation cleared the threshold, we also auto-submit
            // — the explicit `confidence` field is the legacy contract
            // and the auto-triage path is its successor.
            const explicitConfidence =
              typeof parsed.confidence === 'number' ? parsed.confidence : null;
            const threshold = getAutoSubmitThreshold(repoRoot);
            const autoSubmitOnClassify = autoTriageVal !== null || autoSeverityVal !== null;
            const autoSubmitOnConfidence =
              explicitConfidence !== null && explicitConfidence >= threshold;

            if (autoSubmitOnClassify || autoSubmitOnConfidence) {
              writeSubmittedCaptureFile(record, repoRoot);
            } else {
              writeDraftCaptureFile(record, repoRoot);
            }

            emit(record);
            return;
          }

          // Operator capture path.
          const operator = await resolveOperatorIdentity(argv.operator as string | undefined);

          const now = new Date();
          const id = generateCaptureId(now);
          const timestamp = now.toISOString();
          const triageVal = (argv.triage as CaptureTriageValue) ?? 'tbd';

          const record: CaptureRecord = {
            id,
            schemaVersion: 'v1',
            timestamp,
            finding: String(argv.finding),
            severity: (argv.severity as CaptureSeverity) ?? 'unknown',
            triage: triageVal,
            source: {
              type: 'operator',
              agentRole: null,
              operator,
              context: argv.context as string | undefined,
            },
            evidence: {
              filePath: (argv['file-path'] as string | undefined) ?? null,
              line: (argv.line as number | undefined) ?? null,
              prNumber: (argv.pr as number | undefined) ?? null,
            },
            relatedIssueId: (argv['related-issue'] as string | undefined) ?? null,
            extensionTargetIssueId: null,
            featureIssueCarveRef: null,
            blocksIssueId: (argv['blocks-issue'] as string | undefined) ?? null,
            createdIssueId: null,
            createdFeatureIssueId: null,
            resolvedAt: isTerminalTriage(triageVal) ? timestamp : null,
            resolvedBy: isTerminalTriage(triageVal) ? operator : null,
            auditTrail: [
              {
                action: 'captured',
                by: operator,
                at: timestamp,
              },
            ],
          };

          const validErr = validateCaptureRecord(record);
          if (validErr) {
            process.stderr.write(`[cli-capture] invalid record: ${validErr}\n`);
            process.exit(1);
          }

          // Operator captures always go to draft (OQ-1).
          writeDraftCaptureFile(record, repoRoot);

          if (String(argv.format) === 'table') {
            emitText(
              `capture filed: ${record.id}\n` +
                `  finding: ${record.finding}\n` +
                `  severity: ${record.severity}\n` +
                `  triage: ${record.triage}\n` +
                `  state: draft (.ai-sdlc/captures-drafts/${record.id}.md)\n`,
            );
          } else {
            emit(record);
          }
        },
      )
      // ── submit ────────────────────────────────────────────────────────────────
      .command(
        'submit <id>',
        'Promote a draft capture to team-shared (backlog/captures/<id>.md).',
        (y) =>
          y
            .positional('id', {
              type: 'string',
              demandOption: true,
              describe: 'Draft capture ID to submit.',
            })
            .option('by', {
              type: 'string',
              describe: 'Who is submitting. Defaults to git config user.email.',
            })
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'json',
            }),
        async (argv) => {
          requireFeatureFlag();

          const by = await resolveOperatorIdentity(argv.by as string | undefined);
          const repoRoot = resolveRepoRoot();

          const submitted = submitDraft({
            captureId: String(argv.id),
            by,
            repoRoot,
          });

          if (String(argv.format) === 'table') {
            emitText(
              `submitted: ${submitted.id}\n` +
                `  finding: ${submitted.finding}\n` +
                `  state: submitted (backlog/captures/${submitted.id}.md)\n`,
            );
          } else {
            emit(submitted);
          }
        },
      )
      // ── submit-all ────────────────────────────────────────────────────────────
      .command(
        'submit-all',
        'Bulk-promote all draft captures to team-shared.',
        (y) =>
          y
            .option('by', {
              type: 'string',
              describe: 'Who is submitting. Defaults to git config user.email.',
            })
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'table',
            }),
        async (argv) => {
          requireFeatureFlag();

          const by = await resolveOperatorIdentity(argv.by as string | undefined);
          const repoRoot = resolveRepoRoot();

          const result = submitAllDrafts({ by, repoRoot });

          if (String(argv.format) === 'json') {
            emit(result);
            return;
          }

          if (result.submitted.length === 0 && result.failed.length === 0) {
            emitText('(no drafts to submit)');
            return;
          }

          emitText(
            `submitted ${result.submitted.length} capture(s); ${result.failed.length} failed.\n`,
          );
          for (const id of result.submitted) {
            emitText(`  ✓ ${id}`);
          }
          for (const { id, error } of result.failed) {
            emitText(`  ✗ ${id}: ${error}`);
          }
        },
      )
      // ── discard ───────────────────────────────────────────────────────────────
      .command(
        'discard <id>',
        'Hard-delete a draft capture (refuses on submitted captures — use redact instead).',
        (y) =>
          y
            .positional('id', {
              type: 'string',
              demandOption: true,
              describe: 'Draft capture ID to discard.',
            })
            .option('reason', {
              alias: 'r',
              type: 'string',
              demandOption: true,
              describe: 'Reason for discarding (required).',
            })
            .option('by', {
              type: 'string',
              describe: 'Who is discarding. Defaults to git config user.email.',
            }),
        async (argv) => {
          requireFeatureFlag();

          const by = await resolveOperatorIdentity(argv.by as string | undefined);
          const repoRoot = resolveRepoRoot();

          discardDraft({
            captureId: String(argv.id),
            reason: String(argv.reason),
            by,
            repoRoot,
          });

          emitText(`discarded: ${argv.id}\n  reason: ${argv.reason}\n  by: ${by}`);
        },
      )
      // ── list ──────────────────────────────────────────────────────────────────
      .command(
        'list',
        'List capture records from all sources (drafts, submitted, legacy).',
        (y) =>
          y
            .option('triage', {
              type: 'string',
              choices: VALID_TRIAGE_VALUES as unknown as string[],
              describe: 'Filter by triage value.',
            })
            .option('pending', {
              type: 'boolean',
              default: false,
              describe: 'Show only captures with triage=tbd.',
            })
            .option('source', {
              type: 'string',
              choices: ['all', 'drafts', 'submitted', 'legacy'] as const,
              default: 'all',
              describe:
                'Which source(s) to include. "all" = drafts + submitted + legacy (backward-compat).',
            })
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'table',
            }),
        (argv) => {
          requireFeatureFlag();

          const filterOpts = {
            triage: argv.triage as CaptureTriageValue | undefined,
            pendingOnly: argv.pending,
          };
          const repoRoot = resolveRepoRoot();
          const source = String(argv.source);

          let allRecords: CaptureRecord[] = [];
          let totalSkipped = 0;

          // AISDLC-320 review fix: load submitted FIRST so submitted wins on dedup.
          // submitDraft is write-then-delete (not atomic); a crash between those
          // steps leaves both files on disk. Always prefer submitted over draft so
          // operators see the audit trail rather than a stale `triage=tbd` draft.
          if (source === 'all' || source === 'submitted') {
            const s = loadSubmittedCaptures({ ...filterOpts, repoRoot });
            allRecords = allRecords.concat(s.records);
            totalSkipped += s.skippedFiles;
          }
          if (source === 'all' || source === 'drafts') {
            const d = loadDraftCaptures({ ...filterOpts, repoRoot });
            allRecords = allRecords.concat(d.records);
            totalSkipped += d.skippedFiles;
          }
          if (source === 'all' || source === 'legacy') {
            // AC-7 backward-compat: legacy $ARTIFACTS_DIR/_captures/ captures.
            const l = loadCaptures({ ...filterOpts });
            allRecords = allRecords.concat(l.records);
            totalSkipped += l.skippedFiles;
          }

          // Deduplicate by ID — first occurrence wins, so submitted beats draft.
          const seen = new Set<string>();
          const deduped = allRecords.filter((r) => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
          });

          // Sort by timestamp ascending.
          deduped.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

          if (String(argv.format) === 'json') {
            emit({ records: deduped, skippedFiles: totalSkipped });
            return;
          }

          renderCaptureTable(deduped, totalSkipped);
        },
      )
      // ── redact ────────────────────────────────────────────────────────────────
      .command(
        'redact <id>',
        'Scrub the finding text from a capture (preserve audit trail). OQ-7 resolution.',
        (y) =>
          y
            .positional('id', {
              type: 'string',
              demandOption: true,
              describe: 'Capture ID to redact.',
            })
            .option('reason', {
              alias: 'r',
              type: 'string',
              demandOption: true,
              describe: 'Reason for redaction (required).',
            })
            .option('by', {
              type: 'string',
              describe: 'Who is redacting. Defaults to git config user.email.',
            }),
        async (argv) => {
          requireFeatureFlag();

          const redactedBy = await resolveOperatorIdentity(argv.by as string | undefined);
          const captureId = String(argv.id);
          const repoRoot = resolveRepoRoot();

          // Try submitted captures first, then fall back to legacy JSONL.
          // AISDLC-320 review fix: use SubmittedCaptureNotFoundError instanceof
          // check rather than fragile message-string matching, so future
          // refactors of either redact error string don't silently break the
          // fallback path.
          try {
            const updated = redactSubmittedCapture({
              captureId,
              reason: String(argv.reason),
              redactedBy,
              repoRoot,
            });
            emit(updated);
            return;
          } catch (e1) {
            // Not a submitted capture — try legacy JSONL.
            if (!(e1 instanceof SubmittedCaptureNotFoundError)) {
              throw e1;
            }
          }

          // Legacy JSONL path.
          const updated = redactCapture({
            captureId,
            reason: String(argv.reason),
            redactedBy,
          });
          emit(updated);
        },
      )
      // ── against-current-pr ────────────────────────────────────────────────────
      .command(
        'against-current-pr',
        'File a draft capture auto-detecting the current PR from the active git branch (RFC-0024 §OQ-12).',
        (y) =>
          y
            .option('finding', {
              alias: 'f',
              type: 'string',
              demandOption: true,
              describe: 'One-line description of the emergent issue.',
            })
            .option('severity', {
              alias: 's',
              type: 'string',
              choices: VALID_SEVERITIES as unknown as string[],
              default: 'unknown',
            })
            .option('triage', {
              alias: 't',
              type: 'string',
              choices: VALID_TRIAGE_VALUES as unknown as string[],
              default: 'tbd',
            })
            .option('context', {
              alias: 'c',
              type: 'string',
              describe: 'Free-text context.',
            })
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'json',
            }),
        async (argv) => {
          requireFeatureFlag();

          const prNumber = await detectCurrentPrNumber();
          const operator = await resolveOperatorIdentity(undefined);
          const repoRoot = resolveRepoRoot();

          const now = new Date();
          const id = generateCaptureId(now);
          const timestamp = now.toISOString();
          const triageVal = (argv.triage as CaptureTriageValue) ?? 'tbd';

          const record: CaptureRecord = {
            id,
            schemaVersion: 'v1',
            timestamp,
            finding: String(argv.finding),
            severity: (argv.severity as CaptureSeverity) ?? 'unknown',
            triage: triageVal,
            source: {
              type: 'operator',
              agentRole: null,
              operator,
              context: argv.context
                ? String(argv.context)
                : prNumber
                  ? `filed against PR #${prNumber}`
                  : 'filed from active branch (no PR detected)',
            },
            evidence: { prNumber },
            relatedIssueId: null,
            extensionTargetIssueId: null,
            featureIssueCarveRef: null,
            blocksIssueId: null,
            createdIssueId: null,
            createdFeatureIssueId: null,
            resolvedAt: isTerminalTriage(triageVal) ? timestamp : null,
            resolvedBy: isTerminalTriage(triageVal) ? operator : null,
            auditTrail: [{ action: 'captured', by: operator, at: timestamp }],
          };

          // Operator captures always go to draft.
          writeDraftCaptureFile(record, repoRoot);

          if (String(argv.format) === 'table') {
            emitText(
              `capture filed: ${record.id}\n` +
                `  pr: ${prNumber ?? '(not detected)'}\n` +
                `  finding: ${record.finding}\n` +
                `  state: draft (.ai-sdlc/captures-drafts/${record.id}.md)\n`,
            );
          } else {
            emit(record);
          }
        },
      )
      // ── triage ────────────────────────────────────────────────────────────────
      .command(
        'triage <id>',
        'Apply a triage decision to a legacy pending capture (triage=tbd → terminal value).',
        (y) =>
          y
            .positional('id', {
              type: 'string',
              demandOption: true,
              describe: 'Capture ID to triage.',
            })
            .option('to', {
              alias: 't',
              type: 'string',
              choices: VALID_TRIAGE_VALUES.filter((v) => v !== 'tbd') as unknown as string[],
              demandOption: true,
              describe: 'Target triage disposition (must be a terminal value).',
            })
            .option('by', {
              type: 'string',
              describe: 'Who is applying the triage. Defaults to git config user.email.',
            })
            .option('extension-target', {
              type: 'string',
              describe: 'Target issue ID for --to=scope-extension.',
            }),
        async (argv) => {
          requireFeatureFlag();

          const resolvedBy = await resolveOperatorIdentity(argv.by as string | undefined);
          const triage = String(argv.to) as CaptureTriageValue;
          const rubricEntry = getRubricEntry(triage);

          const updated = applyTriageUpdate({
            captureId: String(argv.id),
            triage,
            resolvedBy,
            patch: {
              extensionTargetIssueId: (argv['extension-target'] as string | undefined) ?? null,
            },
          });

          emit({
            updated,
            frameworkAction: rubricEntry.frameworkAction,
            note: 'Adapter calls (Issue creation, scope-extension, etc.) are not yet wired in v1.',
          });
        },
      )
      // ── migrate-legacy ────────────────────────────────────────────────────────
      .command(
        'migrate-legacy',
        'Move legacy JSONL captures from $ARTIFACTS_DIR/_captures/ to backlog/captures/.',
        (y) =>
          y.option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'table',
          }),
        (argv) => {
          requireFeatureFlag();

          const repoRoot = resolveRepoRoot();
          const result = migrateLegacyCaptures({ repoRoot });

          if (String(argv.format) === 'json') {
            emit(result);
            return;
          }

          if (result.migrated === 0 && result.failed === 0) {
            emitText('(no legacy captures found)');
            return;
          }

          emitText(`migrated ${result.migrated} capture(s); ${result.failed} failed.\n`);
          for (const id of result.ids) {
            emitText(`  ✓ ${id}`);
          }
        },
      )
      // ── parse-pr-comments ─────────────────────────────────────────────────────
      .command(
        'parse-pr-comments',
        "Scan a PR's review comments for ai-sdlc:capture markers (RFC-0024 §5.2). Reads JSON from stdin. Pass --classify to also run the OQ-3 LLM auto-classifier on un-marked comments (RFC-0024 Refit Phase 4 / AISDLC-276).",
        (y) =>
          y
            .option('format', {
              type: 'string',
              choices: ['json', 'table'] as const,
              default: 'json',
            })
            .option('classify', {
              type: 'boolean',
              default: false,
              describe:
                'Also run the Haiku auto-classifier on un-marked comments (RFC-0024 Refit Phase 4). Without --classify, only marker-tagged comments are returned (legacy behaviour).',
            })
            .option('threshold', {
              type: 'number',
              describe: `Per-call threshold override for --classify mode (default ${PR_COMMENT_DEFAULT_THRESHOLD}).`,
            }),
        async (argv) => {
          requireFeatureFlag();

          let input = '';
          try {
            input = await stdinReader();
          } catch {
            process.stderr.write('[cli-capture] parse-pr-comments: failed to read stdin\n');
            process.exit(1);
          }

          await runParsePrCommentsHandler({
            input,
            classify: argv.classify === true,
            threshold: argv.threshold as number | undefined,
            format: String(argv.format),
          });
        },
      )
      // ── append-capture-marker (RFC-0024 Refit Phase 4 bidirectional sync) ────
      .command(
        'append-capture-marker',
        'Append the <!-- ai-sdlc:capture-id=<id> --> footer to a PR comment body (RFC-0024 Refit Phase 4 / AISDLC-276 AC-7). Reads {body, captureId} JSON from stdin; emits {body, changed, alreadyLinked} on stdout. Idempotent — refuses to overwrite an existing different-id marker (GitHub-edit-wins per AC-6).',
        (y) =>
          y.option('format', {
            type: 'string',
            choices: ['json', 'text'] as const,
            default: 'json',
          }),
        async (argv) => {
          requireFeatureFlag();

          let input = '';
          try {
            input = await stdinReader();
          } catch {
            process.stderr.write('[cli-capture] append-capture-marker: failed to read stdin\n');
            process.exit(1);
          }

          runAppendCaptureMarkerHandler({
            input,
            format: String(argv.format),
          });
        },
      )
      // ── lint-file ─────────────────────────────────────────────────────────────
      .command(
        'lint-file <path>',
        'Scan a source file for // ai-sdlc:capture in-code markers (RFC-0024 §5.3). Non-blocking warnings.',
        (y) =>
          y
            .positional('path', {
              type: 'string',
              demandOption: true,
              describe: 'Path to the source file to scan.',
            })
            .option('format', {
              type: 'string',
              choices: ['json', 'text'] as const,
              default: 'text',
            }),
        (argv) => {
          requireFeatureFlag();

          const filePath = resolve(String(argv.path));
          let content: string;
          try {
            content = readFileSync(filePath, 'utf8');
          } catch {
            process.stderr.write(`[cli-capture] lint-file: cannot read ${filePath}\n`);
            process.exit(1);
          }

          const marks = parseIncodeMarkers(filePath, content);
          const warnings = markersToWarnings(marks);

          if (String(argv.format) === 'json') {
            emit({ warnings, count: warnings.length });
          } else {
            if (warnings.length === 0) {
              emitText('(no in-code capture markers found)');
            } else {
              process.stderr.write(renderLinterWarnings(warnings));
              emitText(`${warnings.length} in-code capture marker(s) found (non-blocking).`);
            }
          }
        },
      )
      // ── help-triage ───────────────────────────────────────────────────────────
      .command(
        'help-triage',
        'Print the triage rubric table (RFC-0024 §7).',
        () => {},
        () => {
          emitText(renderRubricTable());
        },
      )
      .demandCommand(1, 'A subcommand is required. Run `cli-capture --help` for the list.')
      .strict()
      .help()
      .alias('h', 'help')
      .version(false)
  );
}

export async function runCaptureCli(): Promise<void> {
  await buildCaptureCli().parseAsync();
}
