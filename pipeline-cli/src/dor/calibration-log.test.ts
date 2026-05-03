/**
 * Calibration log writer tests.
 *
 * RFC-0011 §5.5 — every verdict is appended as one JSONL line to
 * `$ARTIFACTS_DIR/_dor/calibration.jsonl`. Tests assert:
 *   - Append-only behavior (re-running the writer keeps prior lines)
 *   - Path resolution honors explicit override → opts → env → default
 *   - Issue body truncation switches to a short checksum for large bodies
 *   - The entry shape is JSON-round-trippable
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCalibrationEntry,
  buildEntry,
  recordOverride,
  resolveCalibrationLogPath,
  type CalibrationEntry,
} from './calibration-log.js';
import type { RefinementVerdict } from './types.js';

function verdict(over: Partial<RefinementVerdict> = {}): RefinementVerdict {
  return {
    issueId: 'AISDLC-test',
    rubricVersion: 'v1',
    overallVerdict: 'admit',
    overallConfidence: 'medium',
    gates: [
      { gateId: 1, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
      { gateId: 2, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
    ],
    signedAt: '2026-05-01T12:00:00.000Z',
    evaluatorVersion: 'test',
    summary: 'all good',
    questions: [],
    ...over,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dor-calib-'));
});

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('resolveCalibrationLogPath', () => {
  it('honors an explicit filePath', () => {
    expect(resolveCalibrationLogPath({ filePath: '/tmp/abc.jsonl' })).toBe('/tmp/abc.jsonl');
  });

  it('uses opts.artifactsDir when provided', () => {
    const p = resolveCalibrationLogPath({ artifactsDir: '/var/x' });
    expect(p).toBe('/var/x/_dor/calibration.jsonl');
  });

  it('falls back to ARTIFACTS_DIR env var', () => {
    const prior = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = '/env/artifacts';
    try {
      expect(resolveCalibrationLogPath()).toBe('/env/artifacts/_dor/calibration.jsonl');
    } finally {
      if (prior === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = prior;
    }
  });

  it('falls back to ./artifacts/_dor/calibration.jsonl', () => {
    const prior = process.env.ARTIFACTS_DIR;
    delete process.env.ARTIFACTS_DIR;
    try {
      const p = resolveCalibrationLogPath();
      expect(p).toContain('artifacts/_dor/calibration.jsonl');
    } finally {
      if (prior !== undefined) process.env.ARTIFACTS_DIR = prior;
    }
  });
});

describe('buildEntry', () => {
  it('captures the verdict and derives failedGates', () => {
    const v = verdict({
      gates: [
        { gateId: 1, verdict: 'fail', severity: 'block', stage: 'A', confidence: 'high' },
        { gateId: 2, verdict: 'pass', severity: 'block', stage: 'A', confidence: 'high' },
        { gateId: 4, verdict: 'fail', severity: 'block', stage: 'B', confidence: 'high' },
      ],
      overallVerdict: 'needs-clarification',
    });
    const e = buildEntry({ verdict: v }, { now: () => new Date('2026-05-01T00:00:00.000Z') });
    expect(e.failedGates).toEqual([1, 4]);
    expect(e.overallVerdict).toBe('needs-clarification');
    expect(e.outcome).toBe('');
    expect(e.ts).toBe('2026-05-01T00:00:00.000Z');
  });

  it('inlines short bodies, replaces long bodies with bodySha', () => {
    const issueShort = {
      id: 'i1',
      source: 'github' as const,
      title: 't',
      body: 'short body',
    };
    const eShort = buildEntry({ verdict: verdict(), issue: issueShort });
    expect(eShort.issue?.bodyPreview).toBe('short body');
    expect(eShort.issue?.bodySha).toBeUndefined();

    const issueLong = {
      id: 'i2',
      source: 'github' as const,
      title: 't',
      body: 'x'.repeat(2000),
    };
    const eLong = buildEntry({ verdict: verdict(), issue: issueLong });
    expect(eLong.issue?.bodySha).toMatch(/^cs_[0-9a-f]{8}$/);
    expect(eLong.issue?.bodyPreview).toBeUndefined();
  });

  it('switches to bodySha at the AISDLC-122 80-char inline limit', () => {
    // AISDLC-122 lowered BODY_INLINE_LIMIT 500 → 80. A body of exactly
    // 80 chars is still inlined (limit is `>` not `>=`); 81 trips SHA.
    // Use word+space text so we don't trip the HIGH-ENTROPY 40+ run
    // catch-all in `redactSecrets()` — that's a redaction-layer concern
    // and is asserted separately below.
    // Repeat 'ab ' (3 chars) and trim/pad to exactly 80 chars. The
    // mandatory spaces break up alphanumeric runs so HIGH-ENTROPY (40+
    // alphanum/_/-) doesn't fire.
    const padded = 'ab '.repeat(27).slice(0, 80);
    expect(padded).toHaveLength(80);
    const at = {
      id: 'i3',
      source: 'github' as const,
      title: 't',
      body: padded,
    };
    const eAt = buildEntry({ verdict: verdict(), issue: at });
    expect(eAt.issue?.bodyPreview).toBe(padded);
    expect(eAt.issue?.bodySha).toBeUndefined();

    const over = {
      id: 'i4',
      source: 'github' as const,
      title: 't',
      body: `${padded}!`, // 81 chars
    };
    const eOver = buildEntry({ verdict: verdict(), issue: over });
    expect(eOver.issue?.bodySha).toMatch(/^cs_[0-9a-f]{8}$/);
    expect(eOver.issue?.bodyPreview).toBeUndefined();
  });

  it('passes outcome through', () => {
    const e = buildEntry({ verdict: verdict(), outcome: 'override', notes: 'maintainer overrode' });
    expect(e.outcome).toBe('override');
    expect(e.notes).toBe('maintainer overrode');
  });

  it('omits issue snapshot when no issue provided', () => {
    const e = buildEntry({ verdict: verdict() });
    expect(e.issue).toBeUndefined();
  });

  it('passes author through and omits the field when undefined (AISDLC-115.6)', () => {
    const eWith = buildEntry({ verdict: verdict(), author: 'alice@example.com' });
    expect(eWith.author).toBe('alice@example.com');

    const eWithout = buildEntry({ verdict: verdict() });
    // Top-level field is intentionally absent (not just undefined) so the
    // serialised JSONL line stays tight.
    expect('author' in eWithout).toBe(false);
  });

  it('redacts secret-shaped author strings (defense-in-depth)', () => {
    const fakePat = `ghp_${'a'.repeat(36)}`;
    const e = buildEntry({ verdict: verdict(), author: fakePat });
    expect(e.author).toContain('[REDACTED:GITHUB_PAT]');
    expect(e.author).not.toContain(fakePat);
  });

  // RFC-0014 §6.3 Phase 3 — blastRadius + highestDownstreamPriority

  it('persists blastRadius when supplied (count + sample ids)', () => {
    const e = buildEntry({
      verdict: verdict(),
      blastRadius: { count: 7, downstreamSampleIds: ['AISDLC-101', 'AISDLC-102'] },
    });
    expect(e.blastRadius).toEqual({
      count: 7,
      downstreamSampleIds: ['AISDLC-101', 'AISDLC-102'],
    });
  });

  it('caps the persisted downstreamSampleIds at 5 entries (defense-in-depth)', () => {
    const e = buildEntry({
      verdict: verdict(),
      blastRadius: {
        count: 12,
        downstreamSampleIds: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      },
    });
    expect(e.blastRadius?.downstreamSampleIds).toHaveLength(5);
    expect(e.blastRadius?.downstreamSampleIds).toEqual(['A', 'B', 'C', 'D', 'E']);
    // Count is preserved even when the sample is truncated.
    expect(e.blastRadius?.count).toBe(12);
  });

  it('omits the blastRadius field when not supplied (backward-compatible)', () => {
    const e = buildEntry({ verdict: verdict() });
    expect('blastRadius' in e).toBe(false);
  });

  it('redacts secret-shaped sample ids (defense-in-depth)', () => {
    const fakePat = `ghp_${'a'.repeat(36)}`;
    const e = buildEntry({
      verdict: verdict(),
      blastRadius: { count: 1, downstreamSampleIds: [fakePat] },
    });
    expect(e.blastRadius?.downstreamSampleIds[0]).toContain('[REDACTED:GITHUB_PAT]');
  });

  it('persists highestDownstreamPriority when supplied', () => {
    const e = buildEntry({ verdict: verdict(), highestDownstreamPriority: 85 });
    expect(e.highestDownstreamPriority).toBe(85);
  });

  it('omits highestDownstreamPriority when not supplied', () => {
    const e = buildEntry({ verdict: verdict() });
    expect('highestDownstreamPriority' in e).toBe(false);
  });
});

describe('recordOverride', () => {
  it('writes an override-outcome entry with author + reason', () => {
    const target = join(tmp, 'cal.jsonl');
    const { entry, path } = recordOverride(
      { issueId: 'AISDLC-90', author: 'maintainer-jane', reason: 'context-only PR — bypass DoR' },
      { filePath: target },
    );
    expect(path).toBe(target);
    expect(entry.outcome).toBe('override');
    expect(entry.author).toBe('maintainer-jane');
    expect(entry.notes).toBe('context-only PR — bypass DoR');
    expect(entry.issueId).toBe('AISDLC-90');
    // Synthetic verdict — no real evaluator run was attached.
    expect(entry.verdict.evaluatorVersion).toBe('override-synthetic');
  });

  it('preserves the supplied verdict when one is provided', () => {
    const target = join(tmp, 'cal.jsonl');
    const realVerdict = verdict({
      gates: [{ gateId: 1, verdict: 'fail', severity: 'block', stage: 'A', confidence: 'high' }],
      overallVerdict: 'needs-clarification',
    });
    const { entry } = recordOverride(
      { issueId: 'AISDLC-91', author: 'maintainer-jane', verdict: realVerdict },
      { filePath: target },
    );
    expect(entry.failedGates).toEqual([1]);
    expect(entry.verdict.evaluatorVersion).toBe('test');
    expect(entry.outcome).toBe('override');
  });
});

describe('appendCalibrationEntry', () => {
  it('writes a JSONL line and creates parent directories', () => {
    const target = join(tmp, 'sub1', 'sub2', '_dor', 'calibration.jsonl');
    const { path, entry } = appendCalibrationEntry({ verdict: verdict() }, { filePath: target });
    expect(path).toBe(target);
    expect(existsSync(target)).toBe(true);
    const lines = readFileSync(target, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as CalibrationEntry;
    expect(parsed.issueId).toBe(entry.issueId);
  });

  it('appends multiple entries without truncating prior ones', () => {
    const target = join(tmp, 'cal.jsonl');
    appendCalibrationEntry({ verdict: verdict({ issueId: 'one' }) }, { filePath: target });
    appendCalibrationEntry({ verdict: verdict({ issueId: 'two' }) }, { filePath: target });
    appendCalibrationEntry({ verdict: verdict({ issueId: 'three' }) }, { filePath: target });
    const lines = readFileSync(target, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).issueId).toBe('one');
    expect(JSON.parse(lines[1]).issueId).toBe('two');
    expect(JSON.parse(lines[2]).issueId).toBe('three');
  });

  it('persists the full verdict object so consumers can replay', () => {
    const target = join(tmp, 'cal.jsonl');
    const v = verdict({ overallVerdict: 'needs-clarification', overallConfidence: 'low' });
    appendCalibrationEntry({ verdict: v }, { filePath: target });
    const parsed = JSON.parse(readFileSync(target, 'utf8').trim()) as CalibrationEntry;
    expect(parsed.verdict.overallVerdict).toBe('needs-clarification');
    expect(parsed.verdict.overallConfidence).toBe('low');
    expect(parsed.verdict.gates).toHaveLength(2);
  });

  it('uses the conventional path under artifactsDir when filePath omitted', () => {
    const { path } = appendCalibrationEntry({ verdict: verdict() }, { artifactsDir: tmp });
    expect(path).toBe(join(tmp, '_dor', 'calibration.jsonl'));
    expect(existsSync(path)).toBe(true);
  });

  it('redacts known-shape secrets from title, bodyPreview, and verdict findings (AISDLC-122)', () => {
    // Use OBVIOUSLY FAKE tokens that pattern-match but aren't real
    // secrets. Each one targets a distinct registry entry so the test
    // covers more than just one regex.
    // Note: OpenAI classic keys are `sk-[A-Za-z0-9]{20,}` — no hyphen
    // in the body. The `testkey` prefix keeps the literal obviously fake
    // without breaking the pattern.
    const fakeOpenAI = 'sk-testkeyABCDEF1234567890abcdef1234567890';
    const fakeGithub = `ghp_${'a'.repeat(36)}`;
    const fakeAws = 'AKIAIOSFODNN7EXAMPLE';

    const issue = {
      id: 'leaky',
      source: 'github' as const,
      // Title carries the OpenAI-shape token. <80 chars total so the
      // body still inlines (we want bodyPreview to also redact).
      title: `bug: ${fakeOpenAI} fails`,
      // Body carries the GitHub PAT.
      body: `Stack trace shows ${fakeGithub} in header`,
    };

    const v = verdict({
      gates: [
        {
          gateId: 1,
          verdict: 'fail',
          severity: 'block',
          stage: 'B',
          confidence: 'high',
          // The LLM finding quotes back the AWS key from the body.
          finding: `Body contains AWS key ${fakeAws} — looks like a leak`,
          clarificationQuestion: `Did you mean to share ${fakeAws}?`,
        },
      ],
      summary: `Issue mentions ${fakeOpenAI}`,
      questions: [`Is ${fakeGithub} still active?`],
    });

    const target = join(tmp, 'redact.jsonl');
    appendCalibrationEntry({ verdict: v, issue }, { filePath: target });

    // Read back the on-disk JSONL — this is the surface that would be
    // committed if the pipeline did `git add -A`. The in-memory entry
    // is NOT what we're asserting; the persisted line is.
    const raw = readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw.trim()) as CalibrationEntry;

    // None of the literal fake tokens may appear anywhere in the line.
    expect(raw).not.toContain(fakeOpenAI);
    expect(raw).not.toContain(fakeGithub);
    expect(raw).not.toContain(fakeAws);

    // And the redaction markers should be present in the right places.
    expect(parsed.issue?.title).toContain('[REDACTED:OPENAI]');
    expect(parsed.issue?.bodyPreview).toContain('[REDACTED:GITHUB_PAT]');
    expect(parsed.verdict.gates[0].finding).toContain('[REDACTED:AWS_ACCESS_KEY]');
    expect(parsed.verdict.gates[0].clarificationQuestion).toContain('[REDACTED:AWS_ACCESS_KEY]');
    expect(parsed.verdict.summary).toContain('[REDACTED:OPENAI]');
    expect(parsed.verdict.questions?.[0]).toContain('[REDACTED:GITHUB_PAT]');
  });
});
