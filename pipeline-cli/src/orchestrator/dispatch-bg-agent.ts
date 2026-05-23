/**
 * `dispatch-bg-agent` — Conductor → main-session bridge for in-session
 * background `Agent` dispatch (RFC-0041 Phase 1, AISDLC-396 / Pattern X).
 *
 * ## Why this module exists
 *
 * `/ai-sdlc orchestrator-tick` (the Conductor) runs in the main Claude Code
 * session's slash-command body. To drain the dispatch frontier in a single
 * session, the Conductor needs to spawn dev subagents itself (Pattern X)
 * instead of leaving the work for sibling sessions (Pattern Z) or shelling
 * out to a paid subprocess pool (Pattern Y).
 *
 * Plugin subagents cannot use the `Agent` tool (Claude Code filters it one
 * level deep — AISDLC-98). The Conductor IS the slash command body, so it
 * COULD call `Agent` directly — but in practice the `orchestrator-tick`
 * body is bash-heavy and the `Agent` call must happen from a separate
 * Agent-tool invocation step. Rather than reshuffling the whole tick body
 * to interleave bash + Agent calls, this module implements a **filesystem
 * coordination protocol**:
 *
 *   1. Conductor's Step 5 (after emitting a manifest to `queue/` and
 *      claiming it into `inflight/`) writes a synthetic request file at
 *      `<board-dir>/bg-agent-request/<task-id>.json` describing the dev
 *      dispatch.
 *   2. The slash command body's Step 2.5 (the next tick, or this tick if
 *      ordering allows) sweeps `bg-agent-request/` and fires actual `Agent`
 *      tool calls. The slash command body lives in the main CC session so
 *      `Agent` is available here.
 *   3. When the dev subagent completes, it writes its standard developer
 *      JSON envelope to `done/<task-id>.json` (via the existing
 *      `dispatch-worker` Step 5 path), and the slash command body deletes
 *      the consumed bg-agent-request file.
 *
 * ## Why a separate `bg-agent-request/` subdir (not in `queue/`)
 *
 * The four Dispatch Board lifecycle subdirs (`queue/inflight/done/failed`)
 * are governed by the manifest-rename atomic-claim protocol. Mixing
 * coordination files into `queue/` would either confuse the `claimNext`
 * scanner (it scans for `*.dispatch.json` so .request.json would be
 * skipped — but the mental model muddles) OR force every claim/peek/sweep
 * site to learn about the new file type. Keeping `bg-agent-request/` as a
 * sibling directory means the Dispatch Board library stays untouched and
 * the coordination channel is logically separate from manifest lifecycle.
 *
 * ## Concurrency cap
 *
 * The Conductor MUST respect `inSessionAgentMaxSessions` (default 4 — see
 * `spec/schemas/dispatch-config.v1.schema.json`). The cap is enforced by
 * counting `bg-agent-request/*.json` files + `inflight/*.dispatch.json`
 * files (the two flight-states a Pattern X task can be in) before writing
 * a new request. Callers should call `countInFlightBgAgents()` and
 * `loadInSessionAgentMaxSessions()` together before emitting.
 *
 * ## Cross-session survivability (AC-6)
 *
 * Both `bg-agent-request/` and `inflight/` are on-disk. A session exit
 * between the Conductor's request-write and the slash command body's
 * Agent-fire leaves the request file durable. The next session's tick
 * (whether the same operator re-launches or a fresh session picks up)
 * sees the pending request and either fires the Agent or — if the
 * inflight heartbeat has gone stale — lets the sweeper reap it into
 * `failed/` per RFC-0041 §5.2. The `bg-agent-request/` file is then
 * orphaned and the slash command body should garbage-collect it (see
 * `pruneOrphanedBgAgentRequests`).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { DispatchManifest } from '../dispatch/index.js';

/**
 * Subdirectory under `<board-dir>/` where Pattern X coordination files
 * live. Intentionally separate from BOARD_SUBDIRS (the manifest lifecycle
 * subdirs queue/inflight/done/failed) so the Dispatch Board library stays
 * agnostic of the in-session-agent dispatch pattern.
 */
export const BG_AGENT_REQUEST_SUBDIR = 'bg-agent-request';

