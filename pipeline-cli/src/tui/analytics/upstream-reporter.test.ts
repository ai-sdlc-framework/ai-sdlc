/**
 * Tests for RFC-0025 §13 OQ-5 upstream-reporter module (AISDLC-307 / Phase 6).
 *
 * Covers:
 *   - capture lookup by id (full + short form)
 *   - anonymisation (home paths, secrets, emails, worktree paths)
 *   - issue body rendering with both the on-disk template + the
 *     built-in fallback
 *   - URL builder (encoding + repoUrl normalisation)
 *   - browser-open injection point (no actual spawn under test)
 *   - suggested-fix + related-paths heuristics
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BUILTIN_UPSTREAM_TEMPLATE,
  DEFAULT_UPSTREAM_TEMPLATE_PATH,
  UpstreamReportError,
  anonymiseText,
  buildCaptureId,
  buildUpstreamReport,
  loadCaptureRecord,
  openInBrowser,
  relatedPathsForSubclass,
  renderIssueBody,
  suggestFixForSubclass,
} from './upstream-reporter.js';
import type { FrameworkBugCaptureRecord } from './quality-classifier.js';
import { FRAMEWORK_QUALITY_CAPTURES_FILE, FRAMEWORK_QUALITY_DIRNAME } from './quality-reader.js';

let workdir: string;
let artifactsDir: string;

function makeRecord(overrides: Partial<FrameworkBugCaptureRecord> = {}): FrameworkBugCaptureRecord {
  const base: FrameworkBugCaptureRecord = {
    ts: '2026-05-16T12:00:00.000Z',
    class: 'framework-misbehaved',
    subclass: 'framework-contract-violated',
    severity: {
      composite: 'high',
      axes: { operatorTimeCost: 'high', blastRadius: 'medium', frequency: 'low' },
    },
    triage: 'framework-bug',
    taskId: 'AISDLC-307',
    workerId: 'worker-1',
    source: 'step-6',
    auditTrail: {
      classificationResult: {
        class: 'framework-misbehaved',
        subclass: 'framework-contract-violated',
        severity: {
          composite: 'high',
          axes: { operatorTimeCost: 'high', blastRadius: 'medium', frequency: 'low' },
        },
        captureRecord: null,
        rationale: 'developer subagent returned prose instead of JSON envelope',
        confidence: 0.8,
        bucket: 'auto-classify',
        effectiveThresholds: { autoClassify: 0.7, ambiguous: 0.3 },
      },
      originalFailure: {
        stderr:
          'SyntaxError: JSON.parse failed at position 0\nat parseJson (file:///Users/test/proj/file.ts:10)',
        exitCode: 1,
        source: 'step-6',
      },
    },
  };
  return { ...base, ...overrides };
}

function writeCaptures(records: FrameworkBugCaptureRecord[]): void {
  const dir = join(artifactsDir, FRAMEWORK_QUALITY_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(dir, FRAMEWORK_QUALITY_CAPTURES_FILE), content);
}

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'upstream-reporter-'));
  artifactsDir = join(workdir, 'artifacts');
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

// ── buildCaptureId ────────────────────────────────────────────────────

describe('buildCaptureId', () => {
  it('produces a stable id from subclass + tsSlug', () => {
    const id = buildCaptureId(
      makeRecord({ ts: '2026-05-16T12:30:00.000Z', subclass: 'framework-gate-faulty' }),
    );
    // tsSlug strips non-digit/T chars then slices first 15 chars → 20260516T123000
    expect(id).toBe('framework-bug-framework-gate-faulty-20260516T123000');
  });

  it('cleans illegal chars in custom (vendor-namespaced) subclasses', () => {
    const id = buildCaptureId(
      makeRecord({ ts: '2026-05-16T12:30:00.000Z', subclass: 'acme-corp:custom-gate' }),
    );
    // colon is stripped to `-` then collapsed
    expect(id).toMatch(/^framework-bug-acme-corp-custom-gate-/);
  });
});

// ── loadCaptureRecord ─────────────────────────────────────────────────

describe('loadCaptureRecord', () => {
  it('returns null when captures file does not exist', () => {
    const r = loadCaptureRecord('whatever', { artifactsDir });
    expect(r).toBeNull();
  });

  it('finds a record by full id', () => {
    const rec = makeRecord();
    writeCaptures([rec]);
    const id = buildCaptureId(rec);
    const found = loadCaptureRecord(id, { artifactsDir });
    expect(found).not.toBeNull();
    expect(found?.subclass).toBe('framework-contract-violated');
  });

  it('finds a record by short id (without framework-bug- prefix)', () => {
    const rec = makeRecord();
    writeCaptures([rec]);
    const fullId = buildCaptureId(rec);
    const shortId = fullId.replace(/^framework-bug-/, '');
    const found = loadCaptureRecord(shortId, { artifactsDir });
    expect(found).not.toBeNull();
  });

  it('returns null when id is not found', () => {
    writeCaptures([makeRecord()]);
    const r = loadCaptureRecord('framework-bug-does-not-exist-20260516T1200', { artifactsDir });
    expect(r).toBeNull();
  });

  it('skips malformed JSONL lines', () => {
    const dir = join(artifactsDir, FRAMEWORK_QUALITY_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const rec = makeRecord();
    writeFileSync(
      join(dir, FRAMEWORK_QUALITY_CAPTURES_FILE),
      ['{bad json', JSON.stringify(rec), '   '].join('\n'),
    );
    const id = buildCaptureId(rec);
    expect(loadCaptureRecord(id, { artifactsDir })).not.toBeNull();
  });
});

// ── anonymiseText ─────────────────────────────────────────────────────

describe('anonymiseText', () => {
  it('strips macOS home paths', () => {
    expect(anonymiseText('error in /Users/dominique/Documents/proj/file.ts')).toContain('~/');
    expect(anonymiseText('error in /Users/dominique/Documents/proj/file.ts')).not.toContain(
      'dominique',
    );
  });

  it('strips Linux home paths', () => {
    expect(anonymiseText('error in /home/alice/proj/file.ts')).toContain('~/');
    expect(anonymiseText('error in /home/alice/proj/file.ts')).not.toContain('alice');
  });

  it('strips worktree paths', () => {
    const out = anonymiseText('cwd: /Users/dominique/proj/.worktrees/aisdlc-307/file.ts');
    expect(out).toContain('<worktree>');
  });

  it('strips OpenAI-style tokens', () => {
    const out = anonymiseText('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('<REDACTED-TOKEN>');
    expect(out).not.toContain('sk-abcdefghijklmnop');
  });

  it('strips GitHub personal access tokens', () => {
    const out = anonymiseText('GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(out).toContain('<REDACTED-TOKEN>');
    expect(out).not.toContain('ghp_abcdefghijklmnop');
  });

  it('strips Slack tokens', () => {
    const out = anonymiseText('SLACK=xoxb-1234567890-abcdefghijklm');
    expect(out).toContain('<REDACTED-TOKEN>');
  });

  it('strips email addresses', () => {
    const out = anonymiseText('contact: alice@example.com');
    expect(out).toContain('<REDACTED-EMAIL>');
    expect(out).not.toContain('alice@example.com');
  });

  it('is idempotent on already-anonymised text', () => {
    const once = anonymiseText('user@example.com from /Users/bob/x');
    const twice = anonymiseText(once);
    expect(twice).toBe(once);
  });

  it('returns empty string unchanged', () => {
    expect(anonymiseText('')).toBe('');
  });
});

// ── suggestFixForSubclass + relatedPathsForSubclass ───────────────────

describe('suggestFixForSubclass + relatedPathsForSubclass', () => {
  it('returns subclass-specific hint for framework-contract-violated', () => {
    expect(suggestFixForSubclass('framework-contract-violated')).toMatch(/Step 6|parse-dev-return/);
  });

  it('returns generic hint for unknown subclasses', () => {
    expect(suggestFixForSubclass('acme-corp:custom-thing')).toMatch(/No automatic suggestion/);
  });

  it('returns subclass-specific paths', () => {
    const out = relatedPathsForSubclass('framework-coverage-gap');
    expect(out).toContain('playbook');
  });

  it('returns generic fallback paths for unknown subclasses', () => {
    expect(relatedPathsForSubclass('acme-corp:custom-thing')).toMatch(/no built-in path mapping/);
  });
});

// ── renderIssueBody ───────────────────────────────────────────────────

describe('renderIssueBody', () => {
  it('renders the built-in template when no on-disk file exists', () => {
    const rec = makeRecord();
    const body = renderIssueBody(rec, { workDir: workdir });
    expect(body).toContain('Framework bug — framework-contract-violated');
    expect(body).toContain('high'); // severity composite
    expect(body).toContain('developer subagent returned prose');
  });

  it('renders an on-disk template when present', () => {
    const dir = join(workdir, '.ai-sdlc', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'framework-bug-report.md'),
      [
        '# Custom template for {{subclass}}',
        '',
        'Severity: {{severity_composite}}',
        'Suggested: {{suggested_fix}}',
      ].join('\n'),
    );
    const body = renderIssueBody(makeRecord(), { workDir: workdir });
    expect(body).toContain('# Custom template for framework-contract-violated');
    expect(body).toContain('Severity: high');
    expect(body).toContain('Suggested: ');
  });

  it('anonymises home paths in rendered stderr', () => {
    const rec = makeRecord({
      auditTrail: {
        classificationResult: {
          class: 'framework-misbehaved',
          subclass: 'framework-contract-violated',
          severity: makeRecord().severity,
          captureRecord: null,
          rationale: 'rationale ref /Users/secret/proj/x.ts',
          confidence: 0.8,
          bucket: 'auto-classify',
          effectiveThresholds: { autoClassify: 0.7, ambiguous: 0.3 },
        },
        originalFailure: {
          stderr: 'fail at /Users/secret/proj/x.ts',
          exitCode: 1,
          source: '/Users/secret/proj/step.ts',
        },
      },
    });
    const body = renderIssueBody(rec, { workDir: workdir });
    expect(body).not.toContain('secret');
    expect(body).toContain('~');
  });

  it('leaves unknown placeholders in place', () => {
    const dir = join(workdir, '.ai-sdlc', 'templates');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'framework-bug-report.md'),
      ['{{subclass}}', '{{unknown_placeholder}}'].join('\n'),
    );
    const body = renderIssueBody(makeRecord(), { workDir: workdir });
    expect(body).toContain('framework-contract-violated');
    expect(body).toContain('{{unknown_placeholder}}');
  });

  it('supports absolute templatePath override', () => {
    const filePath = join(workdir, 'custom.md');
    writeFileSync(filePath, '{{subclass}} via override');
    const body = renderIssueBody(makeRecord(), { workDir: workdir, templatePath: filePath });
    expect(body).toBe('framework-contract-violated via override');
  });

  it('caps stderr to a reasonable tail length', () => {
    const longStderr = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const rec = makeRecord({
      auditTrail: {
        classificationResult: makeRecord().auditTrail.classificationResult,
        originalFailure: { stderr: longStderr, exitCode: 1, source: 'step-6' },
      },
    });
    const body = renderIssueBody(rec, { workDir: workdir });
    // built-in template puts stderr in a fenced block; tail should retain line 199
    expect(body).toContain('line 199');
    // and trim earlier noise — line 100 lies outside the tail-30 window
    expect(body).not.toContain('line 100');
  });

  it('uses BUILTIN_UPSTREAM_TEMPLATE constant as fallback', () => {
    expect(BUILTIN_UPSTREAM_TEMPLATE).toContain('{{subclass}}');
    expect(BUILTIN_UPSTREAM_TEMPLATE).toContain('{{stderr_tail}}');
  });

  it('exports DEFAULT_UPSTREAM_TEMPLATE_PATH for adopter use', () => {
    expect(DEFAULT_UPSTREAM_TEMPLATE_PATH).toBe('.ai-sdlc/templates/framework-bug-report.md');
  });
});

// ── buildUpstreamReport ───────────────────────────────────────────────

describe('buildUpstreamReport', () => {
  it('throws UpstreamReportError when repoUrl is empty', () => {
    writeCaptures([makeRecord()]);
    expect(() =>
      buildUpstreamReport(buildCaptureId(makeRecord()), {
        repoUrl: '',
        artifactsDir,
        workDir: workdir,
      }),
    ).toThrow(UpstreamReportError);
  });

  it('throws UpstreamReportError when capture id is not found', () => {
    writeCaptures([makeRecord()]);
    expect(() =>
      buildUpstreamReport('framework-bug-no-such-thing-20260101T0000', {
        repoUrl: 'https://github.com/org/repo',
        artifactsDir,
        workDir: workdir,
      }),
    ).toThrow(UpstreamReportError);
  });

  it('builds a URL with title + body URL-encoded', () => {
    const rec = makeRecord();
    writeCaptures([rec]);
    const report = buildUpstreamReport(buildCaptureId(rec), {
      repoUrl: 'https://github.com/org/repo',
      artifactsDir,
      workDir: workdir,
    });
    expect(report.url).toMatch(/^https:\/\/github\.com\/org\/repo\/issues\/new\?title=/);
    expect(report.url).toContain('body=');
    expect(report.url).toContain(encodeURIComponent('framework-contract-violated'));
    expect(report.title).toContain('framework-contract-violated');
    expect(report.title).toContain('high');
    expect(report.body).toContain('Framework bug');
    expect(report.captureId).toBe(buildCaptureId(rec));
  });

  it('normalises trailing slash in repoUrl', () => {
    const rec = makeRecord();
    writeCaptures([rec]);
    const report = buildUpstreamReport(buildCaptureId(rec), {
      repoUrl: 'https://github.com/org/repo/',
      artifactsDir,
      workDir: workdir,
    });
    expect(report.url).toMatch(/repo\/issues\/new/);
    expect(report.url).not.toMatch(/repo\/\/issues/);
  });
});

// ── openInBrowser ─────────────────────────────────────────────────────

describe('openInBrowser', () => {
  it('returns true on successful spawn via injected spawnFn', () => {
    let calledCmd = '';
    let calledArgs: string[] = [];
    const result = openInBrowser('https://example.com', {
      spawnFn: (cmd, args) => {
        calledCmd = cmd;
        calledArgs = args;
        return { unref: (): void => {} };
      },
    });
    expect(result).toBe(true);
    expect(calledCmd).toBeTruthy();
    expect(calledArgs).toContain('https://example.com');
  });

  it('returns false when spawn throws', () => {
    const result = openInBrowser('https://example.com', {
      spawnFn: (): { unref: () => void } => {
        throw new Error('spawn-failed');
      },
    });
    expect(result).toBe(false);
  });
});
