import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideFromRawOutput,
  decideFromInvocationFailure,
  validateClassifierOutput,
  defaultRulesetDecision,
  appendCalibrationEntry,
  ALL_REVIEWERS,
} from './classifier.js';

describe('validateClassifierOutput', () => {
  it('accepts a well-formed output', () => {
    const v = validateClassifierOutput({
      reviewers: ['testing', 'critic'],
      rationale: { testing: 'r1', critic: 'r2' },
      confident: true,
      confidence: 0.85,
    });
    expect(v.ok).toBe(true);
  });

  it('rejects non-object input', () => {
    expect(validateClassifierOutput('foo').ok).toBe(false);
    expect(validateClassifierOutput([]).ok).toBe(false);
    expect(validateClassifierOutput(null).ok).toBe(false);
  });

  it('rejects unknown reviewer values', () => {
    const v = validateClassifierOutput({
      reviewers: ['linter'],
      rationale: {},
      confident: false,
      confidence: 0.5,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects duplicate reviewers', () => {
    const v = validateClassifierOutput({
      reviewers: ['critic', 'critic'],
      rationale: {},
      confident: false,
      confidence: 0.5,
    });
    expect(v.ok).toBe(false);
  });

  it('rejects out-of-range confidence', () => {
    expect(
      validateClassifierOutput({
        reviewers: [],
        rationale: {},
        confident: false,
        confidence: 1.1,
      }).ok,
    ).toBe(false);
    expect(
      validateClassifierOutput({
        reviewers: [],
        rationale: {},
        confident: false,
        confidence: -0.1,
      }).ok,
    ).toBe(false);
  });

  it('enforces consistency: confident: true requires confidence >= 0.7', () => {
    const v = validateClassifierOutput({
      reviewers: ['critic'],
      rationale: {},
      confident: true,
      confidence: 0.5,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/confidence >= 0\.7/);
  });

  it('allows confident: false with low confidence', () => {
    expect(
      validateClassifierOutput({
        reviewers: [],
        rationale: {},
        confident: false,
        confidence: 0.3,
      }).ok,
    ).toBe(true);
  });

  it('validates modelOverride keys and values', () => {
    expect(
      validateClassifierOutput({
        reviewers: ['security'],
        rationale: {},
        confident: true,
        confidence: 0.9,
        modelOverride: { security: 'opus' },
      }).ok,
    ).toBe(true);
    expect(
      validateClassifierOutput({
        reviewers: ['security'],
        rationale: {},
        confident: true,
        confidence: 0.9,
        modelOverride: { unknown: 'opus' },
      }).ok,
    ).toBe(false);
    expect(
      validateClassifierOutput({
        reviewers: ['security'],
        rationale: {},
        confident: true,
        confidence: 0.9,
        modelOverride: { security: 'mystery' },
      }).ok,
    ).toBe(false);
  });

  it('validates harnessOverride keys and values', () => {
    expect(
      validateClassifierOutput({
        reviewers: ['security'],
        rationale: {},
        confident: true,
        confidence: 0.9,
        harnessOverride: { security: 'codex' },
      }).ok,
    ).toBe(true);
    expect(
      validateClassifierOutput({
        reviewers: ['security'],
        rationale: {},
        confident: true,
        confidence: 0.9,
        harnessOverride: { security: 'mystery' },
      }).ok,
    ).toBe(false);
  });
});

describe('decideFromRawOutput', () => {
  it('returns the classifier reviewers when output is valid and confident', () => {
    const json = JSON.stringify({
      reviewers: ['critic'],
      rationale: { critic: 'docs only' },
      confident: true,
      confidence: 0.95,
    });
    const d = decideFromRawOutput(json);
    expect(d.fellOpen).toBe(false);
    expect(d.reviewers).toEqual(['critic']);
  });

  it('falls open on parse error', () => {
    const d = decideFromRawOutput('not json');
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('parse-error');
    expect(d.reviewers).toEqual(ALL_REVIEWERS);
  });

  it('falls open on schema validation failure', () => {
    const d = decideFromRawOutput(JSON.stringify({ reviewers: [], rationale: {} }));
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('schema-validation');
    expect(d.reviewers).toEqual(ALL_REVIEWERS);
  });

  it('falls open on confident: false', () => {
    const json = JSON.stringify({
      reviewers: ['critic'],
      rationale: { critic: 'docs only' },
      confident: false,
      confidence: 0.5,
    });
    const d = decideFromRawOutput(json);
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('confident-false');
    expect(d.reviewers).toEqual(ALL_REVIEWERS);
  });

  it('falls open on confident: true with low confidence (consistency rule)', () => {
    const json = JSON.stringify({
      reviewers: ['critic'],
      rationale: { critic: 'maybe?' },
      confident: true,
      confidence: 0.5,
    });
    const d = decideFromRawOutput(json);
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('schema-validation');
  });
});

describe('decideFromInvocationFailure', () => {
  it('falls open with reason invocation-failed', () => {
    const d = decideFromInvocationFailure();
    expect(d.fellOpen).toBe(true);
    expect(d.fellOpenReason).toBe('invocation-failed');
    expect(d.reviewers).toEqual(ALL_REVIEWERS);
  });
});

describe('defaultRulesetDecision', () => {
  it('emits empty reviewers when nothing changed', () => {
    const d = defaultRulesetDecision({
      filesChanged: 0,
      paths: [],
      linesAdded: 0,
      linesRemoved: 0,
    });
    expect(d.reviewers).toEqual([]);
  });

  it('docs-only PR runs only critic', () => {
    const d = defaultRulesetDecision({
      filesChanged: 2,
      paths: ['README.md', 'docs/intro.md'],
      linesAdded: 10,
      linesRemoved: 2,
    });
    expect(d.reviewers).toEqual(['critic']);
  });

  it('auth-touching PR runs all three with security bumped to opus', () => {
    const d = defaultRulesetDecision({
      filesChanged: 1,
      paths: ['src/auth/session.ts'],
      linesAdded: 50,
      linesRemoved: 20,
    });
    expect(d.reviewers.sort()).toEqual(['critic', 'security', 'testing'].sort());
    expect(d.modelOverride?.security).toBe('opus');
  });

  it('lockfile change triggers security + critic', () => {
    const d = defaultRulesetDecision({
      filesChanged: 1,
      paths: ['package-lock.json'],
      linesAdded: 100,
      linesRemoved: 80,
    });
    expect(d.reviewers.sort()).toEqual(['critic', 'security'].sort());
  });

  it('CI workflow change triggers security + critic', () => {
    const d = defaultRulesetDecision({
      filesChanged: 1,
      paths: ['.github/workflows/ci.yml'],
      linesAdded: 12,
      linesRemoved: 4,
    });
    expect(d.reviewers.sort()).toEqual(['critic', 'security'].sort());
  });

  it('default fallback runs all three', () => {
    const d = defaultRulesetDecision({
      filesChanged: 3,
      paths: ['src/foo.ts', 'src/bar.ts', 'src/foo.test.ts'],
      linesAdded: 40,
      linesRemoved: 12,
    });
    expect(d.reviewers.sort()).toEqual(['critic', 'security', 'testing'].sort());
  });
});

describe('appendCalibrationEntry', () => {
  let tmpRoot: string;
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'classifier-cal-'));
  });
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('writes JSONL to $ARTIFACTS_DIR/_classifier/calibration.jsonl', async () => {
    await appendCalibrationEntry(tmpRoot, {
      timestamp: '2026-04-26T12:00:00Z',
      issueId: 'AISDLC-247',
      diffStats: { filesChanged: 1, paths: ['README.md'], linesAdded: 1, linesRemoved: 0 },
      classifierOutput: {
        reviewers: ['critic'],
        rationale: { critic: 'docs' },
        confident: true,
        confidence: 0.9,
      },
      fellOpen: false,
      fellOpenReason: null,
      humanOverrideAfterMerge: null,
    });
    const content = await readFile(join(tmpRoot, '_classifier', 'calibration.jsonl'), 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.issueId).toBe('AISDLC-247');
  });

  it('appends multiple entries on consecutive calls', async () => {
    for (let i = 0; i < 3; i++) {
      await appendCalibrationEntry(tmpRoot, {
        timestamp: new Date().toISOString(),
        issueId: `AISDLC-${i}`,
        diffStats: { filesChanged: 1, paths: ['x'], linesAdded: 0, linesRemoved: 0 },
        classifierOutput: null,
        fellOpen: true,
        fellOpenReason: 'parse-error',
        humanOverrideAfterMerge: null,
      });
    }
    const content = await readFile(join(tmpRoot, '_classifier', 'calibration.jsonl'), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(3);
  });
});
