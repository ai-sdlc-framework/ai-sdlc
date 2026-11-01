import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  routeDecisionPoint,
  routeDecisionPointForTaskFile,
  type DecisionPointFinding,
} from './decision-point.js';
import { listDecisions } from '../decisions/projection.js';
import { DECISION_CATALOG_FLAG } from '../decisions/feature-flag.js';
import { removeFixtureDir } from '../__test-helpers/remove-fixture-dir.js';

const ENV = { [DECISION_CATALOG_FLAG]: 'experimental' } as NodeJS.ProcessEnv;
const FM = 'id: AISDLC-9\nreferences:\n  - spec/rfcs/RFC-0053-x.md\n';
const FINDINGS: DecisionPointFinding[] = [
  { kind: 'open-question', entryId: 'q-1', summary: 'Which adapter?', citations: ['rfc#oq'] },
  { kind: 'contradiction', entryId: 'c-1', summary: 'A vs B', citations: [] },
];

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dp-'));
});
afterEach(() => removeFixtureDir(workDir));

const base = () => ({
  taskId: 'AISDLC-9',
  frontmatter: FM,
  body: 'Body RFC-0035',
  workDir,
  env: ENV,
});

describe('routeDecisionPoint', () => {
  it('queries retrieval with references and body, files findings with contextRef, emits events', async () => {
    let seen = '';
    const r = await routeDecisionPoint({
      ...base(),
      retrieval: async (q) => {
        seen = q;
        return FINDINGS;
      },
    });
    expect(seen).toContain('RFC-0053');
    expect(seen).toContain('Body RFC-0035');
    expect(r.findings).toHaveLength(2);
    expect(r.routed.map((e) => e.eventType)).toEqual([
      'DorDecisionPointRouted',
      'DorDecisionPointRouted',
    ]);
    const { decisions } = listDecisions({ workDir });
    expect(decisions.map((d) => d.spec.contextRef).sort()).toEqual([
      'knowledge:c-1',
      'knowledge:q-1',
    ]);
  });

  it('is idempotent across ticks', async () => {
    const retrieval = async () => FINDINGS;
    await routeDecisionPoint({ ...base(), retrieval });
    const r = await routeDecisionPoint({ ...base(), retrieval });
    expect(r.routed).toHaveLength(0);
    expect(r.skippedDuplicates).toBe(2);
  });

  it('leaves the result unchanged on retrieval failure or empty index', async () => {
    const failed = await routeDecisionPoint({
      ...base(),
      retrieval: async () => {
        throw new Error('no index');
      },
    });
    expect(failed.routed).toEqual([]);
    expect(failed.skippedReason).toMatch(/retrieval failed/);
    const empty = await routeDecisionPoint({ ...base(), retrieval: async () => [] });
    expect(empty).toEqual({ findings: [], routed: [], skippedDuplicates: 0 });
    expect(listDecisions({ workDir }).decisions).toHaveLength(0);
  });

  it('skips on blocked.reason override and when the catalog flag is off', async () => {
    const retrieval = async () => FINDINGS;
    const o = await routeDecisionPoint({
      ...base(),
      frontmatter: FM + 'blocked:\n  reason: "ack"\n',
      retrieval,
    });
    expect(o.routed).toEqual([]);
    const off = await routeDecisionPoint({
      ...base(),
      env: { [DECISION_CATALOG_FLAG]: 'off' },
      retrieval,
    });
    expect(off.routed).toEqual([]);
  });

  it('falls back to the default retrieval, which degrades to empty without an index', async () => {
    const r = await routeDecisionPoint(base());
    expect(r.routed).toEqual([]);
  });
});

describe('routeDecisionPointForTaskFile', () => {
  it('routes findings from a task file and logs each event to stderr', async () => {
    const f = join(workDir, 't.md');
    writeFileSync(f, '---\nid: AISDLC-9\n---\nBody RFC-0035\n');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await routeDecisionPointForTaskFile('AISDLC-9', f, workDir, {
        env: ENV,
        retrieval: async () => FINDINGS,
      });
      expect(write).toHaveBeenCalledTimes(2);
      expect(String(write.mock.calls[0]?.[0])).toContain('DorDecisionPointRouted');
    } finally {
      write.mockRestore();
    }
  });

  it('treats a file without frontmatter as all body', async () => {
    const f = join(workDir, 't.md');
    writeFileSync(f, 'plain body');
    let seen = '';
    await routeDecisionPointForTaskFile('AISDLC-9', f, workDir, {
      env: ENV,
      retrieval: async (q) => {
        seen = q;
        return [];
      },
    });
    expect(seen).toBe('plain body');
  });

  it('swallows a missing file', async () => {
    await expect(
      routeDecisionPointForTaskFile('AISDLC-9', join(workDir, 'nope.md'), workDir),
    ).resolves.toBeUndefined();
  });
});
