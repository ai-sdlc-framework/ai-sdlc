/**
 * `cli-attestation` — review attestation CLI.
 *
 * Subcommands:
 *   transcripts list [<task-id>]  — list captured transcripts with metadata
 *   emit-leaf                     — record one reviewer run in the reviews ledger
 *   verify                        — refuses a v6 envelope with a named error (RFC-0061)
 *   verdict-write / verdict-check — the review verdict gate
 *   reset-stack                   — drop earlier attestation chore commits (AISDLC-999)
 *
 * Output is plain text by default; transcripts list accepts `--json`.
 *
 * @module cli/attestation
 */

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defaultRunner } from '../runtime/exec.js';
import { repositoryFromRemoteUrl } from '../next-step/verdict-ref-push.js';
import {
  DEFAULT_PRUNE_AGE_DAYS,
  ghPrStateFor,
  pruneVerdictRefs,
} from '../attestation/verdict-prune.js';
import type { IndependenceTier } from '../attestation/independence-policy.js';
import { runVerdictCheck } from '../attestation/verdict-cli.js';
import {
  INDEPENDENCE_TIERS,
  verdictRefName,
  writeVerdictCommit,
} from '../attestation/verdict-record.js';
import { validateVerdictArtifact } from '../attestation/verdict-untrusted.js';
import yargs, { type Argv } from 'yargs';
import { hideBin } from 'yargs/helpers';
import {
  generateNonce,
  STAGED_LEAF_STAGES,
  STAGED_REVIEWER_NAME,
  type StagedLeafStage,
} from '../attestation/staged-review.js';
import { dropAttestationChores, type GitFn } from '../attestation/drop-chores.js';
import { V6_REFUSED_CODE, refuseAttestationEnvelope } from '../attestation/v6-refusal.js';
import {
  appendReviewLedgerRecord,
  normalizeFindings,
  normalizeReviewerRole,
} from '../attestation/reviews-ledger.js';
import { formatTranscriptTable, listTranscripts } from '../attestation/transcript-capture.js';
import { AGENT_ID_PATTERN } from '../attestation/verdict-class.js';
import { deriveReviewerSetFromGit } from '../steps/reviewer-set.js';
import { summarizeComparisonWindow } from '../steps/reviewer-set-comparison.js';
import { resolveArtifactsDir } from '../routing/artifacts-dir.js';
import { bindLeafToReviewerRun, nonceMarkerLiteral } from '../attestation/harness-transcript.js';

// ── Repo root resolution ──────────────────────────────────────────────────────

/**
 * Read the harness agent id that `persist-reviewer-artifacts.sh` records next
 * to a persisted reviewer transcript (`<name>.jsonl` -> `<name>.agent-id`).
 * Returns `undefined` when the sidecar is missing, unreadable or does not
 * hold a single well-formed id; the caller then falls back to matching the
 * marker by reviewer role.
 */
