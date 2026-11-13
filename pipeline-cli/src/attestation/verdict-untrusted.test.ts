import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UntrustedPrReport } from '../pipeline/report-validator.js';
import type { ExecResult, Runner } from '../runtime/exec.js';
import { checkVerdict } from './verdict-check.js';
import { VerdictRecordSchema } from './verdict-record.js';
import {
  buildCleanRoomVerdict,
  reviewJobsSucceeded,
  validateVerdictArtifact,
  writeVerdictArtifact,
} from './verdict-untrusted.js';

const HEAD = 'a'.repeat(40);
const TREE = 'c'.repeat(40);
const verdict = (approved: boolean) => ({ approved, findings: [], promptInjectionDetected: false });
const report = (approved = true): UntrustedPrReport => ({
  schemaVersion: 'untrusted-pr-report.v1',
  prNumber: 7,
  headSha: HEAD,
  baseSha: 'b'.repeat(40),
  generatedAt: '2026-11-03T10:00:00.000Z',
  trust: { classification: 'untrusted', reason: 'fork' },
  astGate: { outcome: 'pass', offendingPaths: [] },
  differentialTest: { upstreamSuitePassed: true, newTestsPassed: true, newCodeCoveragePct: 90 },
  reviewers: { code: verdict(true), test: verdict(true), security: verdict(approved) },
  consensus: { approved, blockingFindings: approved ? 0 : 1 },
});
const OK_JOBS = [
  { name: 'Stage 2/3: Sandbox + Hardened Reviewer Matrix', conclusion: 'success' },
  { name: 'Stage 4: Clean-Room Attestation', conclusion: 'success' },
];

describe('verdict-untrusted', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vu-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (r = report()) => {
    const b = buildCleanRoomVerdict(r, { treeSha: TREE, repository: 'o/r' });
    writeVerdictArtifact(dir, b.record, b.leavesJsonl);
    return b;
  };
  const check = (over = {}) =>
    validateVerdictArtifact({ dir, headSha: HEAD, repository: 'o/r', jobs: OK_JOBS, ...over });

  it('builds a schema-valid ci-clean-room isolated record', () => {
    const { record } = buildCleanRoomVerdict(report(), { treeSha: TREE, repository: 'o/r' });
    expect(VerdictRecordSchema.parse(record).issuedBy.principal).toBe('ci-clean-room');
    expect(record.verdict).toBe('approved');
    expect(record.coverage.satisfied).toBe(true);
    expect(record.reviewers.every((r) => r.independenceTier === 'isolated')).toBe(true);
  });

  it('records changes_requested when a reviewer rejects', () => {
    const { record } = buildCleanRoomVerdict(report(false), { treeSha: TREE, repository: 'o/r' });
    expect(record.verdict).toBe('changes_requested');
  });

  it('accepts a valid artifact', () => {
    write();
    expect(check().ok).toBe(true);
    expect(check({ expectedTreeSha: TREE }).ok).toBe(true);
  });

  it('AC-2: rejects a head that does not match the PR head', () => {
    write();
    const r = check({ headSha: 'd'.repeat(40) });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/does not match the PR head/);
  });

  it('AC-2: rejects when a review job did not succeed or is absent', () => {
    write();
    const failed = check({ jobs: [OK_JOBS[0], { ...OK_JOBS[1]!, conclusion: 'failure' }] });
    expect(failed.ok === false && failed.reason).toMatch(/not success/);
    expect(reviewJobsSucceeded([OK_JOBS[1]!])).toMatch(/not found/);
    expect(reviewJobsSucceeded([{ name: 'Stage 2/3: x', conclusion: null }])).toMatch(/none/);
  });

  it('rejects wrong repository, tree, issuer, tier, digest, missing files and bad schema', () => {
    write();
    expect(check({ repository: 'x/y' }).ok).toBe(false);
    expect(check({ expectedTreeSha: 'e'.repeat(40) }).ok).toBe(false);
    writeFileSync(join(dir, 'leaves.jsonl'), 'tampered\n');
    const digest = check();
    expect(digest.ok === false && digest.reason).toMatch(/digest/);

    const b = write();
    writeFileSync(
      join(dir, 'record.json'),
      JSON.stringify({
        ...b.record,
        issuedBy: { ...b.record.issuedBy, principal: 'pipeline-step-11' },
      }),
    );
    expect(check().ok === false && (check() as { reason: string }).reason).toMatch(/issuer/);
    writeFileSync(
      join(dir, 'record.json'),
      JSON.stringify({
        ...b.record,
        reviewers: b.record.reviewers.map((r) => ({ ...r, independenceTier: 'none' })),
      }),
    );
    expect((check() as { reason: string }).reason).toMatch(/isolated/);
    writeFileSync(join(dir, 'record.json'), '{"nope":1}');
    expect((check() as { reason: string }).reason).toMatch(/schema/);
    rmSync(join(dir, 'record.json'));
    expect((check() as { reason: string }).reason).toMatch(/missing/);
  });

  it('AC-4: the verdict check passes for the head with the written record', async () => {
    const b = write();
    const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', code: 0 });
    const runner: Runner = async (_c, args) => {
      if (args[0] === 'show') {
        return ok(args[1]!.endsWith('record.json') ? JSON.stringify(b.record) : b.leavesJsonl);
      }
      return ok();
    };
    const r = await checkVerdict({
      runner,
      cwd: dir,
      headSha: HEAD,
      pullRequest: b.record.subject.pullRequest,
      changedPaths: null,
      requiredTier: 'isolated',
    });
    expect(r.code).toBe('ok');
  });
});