/** Filename suffix for bg-agent-request coordination files. */
const REQUEST_SUFFIX = '.request.json';

/** Default cap when DispatchConfig is missing/malformed (matches schema default). */
export const DEFAULT_IN_SESSION_AGENT_MAX_SESSIONS = 4;

/** Schema version stamped onto every request — bump on incompatible changes. */
export const BG_AGENT_REQUEST_SCHEMA_VERSION = 'v1' as const;

/**
 * Status the slash command body's sweeper transitions a request through.
 * `pending` is what the Conductor writes; `dispatched` is what the sweeper
 * sets after firing the Agent call (kept on disk briefly so a same-tick
 * re-sweep doesn't double-fire). The file is deleted when the dev verdict
 * lands in `done/` or `failed/`.
 */
export type BgAgentRequestStatus = 'pending' | 'dispatched';

/**
 * Synthetic dispatch request the Conductor writes for the slash command
 * body's Agent-fire sweep. See module docstring for the full protocol.
 */
export interface BgAgentRequest {
  schemaVersion: typeof BG_AGENT_REQUEST_SCHEMA_VERSION;
  taskId: string;
  /** Always `developer` in Phase 1 — reviewer fan-out has its own path. */
  subagentType: 'developer';
  /** Worktree the dev subagent should `cwd` into (matches manifest.worktree). */
  worktree: string;
  /** Absolute or board-relative path to the inflight manifest this request belongs to. */
  manifestPath: string;
  /** Full prompt text the slash command body passes to the Agent tool. */
  prompt: string;
  /** ISO-8601 timestamp the Conductor wrote this request. */
  requestedAt: string;
  /** Identifier of the Conductor session/process that wrote this (audit). */
  requestedBy: string;
  /** Lifecycle status the slash command body transitions. */
  status: BgAgentRequestStatus;
}

/** Options for {@link writeBgAgentRequest}. */
export interface WriteBgAgentRequestOptions {
  /** Override the requested-at timestamp (mostly for hermetic tests). */
  requestedAt?: string;
  /** Override `requestedBy` (defaults to `conductor-<pid>`). */
  requestedBy?: string;
}

/** Build the absolute path of a request file in `bg-agent-request/`. */
export function bgAgentRequestPath(boardDir: string, taskId: string): string {
  return path.join(boardDir, BG_AGENT_REQUEST_SUBDIR, `${taskId}${REQUEST_SUFFIX}`);
}

/** Ensure the bg-agent-request subdir exists. Cheap to call repeatedly. */
export function ensureBgAgentRequestDir(boardDir: string): void {
  mkdirSync(path.join(boardDir, BG_AGENT_REQUEST_SUBDIR), { recursive: true });
}

/**
 * Build the prompt the slash command body will pass to the developer
 * `Agent` call. **Honors the dev subagent's hardwired Definition-of-Done
 * contract** (`ai-sdlc-plugin/agents/developer.md` lines 25-36): the dev
 * commits, rebases, pushes, AND opens a DRAFT PR, returning a JSON
 * envelope with `prUrl` populated.
 *
 * ## Why this prompt does NOT say "DO NOT push or open a PR"
 *
 * An earlier revision (Pattern X v1, AISDLC-396 first iteration) told the
 * dev "DO NOT push or open a PR — the Conductor handles sign+push+PR after
 * this Agent call returns." That framing fought the dev agent's hardwired
 * contract:
 *
 *   - The developer.md system prompt declares push + open-PR as core
 *     deliverables on equal footing with the commit itself, explicitly
 *     rejecting "my role ends at commit, the orchestrator handles push +
 *     PR" as the failure mode the prompt was rewritten to eliminate
 *     (operator memory `feedback_dev_subagents_violate_no_push.md`).
 *   - Per the same memory, dev subagents push even when told not to — so
 *     telling them not to was producing a no-op contradiction that
 *     confused the contract reader (the dev) without changing behavior.
 *
 * ## Reframe: dev pushes + opens DRAFT PR; Conductor RECONCILES
 *
 * The de-facto pattern that has been working manually across the autonomous
 * loop:
 *
 *   1. Dev follows its hardwired contract → commits, rebases onto
 *      origin/main, pushes with --force-with-lease, opens a **draft** PR,
 *      returns its JSON envelope with `prUrl` populated.
 *   2. The dev's verdict (parsed from the Agent return value) lands in
 *      `done/<task-id>.verdict.json` via the slash command body's Step 2.5
 *      reconcile path.
 *   3. The Conductor's Step 3 (next tick) picks up the verdict, fans out 3
 *      reviewers, signs the attestation, **force-pushes** the
 *      attestation chore commit on top of the dev's branch, and flips
 *      the draft PR to ready-for-review — triggering CI exactly once on
 *      the fully-attested HEAD.
 *
 * The DRAFT instruction is load-bearing: opening as draft prevents CI from
 * firing on the unsigned HEAD (AISDLC-218). The Conductor's reconcile step
 * flips draft → ready after the attestation chore lands, gating CI on the
 * complete attestation envelope.
 */
