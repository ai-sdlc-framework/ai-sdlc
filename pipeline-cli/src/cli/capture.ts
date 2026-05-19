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
  type CaptureRecord,
  type CaptureSeverity,
  type CaptureTriageValue,
} from '../capture/capture-record.js';
import { loadCaptures } from '../capture/capture-reader.js';
import { applyTriageUpdate, redactCapture } from '../capture/capture-writer.js';
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

// ── Detect current PR number from git branch + gh CLI ─────────────────────────

async function detectCurrentPrNumber(): Promise<number | null> {
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

// ── Resolve operator identity ─────────────────────────────────────────────────

async function resolveOperatorIdentity(override?: string): Promise<string> {
  if (override) return override;
  try {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: 'pipe' });
    return r.stdout?.trim() || process.env.USER || 'unknown';
  } catch {
    return process.env.USER || 'unknown';
  }
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
                'Include "confidence" (0–1) for OQ-2 auto-submit gate.',
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
            const triageVal = (parsed.triage as CaptureTriageValue) ?? 'tbd';

            const record: CaptureRecord = {
              id,
              schemaVersion: 'v1',
              timestamp,
              finding,
              severity: (parsed.severity as CaptureSeverity) ?? 'unknown',
              triage: triageVal,
              source: {
                type: 'ai-agent',
                agentRole: (parsed.agentRole as AgentRole) ?? null,
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
              auditTrail: [
                {
                  action: 'captured',
                  by: (parsed.agentRole as string) ?? 'unknown',
                  at: timestamp,
                },
              ],
            };

            const validErr = validateCaptureRecord(record);
            if (validErr) {
              process.stderr.write(`[cli-capture] invalid record: ${validErr}\n`);
              process.exit(1);
            }

            // OQ-2 gate: confidence >= threshold → auto-submit; else draft.
            const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
            const threshold = getAutoSubmitThreshold(repoRoot);

            if (confidence !== null && confidence >= threshold) {
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
        "Scan a PR's review comments for ai-sdlc:capture markers (RFC-0024 §5.2). Reads JSON from stdin.",
        (y) =>
          y.option('format', {
            type: 'string',
            choices: ['json', 'table'] as const,
            default: 'json',
          }),
        async (argv) => {
          requireFeatureFlag();

          let input = '';
          try {
            const { readSync } = await import('node:fs');
            const fd0 = 0; // stdin fd
            const chunks: Buffer[] = [];
            const chunkBuf = Buffer.alloc(65536);
            let bytesRead = 0;
            do {
              try {
                bytesRead = readSync(fd0, chunkBuf, 0, chunkBuf.length, null);
                if (bytesRead > 0) chunks.push(Buffer.from(chunkBuf.subarray(0, bytesRead)));
              } catch {
                break;
              }
            } while (bytesRead > 0);
            input = Buffer.concat(chunks).toString('utf8');
          } catch {
            process.stderr.write('[cli-capture] parse-pr-comments: failed to read stdin\n');
            process.exit(1);
          }

          let comments: Array<{ body: string; author?: { login: string }; url?: string }>;
          try {
            comments = JSON.parse(input.trim());
          } catch {
            process.stderr.write('[cli-capture] parse-pr-comments: invalid JSON on stdin\n');
            process.exit(1);
          }

          const found = findCaptureComments(comments);

          if (String(argv.format) === 'table') {
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
