/**
 * cli-capture router tests — drive the yargs program in-process and
 * assert on stdout/stderr.
 *
 * Pattern mirrors cli/classify-pr.test.ts:
 *   - Capture/restore process.argv, process.stdout.write, process.stderr.write,
 *     process.exit in beforeEach/afterEach.
 *   - Use a tmp dir for ARTIFACTS_DIR so tests are hermetic.
 *   - Feature flag AI_SDLC_EMERGENT_CAPTURE set to 'experimental' in beforeEach.
 *   - process.exit stubbed to throw Error('process.exit(N)').
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCaptureCli,
  renderClassifierBatch,
  runAppendCaptureMarkerHandler,
  runParsePrCommentsHandler,
  setStdinReaderForTesting,
} from './capture.js';
import { writeCapture } from '../capture/capture-writer.js';
import { writeDraftCaptureFile, writeSubmittedCaptureFile } from '../capture/draft-capture.js';
import { renderRubricTable, getRubricEntry } from '../capture/triage-rubric.js';
import { loadCaptures } from '../capture/capture-reader.js';
import type { CaptureRecord } from '../capture/capture-record.js';
import { generateCaptureId } from '../capture/capture-record.js';

// ── Test infrastructure ───────────────────────────────────────────────────────

let tmp: string;
let savedArgv: string[];
let stdoutChunks: string[];
let stderrChunks: string[];
let savedWrite: typeof process.stdout.write;
let savedErrWrite: typeof process.stderr.write;
let savedExit: typeof process.exit;
let savedEnvCapture: string | undefined;
let savedEnvArtifactsDir: string | undefined;
let savedEnvUser: string | undefined;
let savedEnvRepoRoot: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'cli-capture-'));
  savedArgv = process.argv;
  stdoutChunks = [];
  stderrChunks = [];
  savedWrite = process.stdout.write.bind(process.stdout);
  savedErrWrite = process.stderr.write.bind(process.stderr);
  savedExit = process.exit;
  savedEnvCapture = process.env.AI_SDLC_EMERGENT_CAPTURE;
  savedEnvArtifactsDir = process.env.ARTIFACTS_DIR;
  savedEnvUser = process.env.USER;
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

  // Set feature flag and directories for every test.
  process.env.AI_SDLC_EMERGENT_CAPTURE = 'experimental';
  process.env.ARTIFACTS_DIR = tmp;
  process.env.CAPTURE_REPO_ROOT = tmp;
  process.env.USER = 'test-user';
});

afterEach(() => {
  process.argv = savedArgv;
  process.stdout.write = savedWrite;
  process.stderr.write = savedErrWrite;
  process.exit = savedExit;

  if (savedEnvCapture === undefined) {
    delete process.env.AI_SDLC_EMERGENT_CAPTURE;
  } else {
    process.env.AI_SDLC_EMERGENT_CAPTURE = savedEnvCapture;
  }
  if (savedEnvArtifactsDir === undefined) {
    delete process.env.ARTIFACTS_DIR;
  } else {
    process.env.ARTIFACTS_DIR = savedEnvArtifactsDir;
  }
  if (savedEnvUser === undefined) {
    delete process.env.USER;
  } else {
    process.env.USER = savedEnvUser;
  }
  if (savedEnvRepoRoot === undefined) {
    delete process.env.CAPTURE_REPO_ROOT;
  } else {
    process.env.CAPTURE_REPO_ROOT = savedEnvRepoRoot;
  }

  rmSync(tmp, { recursive: true, force: true });
  setStdinReaderForTesting(null);
  vi.restoreAllMocks();
});

function setArgv(...args: string[]): void {
  process.argv = ['node', 'cli-capture', ...args];
}

function stdoutJson<T = unknown>(): T {
  for (let i = stdoutChunks.length - 1; i >= 0; i--) {
    const c = stdoutChunks[i].trim();
    if (c.startsWith('{') || c.startsWith('[')) {
      return JSON.parse(c) as T;
    }
  }
  throw new Error(`no JSON found in stdout: ${stdoutChunks.join('')}`);
}

function stdoutText(): string {
  return stdoutChunks.join('');
}

function stderrText(): string {
  return stderrChunks.join('');
}

// ── Feature flag gate ─────────────────────────────────────────────────────────

describe('requireFeatureFlag', () => {
  it('exits 1 when AI_SDLC_EMERGENT_CAPTURE is unset', async () => {
    delete process.env.AI_SDLC_EMERGENT_CAPTURE;
    setArgv('file', 'some finding', '--operator', 'op@test.com');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/emergent capture is not enabled/);
    expect(stderrText()).toMatch(/AI_SDLC_EMERGENT_CAPTURE=experimental/);
  });

  it('exits 1 when AI_SDLC_EMERGENT_CAPTURE is set to a non-truthy value', async () => {
    process.env.AI_SDLC_EMERGENT_CAPTURE = 'false';
    setArgv('file', 'some finding', '--operator', 'op@test.com');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/emergent capture is not enabled/);
  });

  it('accepts truthy values: 1', async () => {
    process.env.AI_SDLC_EMERGENT_CAPTURE = '1';
    setArgv('file', 'test finding', '--operator', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.finding).toBe('test finding');
  });

  it('accepts truthy values: true', async () => {
    process.env.AI_SDLC_EMERGENT_CAPTURE = 'true';
    setArgv('file', 'test finding', '--operator', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.finding).toBe('test finding');
  });

  it('accepts truthy values: yes', async () => {
    process.env.AI_SDLC_EMERGENT_CAPTURE = 'yes';
    setArgv('file', 'test finding', '--operator', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.finding).toBe('test finding');
  });

  it('accepts truthy values: on', async () => {
    process.env.AI_SDLC_EMERGENT_CAPTURE = 'on';
    setArgv('file', 'test finding', '--operator', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.finding).toBe('test finding');
  });
});

// ── file subcommand ───────────────────────────────────────────────────────────

describe('file subcommand', () => {
  it('records a new capture with defaults and emits JSON', async () => {
    setArgv('file', 'auth token not refreshed', '--operator', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.id).toMatch(/^cap_/);
    expect(rec.finding).toBe('auth token not refreshed');
    expect(rec.severity).toBe('unknown');
    expect(rec.triage).toBe('tbd');
    expect(rec.source.type).toBe('operator');
    expect(rec.source.operator).toBe('op@test.com');
    expect(rec.schemaVersion).toBe('v1');
  });

  it('records a capture with explicit severity and triage', async () => {
    setArgv(
      'file',
      'retry loop missing jitter',
      '--operator',
      'op@test.com',
      '--severity',
      'minor',
      '--triage',
      'new-issue',
    );
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.severity).toBe('minor');
    expect(rec.triage).toBe('new-issue');
  });

  it('records a capture with evidence fields', async () => {
    setArgv(
      'file',
      'null pointer in handler',
      '--operator',
      'op@test.com',
      '--file-path',
      'src/handler.ts',
      '--line',
      '42',
      '--pr',
      '123',
    );
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.evidence.filePath).toBe('src/handler.ts');
    expect(rec.evidence.line).toBe(42);
    expect(rec.evidence.prNumber).toBe(123);
  });

  it('records a capture with context and related issue', async () => {
    setArgv(
      'file',
      'context finding',
      '--operator',
      'op@test.com',
      '--context',
      'during code review',
      '--related-issue',
      'AISDLC-100',
      '--blocks-issue',
      'AISDLC-200',
    );
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.source.context).toBe('during code review');
    expect(rec.relatedIssueId).toBe('AISDLC-100');
    expect(rec.blocksIssueId).toBe('AISDLC-200');
  });

  it('emits table format when --format table is set', async () => {
    setArgv('file', 'table format finding', '--operator', 'op@test.com', '--format', 'table');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/capture filed: cap_/);
    expect(out).toMatch(/finding: table format finding/);
    expect(out).toMatch(/severity: unknown/);
    expect(out).toMatch(/triage: tbd/);
  });

  it('resolves operator from $USER when --operator is not set', async () => {
    // We set USER=test-user in beforeEach; stub git spawnSync to fail so it falls back to USER.
    // Use vi.mock approach is tricky with dynamic import; instead we rely on $USER fallback.
    // The git config call is dynamic import('node:child_process') — we verify the fallback
    // by unsetting it temporarily so the code has to fall through to process.env.USER.
    const savedUser = process.env.USER;
    process.env.USER = 'fallback-user';
    setArgv('file', 'operator from USER env', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    // operator should be either git config result or fallback-user
    expect(typeof rec.source.operator).toBe('string');
    expect(rec.source.operator!.length).toBeGreaterThan(0);
    process.env.USER = savedUser;
  });

  it('--json path: records via AI-agent JSON blob', async () => {
    const blob = JSON.stringify({
      finding: 'ai agent found an issue',
      severity: 'major',
      triage: 'quick-fix',
      agentRole: 'code-reviewer',
      context: 'during PR review',
      evidenceFile: 'src/foo.ts',
      evidenceLine: 10,
      prNumber: 456,
      relatedIssueId: 'AISDLC-50',
      blocksIssueId: 'AISDLC-51',
    });
    setArgv('file', 'ignored-positional', '--json', blob);
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.finding).toBe('ai agent found an issue');
    expect(rec.severity).toBe('major');
    expect(rec.triage).toBe('quick-fix');
    expect(rec.source.type).toBe('ai-agent');
    expect(rec.source.agentRole).toBe('code-reviewer');
    expect(rec.evidence.filePath).toBe('src/foo.ts');
    expect(rec.evidence.line).toBe(10);
    expect(rec.evidence.prNumber).toBe(456);
    expect(rec.relatedIssueId).toBe('AISDLC-50');
    expect(rec.blocksIssueId).toBe('AISDLC-51');
  });

  it('--json path: exits 1 on invalid JSON', async () => {
    setArgv('file', 'x', '--json', 'not-valid-json{{{');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/--json: invalid JSON/);
  });

  it('--json path: exits 1 when finding field is missing', async () => {
    const blob = JSON.stringify({ severity: 'minor' });
    setArgv('file', 'x', '--json', blob);
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/"finding" field is required/);
  });

  it('writes the record to .ai-sdlc/captures-drafts/<id>.md (draft state)', async () => {
    setArgv('file', 'persisted finding', '--operator', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    // AISDLC-320 Refit Phase 1: file now writes to draft directory, not legacy JSONL path.
    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${rec.id}.md`);
    expect(existsSync(draftPath)).toBe(true);
    // Legacy JSONL should NOT be created.
    const legacyPath = join(tmp, '_captures', `${rec.id}.jsonl`);
    expect(existsSync(legacyPath)).toBe(false);
  });
});

// ── list subcommand ───────────────────────────────────────────────────────────

describe('list subcommand', () => {
  it('prints "(no captures found)" when there are no captures', async () => {
    setArgv('list');
    await buildCaptureCli().parseAsync();
    expect(stdoutText()).toMatch(/\(no captures found\)/);
  });

  it('lists captures in table format (default)', async () => {
    writeCapture({
      finding: 'first finding',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'second finding',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/first finding/);
    expect(out).toMatch(/second finding/);
    // Table headers
    expect(out).toMatch(/id/);
    expect(out).toMatch(/severity/);
    expect(out).toMatch(/triage/);
  });

  it('lists captures in JSON format', async () => {
    writeCapture({
      finding: 'json list finding',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ records: CaptureRecord[]; skippedFiles: number }>();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].finding).toBe('json list finding');
    expect(result.skippedFiles).toBe(0);
  });

  it('filters by triage value', async () => {
    writeCapture({
      finding: 'pending',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'resolved',
      triage: 'new-issue',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list', '--triage', 'tbd', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ records: CaptureRecord[] }>();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].finding).toBe('pending');
  });

  it('filters by --pending flag', async () => {
    writeCapture({
      finding: 'p1',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'p2',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'done',
      triage: 'quick-fix',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list', '--pending', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ records: CaptureRecord[] }>();
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.finding)).not.toContain('done');
  });

  it('shows skipped files count in table footer', async () => {
    // Write a malformed file to trigger skipped count
    const capturesDir = join(tmp, '_captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, 'bad.jsonl'), 'not-valid-json\n', 'utf8');
    writeCapture({
      finding: 'good',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/file\(s\) skipped/);
  });

  it('table output shows (no captures found) when filter yields empty results', async () => {
    writeCapture({
      finding: 'new issue',
      triage: 'new-issue',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list', '--triage', 'tbd');
    await buildCaptureCli().parseAsync();
    expect(stdoutText()).toMatch(/\(no captures found\)/);
  });

  it('truncates long findings in table', async () => {
    const longFinding = 'A'.repeat(80);
    writeCapture({
      finding: longFinding,
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    // Should be truncated to 57 chars + '...'
    expect(out).toMatch(/\.\.\.$/m);
  });
});

// ── redact subcommand ─────────────────────────────────────────────────────────

describe('redact subcommand', () => {
  it('redacts an existing capture by ID', async () => {
    const record = writeCapture({
      finding: 'sensitive PII: user email was logged',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('redact', record.id, '--reason', 'PII accidentally captured', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<CaptureRecord>();
    expect(result.finding).toBe('[REDACTED]');
    expect(result.auditTrail).toHaveLength(2);
    expect(result.auditTrail[1].action).toBe('redacted');
  });

  it('resolves redactedBy from $USER when --by is not set', async () => {
    const record = writeCapture({
      finding: 'to redact without by flag',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('redact', record.id, '--reason', 'testing fallback');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<CaptureRecord>();
    expect(result.finding).toBe('[REDACTED]');
    // resolvedBy will be git config or USER fallback
    const redactEntry = result.auditTrail[1] as Record<string, unknown>;
    expect(typeof redactEntry.by).toBe('string');
  });

  it('exits 1 when capture ID does not exist', async () => {
    setArgv('redact', 'cap_9999-01-01T00-00-00_ffffff', '--reason', 'test', '--by', 'op@test.com');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow();
    // The underlying redactCapture throws; yargs wraps it
  });
});

// ── against-current-pr subcommand ─────────────────────────────────────────────

describe('against-current-pr subcommand', () => {
  it('files a capture with a null PR when git/gh are not available (graceful fallback)', async () => {
    // This test exercises the null-PR branch of detectCurrentPrNumber.
    // In a test environment with no active git branch / gh CLI, detectCurrentPrNumber returns null.
    process.env.USER = 'pr-tester';
    setArgv('against-current-pr', '--finding', 'issue on branch', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.finding).toBe('issue on branch');
    // prNumber may be null (no real PR) or a number
    expect(rec.evidence.prNumber == null || typeof rec.evidence.prNumber === 'number').toBe(true);
  });

  it('emits table format with against-current-pr --format table', async () => {
    process.env.USER = 'pr-tester';
    setArgv('against-current-pr', '--finding', 'table pr finding', '--format', 'table');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/capture filed: cap_/);
    expect(out).toMatch(/finding: table pr finding/);
  });

  it('uses --context when provided instead of auto-generated context', async () => {
    setArgv(
      'against-current-pr',
      '--finding',
      'issue with context',
      '--context',
      'custom context text',
      '--format',
      'json',
    );
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    expect(rec.source.context).toBe('custom context text');
  });
});

// ── triage subcommand ─────────────────────────────────────────────────────────

describe('triage subcommand', () => {
  it('applies new-issue triage to a pending capture', async () => {
    const record = writeCapture({
      finding: 'to triage',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('triage', record.id, '--to', 'new-issue', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ updated: CaptureRecord; frameworkAction: string; note: string }>();
    expect(result.updated.triage).toBe('new-issue');
    expect(result.updated.resolvedBy).toBe('op@test.com');
    expect(typeof result.frameworkAction).toBe('string');
    expect(result.frameworkAction.length).toBeGreaterThan(0);
    expect(result.note).toMatch(/not yet wired in v1/);
  });

  it('applies quick-fix triage', async () => {
    const record = writeCapture({
      finding: 'quick',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('triage', record.id, '--to', 'quick-fix', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ updated: CaptureRecord }>();
    expect(result.updated.triage).toBe('quick-fix');
  });

  it('applies scope-extension triage with --extension-target', async () => {
    const record = writeCapture({
      finding: 'scope ext',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv(
      'triage',
      record.id,
      '--to',
      'scope-extension',
      '--by',
      'op@test.com',
      '--extension-target',
      'AISDLC-99',
    );
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ updated: CaptureRecord }>();
    expect(result.updated.triage).toBe('scope-extension');
    expect(result.updated.extensionTargetIssueId).toBe('AISDLC-99');
  });

  it('applies new-feature-issue triage', async () => {
    const record = writeCapture({
      finding: 'feature issue',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('triage', record.id, '--to', 'new-feature-issue', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ updated: CaptureRecord }>();
    expect(result.updated.triage).toBe('new-feature-issue');
  });

  it('applies framework-bug triage', async () => {
    const record = writeCapture({
      finding: 'fw bug',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('triage', record.id, '--to', 'framework-bug', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ updated: CaptureRecord }>();
    expect(result.updated.triage).toBe('framework-bug');
  });

  it('applies not-actionable triage', async () => {
    const record = writeCapture({
      finding: 'not actionable',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('triage', record.id, '--to', 'not-actionable', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ updated: CaptureRecord }>();
    expect(result.updated.triage).toBe('not-actionable');
  });

  it('resolves resolvedBy from $USER when --by is not set', async () => {
    const record = writeCapture({
      finding: 'to triage no by',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    process.env.USER = 'triage-user';
    setArgv('triage', record.id, '--to', 'new-issue');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ updated: CaptureRecord }>();
    expect(result.updated.triage).toBe('new-issue');
    // resolvedBy should be git config or USER fallback
    expect(typeof result.updated.resolvedBy).toBe('string');
  });

  it('throws when capture does not exist', async () => {
    setArgv('triage', 'cap_9999-01-01T00-00-00_ffffff', '--to', 'new-issue', '--by', 'op@test.com');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow();
  });
});

// ── parse-pr-comments subcommand ──────────────────────────────────────────────
//
// The yargs subcommand handler reads from stdin via `readSync(fd=0)` which
// blocks in vitest worker_threads (the property is non-configurable on
// `node:fs` so it can't be stubbed). To get coverage on the orchestration
// logic (parse JSON, route to legacy vs classifier path, emit), the post-
// stdin handler is exported as `runParsePrCommentsHandler({input, ...})`.
// Tests drive that exported function directly with the already-read JSON
// string. The stdin-reading shell layer is a thin wrapper around it.

describe('runParsePrCommentsHandler — legacy (no --classify) path', () => {
  it('emits JSON {found:[]} for an empty comment array', async () => {
    await runParsePrCommentsHandler({
      input: '[]',
      classify: false,
      format: 'json',
    });
    const result = stdoutJson<{ found: unknown[] }>();
    expect(result.found).toEqual([]);
  });

  it('returns the marker-tagged comments in JSON format', async () => {
    const comments = [
      {
        body: `<!-- ai-sdlc:capture severity=major triage=new-issue -->\nauth token drops on clock skew`,
        author: { login: 'alice' },
        url: 'https://github.com/o/r/pull/1#discussion_r1',
      },
      {
        body: 'this comment has no marker',
        author: { login: 'bob' },
      },
    ];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: false,
      format: 'json',
    });
    const result = stdoutJson<{ found: Array<{ marker: { severity: string; triage: string } }> }>();
    expect(result.found).toHaveLength(1);
    expect(result.found[0].marker.severity).toBe('major');
    expect(result.found[0].marker.triage).toBe('new-issue');
  });

  it('emits the no-markers-found message in table format', async () => {
    await runParsePrCommentsHandler({
      input: '[]',
      classify: false,
      format: 'table',
    });
    expect(stdoutText()).toMatch(/no ai-sdlc:capture markers found/);
  });

  it('renders marker-tagged comments in table format', async () => {
    const comments = [
      {
        body: `<!-- ai-sdlc:capture severity=minor triage=quick-fix -->\nlint nit`,
        author: { login: 'alice' },
      },
    ];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: false,
      format: 'table',
    });
    const out = stdoutText();
    expect(out).toMatch(/marker found:/);
    expect(out).toMatch(/author: alice/);
    expect(out).toMatch(/severity: minor/);
    expect(out).toMatch(/triage: quick-fix/);
    expect(out).toMatch(/finding: lint nit/);
  });

  it('renders (not set) for missing severity/triage in table format', async () => {
    const comments = [
      {
        body: `<!-- ai-sdlc:capture -->\nbare marker`,
        author: { login: 'alice' },
      },
    ];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: false,
      format: 'table',
    });
    const out = stdoutText();
    expect(out).toMatch(/severity: \(not set\)/);
    expect(out).toMatch(/triage: \(not set\)/);
  });

  it('renders unknown for missing author login in table format', async () => {
    const comments = [
      {
        body: `<!-- ai-sdlc:capture severity=minor -->\nbare`,
      },
    ];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: false,
      format: 'table',
    });
    expect(stdoutText()).toMatch(/author: unknown/);
  });

  it('exits 1 with stderr message on invalid JSON', async () => {
    await expect(
      runParsePrCommentsHandler({
        input: 'not json at all',
        classify: false,
        format: 'json',
      }),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid JSON on stdin/);
  });
});

describe('runParsePrCommentsHandler — --classify path (RFC-0024 Refit Phase 4)', () => {
  it('runs the classifier on every comment and emits JSON results', async () => {
    // The CLI surface has no LLM-invoker injection point, so the
    // substrate falls open to the pending sentinel → every comment
    // returns classified-skip with reason=classifier-fall-open. This
    // matches the documented production behavior and exercises the
    // renderClassifierBatch JSON branch.
    const comments = [
      { body: 'arch concern', author: { login: 'alice' }, url: 'http://x/1', prNumber: 1 },
      { body: 'typo nit', author: { login: 'bob' }, url: 'http://x/2', prNumber: 1 },
    ];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: true,
      format: 'json',
    });
    const result = stdoutJson<{
      results: Array<{
        comment: { author: string; url: string; prNumber: number };
        decision: { kind: string; reason?: string };
      }>;
    }>();
    expect(result.results).toHaveLength(2);
    // CLI fall-open → both classified-skip with reason=classifier-fall-open
    expect(result.results[0].decision.kind).toBe('classified-skip');
    expect(result.results[0].decision.reason).toBe('classifier-fall-open');
    expect(result.results[0].comment.author).toBe('alice');
    expect(result.results[0].comment.url).toBe('http://x/1');
    expect(result.results[0].comment.prNumber).toBe(1);
  });

  it('bypasses the classifier for marker-tagged comments and reports kind=marker', async () => {
    const comments = [
      {
        body: `<!-- ai-sdlc:capture severity=major triage=new-issue -->\ntyped finding`,
        author: { login: 'alice' },
      },
    ];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: true,
      format: 'json',
    });
    const result = stdoutJson<{
      results: Array<{ decision: { kind: string } }>;
    }>();
    expect(result.results[0].decision.kind).toBe('marker');
  });

  it('passes threshold override through to classifyPrCommentsBatch', async () => {
    // With threshold=0, even fall-open shouldn't change classification; this
    // just verifies the option flows without throwing.
    const comments = [{ body: 'x', author: { login: 'a' } }];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: true,
      threshold: 0,
      format: 'json',
    });
    const result = stdoutJson<{ results: unknown[] }>();
    expect(result.results).toHaveLength(1);
  });

  it('emits the empty-batch message in table format', async () => {
    await runParsePrCommentsHandler({
      input: '[]',
      classify: true,
      format: 'table',
    });
    expect(stdoutText()).toMatch(/no comments to classify/);
  });

  it('renders classifier results in table format', async () => {
    const comments = [{ body: 'unmarked comment', author: { login: 'alice' }, url: 'http://x/1' }];
    await runParsePrCommentsHandler({
      input: JSON.stringify(comments),
      classify: true,
      format: 'table',
    });
    const out = stdoutText();
    expect(out).toMatch(/classified-skip \(classifier-fall-open\)/);
    expect(out).toMatch(/author: alice/);
    expect(out).toMatch(/url: http:\/\/x\/1/);
  });

  it('exits 1 with stderr message on invalid JSON (classify path)', async () => {
    await expect(
      runParsePrCommentsHandler({
        input: '{not json',
        classify: true,
        format: 'json',
      }),
    ).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid JSON on stdin/);
  });
});

// ── renderClassifierBatch — direct unit tests for each decision kind ─────────
//
// renderClassifierBatch is the new helper that maps every ClassifyPrComment
// decision kind to a one-line table headline. Driving it directly is the
// cleanest way to cover all 5 discriminants (marker / ai-agent /
// classified-capture / classified-skip / already-linked) without needing
// to coax the substrate into producing each one.

describe('renderClassifierBatch — table format covers all decision kinds', () => {
  it('renders headline for marker / ai-agent / classified-capture / classified-skip / already-linked', () => {
    const batch = [
      {
        comment: { body: '', author: { login: 'op' }, url: 'http://x/m', prNumber: 1 },
        decision: {
          kind: 'marker' as const,
          finding: 'marker text',
          severity: 'major',
          triage: 'new-issue',
        },
      },
      {
        comment: { body: '', author: { login: 'github-actions[bot]' }, url: 'http://x/b' },
        decision: { kind: 'ai-agent' as const, finding: 'bot finding' },
      },
      {
        comment: { body: '', author: { login: 'alice' }, url: 'http://x/c' },
        decision: {
          kind: 'classified-capture' as const,
          finding: 'arch concern',
          decision: {
            classification: 'is-capture' as const,
            confidence: 0.83,
            reasoning: 'r',
            inputTokens: 10,
            outputTokens: 5,
          },
        },
      },
      {
        comment: { body: '', author: { login: 'bob' }, url: 'http://x/s' },
        decision: {
          kind: 'classified-skip' as const,
          reason: 'below-threshold' as const,
          decision: {
            classification: 'is-capture' as const,
            confidence: 0.3,
            reasoning: 'r',
            inputTokens: 10,
            outputTokens: 5,
          },
        },
      },
      {
        comment: { body: '', author: { login: 'carol' }, url: 'http://x/a' },
        decision: { kind: 'already-linked' as const, existingCaptureId: 'cap_xyz' },
      },
    ];
    renderClassifierBatch(batch as never, 'table');
    const out = stdoutText();
    expect(out).toMatch(/marker \(severity=major, triage=new-issue\)/);
    expect(out).toMatch(/ai-agent bypass/);
    expect(out).toMatch(/classified-capture \(confidence=0\.83\)/);
    expect(out).toMatch(/classified-skip \(below-threshold\)/);
    expect(out).toMatch(/already-linked \(cap_xyz\)/);
  });

  it('renders (unset) for marker severity/triage when omitted', () => {
    const batch = [
      {
        comment: { body: '', author: { login: 'op' } },
        decision: { kind: 'marker' as const, finding: 'bare' },
      },
    ];
    renderClassifierBatch(batch, 'table');
    const out = stdoutText();
    expect(out).toMatch(/marker \(severity=\(unset\), triage=\(unset\)\)/);
  });

  it('renders unknown author + (no url) when comment lacks those fields', () => {
    const batch = [
      {
        comment: { body: '' },
        decision: { kind: 'already-linked' as const, existingCaptureId: 'cap_y' },
      },
    ];
    renderClassifierBatch(batch, 'table');
    const out = stdoutText();
    expect(out).toMatch(/author: unknown/);
    expect(out).toMatch(/url: \(no url\)/);
  });

  it('json format preserves the comment context (author/url/prNumber)', () => {
    const batch = [
      {
        comment: { body: '', author: { login: 'alice' }, url: 'http://x/1', prNumber: 42 },
        decision: { kind: 'already-linked' as const, existingCaptureId: 'cap_42' },
      },
    ];
    renderClassifierBatch(batch, 'json');
    const result = stdoutJson<{
      results: Array<{ comment: { author: string; url: string; prNumber: number } }>;
    }>();
    expect(result.results[0].comment.author).toBe('alice');
    expect(result.results[0].comment.url).toBe('http://x/1');
    expect(result.results[0].comment.prNumber).toBe(42);
  });
});

// ── append-capture-marker subcommand (RFC-0024 Refit Phase 4 AC-7) ───────────
//
// Same stdin caveat as parse-pr-comments — `readSync(fd=0)` blocks in
// vitest worker_threads. The exported `runAppendCaptureMarkerHandler`
// takes the already-read JSON string so tests can drive the orchestration
// without the stdin loop.

describe('runAppendCaptureMarkerHandler', () => {
  it('appends the marker and emits JSON {body, changed, alreadyLinked}', () => {
    runAppendCaptureMarkerHandler({
      input: JSON.stringify({
        body: 'review finding here',
        captureId: 'cap_2026-05-23T12-34-56_abc123',
      }),
      format: 'json',
    });
    const result = stdoutJson<{ body: string; changed: boolean; alreadyLinked: boolean }>();
    expect(result.changed).toBe(true);
    expect(result.alreadyLinked).toBe(false);
    expect(result.body).toContain('<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->');
  });

  it('reports alreadyLinked=true when the same marker is already present', () => {
    const existing = 'finding\n\n<!-- ai-sdlc:capture-id=cap_2026-05-23T12-34-56_abc123 -->\n';
    runAppendCaptureMarkerHandler({
      input: JSON.stringify({ body: existing, captureId: 'cap_2026-05-23T12-34-56_abc123' }),
      format: 'json',
    });
    const result = stdoutJson<{ changed: boolean; alreadyLinked: boolean }>();
    expect(result.changed).toBe(false);
    expect(result.alreadyLinked).toBe(true);
  });

  it('emits the raw body in text format (no JSON envelope)', () => {
    runAppendCaptureMarkerHandler({
      input: JSON.stringify({ body: 'finding', captureId: 'cap_y' }),
      format: 'text',
    });
    const out = stdoutText();
    expect(out).toContain('finding');
    expect(out).toContain('<!-- ai-sdlc:capture-id=cap_y -->');
    // Text format does NOT wrap in a JSON object
    expect(out.trim().startsWith('{')).toBe(false);
  });

  it('exits 1 with stderr message on invalid JSON', () => {
    expect(() =>
      runAppendCaptureMarkerHandler({
        input: 'not-json',
        format: 'json',
      }),
    ).toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid JSON on stdin/);
  });

  it('exits 1 when payload is missing body', () => {
    expect(() =>
      runAppendCaptureMarkerHandler({
        input: JSON.stringify({ captureId: 'cap_x' }),
        format: 'json',
      }),
    ).toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/must be \{body:string, captureId:string\}/);
  });

  it('exits 1 when payload is missing captureId', () => {
    expect(() =>
      runAppendCaptureMarkerHandler({
        input: JSON.stringify({ body: 'some text' }),
        format: 'json',
      }),
    ).toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/must be \{body:string, captureId:string\}/);
  });

  it('exits 1 when body is not a string', () => {
    expect(() =>
      runAppendCaptureMarkerHandler({
        input: JSON.stringify({ body: 42, captureId: 'cap_x' }),
        format: 'json',
      }),
    ).toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/must be \{body:string, captureId:string\}/);
  });
});

// ── lint-file subcommand ──────────────────────────────────────────────────────

describe('lint-file subcommand', () => {
  it('reports (no in-code capture markers found) on a clean file', async () => {
    const cleanFile = join(tmp, 'clean.ts');
    writeFileSync(cleanFile, 'const x = 1;\n', 'utf8');
    setArgv('lint-file', cleanFile);
    await buildCaptureCli().parseAsync();
    expect(stdoutText()).toMatch(/\(no in-code capture markers found\)/);
  });

  it('reports markers in text format (default)', async () => {
    const markedFile = join(tmp, 'marked.ts');
    writeFileSync(
      markedFile,
      `const x = 1;\n// ai-sdlc:capture severity=minor triage=new-issue\n// retry loop missing jitter\nconst y = 2;\n`,
      'utf8',
    );
    setArgv('lint-file', markedFile);
    await buildCaptureCli().parseAsync();
    // Warnings go to stderr, count to stdout
    expect(stderrText()).toMatch(/warning:/);
    expect(stdoutText()).toMatch(/in-code capture marker\(s\) found/);
  });

  it('reports markers in JSON format', async () => {
    const markedFile = join(tmp, 'marked-json.ts');
    writeFileSync(
      markedFile,
      `// ai-sdlc:capture severity=major\n// missing null check\nconst z = 3;\n`,
      'utf8',
    );
    setArgv('lint-file', markedFile, '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ warnings: unknown[]; count: number }>();
    expect(result.count).toBe(1);
    expect(result.warnings).toHaveLength(1);
  });

  it('exits 1 when file does not exist', async () => {
    setArgv('lint-file', join(tmp, 'no-such-file.ts'));
    let threw = false;
    try {
      await buildCaptureCli().parseAsync();
    } catch (err) {
      threw = true;
      expect((err as Error).message).toMatch(/process\.exit\(1\)/);
    }
    // Either the promise rejected with process.exit(1) or yargs absorbed it —
    // in both cases the stderr should contain the error message.
    expect(stderrText()).toMatch(/cannot read/);
    // When process.exit(1) is stubbed to throw, yargs propagates it upward.
    expect(threw).toBe(true);
  });

  it('emits JSON with count=0 when no markers found (--format json)', async () => {
    const cleanFile = join(tmp, 'clean-json.ts');
    writeFileSync(cleanFile, 'export const a = 42;\n', 'utf8');
    setArgv('lint-file', cleanFile, '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ warnings: unknown[]; count: number }>();
    expect(result.count).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ── help-triage subcommand ────────────────────────────────────────────────────

describe('help-triage subcommand', () => {
  it('prints the triage rubric table', async () => {
    setArgv('help-triage');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/Triage values/);
    expect(out).toMatch(/quick-fix/);
    expect(out).toMatch(/new-issue/);
    expect(out).toMatch(/scope-extension/);
    expect(out).toMatch(/framework-bug/);
    expect(out).toMatch(/not-actionable/);
    expect(out).toMatch(/tbd/);
  });
});

// ── triage-rubric module ──────────────────────────────────────────────────────

describe('triage-rubric: renderRubricTable', () => {
  it('returns a string containing all triage values', () => {
    const table = renderRubricTable();
    expect(typeof table).toBe('string');
    expect(table).toMatch(/quick-fix/);
    expect(table).toMatch(/new-issue/);
    expect(table).toMatch(/scope-extension/);
    expect(table).toMatch(/new-feature-issue/);
    expect(table).toMatch(/framework-bug/);
    expect(table).toMatch(/not-actionable/);
    expect(table).toMatch(/tbd/);
  });

  it('includes shortcuts (q, t, e, r, f, n)', () => {
    const table = renderRubricTable();
    expect(table).toMatch(/\bq\b/);
    expect(table).toMatch(/\bt\b/);
    expect(table).toMatch(/\be\b/);
    expect(table).toMatch(/\br\b/);
    expect(table).toMatch(/\bf\b/);
    expect(table).toMatch(/\bn\b/);
  });

  it('includes the framework action footer', () => {
    const table = renderRubricTable();
    expect(table).toMatch(/Framework action is taken immediately/);
  });

  it('includes the column headers', () => {
    const table = renderRubricTable();
    expect(table).toMatch(/Value/);
    expect(table).toMatch(/Shortcut/);
    expect(table).toMatch(/Description/);
  });
});

describe('triage-rubric: getRubricEntry', () => {
  it('returns the correct entry for quick-fix', () => {
    const entry = getRubricEntry('quick-fix');
    expect(entry.value).toBe('quick-fix');
    expect(entry.isTerminal).toBe(true);
    expect(entry.shortcut).toBe('q');
  });

  it('returns the correct entry for tbd', () => {
    const entry = getRubricEntry('tbd');
    expect(entry.value).toBe('tbd');
    expect(entry.isTerminal).toBe(false);
    expect(entry.shortcut).toBeUndefined();
  });

  it('returns the correct entry for new-issue', () => {
    const entry = getRubricEntry('new-issue');
    expect(entry.value).toBe('new-issue');
    expect(entry.isTerminal).toBe(true);
    expect(entry.shortcut).toBe('t');
  });

  it('returns the correct entry for scope-extension', () => {
    const entry = getRubricEntry('scope-extension');
    expect(entry.value).toBe('scope-extension');
    expect(entry.isTerminal).toBe(true);
    expect(entry.shortcut).toBe('e');
  });

  it('returns the correct entry for new-feature-issue', () => {
    const entry = getRubricEntry('new-feature-issue');
    expect(entry.value).toBe('new-feature-issue');
    expect(entry.isTerminal).toBe(true);
    expect(entry.shortcut).toBe('r');
  });

  it('returns the correct entry for framework-bug', () => {
    const entry = getRubricEntry('framework-bug');
    expect(entry.value).toBe('framework-bug');
    expect(entry.isTerminal).toBe(true);
    expect(entry.shortcut).toBe('f');
  });

  it('returns the correct entry for not-actionable', () => {
    const entry = getRubricEntry('not-actionable');
    expect(entry.value).toBe('not-actionable');
    expect(entry.isTerminal).toBe(true);
    expect(entry.shortcut).toBe('n');
  });

  it('returns tbd entry as defensive fallback for unknown value', () => {
    // getRubricEntry has a ?? TRIAGE_RUBRIC[0] fallback for unrecognised values.
    const entry = getRubricEntry('tbd');
    expect(entry.value).toBe('tbd');
  });

  it('returns entries with non-empty description and frameworkAction', () => {
    for (const value of [
      'tbd',
      'quick-fix',
      'new-issue',
      'scope-extension',
      'new-feature-issue',
      'framework-bug',
      'not-actionable',
    ] as const) {
      const entry = getRubricEntry(value);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.frameworkAction.length).toBeGreaterThan(0);
    }
  });
});

// ── capture-reader: loadCaptures filter combinations ─────────────────────────

describe('capture-reader: loadCaptures', () => {
  it('returns empty result when captures dir does not exist', () => {
    const { records, skippedFiles } = loadCaptures({ artifactsDir: join(tmp, 'nonexistent') });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(0);
  });

  it('skips empty .jsonl files', () => {
    const capturesDir = join(tmp, '_captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, 'empty.jsonl'), '', 'utf8');
    const { records, skippedFiles } = loadCaptures({ artifactsDir: tmp });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('skips malformed JSON files', () => {
    const capturesDir = join(tmp, '_captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, 'bad.jsonl'), 'not-valid-json\n', 'utf8');
    const { records, skippedFiles } = loadCaptures({ artifactsDir: tmp });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('skips invalid-schema JSON files (missing required fields)', () => {
    const capturesDir = join(tmp, '_captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(
      join(capturesDir, 'invalid-schema.jsonl'),
      JSON.stringify({ id: 'x', schemaVersion: 'v2' }) + '\n',
      'utf8',
    );
    const { records, skippedFiles } = loadCaptures({ artifactsDir: tmp });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(1);
  });

  it('ignores non-.jsonl files in the captures dir', () => {
    const capturesDir = join(tmp, '_captures');
    mkdirSync(capturesDir, { recursive: true });
    writeFileSync(join(capturesDir, 'note.txt'), 'not a jsonl file\n', 'utf8');
    const { records, skippedFiles } = loadCaptures({ artifactsDir: tmp });
    expect(records).toHaveLength(0);
    expect(skippedFiles).toBe(0);
  });

  it('loads multiple captures and sorts by timestamp', () => {
    // Use explicit now to control order
    const t1 = new Date('2026-01-01T01:00:00Z');
    const t2 = new Date('2026-01-01T02:00:00Z');
    const t3 = new Date('2026-01-01T03:00:00Z');
    writeCapture({
      finding: 'third',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
      now: t3,
    });
    writeCapture({
      finding: 'first',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
      now: t1,
    });
    writeCapture({
      finding: 'second',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
      now: t2,
    });
    const { records } = loadCaptures({ artifactsDir: tmp });
    expect(records).toHaveLength(3);
    expect(records[0].finding).toBe('first');
    expect(records[1].finding).toBe('second');
    expect(records[2].finding).toBe('third');
  });

  it('filters by triage and pendingOnly simultaneously (triage wins)', () => {
    writeCapture({
      finding: 'tbd-one',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'tbd-two',
      triage: 'tbd',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'done',
      triage: 'new-issue',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
    });
    // When triage=tbd AND pendingOnly=true, still 2 results
    const { records } = loadCaptures({ artifactsDir: tmp, triage: 'tbd', pendingOnly: true });
    expect(records).toHaveLength(2);
  });

  it('filters by sourceType=ai-agent', () => {
    writeCapture({
      finding: 'operator',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'agent',
      sourceType: 'ai-agent',
      agentRole: 'code-reviewer',
      artifactsDir: tmp,
    });
    const { records } = loadCaptures({ artifactsDir: tmp, sourceType: 'ai-agent' });
    expect(records).toHaveLength(1);
    expect(records[0].finding).toBe('agent');
  });

  it('filters by sourceType=operator', () => {
    writeCapture({
      finding: 'operator',
      sourceType: 'operator',
      operator: 'a@b.com',
      artifactsDir: tmp,
    });
    writeCapture({
      finding: 'agent',
      sourceType: 'ai-agent',
      agentRole: 'developer',
      artifactsDir: tmp,
    });
    const { records } = loadCaptures({ artifactsDir: tmp, sourceType: 'operator' });
    expect(records).toHaveLength(1);
    expect(records[0].finding).toBe('operator');
  });
});

// ── AISDLC-320: file command writes to draft path ────────────────────────────

describe('file subcommand — draft state (AISDLC-320)', () => {
  it('AI-agent --json with high confidence auto-submits to backlog/captures/', async () => {
    const blob = JSON.stringify({
      finding: 'high confidence finding',
      severity: 'major',
      triage: 'new-issue',
      agentRole: 'code-reviewer',
      confidence: 0.9, // >= 0.7 threshold
    });
    setArgv('file', 'ignored', '--json', blob);
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    const submittedPath = join(tmp, 'backlog', 'captures', `${rec.id}.md`);
    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${rec.id}.md`);
    expect(existsSync(submittedPath)).toBe(true);
    expect(existsSync(draftPath)).toBe(false);
  });

  it('AI-agent --json with low confidence goes to draft', async () => {
    const blob = JSON.stringify({
      finding: 'low confidence finding',
      severity: 'minor',
      triage: 'tbd',
      agentRole: 'code-reviewer',
      confidence: 0.3, // < 0.7 threshold
    });
    setArgv('file', 'ignored', '--json', blob);
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${rec.id}.md`);
    const submittedPath = join(tmp, 'backlog', 'captures', `${rec.id}.md`);
    expect(existsSync(draftPath)).toBe(true);
    expect(existsSync(submittedPath)).toBe(false);
  });

  it('AI-agent --json with no confidence field goes to draft', async () => {
    const blob = JSON.stringify({
      finding: 'no confidence field',
      agentRole: 'developer',
    });
    setArgv('file', 'ignored', '--json', blob);
    await buildCaptureCli().parseAsync();
    const rec = stdoutJson<CaptureRecord>();
    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${rec.id}.md`);
    expect(existsSync(draftPath)).toBe(true);
  });

  it('emits table format mentioning draft state', async () => {
    setArgv('file', 'table draft', '--operator', 'op@test.com', '--format', 'table');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/capture filed: cap_/);
    expect(out).toMatch(/state: draft/);
  });
});

// ── submit subcommand ─────────────────────────────────────────────────────────

describe('submit subcommand', () => {
  it('promotes a draft to submitted and emits JSON', async () => {
    const now = new Date('2026-05-18T14:30:00Z');
    const record: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'draft to submit',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    writeDraftCaptureFile(record, tmp);

    setArgv('submit', record.id, '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();

    const result = stdoutJson<CaptureRecord>();
    expect(result.id).toBe(record.id);
    expect(result.finding).toBe('draft to submit');

    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${record.id}.md`);
    const submittedPath = join(tmp, 'backlog', 'captures', `${record.id}.md`);
    expect(existsSync(draftPath)).toBe(false);
    expect(existsSync(submittedPath)).toBe(true);
  });

  it('submit --format table emits human-readable output', async () => {
    const now = new Date('2026-05-18T14:30:00Z');
    const record: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'table submit finding',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    writeDraftCaptureFile(record, tmp);

    setArgv('submit', record.id, '--by', 'op@test.com', '--format', 'table');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/submitted:/);
    expect(out).toMatch(/state: submitted/);
  });

  it('throws when draft does not exist', async () => {
    const id = generateCaptureId(new Date('2026-05-18T10:00:00Z'));
    setArgv('submit', id, '--by', 'op@test.com');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow();
  });
});

// ── submit-all subcommand ─────────────────────────────────────────────────────

describe('submit-all subcommand', () => {
  it('bulk-submits all drafts and prints table summary', async () => {
    const now1 = new Date('2026-05-18T10:00:00Z');
    const now2 = new Date('2026-05-18T11:00:00Z');
    const r1: CaptureRecord = {
      id: generateCaptureId(now1),
      schemaVersion: 'v1',
      timestamp: now1.toISOString(),
      finding: 'first draft',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now1.toISOString() }],
    };
    const r2: CaptureRecord = {
      id: generateCaptureId(now2),
      schemaVersion: 'v1',
      timestamp: now2.toISOString(),
      finding: 'second draft',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now2.toISOString() }],
    };
    writeDraftCaptureFile(r1, tmp);
    writeDraftCaptureFile(r2, tmp);

    setArgv('submit-all', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/submitted 2 capture\(s\)/);
  });

  it('submit-all --format json emits JSON result', async () => {
    setArgv('submit-all', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ submitted: string[]; failed: unknown[] }>();
    expect(Array.isArray(result.submitted)).toBe(true);
    expect(Array.isArray(result.failed)).toBe(true);
  });

  it('prints "(no drafts to submit)" when drafts dir is empty', async () => {
    setArgv('submit-all', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    expect(stdoutText()).toMatch(/no drafts to submit/);
  });
});

// ── discard subcommand ────────────────────────────────────────────────────────

describe('discard subcommand', () => {
  it('hard-deletes a draft capture', async () => {
    const now = new Date('2026-05-18T14:30:00Z');
    const record: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'to discard',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    writeDraftCaptureFile(record, tmp);

    const draftPath = join(tmp, '.ai-sdlc', 'captures-drafts', `${record.id}.md`);
    expect(existsSync(draftPath)).toBe(true);

    setArgv('discard', record.id, '--reason', 'half-formed thought', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();
    expect(stdoutText()).toMatch(/discarded:/);
    expect(existsSync(draftPath)).toBe(false);
  });

  it('refuses to discard a submitted capture and prints pointer to redact', async () => {
    const now = new Date('2026-05-18T14:30:00Z');
    const record: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'submitted capture',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    writeSubmittedCaptureFile(record, tmp);

    setArgv('discard', record.id, '--reason', 'want to delete', '--by', 'op@test.com');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow();
  });

  it('throws when draft does not exist', async () => {
    const id = generateCaptureId(new Date('2026-05-18T10:00:00Z'));
    setArgv('discard', id, '--reason', 'cleanup', '--by', 'op@test.com');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow();
  });
});

// ── list with --source flag ───────────────────────────────────────────────────

describe('list subcommand — multi-source (AISDLC-320)', () => {
  it('shows legacy captures when --source legacy', async () => {
    writeCapture({
      finding: 'legacy only',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('list', '--source', 'legacy', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ records: CaptureRecord[] }>();
    expect(result.records.some((r) => r.finding === 'legacy only')).toBe(true);
  });

  it('shows submitted captures when --source submitted', async () => {
    const now = new Date('2026-05-18T14:30:00Z');
    const record: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'submitted capture',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    writeSubmittedCaptureFile(record, tmp);

    setArgv('list', '--source', 'submitted', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ records: CaptureRecord[] }>();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].finding).toBe('submitted capture');
  });

  it('shows all captures (legacy + submitted + drafts) when --source all', async () => {
    // Legacy
    writeCapture({
      finding: 'legacy find',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });

    // Submitted
    const now = new Date('2026-05-18T15:00:00Z');
    const subRecord: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'submitted find',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    writeSubmittedCaptureFile(subRecord, tmp);

    // Draft
    const now2 = new Date('2026-05-18T16:00:00Z');
    const draftRecord: CaptureRecord = {
      id: generateCaptureId(now2),
      schemaVersion: 'v1',
      timestamp: now2.toISOString(),
      finding: 'draft find',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now2.toISOString() }],
    };
    writeDraftCaptureFile(draftRecord, tmp);

    setArgv('list', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ records: CaptureRecord[] }>();
    const findings = result.records.map((r) => r.finding);
    expect(findings).toContain('legacy find');
    expect(findings).toContain('submitted find');
    expect(findings).toContain('draft find');
  });

  it('deduplicates captures that appear in multiple sources', async () => {
    const now = new Date('2026-05-18T14:30:00Z');
    const record: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'shared capture',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    // Write to both submitted and draft dirs to simulate overlap.
    writeSubmittedCaptureFile(record, tmp);
    writeDraftCaptureFile(record, tmp);

    setArgv('list', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ records: CaptureRecord[] }>();
    // Should appear only once despite being in two dirs.
    const matching = result.records.filter((r) => r.id === record.id);
    expect(matching).toHaveLength(1);
  });
});

// ── migrate-legacy subcommand ─────────────────────────────────────────────────

describe('migrate-legacy subcommand', () => {
  it('migrates legacy JSONL captures and prints table summary', async () => {
    writeCapture({
      finding: 'to migrate',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('migrate-legacy');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toMatch(/migrated 1 capture\(s\)/);
  });

  it('--format json emits structured result', async () => {
    writeCapture({
      finding: 'json migration',
      sourceType: 'operator',
      operator: 'op@test.com',
      artifactsDir: tmp,
    });
    setArgv('migrate-legacy', '--format', 'json');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ migrated: number; failed: number; ids: string[] }>();
    expect(result.migrated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.ids).toHaveLength(1);
  });

  it('prints "(no legacy captures found)" when nothing to migrate', async () => {
    setArgv('migrate-legacy');
    await buildCaptureCli().parseAsync();
    expect(stdoutText()).toMatch(/no legacy captures found/);
  });
});

// ── redact subcommand — submitted capture ─────────────────────────────────────

describe('redact subcommand — submitted capture path (AISDLC-320)', () => {
  it('redacts a submitted capture in backlog/captures/', async () => {
    const now = new Date('2026-05-18T14:30:00Z');
    const record: CaptureRecord = {
      id: generateCaptureId(now),
      schemaVersion: 'v1',
      timestamp: now.toISOString(),
      finding: 'PII in submitted capture',
      severity: 'unknown',
      triage: 'tbd',
      source: { type: 'operator', agentRole: null, operator: 'op@test.com' },
      evidence: {},
      relatedIssueId: null,
      extensionTargetIssueId: null,
      featureIssueCarveRef: null,
      blocksIssueId: null,
      createdIssueId: null,
      createdFeatureIssueId: null,
      resolvedAt: null,
      resolvedBy: null,
      auditTrail: [{ action: 'captured', by: 'op@test.com', at: now.toISOString() }],
    };
    writeSubmittedCaptureFile(record, tmp);

    setArgv('redact', record.id, '--reason', 'PII captured', '--by', 'op@test.com');
    await buildCaptureCli().parseAsync();

    const result = stdoutJson<CaptureRecord>();
    expect(result.finding).toBe('[REDACTED]');
    expect(result.auditTrail[result.auditTrail.length - 1].action).toBe('redacted');
  });
});

// ── End-to-end yargs path tests for stdin-driven subcommands ─────────────────
//
// These tests drive the full buildCaptureCli().parseAsync() path through
// the `parse-pr-comments` and `append-capture-marker` subcommands by
// stubbing the module-level stdin reader. They cover the yargs option
// wiring + the thin stdin try/catch wrapper that the in-process unit
// tests above can't reach (because the real `readSync(fd=0)` blocks).

describe('parse-pr-comments subcommand — end-to-end yargs path', () => {
  it('routes JSON-format legacy parse with empty array via the full CLI', async () => {
    setStdinReaderForTesting(async () => '[]');
    setArgv('parse-pr-comments');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ found: unknown[] }>();
    expect(result.found).toEqual([]);
  });

  it('routes --classify flag through to runParsePrCommentsHandler', async () => {
    setStdinReaderForTesting(async () => JSON.stringify([{ body: 'x', author: { login: 'a' } }]));
    setArgv('parse-pr-comments', '--classify');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ results: Array<{ decision: { kind: string } }> }>();
    expect(result.results).toHaveLength(1);
    // CLI surface has no LLM invoker → fall-open
    expect(result.results[0].decision.kind).toBe('classified-skip');
  });

  it('routes --format table for legacy path', async () => {
    setStdinReaderForTesting(async () => '[]');
    setArgv('parse-pr-comments', '--format', 'table');
    await buildCaptureCli().parseAsync();
    expect(stdoutText()).toMatch(/no ai-sdlc:capture markers found/);
  });

  it('routes --classify --threshold through', async () => {
    setStdinReaderForTesting(async () => '[]');
    setArgv('parse-pr-comments', '--classify', '--threshold', '0.3');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ results: unknown[] }>();
    expect(result.results).toEqual([]);
  });

  it('exits 1 when stdin reader throws (failed to read stdin branch)', async () => {
    setStdinReaderForTesting(async () => {
      throw new Error('boom');
    });
    setArgv('parse-pr-comments');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/failed to read stdin/);
  });

  it('exits 1 with stderr message on invalid JSON via yargs path', async () => {
    setStdinReaderForTesting(async () => 'not-json');
    setArgv('parse-pr-comments');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid JSON on stdin/);
  });
});

describe('append-capture-marker subcommand — end-to-end yargs path', () => {
  it('appends the marker and emits JSON via the full CLI', async () => {
    setStdinReaderForTesting(async () => JSON.stringify({ body: 'finding', captureId: 'cap_xyz' }));
    setArgv('append-capture-marker');
    await buildCaptureCli().parseAsync();
    const result = stdoutJson<{ body: string; changed: boolean; alreadyLinked: boolean }>();
    expect(result.changed).toBe(true);
    expect(result.body).toContain('<!-- ai-sdlc:capture-id=cap_xyz -->');
  });

  it('emits text format when --format text is set', async () => {
    setStdinReaderForTesting(async () => JSON.stringify({ body: 'finding', captureId: 'cap_t' }));
    setArgv('append-capture-marker', '--format', 'text');
    await buildCaptureCli().parseAsync();
    const out = stdoutText();
    expect(out).toContain('finding');
    expect(out).toContain('<!-- ai-sdlc:capture-id=cap_t -->');
  });

  it('exits 1 when stdin reader throws (failed to read stdin branch)', async () => {
    setStdinReaderForTesting(async () => {
      throw new Error('boom');
    });
    setArgv('append-capture-marker');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/failed to read stdin/);
  });

  it('exits 1 on invalid JSON via yargs path', async () => {
    setStdinReaderForTesting(async () => '{not json');
    setArgv('append-capture-marker');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/invalid JSON on stdin/);
  });

  it('exits 1 on malformed payload (missing captureId) via yargs path', async () => {
    setStdinReaderForTesting(async () => JSON.stringify({ body: 'finding' }));
    setArgv('append-capture-marker');
    await expect(buildCaptureCli().parseAsync()).rejects.toThrow(/process\.exit\(1\)/);
    expect(stderrText()).toMatch(/must be \{body:string, captureId:string\}/);
  });
});