export function buildDevPromptFromManifest(manifest: DispatchManifest): string {
  const taskFile = manifest.spec.taskFile;
  const branch = manifest.branch;
  const worktree = manifest.worktree;
  return [
    `You are implementing backlog task **${manifest.taskId}** in worktree \`${worktree}\`.`,
    '',
    '## Read the full task body',
    `The task file is at \`${taskFile}\` in your worktree. **Read it FIRST** — it has the full task description, acceptance criteria, references, and any \`permittedExternalPaths\`.`,
    '',
    '## Branch',
    `\`${branch}\` at \`${worktree}\`. The branch is already created off \`origin/main\`.`,
    '',
    '## Verification commands',
    manifest.spec.verifyCommands.length > 0
      ? manifest.spec.verifyCommands.map((c) => `- \`${c}\``).join('\n')
      : '- (no manifest-declared verify commands; fall back to project defaults)',
    '',
    '## Definition of Done — follow your standard contract',
    'Honor the developer agent system prompt verbatim: commit, rebase onto `origin/main`, push with `--force-with-lease`, and open a **DRAFT** PR via `gh pr create --draft`. Capture the PR URL into the `prUrl` field of your return envelope.',
    '',
    '## Why DRAFT specifically (Pattern X reconcile contract)',
    'The orchestrator-tick Conductor picks up your return verdict on its next tick, fans out 3 reviewer subagents (code/test/security), signs an attestation envelope, and **force-pushes the attestation chore commit on top of your branch**. It then flips the draft → ready-for-review via `gh pr ready <number>`, which triggers CI exactly ONCE on the fully-attested HEAD. Opening the PR as ready (non-draft) would fire CI immediately on the unattested HEAD — wasting a CI cycle and posting an attestation failure status that the operator must manually re-trigger.',
    '',
    '## Return value',
    'Return the standard developer JSON envelope (`summary`, `filesChanged`, `commitSha`, `prUrl`, `verifications`, `acceptanceCriteriaMet`, `notes`). `prUrl` MUST be populated — the Conductor reads it to locate the PR to flip from draft to ready.',
  ].join('\n');
}

/**
 * Write a bg-agent-request file describing a dev dispatch.
 *
 * Atomic (temp + rename within the same subdir) so a partial write is
 * never visible to the slash command body's sweep.
 *
 * @throws if the destination already exists — duplicate requests indicate
 *   a Conductor bug (the same task should never be dispatched twice in
 *   parallel; the dispatch-board claim already lives in `inflight/`).
 */