export function readAgentIdSidecar(transcriptPath: string): string | undefined {
  try {
    if (!transcriptPath.endsWith('.jsonl')) return undefined;
    const sidecar = transcriptPath.slice(0, -'.jsonl'.length) + '.agent-id';
    if (!existsSync(sidecar)) return undefined;
    if (statSync(sidecar).size > 256) return undefined;
    const value = readFileSync(sidecar, 'utf8').trim();
    return AGENT_ID_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the repo root from `--repo-root`, `REPO_ROOT` env, or `process.cwd()`.
 * The leaves file and transcripts dir are always relative to the repo root.
 */
function resolveRepoRoot(cwd?: string): string {
  return resolve(cwd ?? process.env['REPO_ROOT'] ?? process.cwd());
}

/** `git` in `cwd`, never throwing; a spawn failure is a non-zero status. */
export function gitIn(cwd: string): GitFn {
  return (args) =>
    new Promise((resolveP) => {
      execFile('git', [...args], { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? err.code : 1;
        resolveP({ status: err ? (code as number) : 0, stdout, stderr });
      });
    });
}

// ── Output helpers ────────────────────────────────────────────────────────────

function emitText(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function emitJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// ── Input validation helpers (AISDLC-391) ─────────────────────────────────────

/**
 * Validate that a string is exactly 40 lowercase-hex characters (a git commit SHA).
 * Used to guard `--head-sha` on `emit-leaf`: the nonce-binding invariant in
 * RFC-0042 requires the head SHA be well-formed; an empty or multi-line value
 * silently weakens replay resistance.
 */
function isValidHeadSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * Validate that a string is exactly 64 lowercase-hex characters — the format
 * `generateNonce()` produces. Used to guard an explicitly-passed `--nonce`
 * (AISDLC-570): when the orchestrating dispatch pre-generates a nonce and
 * embeds it in the reviewer's prompt BEFORE the reviewer runs (required for
 * `harnessTranscriptHash` diff-binding), it must pass that SAME value here
 * rather than letting `emit-leaf` generate a fresh, never-seen-by-the-
 * reviewer nonce.
 */
function isValidNonce(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Return true iff `candidate` (already resolved to an absolute path) lies
 * inside `<repoRoot>/.ai-sdlc/` (or is the directory itself). Used to guard
 * `--transcript-path` and `--verdict-path` on `emit-leaf` against caller bugs
 * or `../`-injection through unsanitized bash variables that would otherwise
 * let the CLI hash arbitrary files into the Merkle tree.
 *
 * The check uses path.relative() so it correctly handles symlinks-as-strings
 * and cross-platform separators; a `..` prefix or an absolute relative result
 * means the candidate escapes the base.
 */
function isPathInside(baseDir: string, candidate: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedBase, resolvedCandidate);
  if (rel === '') return true; // candidate IS the base directory
  if (rel.startsWith('..' + sep) || rel === '..') return false;
  // On POSIX, an absolute `rel` indicates the candidate is on a different
  // device/root than the base — treat as outside.
  if (resolve(rel) === rel) return false;
  return true;
}

// ── CLI builder ───────────────────────────────────────────────────────────────

export function buildAttestationCli(argv: string[]): ReturnType<typeof yargs> {
  return (
    yargs(argv)
      .scriptName('cli-attestation')
      .usage('Usage: $0 <command> [options]')
      .option('repo-root', {
        type: 'string',
        describe:
          'Absolute path to the repo root. Defaults to REPO_ROOT env or process.cwd(). ' +
          'Transcripts are under <repo-root>/.ai-sdlc/transcripts/ and leaves under ' +
          '<repo-root>/.ai-sdlc/transcript-leaves.jsonl.',
      })
      .strict()
      .command(
        'transcripts',
        'Manage reviewer transcript files (RFC-0042 Phase 1)',
        (yargs: Argv) => {
          yargs.command(
            'list [task-id]',
            'List captured transcripts with event count and byte size',
            (yargs: Argv) => {
              yargs.positional('task-id', {
                type: 'string',
                description:
                  'Filter to a specific task ID (e.g. aisdlc-383.1). Omit to list all tasks.',
                demandOption: false,
              });
              yargs.option('json', {
                type: 'boolean',
                description: 'Emit JSON array instead of human-readable table',
                default: false,
              });
            },
            (args) => {
              const taskId = args['task-id'] as string | undefined;
              const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
              const jsonOutput = args['json'] as boolean;

              const infos = listTranscripts(repoRoot, taskId);

              if (jsonOutput) {
                process.stdout.write(JSON.stringify(infos, null, 2) + '\n');
                return;
              }

              const header =
                taskId != null ? `Transcripts for task: ${taskId}` : 'All captured transcripts';

              process.stdout.write(`\n${header}\n`);
              process.stdout.write('(from ' + repoRoot + '/.ai-sdlc/transcripts/)\n\n');
              process.stdout.write(formatTranscriptTable(infos) + '\n\n');

              if (infos.length > 0) {
                const totalEvents = infos.reduce((sum, i) => sum + i.eventCount, 0);
                const totalBytes = infos.reduce((sum, i) => sum + i.byteSize, 0);
                const malformed = infos.filter((i) => !i.isWellFormed).length;
                process.stdout.write(
                  `Summary: ${infos.length} file(s), ${totalEvents} event(s), ${totalBytes} bytes` +
                    (malformed > 0 ? `, ${malformed} malformed file(s)` : '') +
                    '\n',
                );
              }
            },
          );
          yargs.demandCommand(1, 'Specify a transcripts subcommand (e.g. list)');
        },
      )
      // ── reset-stack (AISDLC-999) ──────────────────────────────────────────────
      .command(
        'reset-stack',
        "Drop this task's earlier attestation chore commits (`chore: sign attestation` and " +
          '`chore: commit pending transcript leaves`) from the branch non-interactively, so a ' +
          'retry re-signs on a clean stack. Refuses (exit 1, nothing changed) when a candidate ' +
          'commit touches any path other than .ai-sdlc/attestations/ and the transcript leaves. ' +
          'Leaf files the dropped commits carried are restored staged; commit them, then sign.',
        (y: Argv) =>
          y
            .option('target', {
              type: 'string',
              default: 'main',
              describe: 'Target branch the stack is measured against (origin/<target>).',
            })
            .option('task-id', { type: 'string', describe: 'Task id (allows its review ledger).' })
            .option('repo-root', { type: 'string', describe: 'Worktree to operate in.' }),
        async (args) => {
          const root = resolveRepoRoot(args['repo-root'] as string | undefined);
          const r = await dropAttestationChores(gitIn(root), {
            target: args['target'] as string,
            taskId: args['task-id'] as string | undefined,
          });
          if (r.kind === 'none')
            emitText('[cli-attestation] reset-stack: no attestation chore commits to drop');
          else if (r.kind === 'dropped')
            emitText(
              `[cli-attestation] reset-stack: dropped ${r.dropped.length} commit(s); restored ${r.restored.length} file(s) (staged)`,
            );
          else {
            const why =
              r.kind === 'refused'
                ? `commit ${r.sha.slice(0, 7)} touches other paths: ${r.paths.join(', ')}`
                : r.reason;
            process.stderr.write(`[cli-attestation] reset-stack: refused: ${why}\n`);
            process.exitCode = 1;
          }
        },
      )
      // ── emit-leaf ───────────────────────────────────────────────────────────────
      .command(
        'emit-leaf',
        "Record one reviewer run after it finishes: bind it to the reviewer's harness run " +
          '(consuming the SubagentStart marker) and append the verdict to the reviews ledger. ' +
          'No transcript leaf or Merkle input is written (RFC-0061 phase 3).',
        (y: Argv) =>
          y
            .option('task-id', {
              type: 'string',
              demandOption: true,
              describe: 'Task ID, e.g. AISDLC-383.8.',
            })
            .option('reviewer', {
              type: 'string',
              demandOption: true,
              describe:
                'Reviewer name: code-reviewer | test-reviewer | security-reviewer | ' +
                'code-reviewer-codex | test-reviewer-codex | correctness-reviewer ' +
                '(AISDLC-617 opt-in merged code+test reviewer).',
            })
            .option('transcript-path', {
              type: 'string',
              demandOption: true,
              describe:
                'Absolute path to the reviewer transcript JSONL file whose SHA-256 is hashed into the leaf.',
            })
            .option('verdict-path', {
              type: 'string',
              demandOption: true,
              describe:
                'Absolute path to the verdict JSON file (shape: { approved, findings: { critical, major, minor, suggestion } }).',
            })
            .option('head-sha', {
              type: 'string',
              demandOption: true,
              describe: '40-char hex git commit SHA of the PR head. Used to generate the nonce.',
            })
            .option('harness', {
              type: 'string',
              demandOption: true,
              describe: 'Harness: claude-code | codex.',
            })
            .option('model', {
              type: 'string',
              demandOption: true,
              describe: 'LLM model identifier, e.g. sonnet, or a pinned model id.',
            })
            .option('nonce', {
              type: 'string',
              describe:
                'AISDLC-570: 64-char hex nonce to use verbatim instead of generating a fresh ' +
                'one. Required for harnessTranscriptHash diff-binding — the orchestrating ' +
                'dispatch must generate this nonce and embed it (via nonceMarkerLiteral()) in ' +
                "the reviewer's prompt BEFORE the reviewer runs, then pass the SAME value here. " +
                'Omit and a fresh nonce is generated that no reviewer saw, so the leaf is ' +
                'self-authored unless --allow-role-matched-independent is set.',
            })
            .option('allow-role-matched-independent', {
              type: 'boolean',
              default: false,
              describe:
                'AISDLC-701: opt in to the local role-matched rule. Without it a leaf is ' +
                "`independent` only when the nonce is found in the reviewer run's own harness " +
                'transcript; with it, a role-matched marker under --repo-root also counts.',
            })
            .option('claude-session-id', {
              type: 'string',
              describe:
                'AISDLC-570: explicit Claude Code session id used to resolve the reviewer ' +
                "subagent's harness-captured transcript at " +
                '~/.claude/projects/<slug>/<session-id>/subagents/agent-<agent-id>.jsonl. ' +
                'When omitted, falls back to the most-recently-modified session directory ' +
                'under the resolved project slug (disclosed race window, AISDLC-216-style).',
            })
            .option('agent-id', {
              type: 'string',
              describe:
                'Harness agent id of the reviewer subagent run this leaf is for (the id the ' +
                'Agent tool returned at spawn, also the SubagentStart marker file name). ' +
                'When given, the leaf is bound to exactly that run: only the marker and ' +
                'harness transcript of that agent are used, whatever order or timing the ' +
                'reviewers finished in. When omitted, the id is read from the ' +
                '`<transcript>.agent-id` sidecar that persist-reviewer-artifacts.sh writes ' +
                'next to --transcript-path; when that is absent too, the marker is matched ' +
                'by reviewer role.',
            })
            .option('project-dir', {
              type: 'string',
              describe:
                'Also searched for SubagentStart markers ' +
                '(<project-dir>/.ai-sdlc/subagent-sessions/), next to --repo-root and the ' +
                'main checkout. ' +
                'AISDLC-589: explicit override for the directory whose slug is used to ' +
                'resolve ~/.claude/projects/<slug>/. In a Pattern-C layout (non-bare parent ' +
                'repo + .worktrees/<task-id>/ isolates), --repo-root points at the WORKTREE ' +
                "but the Claude Code session's transcripts live under the MAIN checkout's " +
                'slug. When omitted, the main-checkout root is auto-derived via ' +
                '`git rev-parse --git-common-dir` (falls back to --repo-root if that fails).',
            })
            .option('stage', {
              type: 'string',
              choices: [...STAGED_LEAF_STAGES],
              describe:
                'Staged review: the stage this transcript belongs to (plan | execute | synthesize). ' +
                'Only valid with --reviewer staged-review. One leaf is emitted per planner, per probe ' +
                'and per synthesizer transcript. plan and execute leaves carry zero findings and ' +
                'verdictApproved=false whatever the verdict file says; only the synthesize leaf carries ' +
                'the verdict. Omit for every other reviewer: the field is then absent from the leaf.',
            })
            .option('iteration', {
              type: 'number',
              default: 1,
              describe:
                'AISDLC-616: 1-based review-iteration number (first pass = 1). Recorded on the ' +
                'append-only reviews ledger (.ai-sdlc/reviews/<task-id>.jsonl) alongside the ' +
                'Merkle leaf so the marginal-value analysis can distinguish first-pass findings ' +
                'from later-iteration re-reviews.',
            })
            .option('pr-number', {
              type: 'number',
              describe:
                'AISDLC-616: GitHub PR number, when already known at emit-leaf time. Recorded ' +
                'on the reviews ledger record as `prNumber` (nullable — omit when the PR has not ' +
                'been opened yet).',
            })
            .option('review-mode', {
              type: 'string',
              choices: ['full', 'delta'] as const,
              describe:
                'AISDLC-725: whether this round read the full diff or only a delta. A delta ' +
                'round also needs --review-base-sha; its leaf then binds to the commit range.',
            })
            .option('review-base-sha', {
              type: 'string',
              describe:
                'AISDLC-725: 40-hex commit a delta round read from (the last-reviewed commit).',
            })
            .option('review-head-sha', {
              type: 'string',
              describe:
                'AISDLC-725: commit the delta round actually reviewed, when it differs from ' +
                '--head-sha (reconcile signs the post-rebase head). Defaults to --head-sha.',
            })
            .option('review-reason', {
              type: 'string',
              describe: 'AISDLC-725: why the round was full or delta (the plan reason).',
            }),
        (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const taskId = args['task-id'] as string;
          const reviewerName = args['reviewer'] as string;
          const transcriptPath = resolve(args['transcript-path'] as string);
          const verdictPath = resolve(args['verdict-path'] as string);
          const headSha = args['head-sha'] as string;
          const harness = args['harness'] as string;

          // Staged review: --stage labels one stage's leaf and only exists for the
          // staged set, so a stage on any other reviewer is a caller bug.
          const stage = args['stage'] as StagedLeafStage | undefined;
          if (stage !== undefined && reviewerName !== STAGED_REVIEWER_NAME) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --stage is only valid with --reviewer ${STAGED_REVIEWER_NAME} ` +
                `(got --reviewer ${reviewerName})\n`,
            );
            process.exit(1);
          }

          // AISDLC-391 Finding 1: validate --head-sha is a well-formed 40-hex-char
          // git commit SHA. RFC-0042's nonce-binding invariant assumes a real SHA;
          // an empty or multi-line value (e.g. from a silently-failed `git rev-parse`)
          // would weaken replay resistance.
          if (!isValidHeadSha(headSha)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --head-sha must be exactly 40 lowercase hex characters ` +
                `(got ${headSha.length}-char value: ${JSON.stringify(headSha.slice(0, 80))})\n`,
            );
            process.exit(1);
          }

          // AISDLC-391 Finding 2: validate --transcript-path resolves inside
          // <repo-root>/.ai-sdlc/. Defense-in-depth against `../` injection through
          // unsanitized bash variables in the slash-command-body caller.
          const aiSdlcDir = join(repoRoot, '.ai-sdlc');
          if (!isPathInside(aiSdlcDir, transcriptPath)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --transcript-path must resolve inside ` +
                `${aiSdlcDir}/ (got: ${transcriptPath})\n`,
            );
            process.exit(1);
          }
          if (!isPathInside(aiSdlcDir, verdictPath)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --verdict-path must resolve inside ` +
                `${aiSdlcDir}/ (got: ${verdictPath})\n`,
            );
            process.exit(1);
          }

          // Validate transcript file exists.
          if (!existsSync(transcriptPath)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: transcript file not found: ${transcriptPath}\n`,
            );
            process.exit(1);
          }

          // Validate verdict file exists.
          if (!existsSync(verdictPath)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: verdict file not found: ${verdictPath}\n`,
            );
            process.exit(1);
          }

          // AISDLC-570: validate --nonce (if provided) and --claude-session-id
          // (opaque; only used as a path segment, validated by
          // resolveHarnessTranscriptPath's existsSync check downstream).
          const explicitNonce = args['nonce'] as string | undefined;
          if (explicitNonce !== undefined && !isValidNonce(explicitNonce)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --nonce must be exactly 64 lowercase hex characters ` +
                `(got ${explicitNonce.length}-char value: ${JSON.stringify(explicitNonce.slice(0, 80))})\n`,
            );
            process.exit(1);
          }
          const claudeSessionId = args['claude-session-id'] as string | undefined;
          const projectDirOverride = args['project-dir'] as string | undefined;

          // Identity of the reviewer run this leaf belongs to. An explicit
          // --agent-id wins; otherwise the sidecar written next to the
          // persisted transcript. Either way the value is only ever compared
          // against marker contents and used as a sanitised file-name segment.
          let agentId = args['agent-id'] as string | undefined;
          if (agentId !== undefined && !AGENT_ID_PATTERN.test(agentId)) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --agent-id may only contain [A-Za-z0-9._-] ` +
                `(got ${JSON.stringify(agentId.slice(0, 80))})\n`,
            );
            process.exit(1);
          }
          if (agentId === undefined) {
            agentId = readAgentIdSidecar(transcriptPath);
          }

          // Parse verdict JSON. `findings` may be EITHER the aggregated
          // counts-object shape historically consumed here, OR the itemized
          // array shape reviewer subagents actually return
          // (`ai-sdlc-plugin/agents/*-reviewer.md`) — AISDLC-616 accepts both
          // so the reviews ledger can capture itemized findings when
          // available, without breaking existing counts-only callers.
          let verdict: {
            approved?: boolean;
            verdictApproved?: boolean;
            findings?:
              | { critical?: number; major?: number; minor?: number; suggestion?: number }
              | Array<{ severity?: string; file?: string; line?: number; message?: string }>;
          };
          try {
            verdict = JSON.parse(readFileSync(verdictPath, 'utf8')) as typeof verdict;
          } catch (err) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: failed to parse verdict file: ${(err as Error).message}\n`,
            );
            process.exit(1);
          }

          // Extract verdictApproved (supports both `approved` and `verdictApproved` keys for
          // compatibility with the slash-command-body verdicts format which uses `approved`).
          // Staged review: only the synthesize leaf carries a verdict. A plan or
          // execute leaf is evidence that a stage ran, so it carries zero findings
          // and verdictApproved=false by construction, whatever the verdict file holds.
          const carriesVerdict = stage === undefined || stage === 'synthesize';
          const verdictApproved = carriesVerdict
            ? Boolean(verdict.verdictApproved ?? verdict.approved ?? false)
            : false;

          // AISDLC-616: normalize itemized findings for the reviews ledger.
          if (!carriesVerdict) verdict.findings = [];
          const normalizedFindings = normalizeFindings(verdict.findings);

          // Nonce bound to this PR's head SHA (replay-resistance per RFC-0042
          // §Nonce binding). AISDLC-570: prefer an explicitly-passed --nonce
          // (the value the orchestrating dispatch already embedded in the
          // reviewer's prompt) so harnessTranscriptHash's nonce search can
          // find it; falls back to generating a fresh one (legacy behavior —
          // a freshly-generated nonce was never seen by the already-completed
          // reviewer, so harnessTranscriptHash will correctly resolve null).
          const nonce = explicitNonce ?? generateNonce(headSha);

          const signedAt = new Date().toISOString();

          const transcriptMtimeMs = statSync(transcriptPath).mtimeMs;

          // AISDLC-570 (DEC-0013 → opt1): sign-time-only, informational
          // binding to the reviewer subagent's own harness-captured
          // transcript. Fail-safe — see attestation/harness-transcript.ts
          // for the full mechanism + honest limits. The `reason` is always
          // logged (even on success) for signer-side observability.
          //
          // bindLeafToReviewerRun makes ONE selection that decides both the hash
          // and the verdict class, and claims the marker atomically (AISDLC-701),
          // so two emit-leaf runs for one leaf cannot both be `independent`.
          const allowRoleMatched = Boolean(args['allow-role-matched-independent']);
          if (allowRoleMatched) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --allow-role-matched-independent set; a role-matched ` +
                `marker under --repo-root can make this leaf independent without a verified nonce\n`,
            );
          }
          const harnessResult = bindLeafToReviewerRun({
            repoRoot,
            transcriptMtimeMs,
            nonce,
            claudeSessionId,
            projectDirOverride,
            reviewerName,
            agentId,
            headSha,
            taskId,
            allowRoleMatchedIndependent: allowRoleMatched,
          });
          process.stderr.write(
            `[cli-attestation] emit-leaf: harnessTranscriptHash=${
              harnessResult.harnessTranscriptHash
                ? harnessResult.harnessTranscriptHash.slice(0, 16) + '...'
                : 'null'
            } (${harnessResult.reason})\n`,
          );

          // One selection decides both fields (see bindLeafToReviewerRun): a
          // marker whose harness transcript carries this nonce gives the hash
          // and, when typed, `independent`; without one, only a role-matched
          // marker under --repo-root itself can still earn `independent`.
          const verdictClass = harnessResult.verdictClass;

          // RFC-0046 Phase 1 (AISDLC-588): independenceTier derived from the
          // SAME signal as verdictClass. Omitted (undefined), never an explicit
          // default, so the leaf hash is identical under verifiers that
          // predate the field.
          const independenceTier: 'attested' | undefined =
            verdictClass === 'independent' ? 'attested' : undefined;

          // AISDLC-725: a delta round's leaf binds to the commit range it covered.
          const reviewMode = args['review-mode'] as 'full' | 'delta' | undefined;
          const reviewBaseSha = (args['review-base-sha'] as string | undefined)?.toLowerCase();
          if (reviewMode === 'delta' && !(reviewBaseSha && /^[0-9a-f]{40}$/.test(reviewBaseSha))) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --review-mode delta requires --review-base-sha ` +
                `(40 lowercase hex characters)\n`,
            );
            process.exit(1);
          }
          const reviewHeadArg = args['review-head-sha'] as string | undefined;
          if (reviewHeadArg !== undefined && !/^[0-9a-f]{40}$/.test(reviewHeadArg.toLowerCase())) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: --review-head-sha must be 40 hex characters\n`,
            );
            process.exit(1);
          }
          // AISDLC-616: append the SAME reviewer verdict to the durable,
          // append-only reviews ledger (.ai-sdlc/reviews/<task-id>.jsonl).
          // This is written EVERY call — including re-review iterations —
          // so first-pass findings survive even once a later iteration
          // flips the same reviewer to APPROVED, unlike the gitignored,
          // overwritten `.ai-sdlc/verdicts/*.json`. A reviewer name that
          // doesn't map to a canonical role (`normalizeReviewerRole`
          // returns null) is logged and skipped rather than silently
          // mis-tagging a record with a guessed role.
          // Staged review: the ledger records one `staged` row per review, taken
          // from the synthesize leaf; plan and execute leaves are evidence of
          // execution and add no row, so per-role counts are unchanged.
          const role = carriesVerdict ? normalizeReviewerRole(reviewerName) : null;
          if (role) {
            const iteration = (args['iteration'] as number | undefined) ?? 1;
            const prNumberArg = args['pr-number'] as number | undefined;
            appendReviewLedgerRecord(
              {
                taskId,
                prNumber: prNumberArg ?? null,
                commitSha: headSha,
                iteration,
                role,
                harness,
                timestamp: signedAt,
                verdict: verdictApproved ? 'approved' : 'rejected',
                findings: normalizedFindings,
                // The staged set runs as shadow beside the gating reviewers (DEC-0149).
                ...(role === 'staged' ? { gating: false } : {}),
                ...(reviewMode
                  ? {
                      reviewMode,
                      reviewBaseSha: reviewMode === 'delta' ? (reviewBaseSha ?? null) : null,
                      ...(args['review-reason']
                        ? { reviewReason: args['review-reason'] as string }
                        : {}),
                    }
                  : {}),
              },
              repoRoot,
            );
          } else if (carriesVerdict) {
            process.stderr.write(
              `[cli-attestation] emit-leaf: reviewer '${reviewerName}' does not map to a ` +
                `canonical reviews-ledger role (code/test/security) — skipping ledger append\n`,
            );
          }

          emitText(
            `[cli-attestation] emit-leaf: recorded ${reviewerName} for ${taskId} ` +
              `(approved=${verdictApproved}, verdictClass=${verdictClass}, ` +
              `independenceTier=${independenceTier}, ` +
              `harnessTranscriptHash=${harnessResult.harnessTranscriptHash ? 'set' : 'null'})`,
          );
        },
      )
      // ── reviewer-set (AISDLC-722) ─────────────────────────────────────────────
      .command(
        'reviewer-set',
        'Print the reviewer set the PR diff requires (DEC-0055): the two-reviewer set when the ' +
          'diff touches no trust-chain path, else three. Same classifier the CI verifier ' +
          're-derives from the same diff. Config is read from the base ref, never the worktree. ' +
          'Prints JSON {set, reviewers, reason, triggeringPaths}; fails closed to three.',
        (y: Argv) =>
          y
            .option('repo-root', {
              type: 'string',
              default: process.cwd(),
              describe: 'Worktree root (default: cwd).',
            })
            .option('base-ref', {
              type: 'string',
              default: 'origin/main',
              describe: 'Base ref the diff and the trusted review config are read from.',
            })
            .option('head-ref', {
              type: 'string',
              default: 'HEAD',
              describe: 'Head ref of the diff.',
            }),
        (args) => {
          emitJson(
            deriveReviewerSetFromGit({
              repoRoot: resolve(args['repo-root'] as string),
              baseRef: args['base-ref'] as string,
              headRef: args['head-ref'] as string,
            }),
          );
        },
      )
      // ── reviewer-set-window (AISDLC-722) ───────────────────────────────────────
      .command(
        'reviewer-set-window',
        'Summarise the two-reviewer-default comparison window (first 20 PRs or one week): ' +
          'PR counts per set, sampled PRs and the disagreements between the two sets, as JSON ' +
          'for the decision digest.',
        (y: Argv) =>
          y.option('artifacts-dir', {
            type: 'string',
            describe: 'Artifacts directory (default: $ARTIFACTS_DIR or <cwd>/.ai-sdlc/artifacts).',
          }),
        (args) => {
          emitJson(
            summarizeComparisonWindow(
              resolveArtifactsDir(process.cwd(), args['artifacts-dir'] as string | undefined),
            ),
          );
        },
      )
      // ── generate-nonce (AISDLC-573) ───────────────────────────────────────────
      .command(
        'generate-nonce',
        'Generate a diff-binding nonce for a PR head SHA, printed to stdout. ' +
          'AISDLC-573: the reviewer-dispatch orchestrator (slash-command body / ' +
          'orchestrator-tick reconcile) calls this ONCE per PR before spawning any ' +
          'reviewer subagents, embeds the result (via `nonce-marker`) in EACH ' +
          "reviewer's prompt, then passes the SAME nonce value to `emit-leaf --nonce` " +
          'for every reviewer leaf emitted for this PR — all reviewers on one diff ' +
          'share one nonce.',
        (y: Argv) =>
          y.option('head-sha', {
            type: 'string',
            demandOption: true,
            describe: '40-char hex git commit SHA of the PR head.',
          }),
        (args) => {
          const headSha = args['head-sha'] as string;
          if (!isValidHeadSha(headSha)) {
            process.stderr.write(
              `[cli-attestation] generate-nonce: --head-sha must be exactly 40 lowercase hex ` +
                `characters (got ${headSha.length}-char value: ${JSON.stringify(headSha.slice(0, 80))})\n`,
            );
            process.exit(1);
          }
          emitText(generateNonce(headSha));
        },
      )
      // ── nonce-marker (AISDLC-573) ─────────────────────────────────────────────
      .command(
        'nonce-marker',
        'Print the EXACT literal string (via nonceMarkerLiteral()) that must be embedded ' +
          "in a reviewer subagent's prompt for diff-binding (AISDLC-570/573). Wraps the " +
          'literal-format single source of truth so the orchestrating dispatch never has ' +
          'to hand-construct or duplicate the format.',
        (y: Argv) =>
          y.option('nonce', {
            type: 'string',
            demandOption: true,
            describe: '64-char hex nonce, as produced by `generate-nonce`.',
          }),
        (args) => {
          const nonce = args['nonce'] as string;
          if (!isValidNonce(nonce)) {
            process.stderr.write(
              `[cli-attestation] nonce-marker: --nonce must be exactly 64 lowercase hex ` +
                `characters (got ${nonce.length}-char value: ${JSON.stringify(nonce.slice(0, 80))})\n`,
            );
            process.exit(1);
          }
          emitText(nonceMarkerLiteral(nonce));
        },
      )
      // ── verify: v6 is refused (RFC-0061 phase 3, OQ-3 hard cut) ───────────────
      .command(
        'verify',
        'Refuse a v6 attestation envelope. The signed-envelope gate was retired by the review ' +
          'verdict check (`verdict-check`); no verifier is left, so every call fails with the ' +
          `named error ${V6_REFUSED_CODE}. Kept so an old caller gets a reason, not a missing command.`,
        (y: Argv) =>
          y
            .option('head', { type: 'string', describe: 'Ignored; accepted for old callers.' })
            .option('base', { type: 'string', describe: 'Ignored; accepted for old callers.' })
            .option('envelope', {
              type: 'string',
              describe: 'Path of an envelope file to refuse; the schema it declares is named.',
            }),
        (args) => {
          const refusal = refuseAttestationEnvelope(args['envelope'] as string | undefined);
          process.stdout.write(`status=invalid\nreason=${refusal}\n`);
          process.exitCode = 1;
        },
      )
      // ── verdict-prune (RFC-0061 Phase 1) ─────────────────────────────────────
      .command(
        'verdict-prune',
        'Delete refs/ai-sdlc/verdicts/* whose PR is closed or merged and older than --max-age-days (default 30). Not scheduled.',
        (y: Argv) =>
          y
            .option('max-age-days', { type: 'number', default: DEFAULT_PRUNE_AGE_DAYS })
            .option('remote', { type: 'string', default: 'origin' })
            .option('dry-run', { type: 'boolean', default: false }),
        async (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const remote = args['remote'] as string;
          const url = await defaultRunner('git', ['remote', 'get-url', remote], {
            cwd: repoRoot,
            allowFailure: true,
          });
          const repository = repositoryFromRemoteUrl(url.stdout);
          if (!repository) {
            process.stderr.write(`[cli-attestation] verdict-prune: cannot resolve repository\n`);
            process.exitCode = 1;
            return;
          }
          const out = await pruneVerdictRefs({
            runner: defaultRunner,
            cwd: repoRoot,
            remote,
            maxAgeDays: args['max-age-days'] as number,
            dryRun: args['dry-run'] as boolean,
            prStateFor: ghPrStateFor(defaultRunner, repoRoot, repository),
          });
          for (const ref of out.deleted) process.stdout.write(`deleted ${ref}\n`);
          process.stdout.write(`deleted=${out.deleted.length} kept=${out.kept.length}\n`);
        },
      )
      // ── verdict-write (RFC-0061 OQ-7): the trusted workflow_run writer ───────
      .command(
        'verdict-write',
        'Validate a clean-room verdict artifact against the triggering run and write the verdict ref for the head. Reads no PR content.',
        (y: Argv) =>
          y
            .option('artifact-dir', { type: 'string', demandOption: true })
            .option('head', { type: 'string', demandOption: true })
            .option('repository', { type: 'string', demandOption: true })
            .option('jobs-file', { type: 'string', demandOption: true })
            .option('tree', { type: 'string' })
            .option('dry-run', { type: 'boolean', default: false }),
        async (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const raw = JSON.parse(readFileSync(args['jobs-file'] as string, 'utf8')) as {
            jobs?: Array<{ name: string; conclusion: string | null }>;
          };
          const checked = validateVerdictArtifact({
            dir: resolve(args['artifact-dir'] as string),
            headSha: args['head'] as string,
            repository: args['repository'] as string,
            jobs: raw.jobs ?? [],
            expectedTreeSha: args['tree'] as string | undefined,
          });
          if (!checked.ok) {
            process.stderr.write(`[cli-attestation] verdict-write: rejected: ${checked.reason}\n`);
            process.exitCode = 1;
            return;
          }
          const ref = verdictRefName(checked.record.subject.headSha);
          if (args['dry-run']) {
            process.stdout.write(`valid; would write ${ref}\n`);
            return;
          }
          const commit = await writeVerdictCommit(
            defaultRunner,
            repoRoot,
            checked.record,
            checked.leavesJsonl,
          );
          if (!commit) {
            process.stderr.write('[cli-attestation] verdict-write: tree write failed\n');
            process.exitCode = 1;
            return;
          }
          // No force: an issued record for a head is never overwritten.
          const out = await defaultRunner('git', ['push', 'origin', `${commit}:${ref}`], {
            cwd: repoRoot,
            allowFailure: true,
          });
          if (out.code !== 0) {
            process.stderr.write(`[cli-attestation] verdict-write: write failed: ${out.stderr}\n`);
            process.exitCode = 1;
            return;
          }
          process.stdout.write(`wrote ${ref}\n`);
        },
      )
      // ── verdict-check (RFC-0061 Phase 2: the required check) ─────────────────
      .command(
        'verdict-check',
        'Check refs/ai-sdlc/verdicts/<head> and print a reason code (ok, ok-carried:<sha>, no-record, subject-mismatch, coverage-short, replay-dirty, tier-short). --post-status posts the ai-sdlc/attestation status; exits 1 unless the result is ok.',
        (y: Argv) =>
          y
            .option('head', { type: 'string', demandOption: true })
            .option('base', { type: 'string', demandOption: true })
            .option('repository', { type: 'string', demandOption: true })
            .option('pull-request', { type: 'number' })
            .option('required-tier', { type: 'string', choices: [...INDEPENDENCE_TIERS] })
            .option('post-status', { type: 'boolean', default: false }),
        async (args) => {
          const repoRoot = resolveRepoRoot(args['repo-root'] as string | undefined);
          const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
          const result = await runVerdictCheck({
            runner: defaultRunner,
            cwd: repoRoot,
            repository: args['repository'] as string,
            headSha: args['head'] as string,
            baseSha: args['base'] as string,
            pullRequest: args['pull-request'] as number | undefined,
            requiredTier: args['required-tier'] as IndependenceTier | undefined,
            postStatus: args['post-status'] as boolean,
            writeSummary: summaryFile ? (md) => appendFileSync(summaryFile, md + '\n') : undefined,
          });
          process.stdout.write(`${result.code} ${result.detail}\n`);
          if (!result.ok) process.exitCode = 1;
        },
      )
      .demandCommand(
        1,
        'Specify a subcommand (e.g. transcripts list, verdict-prune, emit-leaf, generate-nonce, nonce-marker, verify, independence-policy, reset-stack, reviewer-set, reviewer-set-window)',
      )
      .help()
      .alias('h', 'help')
      .version(false)
  );
}

/** Entry point for the bin shim. */
export async function runAttestationCli(): Promise<void> {
  await buildAttestationCli(hideBin(process.argv)).parseAsync();
}
