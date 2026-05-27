/**
 * Tests for RFC-0024 Refit Phase 6 — capture lifecycle module (AISDLC-278).
 *
 * AC coverage:
 *   - AC-1  capture-config.yaml schema ships with 4 timeboxes + rate ceiling
 *   - AC-3  Background timer service (runLifecycleTick)
 *   - AC-4  OQ-1 draft auto-submit at 7d (configurable)
 *   - AC-5  OQ-2 pending-triage auto-classify at 14d
 *   - AC-6  OQ-5 unknown-severity auto-classify at 14d
 *   - AC-7  OQ-6 rate-ceiling violation detection
 *   - AC-8  OQ-9 stale ladder: 3d TUI → 7d Slack → 14d email → 21d archive
 *   - AC-9  Archived captures in backlog/captures/archived/ + classifier guess
 *   - AC-10 All auto-actions reversible (reactivateCapture tested)
 *   - AC-11 Integration test: capture progresses through full lifecycle ladder
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateCaptureId, type CaptureRecord } from './capture-record.js';
import {
  resolveDraftsDir,
  resolveSubmittedDir,
  writeDraftCaptureFile,
  writeSubmittedCaptureFile,
} from './draft-capture.js';
import {
  LIFECYCLE_DEFAULTS,
  archiveCapture,
  captureAgeDays,
  captureAgeMs,
  checkDraftExpiry,
  checkPendingTriageExpiry,
  checkRateCeiling,
  checkStaleLadder,
  checkUnknownSeverityExpiry,
  hasAuditAction,
  loadArchivedCaptures,
  loadCaptureLifecycleConfig,
  reactivateCapture,
  resolveArchivedDir,
  resolveNotificationsDir,
  runLifecycleTick,
  updateSubmittedCapture,
  type CaptureLifecycleConfig,
} from './capture-lifecycle.js';
import { FakeLlmInvoker } from '../classifier/substrate/fake-invoker.js';

// ── Test fixture setup ────────────────────────────────────────────────────────

let tmp: string;
let savedRepoRoot: string | undefined;
let savedArtifactsDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aisdlc-278-lifecycle-'));
  savedRepoRoot = process.env.CAPTURE_REPO_ROOT;
  savedArtifactsDir = process.env.ARTIFACTS_DIR;
  process.env.CAPTURE_REPO_ROOT = tmp;
  process.env.ARTIFACTS_DIR = join(tmp, '_artifacts');
  // Ensure required directories exist.
  mkdirSync(join(tmp, '.ai-sdlc'), { recursive: true });
  mkdirSync(join(tmp, 'backlog', 'captures'), { recursive: true });
  mkdirSync(join(tmp, '.ai-sdlc', 'captures-drafts'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (savedRepoRoot === undefined) {
    delete process.env.CAPTURE_REPO_ROOT;
  } else {
    process.env.CAPTURE_REPO_ROOT = savedRepoRoot;
  }
  if (savedArtifactsDir === undefined) {
    delete process.env.ARTIFACTS_DIR;
  } else {
    process.env.ARTIFACTS_DIR = savedArtifactsDir;
  }
});

function makeRecord(overrides: Partial<CaptureRecord> = {}): CaptureRecord {
  const now = new Date('2026-05-01T12:00:00Z');
  const id = generateCaptureId(now);
  return {
    id,
    schemaVersion: 'v1',
    timestamp: now.toISOString(),
    finding: 'test finding: auth middleware missing refresh',
    severity: 'unknown',
    triage: 'tbd',
    source: { type: 'operator', agentRole: null, operator: 'test@example.com' },
    evidence: {},
    relatedIssueId: null,
    extensionTargetIssueId: null,
    featureIssueCarveRef: null,
    blocksIssueId: null,
    createdIssueId: null,
    createdFeatureIssueId: null,
    resolvedAt: null,
    resolvedBy: null,
    auditTrail: [{ action: 'captured', by: 'test@example.com', at: now.toISOString() }],
    ...overrides,
  };
}

function makeAgentRecord(
  agentRole: string,
  submittedAt: string,
  overrides: Partial<CaptureRecord> = {},
): CaptureRecord {
  const ts = '2026-05-01T12:00:00Z';
  const id = generateCaptureId(new Date(ts));
  return {
    id,
    schemaVersion: 'v1',
    timestamp: ts,
    finding: `finding from ${agentRole}`,
    severity: 'unknown',
    triage: 'tbd',
    source: {
      type: 'ai-agent',
      agentRole: agentRole as CaptureRecord['source']['agentRole'],
      operator: null,
    },
    evidence: {},
    relatedIssueId: null,
    extensionTargetIssueId: null,
    featureIssueCarveRef: null,
    blocksIssueId: null,
    createdIssueId: null,
    createdFeatureIssueId: null,
    resolvedAt: null,
    resolvedBy: null,
    auditTrail: [
      { action: 'captured', by: agentRole, at: ts },
      { action: 'submitted', by: agentRole, at: submittedAt },
    ],
    ...overrides,
  };
}

// ── AC-1: loadCaptureLifecycleConfig ─────────────────────────────────────────

describe('loadCaptureLifecycleConfig', () => {
  it('returns LIFECYCLE_DEFAULTS when no config file exists', () => {
    const config = loadCaptureLifecycleConfig(tmp);
    expect(config.draftAutoSubmitDays).toBe(7);
    expect(config.pendingTriageDays).toBe(14);
    expect(config.unknownSeverityDays).toBe(14);
    expect(config.staleNotificationLadder.tuiHighlightDays).toBe(3);
    expect(config.staleNotificationLadder.slackDmDays).toBe(7);
    expect(config.staleNotificationLadder.emailDigestDays).toBe(14);
    expect(config.staleNotificationLadder.autoArchiveDays).toBe(21);
    expect(config.rateCeiling.dailyCapPerAgentRole).toBe(50);
  });

  it('merges per-org overrides with defaults', () => {
    const yaml = `
capture:
  lifecycle:
    draftAutoSubmitDays: 3
    pendingTriageDays: 7
    staleNotificationLadder:
      slackDmDays: 5
    rateCeiling:
      dailyCapPerAgentRole: 100
      perAgentRoleOverrides:
        security-reviewer: 10
`;
    writeFileSync(join(tmp, '.ai-sdlc', 'capture-config.yaml'), yaml, 'utf8');
    const config = loadCaptureLifecycleConfig(tmp);
    expect(config.draftAutoSubmitDays).toBe(3);
    expect(config.pendingTriageDays).toBe(7);
    expect(config.unknownSeverityDays).toBe(14); // unchanged default
    expect(config.staleNotificationLadder.slackDmDays).toBe(5);
    expect(config.staleNotificationLadder.tuiHighlightDays).toBe(3); // unchanged
    expect(config.rateCeiling.dailyCapPerAgentRole).toBe(100);
    expect(config.rateCeiling.perAgentRoleOverrides['security-reviewer']).toBe(10);
  });

  it('ignores invalid (non-positive) values and falls back to defaults', () => {
    const yaml = `
capture:
  lifecycle:
    draftAutoSubmitDays: -1
    pendingTriageDays: 0
`;
    writeFileSync(join(tmp, '.ai-sdlc', 'capture-config.yaml'), yaml, 'utf8');
    const config = loadCaptureLifecycleConfig(tmp);
    expect(config.draftAutoSubmitDays).toBe(7); // default
    expect(config.pendingTriageDays).toBe(14); // default
  });
});

// ── Helper functions ──────────────────────────────────────────────────────────

describe('captureAgeMs + captureAgeDays', () => {
  it('computes age correctly', () => {
    const record = makeRecord({ timestamp: '2026-05-01T00:00:00Z' });
    const now = new Date('2026-05-08T00:00:00Z'); // 7 days later
    expect(captureAgeMs(record, now)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(captureAgeDays(record, now)).toBe(7);
  });
});

describe('hasAuditAction', () => {
  it('returns true when action exists in audit trail', () => {
    const record = makeRecord({
      auditTrail: [
        { action: 'captured', by: 'test', at: '2026-05-01T00:00:00Z' },
        { action: 'stale-3d-tui-notified', by: 'framework', at: '2026-05-04T00:00:00Z' },
      ],
    });
    expect(hasAuditAction(record, 'stale-3d-tui-notified')).toBe(true);
    expect(hasAuditAction(record, 'stale-7d-slack-notified')).toBe(false);
  });
});

// ── AC-4: OQ-1 draft auto-submit ─────────────────────────────────────────────

describe('checkDraftExpiry (AC-4)', () => {
  it('auto-submits drafts older than draftAutoSubmitDays', () => {
    // Draft captured 8 days ago — exceeds the 7d default.
    const oldRecord = makeRecord({ timestamp: '2026-05-01T00:00:00Z' });
    writeDraftCaptureFile(oldRecord, tmp);

    // Draft captured 2 days ago — should not be submitted yet.
    const recentId = generateCaptureId(new Date('2026-05-07T00:00:00Z'));
    const recentRecord = makeRecord({
      id: recentId,
      timestamp: '2026-05-07T00:00:00Z',
    });
    writeDraftCaptureFile(recentRecord, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = checkDraftExpiry({ repoRoot: tmp, now });

    expect(result.submitted).toContain(oldRecord.id);
    expect(result.submitted).not.toContain(recentRecord.id);

    // Verify old draft was moved to submitted.
    const submittedDir = resolveSubmittedDir(tmp);
    expect(existsSync(join(submittedDir, `${oldRecord.id}.md`))).toBe(true);
    // Drafts dir should not contain old record.
    const draftsDir = resolveDraftsDir(tmp);
    expect(existsSync(join(draftsDir, `${oldRecord.id}.md`))).toBe(false);
    // Recent draft should still be in drafts.
    expect(existsSync(join(draftsDir, `${recentRecord.id}.md`))).toBe(true);
  });

  it('respects configurable draftAutoSubmitDays override', () => {
    const yaml = `capture:\n  lifecycle:\n    draftAutoSubmitDays: 3\n`;
    writeFileSync(join(tmp, '.ai-sdlc', 'capture-config.yaml'), yaml, 'utf8');

    // Draft captured 4 days ago — exceeds the 3d config.
    const record = makeRecord({ timestamp: '2026-05-05T00:00:00Z' });
    writeDraftCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = checkDraftExpiry({ repoRoot: tmp, now });

    expect(result.submitted).toContain(record.id);
  });
});

// ── AC-5: OQ-2 pending-triage auto-classify ───────────────────────────────────

describe('checkPendingTriageExpiry (AC-5)', () => {
  it('marks expiry without invoker when threshold exceeded', async () => {
    const record = makeRecord({ timestamp: '2026-04-15T00:00:00Z' }); // 24d ago
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkPendingTriageExpiry({ repoRoot: tmp, now, invoker: null });

    expect(result.classified.length).toBe(1);
    expect(result.classified[0].applied).toBe(false);
    expect(result.classified[0].reason).toContain('invoker not configured');

    // Verify audit entry was written.
    const submittedDir = resolveSubmittedDir(tmp);
    const content = readFileSync(join(submittedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('pending-triage-expired');
  });

  it('auto-classifies when invoker is available and high-confidence', async () => {
    const record = makeRecord({ timestamp: '2026-04-15T00:00:00Z' }); // 24d ago
    writeSubmittedCaptureFile(record, tmp);

    const invoker = new FakeLlmInvoker({
      'capture-triage': {
        classification: 'quick-fix-task',
        confidence: 0.9,
        reasoning: 'Small scope, trivial fix.',
        inputTokens: 0,
        outputTokens: 0,
      },
      'capture-severity': {
        classification: 'low',
        confidence: 0.8,
        reasoning: 'Suggestion-level.',
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkPendingTriageExpiry({
      repoRoot: tmp,
      now,
      invoker,
    });

    expect(result.classified.length).toBe(1);
    expect(result.classified[0].applied).toBe(true);
    expect(result.classified[0].reason).toContain('quick-fix');

    // Verify triage was updated in the file.
    const submittedDir = resolveSubmittedDir(tmp);
    const content = readFileSync(join(submittedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('auto-classified-triage');
    expect(content).toContain('quick-fix');
  });

  it('skips captures not yet expired', async () => {
    const record = makeRecord({ timestamp: '2026-05-07T00:00:00Z' }); // 2d ago
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkPendingTriageExpiry({ repoRoot: tmp, now, invoker: null });

    expect(result.skipped.some((s) => s.id === record.id)).toBe(true);
    expect(result.classified.some((c) => c.id === record.id)).toBe(false);
  });

  it('ignores captures that already have terminal triage', async () => {
    const record = makeRecord({
      timestamp: '2026-04-15T00:00:00Z',
      triage: 'new-issue', // already resolved — not a candidate for pending-triage expiry
    });
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkPendingTriageExpiry({ repoRoot: tmp, now, invoker: null });

    // Non-tbd captures are silently skipped; they never appear in classified.
    expect(result.classified.every((c) => c.id !== record.id)).toBe(true);
    // They may or may not appear in skipped — the key invariant is they're not classified.
  });
});

// ── AC-6: OQ-5 unknown-severity auto-classify ────────────────────────────────

describe('checkUnknownSeverityExpiry (AC-6)', () => {
  it('marks expiry without invoker when threshold exceeded', async () => {
    const record = makeRecord({
      timestamp: '2026-04-15T00:00:00Z',
      triage: 'new-issue', // terminal triage, but severity unknown
    });
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkUnknownSeverityExpiry({ repoRoot: tmp, now, invoker: null });

    expect(result.classified.length).toBe(1);
    expect(result.classified[0].applied).toBe(false);

    const submittedDir = resolveSubmittedDir(tmp);
    const content = readFileSync(join(submittedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('unknown-severity-expired');
  });

  it('auto-classifies severity when invoker is available and high-confidence', async () => {
    const record = makeRecord({
      timestamp: '2026-04-15T00:00:00Z',
      triage: 'new-issue',
      severity: 'unknown',
    });
    writeSubmittedCaptureFile(record, tmp);

    const invoker = new FakeLlmInvoker({
      'capture-severity': {
        classification: 'high',
        confidence: 0.85,
        reasoning: 'Breaking change in auth flow.',
        inputTokens: 0,
        outputTokens: 0,
      },
      'capture-triage': {
        classification: 'tbd',
        confidence: 0.3,
        reasoning: 'unclear',
        inputTokens: 0,
        outputTokens: 0,
      },
    });

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkUnknownSeverityExpiry({ repoRoot: tmp, now, invoker });

    expect(result.classified[0].applied).toBe(true);
    expect(result.classified[0].reason).toContain('major');

    const submittedDir = resolveSubmittedDir(tmp);
    const content = readFileSync(join(submittedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('auto-classified-severity');
  });
});

// ── AC-7: OQ-6 rate ceiling ───────────────────────────────────────────────────

describe('checkRateCeiling (AC-7)', () => {
  it('returns empty when no agent captures today', () => {
    const violations = checkRateCeiling({ repoRoot: tmp });
    expect(violations).toEqual([]);
  });

  it('returns violation when agent exceeds ceiling', () => {
    const today = '2026-05-09';
    const config: CaptureLifecycleConfig = {
      ...LIFECYCLE_DEFAULTS,
      rateCeiling: {
        dailyCapPerAgentRole: 2,
        perAgentRoleOverrides: {},
      },
    };

    // Write 3 captures submitted today by code-reviewer.
    for (let i = 0; i < 3; i++) {
      const ts = `2026-05-0${i + 1}T12:00:00Z`;
      const id = generateCaptureId(new Date(ts));
      const record = makeAgentRecord('code-reviewer', `${today}T10:00:00Z`, {
        id,
        timestamp: ts,
      });
      writeSubmittedCaptureFile(record, tmp);
    }

    const now = new Date(`${today}T23:00:00Z`);
    const violations = checkRateCeiling({ config, repoRoot: tmp, now });

    expect(violations.length).toBe(1);
    expect(violations[0].agentRole).toBe('code-reviewer');
    expect(violations[0].dailyCount).toBe(3);
    expect(violations[0].ceiling).toBe(2);
  });

  it('respects per-role overrides', () => {
    const today = '2026-05-09';
    const config: CaptureLifecycleConfig = {
      ...LIFECYCLE_DEFAULTS,
      rateCeiling: {
        dailyCapPerAgentRole: 50,
        perAgentRoleOverrides: {
          'security-reviewer': 2,
        },
      },
    };

    for (let i = 0; i < 3; i++) {
      const ts = `2026-05-0${i + 1}T12:00:00Z`;
      const id = generateCaptureId(new Date(ts));
      const record = makeAgentRecord('security-reviewer', `${today}T10:00:0${i}Z`, {
        id,
        timestamp: ts,
      });
      writeSubmittedCaptureFile(record, tmp);
    }

    const now = new Date(`${today}T23:00:00Z`);
    const violations = checkRateCeiling({ config, repoRoot: tmp, now });

    expect(violations.length).toBe(1);
    expect(violations[0].agentRole).toBe('security-reviewer');
    expect(violations[0].ceiling).toBe(2);
  });
});

// ── AC-8: OQ-9 stale ladder ───────────────────────────────────────────────────

describe('checkStaleLadder (AC-8)', () => {
  it('fires tui-highlight for 3d-old captures', async () => {
    const record = makeRecord({ timestamp: '2026-05-06T00:00:00Z' }); // 3d ago
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkStaleLadder({ repoRoot: tmp, now });

    const action = result.actions.find((a) => a.captureId === record.id);
    expect(action?.action).toBe('tui-highlight');
    expect(action?.alreadyApplied).toBe(false);

    // Check audit entry was written.
    const submittedDir = resolveSubmittedDir(tmp);
    const content = readFileSync(join(submittedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('stale-3d-tui-notified');
  });

  it('fires slack-notify for 7d-old captures', async () => {
    const record = makeRecord({ timestamp: '2026-05-02T00:00:00Z' }); // 7d ago
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkStaleLadder({ repoRoot: tmp, now });

    const action = result.actions.find((a) => a.captureId === record.id);
    expect(action?.action).toBe('slack-notify');

    // Check Slack notification file was written.
    const notifDir = resolveNotificationsDir(join(tmp, '_artifacts'));
    const slackFile = join(notifDir, 'slack-pending.jsonl');
    expect(existsSync(slackFile)).toBe(true);
    const content = readFileSync(slackFile, 'utf8');
    expect(content).toContain('capture-stale-7d');
    expect(content).toContain(record.id);
  });

  it('fires email-notify for 14d-old captures', async () => {
    const record = makeRecord({ timestamp: '2026-04-25T00:00:00Z' }); // 14d ago
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkStaleLadder({ repoRoot: tmp, now });

    const action = result.actions.find((a) => a.captureId === record.id);
    expect(action?.action).toBe('email-notify');

    const notifDir = resolveNotificationsDir(join(tmp, '_artifacts'));
    const emailFile = join(notifDir, 'email-digest-pending.jsonl');
    expect(existsSync(emailFile)).toBe(true);
    const content = readFileSync(emailFile, 'utf8');
    expect(content).toContain('capture-stale-14d');
  });

  it('archives for 21d-old captures (AC-9)', async () => {
    const record = makeRecord({ timestamp: '2026-04-18T00:00:00Z' }); // 21d ago
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkStaleLadder({ repoRoot: tmp, now });

    const action = result.actions.find((a) => a.captureId === record.id);
    expect(action?.action).toBe('archive');
    expect(result.archived).toContain(record.id);

    // Verify file moved to archived dir.
    const archivedDir = resolveArchivedDir(tmp);
    expect(existsSync(join(archivedDir, `${record.id}.md`))).toBe(true);
    // Verify removed from submitted dir.
    const submittedDir = resolveSubmittedDir(tmp);
    expect(existsSync(join(submittedDir, `${record.id}.md`))).toBe(false);

    // Check audit trail in archived file.
    const content = readFileSync(join(archivedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('"archived"');
  });

  it('archives include classifier guess when invoker available (AC-9)', async () => {
    const record = makeRecord({ timestamp: '2026-04-18T00:00:00Z' });
    writeSubmittedCaptureFile(record, tmp);

    const invoker = new FakeLlmInvoker({
      'capture-triage': {
        classification: 'not-actionable' as unknown as 'quick-fix-task',
        confidence: 0.8,
        reasoning: 'Not worth tracking.',
        model: 'claude-haiku-4-5',
      },
      'capture-severity': {
        classification: 'low',
        confidence: 0.7,
        reasoning: 'Trivial.',
        model: 'claude-haiku-4-5',
      },
    } as unknown as ConstructorParameters<typeof FakeLlmInvoker>[0]);

    const now = new Date('2026-05-09T00:00:00Z');
    await checkStaleLadder({ repoRoot: tmp, now, invoker });

    const archivedDir = resolveArchivedDir(tmp);
    const content = readFileSync(join(archivedDir, `${record.id}.md`), 'utf8');
    // Classifier guess should be present in the audit entry.
    expect(content).toContain('classifierGuessTriage');
  });

  it('is idempotent — does not re-fire notifications', async () => {
    const record = makeRecord({ timestamp: '2026-05-02T00:00:00Z' }); // 7d ago
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result1 = await checkStaleLadder({ repoRoot: tmp, now });
    const result2 = await checkStaleLadder({ repoRoot: tmp, now });

    const action1 = result1.actions.find((a) => a.captureId === record.id);
    const action2 = result2.actions.find((a) => a.captureId === record.id);

    expect(action1?.alreadyApplied).toBe(false);
    expect(action2?.alreadyApplied).toBe(true);

    // Notifications file should only have one entry.
    const notifDir = resolveNotificationsDir(join(tmp, '_artifacts'));
    const content = readFileSync(join(notifDir, 'slack-pending.jsonl'), 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('does not affect non-tbd captures', async () => {
    const record = makeRecord({
      timestamp: '2026-04-18T00:00:00Z',
      triage: 'new-issue',
    });
    writeSubmittedCaptureFile(record, tmp);

    const now = new Date('2026-05-09T00:00:00Z');
    const result = await checkStaleLadder({ repoRoot: tmp, now });

    expect(result.actions.find((a) => a.captureId === record.id)).toBeUndefined();
    expect(result.archived).not.toContain(record.id);
  });
});

// ── AC-9: archiveCapture + loadArchivedCaptures ───────────────────────────────

describe('archiveCapture + loadArchivedCaptures (AC-9)', () => {
  it('moves capture from submitted to archived dir', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);

    const archived = archiveCapture({ captureId: record.id, repoRoot: tmp });

    expect(hasAuditAction(archived, 'archived')).toBe(true);

    const archivedDir = resolveArchivedDir(tmp);
    expect(existsSync(join(archivedDir, `${record.id}.md`))).toBe(true);

    const submittedDir = resolveSubmittedDir(tmp);
    expect(existsSync(join(submittedDir, `${record.id}.md`))).toBe(false);
  });

  it('attaches classifier guess when provided', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);

    archiveCapture({
      captureId: record.id,
      classifierGuess: { triage: 'quick-fix', severity: 'minor', reasoning: 'trivial' },
      repoRoot: tmp,
    });

    const archivedDir = resolveArchivedDir(tmp);
    const content = readFileSync(join(archivedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('classifierGuessTriage');
    expect(content).toContain('quick-fix');
  });

  it('loadArchivedCaptures reads archived dir', () => {
    const r1 = makeRecord();
    const r2Id = generateCaptureId(new Date('2026-05-02T00:00:00Z'));
    const r2 = makeRecord({ id: r2Id, timestamp: '2026-05-02T00:00:00Z' });
    writeSubmittedCaptureFile(r1, tmp);
    writeSubmittedCaptureFile(r2, tmp);
    archiveCapture({ captureId: r1.id, repoRoot: tmp });
    archiveCapture({ captureId: r2.id, repoRoot: tmp });

    const archived = loadArchivedCaptures(tmp);
    expect(archived.length).toBe(2);
    expect(archived.map((r) => r.id)).toContain(r1.id);
  });

  it('returns empty array when archived dir missing', () => {
    const archived = loadArchivedCaptures(tmp);
    expect(archived).toEqual([]);
  });
});

// ── AC-10: Reversibility — reactivateCapture ──────────────────────────────────

describe('reactivateCapture (AC-10)', () => {
  it('moves capture from archived back to submitted dir', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);
    archiveCapture({ captureId: record.id, repoRoot: tmp });

    const reactivated = reactivateCapture({
      captureId: record.id,
      by: 'operator@example.com',
      reason: 'Operator decided to revisit this finding',
      repoRoot: tmp,
    });

    expect(hasAuditAction(reactivated, 're-activated')).toBe(true);

    const submittedDir = resolveSubmittedDir(tmp);
    expect(existsSync(join(submittedDir, `${record.id}.md`))).toBe(true);

    const archivedDir = resolveArchivedDir(tmp);
    expect(existsSync(join(archivedDir, `${record.id}.md`))).toBe(false);
  });

  it('throws when capture is not in archive', () => {
    expect(() =>
      reactivateCapture({ captureId: 'cap_2026-05-01T00-00-00_aaaaaa', repoRoot: tmp }),
    ).toThrow('not found in archive');
  });
});

// ── AC-11: Integration test — full lifecycle ladder ───────────────────────────

describe('Integration: full lifecycle ladder (AC-11)', () => {
  it('processes a capture through the complete §15.1 lifecycle', async () => {
    // Create a config with aggressive timeboxes for testing.
    const yaml = `
capture:
  lifecycle:
    draftAutoSubmitDays: 2
    pendingTriageDays: 5
    unknownSeverityDays: 5
    staleNotificationLadder:
      tuiHighlightDays: 1
      slackDmDays: 3
      emailDigestDays: 5
      autoArchiveDays: 7
    rateCeiling:
      dailyCapPerAgentRole: 2
`;
    writeFileSync(join(tmp, '.ai-sdlc', 'capture-config.yaml'), yaml, 'utf8');

    // T+0: Capture filed as a draft.
    const capturedAt = new Date('2026-05-01T00:00:00Z');
    const record = makeRecord({ timestamp: capturedAt.toISOString() });
    writeDraftCaptureFile(record, tmp);

    // ── T+3d: Draft auto-submit should fire (threshold=2d). ──
    const day3 = new Date('2026-05-04T00:00:00Z');
    const tick1 = await runLifecycleTick({ repoRoot: tmp, now: day3, invoker: null });
    expect(tick1.submittedDrafts).toContain(record.id);

    // Now it's in submitted dir.
    expect(existsSync(join(resolveSubmittedDir(tmp), `${record.id}.md`))).toBe(true);

    // ── T+6d: Pending-triage expiry fires (threshold=5d). ──
    const day6 = new Date('2026-05-07T00:00:00Z');
    const tick2 = await runLifecycleTick({ repoRoot: tmp, now: day6, invoker: null });
    expect(tick2.pendingTriageAutoClassified.classified.some((c) => c.id === record.id)).toBe(true);

    // ── T+6d: Stale ladder email-notify fires (threshold=5d). ──
    expect(
      tick2.staleLadder.actions.some(
        (a) => a.captureId === record.id && a.action === 'email-notify',
      ),
    ).toBe(true);

    // ── T+8d: Archive fires (threshold=7d). ──
    const day8 = new Date('2026-05-09T00:00:00Z');
    const tick3 = await runLifecycleTick({ repoRoot: tmp, now: day8, invoker: null });
    expect(tick3.staleLadder.archived).toContain(record.id);

    // Verify final state: capture is in archived dir, not submitted.
    const archivedDir = resolveArchivedDir(tmp);
    expect(existsSync(join(archivedDir, `${record.id}.md`))).toBe(true);
    expect(existsSync(join(resolveSubmittedDir(tmp), `${record.id}.md`))).toBe(false);

    // ── Reversibility: re-activate and verify. ──
    const reactivated = reactivateCapture({ captureId: record.id, repoRoot: tmp });
    expect(hasAuditAction(reactivated, 're-activated')).toBe(true);
    expect(existsSync(join(resolveSubmittedDir(tmp), `${record.id}.md`))).toBe(true);
    expect(existsSync(join(archivedDir, `${record.id}.md`))).toBe(false);
  });
});

// ── updateSubmittedCapture ────────────────────────────────────────────────────

describe('updateSubmittedCapture', () => {
  it('updates triage and appends audit entry', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);

    const updated = updateSubmittedCapture({
      captureId: record.id,
      triage: 'quick-fix',
      auditEntry: {
        action: 'triaged',
        by: 'framework',
        at: new Date().toISOString(),
        to: 'quick-fix',
      },
      repoRoot: tmp,
    });

    expect(updated.triage).toBe('quick-fix');
    expect(hasAuditAction(updated, 'triaged')).toBe(true);

    const submittedDir = resolveSubmittedDir(tmp);
    const content = readFileSync(join(submittedDir, `${record.id}.md`), 'utf8');
    expect(content).toContain('quick-fix');
  });

  it('throws when capture not found', () => {
    expect(() =>
      updateSubmittedCapture({
        captureId: 'cap_2026-05-01T00-00-00_aaaaaa',
        auditEntry: { action: 'test', by: 'test', at: new Date().toISOString() },
        repoRoot: tmp,
      }),
    ).toThrow('not found');
  });
});
