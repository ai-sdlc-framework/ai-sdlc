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
    // Explicit DO NOT push/PR contract — Conductor owns those steps.
    expect(prompt).toMatch(/DO NOT push or open a PR/);
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
// AC-7 — hermetic 3-task drain simulation.
//
// We simulate a single autonomous-loop tick:
//   1. Conductor emits 3 manifests to inflight/ + 3 bg-agent-requests
//   2. Slash command body sweeps the requests, fires "Agent" (here: a
//      synthetic verdict-writer), removes each consumed request
//   3. Conductor's next-tick verdict pickup finds 3 done/ verdicts
//
// The real reviewer fan-out / sign / push happens in the slash command
// body's existing Step 3. This test asserts only that the Pattern X
// coordination layer correctly stages 3 verdicts for that downstream
// pickup to consume.
// ---------------------------------------------------------------------------

describe('Pattern X — hermetic 3-task drain (AC-7)', () => {
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

  it('drains 3 tasks: Conductor emits → sweep fires → Workers write verdicts → cleanup', () => {
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

    // === Slash command body Step 2.5 — sweep, fire Agent, write verdict ===
    // In the real flow the "fire Agent" step is the slash command body's
    // `Agent(developer)` call. Here we stub it with the verdict-writer
    // that the `dispatch-worker` Step 5 path uses, mirroring what the dev
    // subagent's success-return triggers.
    const requests = listBgAgentRequests(boardDir);
    for (const req of requests) {
      // Simulate Agent fire — dev subagent runs, returns success envelope.
      dispatchWriteVerdict(boardDir, {
        schemaVersion: 'v1',
        taskId: req.taskId,
        outcome: 'success',
        commitSha: `sha-${req.taskId.toLowerCase()}`,
        pushedBranch: null, // dev didn't push (Conductor owns push)
        prUrl: null, // dev didn't open PR (Conductor opens it)
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

    // === Assertions — 3 verdicts staged, 0 requests left ===
    expect(listBgAgentRequests(boardDir)).toHaveLength(0);
    for (const taskId of taskIds) {
      const verdictPath = path.join(boardDir, 'done', `${taskId}.verdict.json`);
      expect(existsSync(verdictPath)).toBe(true);
      const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
      expect(verdict.outcome).toBe('success');
      expect(verdict.commitSha).toBe(`sha-${taskId.toLowerCase()}`);
    }
    // The 3 inflight manifests have been cleared by writeVerdict.
    expect(countInFlightBgAgents(boardDir)).toBe(0);
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
