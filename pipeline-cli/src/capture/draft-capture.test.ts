/**
 * Unit tests for RFC-0024 Refit Phase 1 (AISDLC-320) — draft-capture module.
 *
 * Covers:
 *   - captureToMarkdown / parseMarkdownCapture round-trip
 *   - writeDraftCaptureFile / writeSubmittedCaptureFile
 *   - submitDraft (move draft → submitted)
 *   - submitAllDrafts (bulk submit)
 *   - discardDraft (hard-delete draft; refuse on submitted)
 *   - loadDraftCaptures / loadSubmittedCaptures
 *   - migrateLegacyCaptures (JSONL → submitted MD)
 *   - redactSubmittedCapture
 *   - getAutoSubmitThreshold (config + default)
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateCaptureId, type CaptureRecord } from './capture-record.js';
import { writeCapture } from './capture-writer.js';
import {
  captureToMarkdown,
  parseMarkdownCapture,
  writeDraftCaptureFile,
  writeSubmittedCaptureFile,
  submitDraft,
  submitAllDrafts,
  discardDraft,
  loadDraftCaptures,
  loadSubmittedCaptures,
  migrateLegacyCaptures,
  redactSubmittedCapture,
  getAutoSubmitThreshold,
  resolveDraftsDir,
  resolveSubmittedDir,
} from './draft-capture.js';

// ── Shared test fixture helpers ───────────────────────────────────────────────

let tmp: string;
let savedRepoRoot: string | undefined;
let savedArtifactsDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'aisdlc-draft-capture-'));
  savedRepoRoot = process.env.CAPTURE_REPO_ROOT;
  savedArtifactsDir = process.env.ARTIFACTS_DIR;
  process.env.CAPTURE_REPO_ROOT = tmp;
  process.env.ARTIFACTS_DIR = tmp;
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
  const now = new Date('2026-05-18T14:30:00Z');
  const id = generateCaptureId(now);
  return {
    id,
    schemaVersion: 'v1',
    timestamp: now.toISOString(),
    finding: 'auth middleware does not refresh tokens',
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

// ── captureToMarkdown / parseMarkdownCapture ──────────────────────────────────

describe('captureToMarkdown + parseMarkdownCapture', () => {
  it('round-trips a capture record through markdown format', () => {
    const record = makeRecord();
    const md = captureToMarkdown(record);
    const parsed = parseMarkdownCapture(md);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(record.id);
    expect(parsed!.finding).toBe(record.finding);
    expect(parsed!.severity).toBe('unknown');
    expect(parsed!.triage).toBe('tbd');
  });

  it('returns null when markdown has no capture:json block', () => {
    const result = parseMarkdownCapture('# Just a heading\n\nNo JSON here.');
    expect(result).toBeNull();
  });

  it('returns null when the JSON block is invalid', () => {
    const md = '<!-- capture:json\nnot-valid-json\n-->\n\n# test\n';
    const result = parseMarkdownCapture(md);
    expect(result).toBeNull();
  });

  it('includes human-readable fields in the markdown body', () => {
    const record = makeRecord({
      finding: 'retry loop missing jitter',
      severity: 'minor',
      source: {
        type: 'operator',
        agentRole: null,
        operator: 'op@example.com',
        context: 'during code review',
      },
      evidence: { filePath: 'src/retry.ts', line: 42, prNumber: 234 },
    });
    const md = captureToMarkdown(record);
    expect(md).toMatch(/retry loop missing jitter/);
    expect(md).toMatch(/\bminor\b/);
    expect(md).toMatch(/\btbd\b/);
    expect(md).toMatch(/op@example\.com/);
    expect(md).toMatch(/during code review/);
    expect(md).toMatch(/src\/retry\.ts:42/);
    expect(md).toMatch(/#234/);
  });

  it('preserves a full CaptureRecord with auditTrail', () => {
    const record = makeRecord({
      triage: 'new-issue',
      resolvedAt: '2026-05-18T15:00:00.000Z',
      resolvedBy: 'op@example.com',
      auditTrail: [
        { action: 'captured', by: 'op@example.com', at: '2026-05-18T14:30:00.000Z' },
        {
          action: 'triaged',
          by: 'op@example.com',
          at: '2026-05-18T15:00:00.000Z',
          to: 'new-issue',
        },
      ],
    });
    const md = captureToMarkdown(record);
    const parsed = parseMarkdownCapture(md);
    expect(parsed!.auditTrail).toHaveLength(2);
    expect(parsed!.resolvedAt).toBe('2026-05-18T15:00:00.000Z');
  });
});

// ── Directory helpers ─────────────────────────────────────────────────────────

describe('resolveDraftsDir / resolveSubmittedDir', () => {
  it('appends .ai-sdlc/captures-drafts to repo root', () => {
    const dir = resolveDraftsDir(tmp);
    expect(dir).toBe(join(tmp, '.ai-sdlc', 'captures-drafts'));
  });

  it('appends backlog/captures to repo root', () => {
    const dir = resolveSubmittedDir(tmp);
    expect(dir).toBe(join(tmp, 'backlog', 'captures'));
  });
});

// ── writeDraftCaptureFile ─────────────────────────────────────────────────────

describe('writeDraftCaptureFile', () => {
  it('creates a .md file in the drafts directory', () => {
    const record = makeRecord();
    writeDraftCaptureFile(record, tmp);
    const expectedPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${record.id}.md`);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('throws on collision (same ID twice)', () => {
    const record = makeRecord();
    writeDraftCaptureFile(record, tmp);
    expect(() => writeDraftCaptureFile(record, tmp)).toThrow(/collision/);
  });

  it('creates the drafts directory if it does not exist', () => {
    const record = makeRecord();
    const dir = resolveDraftsDir(tmp);
    expect(existsSync(dir)).toBe(false);
    writeDraftCaptureFile(record, tmp);
    expect(existsSync(dir)).toBe(true);
  });
});

// ── writeSubmittedCaptureFile ─────────────────────────────────────────────────

describe('writeSubmittedCaptureFile', () => {
  it('creates a .md file in the submitted directory', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);
    const expectedPath = join(tmp, 'backlog', 'captures', `${record.id}.md`);
    expect(existsSync(expectedPath)).toBe(true);
  });

  it('throws on collision', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);
    expect(() => writeSubmittedCaptureFile(record, tmp)).toThrow(/collision/);
  });
});

// ── submitDraft ───────────────────────────────────────────────────────────────

describe('submitDraft', () => {
  it('moves a draft to the submitted directory', () => {
    const record = makeRecord();
    writeDraftCaptureFile(record, tmp);

    const submitted = submitDraft({ captureId: record.id, by: 'op@example.com', repoRoot: tmp });

    expect(submitted.id).toBe(record.id);
    expect(submitted.finding).toBe(record.finding);

    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${record.id}.md`);
    const submittedPath = join(tmp, 'backlog', 'captures', `${record.id}.md`);

    expect(existsSync(draftPath)).toBe(false);
    expect(existsSync(submittedPath)).toBe(true);
  });

  it('appends a submitted audit entry', () => {
    const record = makeRecord();
    writeDraftCaptureFile(record, tmp);

    const submitted = submitDraft({ captureId: record.id, by: 'op@example.com', repoRoot: tmp });

    const lastEntry = submitted.auditTrail[submitted.auditTrail.length - 1];
    expect(lastEntry.action).toBe('submitted');
    expect(lastEntry.by).toBe('op@example.com');
  });

  it('throws when the draft does not exist', () => {
    const id = generateCaptureId(new Date('2026-05-18T10:00:00Z'));
    expect(() => submitDraft({ captureId: id, by: 'op@example.com', repoRoot: tmp })).toThrow(
      /draft not found/,
    );
  });

  it('throws when capture is already submitted with a helpful message', () => {
    const record = makeRecord();
    writeDraftCaptureFile(record, tmp);
    submitDraft({ captureId: record.id, by: 'op@example.com', repoRoot: tmp });

    expect(() =>
      submitDraft({ captureId: record.id, by: 'op@example.com', repoRoot: tmp }),
    ).toThrow(/already submitted/);
  });

  it('throws on invalid captureId', () => {
    expect(() =>
      submitDraft({ captureId: '../../etc/passwd', by: 'op@example.com', repoRoot: tmp }),
    ).toThrow(/invalid captureId/);
  });
});

// ── submitAllDrafts ───────────────────────────────────────────────────────────

describe('submitAllDrafts', () => {
  it('submits all drafts and returns their IDs', () => {
    const r1 = makeRecord({ finding: 'first' });
    const r2 = makeRecord({
      finding: 'second',
      id: generateCaptureId(new Date('2026-05-18T15:00:00Z')),
    });
    writeDraftCaptureFile(r1, tmp);
    writeDraftCaptureFile(r2, tmp);

    const result = submitAllDrafts({ by: 'op@example.com', repoRoot: tmp });

    expect(result.submitted).toHaveLength(2);
    expect(result.failed).toHaveLength(0);

    const draftsDir = resolveDraftsDir(tmp);
    const submittedDir = resolveSubmittedDir(tmp);

    expect(existsSync(join(draftsDir, `${r1.id}.md`))).toBe(false);
    expect(existsSync(join(draftsDir, `${r2.id}.md`))).toBe(false);
    expect(existsSync(join(submittedDir, `${r1.id}.md`))).toBe(true);
    expect(existsSync(join(submittedDir, `${r2.id}.md`))).toBe(true);
  });

  it('returns empty when no drafts exist', () => {
    const result = submitAllDrafts({ repoRoot: tmp });
    expect(result.submitted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('reports non-canonical .md files in failed (not submitted)', () => {
    // Create a .md file with an invalid capture ID format.
    const draftsDir = resolveDraftsDir(tmp);
    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(join(draftsDir, 'not-a-valid-id.md'), '# junk\n', 'utf8');

    const result = submitAllDrafts({ repoRoot: tmp });
    expect(result.submitted).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/invalid captureId/);
  });

  it('skips .gitkeep files silently', () => {
    const draftsDir = resolveDraftsDir(tmp);
    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(join(draftsDir, '.gitkeep'), '', 'utf8');

    const result = submitAllDrafts({ repoRoot: tmp });
    // .gitkeep doesn't have .md extension so it's ignored by readdirSync filter
    expect(result.submitted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });
});

// ── discardDraft ──────────────────────────────────────────────────────────────

describe('discardDraft', () => {
  it('hard-deletes a draft without an audit entry', () => {
    const record = makeRecord();
    writeDraftCaptureFile(record, tmp);
    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${record.id}.md`);
    expect(existsSync(draftPath)).toBe(true);

    discardDraft({ captureId: record.id, reason: 'half-formed thought', repoRoot: tmp });

    expect(existsSync(draftPath)).toBe(false);
  });

  it('throws when the draft does not exist', () => {
    const id = generateCaptureId(new Date('2026-05-18T10:00:00Z'));
    expect(() => discardDraft({ captureId: id, reason: 'test', repoRoot: tmp })).toThrow(
      /draft not found/,
    );
  });

  it('refuses to discard a submitted capture and points to redact', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);

    expect(() => discardDraft({ captureId: record.id, reason: 'PII', repoRoot: tmp })).toThrow(
      /submitted to the team/,
    );
  });

  it('throws on invalid captureId', () => {
    expect(() => discardDraft({ captureId: '../bad', reason: 'x', repoRoot: tmp })).toThrow(
      /invalid captureId/,
    );
  });
});

// ── loadDraftCaptures ─────────────────────────────────────────────────────────

describe('loadDraftCaptures', () => {
  it('returns empty when no drafts exist', () => {
    const { records, skippedFiles } = loadDraftCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(0);
  });

  it('loads all draft captures', () => {
    const r1 = makeRecord({ finding: 'one' });
    const r2 = makeRecord({
      finding: 'two',
      id: generateCaptureId(new Date('2026-05-18T15:00:00Z')),
    });
    writeDraftCaptureFile(r1, tmp);
    writeDraftCaptureFile(r2, tmp);

    const { records } = loadDraftCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.finding)).toContain('one');
    expect(records.map((r) => r.finding)).toContain('two');
  });

  it('filters by triage', () => {
    const r1 = makeRecord({ finding: 'pending' });
    const r2 = makeRecord({
      finding: 'resolved',
      triage: 'new-issue',
      resolvedAt: new Date().toISOString(),
      resolvedBy: 'op@example.com',
      id: generateCaptureId(new Date('2026-05-18T15:00:00Z')),
    });
    writeDraftCaptureFile(r1, tmp);
    writeDraftCaptureFile(r2, tmp);

    const { records } = loadDraftCaptures({ repoRoot: tmp, triage: 'tbd' });
    expect(records).toHaveLength(1);
    expect(records[0].finding).toBe('pending');
  });

  it('skips non-.md files', () => {
    const draftsDir = resolveDraftsDir(tmp);
    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(join(draftsDir, 'note.txt'), 'not a capture\n', 'utf8');

    const { records, skippedFiles } = loadDraftCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(0); // .txt files are skipped silently
  });

  it('counts corrupt .md files in skippedFiles', () => {
    const draftsDir = resolveDraftsDir(tmp);
    mkdirSync(draftsDir, { recursive: true });
    writeFileSync(join(draftsDir, 'cap_2026-01-01T00-00-00_abcdef.md'), 'no json block\n', 'utf8');

    const { records, skippedFiles } = loadDraftCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });
});

// ── loadSubmittedCaptures ─────────────────────────────────────────────────────

describe('loadSubmittedCaptures', () => {
  it('returns empty when no submitted captures exist', () => {
    const { records } = loadSubmittedCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(0);
  });

  it('loads all submitted captures', () => {
    const record = makeRecord();
    writeSubmittedCaptureFile(record, tmp);

    const { records } = loadSubmittedCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(record.id);
  });

  it('sorts by timestamp ascending', () => {
    const t1 = new Date('2026-01-01T01:00:00Z');
    const t2 = new Date('2026-01-01T02:00:00Z');
    const r1 = makeRecord({
      finding: 'later',
      id: generateCaptureId(t2),
      timestamp: t2.toISOString(),
    });
    const r2 = makeRecord({
      finding: 'earlier',
      id: generateCaptureId(t1),
      timestamp: t1.toISOString(),
    });
    writeSubmittedCaptureFile(r1, tmp);
    writeSubmittedCaptureFile(r2, tmp);

    const { records } = loadSubmittedCaptures({ repoRoot: tmp });
    expect(records[0].finding).toBe('earlier');
    expect(records[1].finding).toBe('later');
  });
});

// ── migrateLegacyCaptures ─────────────────────────────────────────────────────

describe('migrateLegacyCaptures', () => {
  it('migrates a JSONL capture to the submitted directory', () => {
    const record = writeCapture({
      finding: 'legacy capture',
      sourceType: 'operator',
      operator: 'op@example.com',
      artifactsDir: tmp,
    });

    const result = migrateLegacyCaptures({ artifactsDir: tmp, repoRoot: tmp });

    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.ids).toContain(record.id);

    const legacyPath = join(tmp, '_captures', `${record.id}.jsonl`);
    const submittedPath = join(tmp, 'backlog', 'captures', `${record.id}.md`);

    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(submittedPath)).toBe(true);
  });

  it('appends a migrated-from-legacy audit entry', () => {
    writeCapture({
      finding: 'to be migrated',
      sourceType: 'operator',
      operator: 'op@example.com',
      artifactsDir: tmp,
    });

    migrateLegacyCaptures({ artifactsDir: tmp, repoRoot: tmp });

    const { records } = loadSubmittedCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(1);
    const lastEntry = records[0].auditTrail[records[0].auditTrail.length - 1];
    expect(lastEntry.action).toBe('migrated-from-legacy');
    expect(lastEntry.by).toBe('cli-capture migrate-legacy');
  });

  it('returns zeros when no legacy captures exist', () => {
    const result = migrateLegacyCaptures({ artifactsDir: tmp, repoRoot: tmp });
    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('is idempotent: removes the legacy file even if already migrated', () => {
    const record = writeCapture({
      finding: 'already migrated',
      sourceType: 'operator',
      operator: 'op@example.com',
      artifactsDir: tmp,
    });

    // First migration.
    migrateLegacyCaptures({ artifactsDir: tmp, repoRoot: tmp });

    // Second migration attempt — legacy file should be gone after first run.
    const result2 = migrateLegacyCaptures({ artifactsDir: tmp, repoRoot: tmp });
    expect(result2.migrated).toBe(0);
    expect(result2.ids).not.toContain(record.id);
  });

  it('counts corrupt JSONL files in failed', () => {
    const capturesDir = join(tmp, '_captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, 'bad.jsonl'), 'not-valid-json\n', 'utf8');

    const result = migrateLegacyCaptures({ artifactsDir: tmp, repoRoot: tmp });
    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('migrates multiple JSONL captures', () => {
    writeCapture({
      finding: 'one',
      sourceType: 'operator',
      operator: 'op@example.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'two',
      sourceType: 'operator',
      operator: 'op@example.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'three',
      sourceType: 'operator',
      operator: 'op@example.com',
      artifactsDir: tmp,
    });

    const result = migrateLegacyCaptures({ artifactsDir: tmp, repoRoot: tmp });
    expect(result.migrated).toBe(3);
    expect(result.ids).toHaveLength(3);

    const { records } = loadSubmittedCaptures({ repoRoot: tmp });
    expect(records).toHaveLength(3);
  });
});

// ── redactSubmittedCapture ────────────────────────────────────────────────────

describe('redactSubmittedCapture', () => {
  it('scrubs finding and context, preserves audit trail', () => {
    const record = makeRecord({
      finding: 'sensitive PII: user email logged',
      source: {
        type: 'operator',
        agentRole: null,
        operator: 'op@example.com',
        context: 'saw it in logs',
      },
    });
    writeSubmittedCaptureFile(record, tmp);

    const redacted = redactSubmittedCapture({
      captureId: record.id,
      reason: 'PII accidentally captured',
      redactedBy: 'op@example.com',
      repoRoot: tmp,
    });

    expect(redacted.finding).toBe('[REDACTED]');
    expect(redacted.auditTrail).toHaveLength(2);
    expect(redacted.auditTrail[1].action).toBe('redacted');
    expect((redacted.auditTrail[1] as Record<string, unknown>).reason).toBe(
      'PII accidentally captured',
    );
  });

  it('throws when the submitted capture does not exist', () => {
    const id = generateCaptureId(new Date('2026-05-18T10:00:00Z'));
    expect(() =>
      redactSubmittedCapture({
        captureId: id,
        reason: 'test',
        redactedBy: 'op@example.com',
        repoRoot: tmp,
      }),
    ).toThrow(/not found/);
  });

  it('throws on invalid captureId', () => {
    expect(() =>
      redactSubmittedCapture({
        captureId: '../../bad',
        reason: 'x',
        redactedBy: 'op@example.com',
        repoRoot: tmp,
      }),
    ).toThrow(/invalid captureId/);
  });
});

// ── getAutoSubmitThreshold ────────────────────────────────────────────────────

describe('getAutoSubmitThreshold', () => {
  it('returns 0.7 when no config file exists', () => {
    // tmp does not have .ai-sdlc/capture-config.yaml
    const threshold = getAutoSubmitThreshold(tmp);
    expect(threshold).toBe(0.7);
  });

  it('reads threshold from capture-config.yaml when present', () => {
    const configDir = join(tmp, '.ai-sdlc');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'capture-config.yaml'),
      'capture:\n  confidence:\n    autoSubmitThreshold: 0.9\n',
      'utf8',
    );

    const threshold = getAutoSubmitThreshold(tmp);
    expect(threshold).toBe(0.9);
  });

  it('falls back to 0.7 when config exists but threshold is not set', () => {
    const configDir = join(tmp, '.ai-sdlc');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'capture-config.yaml'),
      'capture:\n  lifecycle:\n    draftAutoSubmitDays: 3\n',
      'utf8',
    );

    const threshold = getAutoSubmitThreshold(tmp);
    expect(threshold).toBe(0.7);
  });
});
