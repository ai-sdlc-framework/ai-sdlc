/**
 * Hermetic tests for the Pattern X bg-agent-request coordination protocol
 * (AISDLC-396 / RFC-0041 §4.4).
 *
 * The protocol is filesystem-only:
 *   - Conductor writes bg-agent-request/<task>.request.json
 *   - Slash command body sweeps + fires Agent
 *   - Worker writes done/<task>.verdict.json
 *   - Slash command body removes the request
 *
 * These tests exercise the library functions directly (no CLI parsing) +
 * simulate a 3-task drain end-to-end (AC-7) by stubbing the Agent-fire
 * step with a verdict-writer that mirrors what `dispatch-worker` does.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatchEnsureBoardDirs, dispatchWriteVerdict, type DispatchManifest } from '../index.js';

import {
  BG_AGENT_REQUEST_SCHEMA_VERSION,
  bgAgentRequestPath,
  buildDevPromptFromManifest,
  countInFlightBgAgents,
  ensureBgAgentRequestDir,
  listBgAgentRequests,
  pruneOrphanedBgAgentRequests,
  readBgAgentRequest,
  removeBgAgentRequest,
  writeBgAgentRequest,
} from './dispatch-bg-agent.js';

function mkBoard(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'bg-agent-')), 'dispatch');
}

function mkManifest(taskId: string, overrides: Partial<DispatchManifest> = {}): DispatchManifest {
  return {
    schemaVersion: 'v1',
    taskId,
    branch: `ai-sdlc/${taskId.toLowerCase()}`,
    worktree: `.worktrees/${taskId.toLowerCase()}`,
    baseSha: 'abc1234',
    workerKind: 'in-session-agent',
    dispatchedAt: '2026-05-22T10:00:00.000Z',
    dispatchedBy: 'conductor-test',
    spec: {
      taskFile: `backlog/tasks/${taskId.toLowerCase()}.md`,
      verifyCommands: ['pnpm build', 'pnpm test'],
    },
    ...overrides,
  };
}

/**
 * Helper — write a manifest directly into the boards' inflight/ so a test
 * can simulate a Conductor that has already emitted+claimed before calling
 * the bg-agent-request layer.
 */
function placeManifestInflight(boardDir: string, manifest: DispatchManifest): string {
  const target = path.join(boardDir, 'inflight', `${manifest.taskId}.dispatch.json`);
  writeFileSync(target, JSON.stringify(manifest, null, 2), 'utf-8');
  return target;
}