export function writeBgAgentRequest(
  boardDir: string,
  manifest: DispatchManifest,
  options: WriteBgAgentRequestOptions = {},
): string {
  ensureBgAgentRequestDir(boardDir);
  const target = bgAgentRequestPath(boardDir, manifest.taskId);
  if (existsSync(target)) {
    throw new Error(
      `dispatch-bg-agent.writeBgAgentRequest: ${target} already exists; an earlier request for ${manifest.taskId} is still pending`,
    );
  }
  const request: BgAgentRequest = {
    schemaVersion: BG_AGENT_REQUEST_SCHEMA_VERSION,
    taskId: manifest.taskId,
    subagentType: 'developer',
    worktree: manifest.worktree,
    manifestPath: path.join(boardDir, 'inflight', `${manifest.taskId}.dispatch.json`),
    prompt: buildDevPromptFromManifest(manifest),
    requestedAt: options.requestedAt ?? new Date().toISOString(),
    requestedBy: options.requestedBy ?? `conductor-${process.pid}`,
    status: 'pending',
  };
  // Atomic temp-and-rename. The Node stdlib doesn't expose `O_TMPFILE`, so
  // we write next to the target and rename — same-FS rename is atomic.
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(request, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
  return target;
}

/** Read a single bg-agent-request from disk. Returns undefined if missing. */
export function readBgAgentRequest(boardDir: string, taskId: string): BgAgentRequest | undefined {
  const target = bgAgentRequestPath(boardDir, taskId);
  if (!existsSync(target)) return undefined;
  try {
    return JSON.parse(readFileSync(target, 'utf8')) as BgAgentRequest;
  } catch {
    return undefined;
  }
}

/**
 * List every pending bg-agent-request on disk, oldest-first by mtime.
 * The slash command body's Step 2.5 sweep uses this to discover dispatches.
 */
export function listBgAgentRequests(boardDir: string): BgAgentRequest[] {
  const dir = path.join(boardDir, BG_AGENT_REQUEST_SUBDIR);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(REQUEST_SUFFIX));
  } catch {
    return [];
  }
  const out: BgAgentRequest[] = [];
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, entry), 'utf8')) as BgAgentRequest;
      out.push(parsed);
    } catch {
      continue;
    }
  }
  // Sort oldest-first by requestedAt so the slash command body fires
  // dispatches in FIFO order — first dispatched, first reviewed.
  out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  return out;
}

/**
 * Remove a consumed bg-agent-request from disk. Idempotent — no-op if the
 * file is already gone (the slash command body may have raced its own
 * removal across ticks).
 */
export function removeBgAgentRequest(boardDir: string, taskId: string): void {
  const target = bgAgentRequestPath(boardDir, taskId);
  if (!existsSync(target)) return;
  try {
    unlinkSync(target);
  } catch {
    /* swallow ENOENT-race etc. */
  }
}

/**
 * Count the in-flight Pattern X dispatches (pending requests + manifests
 * already in `inflight/`). The Conductor compares this against the
 * configured concurrency cap before emitting a new manifest.
 *
 * The two states are summed because a Pattern X task can be in EITHER:
 *
 *   - `bg-agent-request/` AND `inflight/` simultaneously (Conductor wrote
 *     both in the same tick; slash command body hasn't fired Agent yet)
 *   - JUST `inflight/` (slash command body fired the Agent, deleted the
 *     request, and the dev subagent is running)
 *
 * Summing both with a `taskId` dedupe gives the true in-flight count.
 */
export function countInFlightBgAgents(boardDir: string): number {
  const taskIds = new Set<string>();
  const inflightDir = path.join(boardDir, 'inflight');
  if (existsSync(inflightDir)) {
    try {
      for (const f of readdirSync(inflightDir)) {
        if (f.endsWith('.dispatch.json')) {
          taskIds.add(f.replace(/\.dispatch\.json$/, ''));
        }
      }
    } catch {
      /* treat as empty */
    }
  }
  const reqDir = path.join(boardDir, BG_AGENT_REQUEST_SUBDIR);
  if (existsSync(reqDir)) {
    try {
      for (const f of readdirSync(reqDir)) {
        if (f.endsWith(REQUEST_SUFFIX)) {
          taskIds.add(f.replace(/\.request\.json$/, ''));
        }
      }
    } catch {
      /* treat as empty */
    }
  }
  return taskIds.size;
}

/**
 * Garbage-collect bg-agent-request files whose corresponding inflight
 * manifest no longer exists. This happens when the stale-heartbeat sweeper
 * reaps an in-flight Worker into `failed/` while the Conductor's request
 * was still pending — the slash command body should not fire an Agent
 * call for a task that's already been escalated.
 *
 * Returns the taskIds it pruned. Safe to call on every tick.
 */
export function pruneOrphanedBgAgentRequests(boardDir: string): string[] {
  const requests = listBgAgentRequests(boardDir);
  const pruned: string[] = [];
  for (const req of requests) {
    const manifestExists = existsSync(req.manifestPath);
    if (!manifestExists) {
      removeBgAgentRequest(boardDir, req.taskId);
      pruned.push(req.taskId);
    }
  }
  return pruned;
}
