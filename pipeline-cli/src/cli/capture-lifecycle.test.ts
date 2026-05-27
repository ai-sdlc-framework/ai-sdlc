/**
 * Tests for `cli/capture-lifecycle.ts` (AISDLC-278).
 *
 * Covers:
 *   1. `renderTickResult` — exported pure function; each OQ branch.
 *   2. `buildCaptureLifecycleCli` — yargs builder; integration tests against
 *      show-config, list-archived, tick --dry-run with stdout/stderr/exit
 *      stubbed (pattern from cli/capture.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LifecycleTickResult } from '../capture/capture-lifecycle.js';
import { renderTickResult, buildCaptureLifecycleCli } from './capture-lifecycle.js';

function emptyResult(): LifecycleTickResult {
  return {
    submittedDrafts: [],
    pendingTriageAutoClassified: { classified: [], skipped: [] },
    unknownSeverityAutoClassified: { classified: [], skipped: [] },
    staleLadder: { actions: [], archived: [], notificationsWritten: 0 },
    rateCeilingViolations: [],
  };
}

describe('renderTickResult — no-op tick', () => {
  it('renders all "none" branches when no expirations fired', () => {
    const out = renderTickResult(emptyResult());
    expect(out).toContain('[cli-capture-lifecycle] tick complete');
    expect(out).toContain('OQ-1 drafts: none expired');
    expect(out).toContain('OQ-2 pending-triage: none expired');
    expect(out).toContain('OQ-5 unknown-severity: none expired');
    expect(out).toContain('OQ-9 stale ladder: no new actions');
    expect(out).toContain('OQ-6 rate ceiling: within bounds');
  });
});

describe('renderTickResult — OQ-1 submittedDrafts', () => {
  it('renders the auto-submit count + per-id list when drafts were submitted', () => {
    const r = emptyResult();
    r.submittedDrafts = ['cap_2026-01-01T00-00-00_aaaaaa', 'cap_2026-01-01T00-00-00_bbbbbb'];
    const out = renderTickResult(r);
    expect(out).toContain('✓ OQ-1 auto-submitted 2 draft(s):');
    expect(out).toContain('cap_2026-01-01T00-00-00_aaaaaa');
    expect(out).toContain('cap_2026-01-01T00-00-00_bbbbbb');
    expect(out).not.toContain('OQ-1 drafts: none expired');
  });
});

describe('renderTickResult — OQ-2 pendingTriage', () => {
  it('renders applied vs skipped branches together', () => {
    const r = emptyResult();
    r.pendingTriageAutoClassified.classified = [
      { id: 'cap_a', applied: true, reason: 'classified to major' },
      { id: 'cap_b', applied: false, reason: 'low confidence; left for operator' },
    ];
    const out = renderTickResult(r);
    expect(out).toContain('✓ OQ-2 auto-classified triage for 1 capture(s):');
    expect(out).toContain('cap_a: classified to major');
    expect(out).toContain('⚠ OQ-2 1 pending-triage capture(s) need attention:');
    expect(out).toContain('cap_b: low confidence');
    expect(out).not.toContain('OQ-2 pending-triage: none expired');
  });

  it('renders only the warning branch when all entries were skipped', () => {
    const r = emptyResult();
    r.pendingTriageAutoClassified.classified = [
      { id: 'cap_c', applied: false, reason: 'no invoker configured' },
    ];
    const out = renderTickResult(r);
    expect(out).not.toContain('✓ OQ-2 auto-classified');
    expect(out).toContain('⚠ OQ-2 1 pending-triage capture(s) need attention:');
    expect(out).toContain('cap_c: no invoker configured');
  });
});

describe('renderTickResult — OQ-5 unknownSeverity', () => {
  it('renders applied + skipped severity classifications', () => {
    const r = emptyResult();
    r.unknownSeverityAutoClassified.classified = [
      { id: 'cap_x', applied: true, reason: 'severity → major' },
      { id: 'cap_y', applied: false, reason: 'confidence below threshold' },
    ];
    const out = renderTickResult(r);
    expect(out).toContain('✓ OQ-5 auto-classified severity for 1 capture(s):');
    expect(out).toContain('cap_x: severity → major');
    expect(out).toContain('⚠ OQ-5 1 unknown-severity capture(s) need attention:');
    expect(out).toContain('cap_y: confidence below threshold');
    expect(out).not.toContain('OQ-5 unknown-severity: none expired');
  });
});

describe('renderTickResult — OQ-9 staleLadder', () => {
  it('renders fresh actions + archived count when ladder fired', () => {
    const r = emptyResult();
    r.staleLadder.actions = [
      { captureId: 'cap_p', ageDays: 3, action: 'tui-highlight', alreadyApplied: false },
      { captureId: 'cap_q', ageDays: 21, action: 'archive', alreadyApplied: false },
      { captureId: 'cap_r', ageDays: 7, action: 'slack-notify', alreadyApplied: true },
    ];
    r.staleLadder.archived = ['cap_q'];
    const out = renderTickResult(r);
    // Only fresh (not-already-applied) actions appear in the action count
    expect(out).toContain('OQ-9 stale ladder — 2 action(s) fired:');
    expect(out).toContain('cap_p: tui-highlight (3d old)');
    expect(out).toContain('cap_q: archive (21d old)');
    expect(out).not.toContain('cap_r: slack-notify');
    expect(out).toContain('✓ Archived 1 capture(s) → backlog/captures/archived/');
  });

  it('renders the no-action branch + skips archive line when nothing archived', () => {
    const out = renderTickResult(emptyResult());
    expect(out).toContain('OQ-9 stale ladder: no new actions');
    expect(out).not.toContain('Archived');
  });
});

describe('renderTickResult — OQ-6 rate ceiling', () => {
  it('renders per-role violations with daily count + ceiling', () => {
    const r = emptyResult();
    r.rateCeilingViolations = [
      { agentRole: 'classifier-bot', dailyCount: 12, ceiling: 10 },
      { agentRole: 'pr-comment-syncer', dailyCount: 50, ceiling: 30 },
    ];
    const out = renderTickResult(r);
    expect(out).toContain('⚠ OQ-6 rate ceiling exceeded for 2 role(s):');
    expect(out).toContain('classifier-bot: 12 today (ceiling: 10)');
    expect(out).toContain('pr-comment-syncer: 50 today (ceiling: 30)');
    expect(out).not.toContain('OQ-6 rate ceiling: within bounds');
  });
});

// ── buildCaptureLifecycleCli integration tests ────────────────────────────────
//
// Mirrors the pattern from cli/capture.test.ts: stub process.argv / .stdout
// / .stderr / .exit, set CAPTURE_REPO_ROOT + AI_SDLC_EMERGENT_CAPTURE, then
// drive the yargs program in-process.

describe('buildCaptureLifecycleCli — yargs integration', () => {
  let tmp: string;
  let savedArgv: string[];
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let savedWrite: typeof process.stdout.write;
  let savedErrWrite: typeof process.stderr.write;
  let savedExit: typeof process.exit;
  let savedEnvCapture: string | undefined;
  let savedEnvRepoRoot: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cli-capture-lifecycle-'));
    mkdirSync(join(tmp, 'backlog', 'captures', 'archived'), { recursive: true });
    mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
    savedArgv = process.argv;
    stdoutChunks = [];
    stderrChunks = [];
    savedWrite = process.stdout.write.bind(process.stdout);
    savedErrWrite = process.stderr.write.bind(process.stderr);
    savedExit = process.exit;
    savedEnvCapture = process.env.AI_SDLC_EMERGENT_CAPTURE;
    savedEnvRepoRoot = process.env.CAPTURE_REPO_ROOT;

    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    process.env.AI_SDLC_EMERGENT_CAPTURE = 'experimental';
    process.env.CAPTURE_REPO_ROOT = tmp;
  });

  afterEach(() => {
    process.argv = savedArgv;
    process.stdout.write = savedWrite;
    process.stderr.write = savedErrWrite;
    process.exit = savedExit;
    if (savedEnvCapture === undefined) delete process.env.AI_SDLC_EMERGENT_CAPTURE;
    else process.env.AI_SDLC_EMERGENT_CAPTURE = savedEnvCapture;
    if (savedEnvRepoRoot === undefined) delete process.env.CAPTURE_REPO_ROOT;
    else process.env.CAPTURE_REPO_ROOT = savedEnvRepoRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses every subcommand that requires the feature flag when it is unset', async () => {
    delete process.env.AI_SDLC_EMERGENT_CAPTURE;
    process.argv = ['node', 'cli-capture-lifecycle', 'tick', '--format', 'json'];
    await expect(buildCaptureLifecycleCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    const err = stderrChunks.join('');
    expect(err).toContain('emergent capture is not enabled');
    expect(err).toContain('AI_SDLC_EMERGENT_CAPTURE=experimental');
  });

  it('show-config emits JSON when --format json', async () => {
    process.argv = ['node', 'cli-capture-lifecycle', 'show-config', '--format', 'json'];
    await buildCaptureLifecycleCli().parseAsync();
    const stdout = stdoutChunks.join('');
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('config');
    expect(parsed).toHaveProperty('defaults');
    expect(parsed.config).toHaveProperty('draftAutoSubmitDays');
    expect(parsed.config).toHaveProperty('staleNotificationLadder');
    expect(parsed.config).toHaveProperty('rateCeiling');
  });

  it('show-config emits human-readable table when --format defaults to table', async () => {
    process.argv = ['node', 'cli-capture-lifecycle', 'show-config'];
    await buildCaptureLifecycleCli().parseAsync();
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('resolved lifecycle config');
    expect(stdout).toContain('draftAutoSubmitDays:');
    expect(stdout).toContain('pendingTriageDays:');
    expect(stdout).toContain('staleNotificationLadder:');
    expect(stdout).toContain('rateCeiling:');
  });

  it('list-archived emits the "(no archived captures)" branch on an empty archive dir', async () => {
    process.argv = ['node', 'cli-capture-lifecycle', 'list-archived'];
    await buildCaptureLifecycleCli().parseAsync();
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('(no archived captures)');
  });

  it('list-archived emits JSON {archived, count:0} on empty archive dir with --format json', async () => {
    process.argv = ['node', 'cli-capture-lifecycle', 'list-archived', '--format', 'json'];
    await buildCaptureLifecycleCli().parseAsync();
    const stdout = stdoutChunks.join('');
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual({ archived: [], count: 0 });
  });

  it('tick --dry-run prints config + exits without running tick logic', async () => {
    process.argv = ['node', 'cli-capture-lifecycle', 'tick', '--dry-run'];
    await buildCaptureLifecycleCli().parseAsync();
    const stdout = stdoutChunks.join('');
    expect(stdout).toContain('dry-run');
    expect(stdout).toContain('resolved config');
    // The dry-run path emits the loaded config as JSON; verify the shape lands.
    expect(stdout).toContain('draftAutoSubmitDays');
  });
});