describe('bg-agent-request — library API', () => {
  let boardDir: string;

  beforeEach(() => {
    boardDir = mkBoard();
    dispatchEnsureBoardDirs(boardDir);
    ensureBgAgentRequestDir(boardDir);
  });
  afterEach(() => {
    try {
      rmSync(path.dirname(boardDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('writeBgAgentRequest persists a v1 record with the manifest-derived prompt', () => {
    const manifest = mkManifest('AISDLC-6000');
    placeManifestInflight(boardDir, manifest);
    const target = writeBgAgentRequest(boardDir, manifest, {
      requestedAt: '2026-05-22T11:00:00.000Z',
      requestedBy: 'conductor-pid-12345',
    });
    expect(existsSync(target)).toBe(true);
    const stored = JSON.parse(readFileSync(target, 'utf-8'));
    expect(stored.schemaVersion).toBe(BG_AGENT_REQUEST_SCHEMA_VERSION);
    expect(stored.taskId).toBe('AISDLC-6000');
    expect(stored.subagentType).toBe('developer');
    expect(stored.worktree).toBe('.worktrees/aisdlc-6000');
    expect(stored.requestedBy).toBe('conductor-pid-12345');
    expect(stored.requestedAt).toBe('2026-05-22T11:00:00.000Z');
    expect(stored.status).toBe('pending');
    expect(stored.prompt).toContain('AISDLC-6000');
    expect(stored.prompt).toContain('.worktrees/aisdlc-6000');
    expect(stored.manifestPath).toMatch(/AISDLC-6000\.dispatch\.json$/);
  });

  it('writeBgAgentRequest throws on duplicate write for the same task', () => {
    const manifest = mkManifest('AISDLC-6001');
    placeManifestInflight(boardDir, manifest);
    writeBgAgentRequest(boardDir, manifest);
    expect(() => writeBgAgentRequest(boardDir, manifest)).toThrow(/already exists/);
  });

  it('readBgAgentRequest returns undefined for an absent task', () => {
    expect(readBgAgentRequest(boardDir, 'AISDLC-NOPE')).toBeUndefined();
  });

  it('readBgAgentRequest round-trips a previously written record', () => {
    const manifest = mkManifest('AISDLC-6002');
    placeManifestInflight(boardDir, manifest);
    writeBgAgentRequest(boardDir, manifest, { requestedBy: 'conductor-A' });
    const stored = readBgAgentRequest(boardDir, 'AISDLC-6002');
    expect(stored).toBeDefined();
    expect(stored?.taskId).toBe('AISDLC-6002');
    expect(stored?.requestedBy).toBe('conductor-A');
  });

  it('listBgAgentRequests sorts oldest-first by requestedAt', () => {
    const m1 = mkManifest('AISDLC-6010');
    const m2 = mkManifest('AISDLC-6011');
    const m3 = mkManifest('AISDLC-6012');
    placeManifestInflight(boardDir, m1);
    placeManifestInflight(boardDir, m2);
    placeManifestInflight(boardDir, m3);
    writeBgAgentRequest(boardDir, m1, { requestedAt: '2026-05-22T12:00:00.000Z' });
    writeBgAgentRequest(boardDir, m2, { requestedAt: '2026-05-22T10:00:00.000Z' });
    writeBgAgentRequest(boardDir, m3, { requestedAt: '2026-05-22T11:00:00.000Z' });
    const requests = listBgAgentRequests(boardDir);
    expect(requests.map((r) => r.taskId)).toEqual(['AISDLC-6011', 'AISDLC-6012', 'AISDLC-6010']);
  });

  it('listBgAgentRequests returns [] when the subdir is missing', () => {
    const freshDir = mkBoard();
    dispatchEnsureBoardDirs(freshDir);
    // Do NOT call ensureBgAgentRequestDir — listing must tolerate absence.
    expect(listBgAgentRequests(freshDir)).toEqual([]);
    rmSync(path.dirname(freshDir), { recursive: true, force: true });
  });

  it('removeBgAgentRequest is idempotent', () => {
    const manifest = mkManifest('AISDLC-6020');
    placeManifestInflight(boardDir, manifest);
    writeBgAgentRequest(boardDir, manifest);
    expect(existsSync(bgAgentRequestPath(boardDir, 'AISDLC-6020'))).toBe(true);
    removeBgAgentRequest(boardDir, 'AISDLC-6020');
    expect(existsSync(bgAgentRequestPath(boardDir, 'AISDLC-6020'))).toBe(false);
    // Second call: no throw, no error.
    expect(() => removeBgAgentRequest(boardDir, 'AISDLC-6020')).not.toThrow();
    // Also tolerates entirely-unknown task IDs.
    expect(() => removeBgAgentRequest(boardDir, 'AISDLC-NOPE')).not.toThrow();
  });

  it('countInFlightBgAgents counts inflight ∪ request, deduplicated by taskId', () => {
    const m1 = mkManifest('AISDLC-6030');
    const m2 = mkManifest('AISDLC-6031');
    placeManifestInflight(boardDir, m1);
    placeManifestInflight(boardDir, m2);
    writeBgAgentRequest(boardDir, m1);
    // m1 has BOTH inflight + request; m2 only inflight. Union = 2.
    expect(countInFlightBgAgents(boardDir)).toBe(2);
  });

  it('countInFlightBgAgents returns 0 on a fresh board', () => {
    expect(countInFlightBgAgents(boardDir)).toBe(0);
  });

  it('pruneOrphanedBgAgentRequests removes requests whose inflight manifest was reaped', () => {
    const healthy = mkManifest('AISDLC-6040');
    const reaped = mkManifest('AISDLC-6041');
    placeManifestInflight(boardDir, healthy);
    const reapedPath = placeManifestInflight(boardDir, reaped);
    writeBgAgentRequest(boardDir, healthy);
    writeBgAgentRequest(boardDir, reaped);
    // Simulate the stale-heartbeat sweeper reaping the manifest.
    rmSync(reapedPath);
    const pruned = pruneOrphanedBgAgentRequests(boardDir);
    expect(pruned).toEqual(['AISDLC-6041']);
    expect(existsSync(bgAgentRequestPath(boardDir, 'AISDLC-6040'))).toBe(true);
    expect(existsSync(bgAgentRequestPath(boardDir, 'AISDLC-6041'))).toBe(false);
  });

  it('buildDevPromptFromManifest mentions taskId, worktree, branch, taskFile, verifyCommands', () => {
    const manifest = mkManifest('AISDLC-6050', {
      spec: {
        taskFile: 'backlog/tasks/aisdlc-6050.md',
        verifyCommands: ['pnpm build', 'pnpm lint'],
      },
    });
    const prompt = buildDevPromptFromManifest(manifest);
    expect(prompt).toContain('AISDLC-6050');
    expect(prompt).toContain('.worktrees/aisdlc-6050');
    expect(prompt).toContain('ai-sdlc/aisdlc-6050');
    expect(prompt).toContain('backlog/tasks/aisdlc-6050.md');
    expect(prompt).toContain('pnpm build');
    expect(prompt).toContain('pnpm lint');
  });

  it('buildDevPromptFromManifest honors the dev standard push+draft-PR contract (Pattern X v2 reconcile)', () => {
    // Pattern X v2 reframe (AISDLC-396 round 2): the prompt MUST NOT tell
    // the dev "DO NOT push" — that fights the developer agent's hardwired
    // Definition-of-Done (developer.md lines 25-36) and was a no-op
    // anyway per feedback_dev_subagents_violate_no_push.md. Instead the
    // prompt:
    //   - reiterates the standard contract (commit + rebase + push +
    //     open PR)
    //   - tells the dev to open the PR as DRAFT so CI doesn't fire
    //     before the Conductor's reconcile attestation lands
    //   - asserts the prUrl field MUST be populated so the Conductor's
    //     Step 3 reconcile can find the PR to flip ready
    const manifest = mkManifest('AISDLC-6060');
    const prompt = buildDevPromptFromManifest(manifest);
    // No "DO NOT push" anti-instruction — the dev's hardwired contract
    // owns push + open PR. (Negative assertion guards against regression
    // back to the v1 framing.)
    expect(prompt).not.toMatch(/DO NOT push/i);
    // Explicit DRAFT instruction.
    expect(prompt).toMatch(/DRAFT/);
    expect(prompt).toMatch(/gh pr create --draft/);
    // prUrl required for reconcile path.
    expect(prompt).toMatch(/prUrl/);
    // Reference to the Conductor's reconcile / attestation chore flow so
    // the dev understands WHY DRAFT (not just WHAT).
    expect(prompt).toMatch(/Conductor/);
    expect(prompt).toMatch(/attestation/);
  });

  it('buildDevPromptFromManifest tolerates empty verifyCommands', () => {
    const manifest = mkManifest('AISDLC-6051', {
      spec: { taskFile: 'backlog/tasks/aisdlc-6051.md', verifyCommands: [] },
    });
    const prompt = buildDevPromptFromManifest(manifest);
    expect(prompt).toContain('no manifest-declared verify commands');
  });
});

// ---------------------------------------------------------------------------
// AC-7 — hermetic 3-task drain simulation (Pattern X v2 reconcile flow).
//
// REFRAME from v1 (AISDLC-396 round 2):
//   v1 modeled "dev returns commit-only verdict; Conductor owns push+PR".
//   v2 models the REAL flow: dev pushes + opens DRAFT PR per its standard
//   contract; verdict carries `prUrl`; Conductor's Step 3 next-tick
//   reconciles by force-pushing the attestation chore commit on top.
//
// We simulate a single autonomous-loop tick:
//   1. Conductor Step 5 emits 3 manifests to inflight/ + 3 bg-agent-requests
//   2. Slash command body Step 2.5 sweeps the requests, fires `Agent`
//      (here stubbed by a verdict-writer that mirrors the real dev's
//      return-envelope-with-prUrl), removes each consumed request
//   3. Conductor's Step 3 verdict pickup finds 3 done/ verdicts each
//      with prUrl set, ready for reviewer fanout + attestation reconcile
//
// The real reviewer fan-out / sign / force-push-chore / flip-draft-ready
// happens in the slash command body's existing Step 3 (orchestrator-tick.md).
// This test asserts only that the Pattern X coordination layer correctly
// stages 3 verdicts WITH prUrl populated for that downstream pickup to
// consume.
// ---------------------------------------------------------------------------

describe('Pattern X — hermetic 3-task drain (AC-7, reconcile flow)', () => {
  let boardDir: string;

  beforeEach(() => {
    boardDir = mkBoard();
    dispatchEnsureBoardDirs(boardDir);
    ensureBgAgentRequestDir(boardDir);
  });
  afterEach(() => {
    try {
      rmSync(path.dirname(boardDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('drains 3 tasks: Conductor emits → sweep fires → devs push+open-PR → verdicts staged for reconcile', () => {
    const taskIds = ['AISDLC-7001', 'AISDLC-7002', 'AISDLC-7003'];

    // === Conductor Step 5 — emit + claim + request ===
    for (const taskId of taskIds) {
      const manifest = mkManifest(taskId);
      placeManifestInflight(boardDir, manifest);
      writeBgAgentRequest(boardDir, manifest, {
        requestedAt: `2026-05-22T10:0${taskIds.indexOf(taskId)}:00.000Z`,
      });
    }
    expect(countInFlightBgAgents(boardDir)).toBe(3);
    expect(listBgAgentRequests(boardDir)).toHaveLength(3);

    // === Slash command body Step 2.5 — sweep, fire Agent, parse return,
    //     write verdict ===
    // In the real flow the "fire Agent" step is the slash command body's
    // `Agent(developer)` call. The dev follows its standard contract:
    // commit → rebase → push --force-with-lease → gh pr create --draft →
    // return JSON envelope with prUrl populated. Step 2.5's reconcile
    // path parses that return and writes the verdict.
    const requests = listBgAgentRequests(boardDir);
    for (const req of requests) {
      // Simulate Agent fire — dev subagent runs, returns success envelope
      // with prUrl populated (the v2 reconcile contract).
      const taskIdLower = req.taskId.toLowerCase();
      dispatchWriteVerdict(boardDir, {
        schemaVersion: 'v1',
        taskId: req.taskId,
        outcome: 'success',
        commitSha: `sha-${taskIdLower}`,
        // Dev DID push (per its standard Definition of Done).
        pushedBranch: `ai-sdlc/${taskIdLower}`,
        // Dev DID open a draft PR (per Pattern X v2 reconcile contract).
        // Conductor's Step 3 will flip draft → ready after attestation.
        prUrl: `https://github.com/org/repo/pull/${1000 + taskIds.indexOf(req.taskId)}`,
        verifications: { build: 'passed', test: 'passed', lint: 'passed' },
        acceptanceCriteriaMet: [1, 2, 3],
        completedAt: new Date().toISOString(),
        workerId: 'in-session-agent-test',
        workerKind: 'in-session-agent',
        durationMs: 60_000,
        iterationsAttempted: 1,
      });
      // Slash command body deletes the consumed request.
      removeBgAgentRequest(boardDir, req.taskId);
    }

    // === Assertions — 3 verdicts staged with prUrl, 0 requests left ===
    expect(listBgAgentRequests(boardDir)).toHaveLength(0);
    for (const taskId of taskIds) {
      const verdictPath = path.join(boardDir, 'done', `${taskId}.verdict.json`);
      expect(existsSync(verdictPath)).toBe(true);
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      expect(verdict.outcome).toBe('success');
      expect(verdict.commitSha).toBe(`sha-${taskId.toLowerCase()}`);
      // Reconcile contract: dev pushed + opened PR; verdict carries both.
      expect(verdict.pushedBranch).toBe(`ai-sdlc/${taskId.toLowerCase()}`);
      expect(verdict.prUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/);
    }
    // The 3 inflight manifests have been cleared by writeVerdict.
    expect(countInFlightBgAgents(boardDir)).toBe(0);
  });

  it('Step 2.5 verdict-write path: Agent return JSON with prUrl populated lands as a success verdict', () => {
    // This test asserts the AC-2 contract: when the bg Agent returns with
    // a populated `prUrl` (v2 reconcile flow), Step 2.5 must correctly
    // translate that into a verdict file with the same prUrl so Step 3
    // can pick it up for attestation force-push + draft→ready flip.
    const manifest = mkManifest('AISDLC-7200');
    placeManifestInflight(boardDir, manifest);
    writeBgAgentRequest(boardDir, manifest);

    // Simulate Step 2.5 parsing the Agent return JSON:
    //   { commitSha: "...", prUrl: "https://github.com/...", ... }
    // and translating it into a DispatchVerdict via dispatchWriteVerdict.
    const agentReturn = {
      commitSha: 'abc1234',
      prUrl: 'https://github.com/org/repo/pull/4321',
      verifications: { build: 'passed' as const, test: 'passed' as const, lint: 'passed' as const },
      acceptanceCriteriaMet: [1, 2, 3, 4],
    };
    dispatchWriteVerdict(boardDir, {
      schemaVersion: 'v1',
      taskId: 'AISDLC-7200',
      outcome: 'success',
      commitSha: agentReturn.commitSha,
      pushedBranch: manifest.branch,
      prUrl: agentReturn.prUrl,
      verifications: agentReturn.verifications,
      acceptanceCriteriaMet: agentReturn.acceptanceCriteriaMet,
      completedAt: '2026-05-22T11:00:00.000Z',
      workerId: 'in-session-agent-test',
      workerKind: 'in-session-agent',
      durationMs: 60_000,
      iterationsAttempted: 1,
    });
    removeBgAgentRequest(boardDir, 'AISDLC-7200');

    const verdictPath = path.join(boardDir, 'done', 'AISDLC-7200.verdict.json');
    expect(existsSync(verdictPath)).toBe(true);
    const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
    expect(verdict.outcome).toBe('success');
    expect(verdict.commitSha).toBe('abc1234');
    expect(verdict.prUrl).toBe('https://github.com/org/repo/pull/4321');
    expect(verdict.pushedBranch).toBe(manifest.branch);
    // The bg-agent-request is consumed so Step 2.5 doesn't double-fire.
    expect(existsSync(bgAgentRequestPath(boardDir, 'AISDLC-7200'))).toBe(false);
  });

  it('cross-session survivability (AC-6): bg-agent-request persists across "session exit"', () => {
    // Simulate Conductor writing a request, then the session dying before
    // the slash command body can fire the Agent call. We then create a
    // fresh "session" (which is just a fresh test scope) reading the same
    // boardDir and asserting the request survives.
    const manifest = mkManifest('AISDLC-7100');
    placeManifestInflight(boardDir, manifest);
    writeBgAgentRequest(boardDir, manifest);

    // --- session "exits" — no further writes, but boardDir persists ---

    // --- fresh "session" starts — reads what was on disk ---
    const surviving = listBgAgentRequests(boardDir);
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.taskId).toBe('AISDLC-7100');
    // Counting still correctly accounts for the un-fired request.
    expect(countInFlightBgAgents(boardDir)).toBe(1);
  });

  it('respects the inSessionAgentMaxSessions cap (AC-5) via library-level check', () => {
    // Pre-populate inflight/ + request files up to cap=4.
    for (let i = 0; i < 4; i++) {
      const m = mkManifest(`AISDLC-72${i.toString().padStart(2, '0')}`);
      placeManifestInflight(boardDir, m);
      writeBgAgentRequest(boardDir, m);
    }
    expect(countInFlightBgAgents(boardDir)).toBe(4);
    // The Conductor's wrapper logic (cli-dispatch dispatch-bg-agent) is
    // what compares this against the cap; here we just assert the count
    // probe gives the correct backpressure signal. The integration with
    // the cap check is covered in dispatch.test.ts's "refuses when the
    // in-flight cap is already saturated" case.
  });
});
