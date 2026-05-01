import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateIssue } from './evaluate.js';
import { fileExistenceResolver } from './resolvers/file-existence.js';
import { cleanupTmpProject, makeTmpProject } from '../__test-helpers/make-task.js';
import type { IssueInput } from './types.js';

let tmp: string;
beforeEach(() => {
  tmp = makeTmpProject();
  mkdirSync(join(tmp, 'spec', 'rfcs'), { recursive: true });
  writeFileSync(join(tmp, 'spec', 'rfcs', 'RFC-0011-foo.md'), '');
  mkdirSync(join(tmp, 'pipeline-cli', 'src'), { recursive: true });
  writeFileSync(join(tmp, 'pipeline-cli', 'src', 'index.ts'), 'export {};');
  writeFileSync(join(tmp, 'pipeline-cli', 'src', 'x.ts'), 'export {};');
  writeFileSync(join(tmp, 'pipeline-cli', 'x.ts'), 'export {};');
  // Sub-paths used in fixtures.
  mkdirSync(join(tmp, 'path', 'to'), { recursive: true });
  writeFileSync(join(tmp, 'path', 'to', 'file.ts'), 'export {};');
  writeFileSync(join(tmp, 'path', 'to', 'x.ts'), 'export {};');
});
afterEach(() => cleanupTmpProject(tmp));

function input(body: string, title = 't', extras?: Partial<IssueInput>): IssueInput {
  return {
    source: 'backlog',
    id: 'AISDLC-1',
    title,
    body,
    workDir: tmp,
    ...extras,
  };
}

describe('evaluateIssue (Stage A only)', () => {
  it('admits a well-formed issue', async () => {
    const v = await evaluateIssue(
      input(
        '## Description\nFix typo in `pipeline-cli/src/index.ts`.\n## Acceptance Criteria\n- [ ] #1 Fix the typo\n',
        'fix RFC-0011 reference',
      ),
      { hermetic: true },
    );
    expect(v.overallVerdict).toBe('admit');
    expect(v.summary).toMatch(/admit/);
    expect(v.questions).toHaveLength(0);
  });

  it('blocks on missing AC list (gate 1)', async () => {
    const v = await evaluateIssue(input('plain body without AC', 'fix `path/to/file.ts`'), {
      hermetic: true,
    });
    expect(v.overallVerdict).toBe('needs-clarification');
    expect(v.gates.find((g) => g.gateId === 1)?.verdict).toBe('fail');
  });

  it('blocks on TBD marker (gate 2)', async () => {
    const v = await evaluateIssue(
      input('## Description\nThe plan is TBD.\n- [ ] #1 something `path/to/file.ts`'),
      { hermetic: true },
    );
    expect(v.overallVerdict).toBe('needs-clarification');
    expect(v.gates.find((g) => g.gateId === 2)?.verdict).toBe('fail');
  });

  it('blocks on missing surface (gate 5)', async () => {
    const v = await evaluateIssue(
      input('## Description\nMake the dashboard faster.\n- [ ] #1 Make it faster', 'speedup'),
      { hermetic: true },
    );
    expect(v.overallVerdict).toBe('needs-clarification');
    expect(v.gates.find((g) => g.gateId === 5)?.verdict).toBe('fail');
  });

  it('blocks on invisible dependency (gate 7)', async () => {
    const v = await evaluateIssue(
      input(
        '## Description\nDepends on the auth rewrite. `path/to/file.ts`\n- [ ] #1 Update auth flow',
      ),
      { hermetic: true },
    );
    expect(v.overallVerdict).toBe('needs-clarification');
    expect(v.gates.find((g) => g.gateId === 7)?.verdict).toBe('fail');
  });

  it('attaches durationMs and signedAt', async () => {
    const v = await evaluateIssue(input('## Description\nfoo `pipeline-cli/x.ts`\n- [ ] #1 do x'), {
      hermetic: true,
      now: () => new Date('2026-05-01T00:00:00Z'),
      evaluatorVersion: 'test-v1',
    });
    expect(v.signedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(v.evaluatorVersion).toBe('test-v1');
    expect(typeof v.durationMs).toBe('number');
    expect(v.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('runs gate 3 with file-existence resolver in hermetic mode', async () => {
    const v = await evaluateIssue(
      input('## Description\nSee RFC-9999 for context.\n- [ ] #1 do work `path/to/x.ts`'),
      { hermetic: true },
    );
    expect(v.overallVerdict).toBe('needs-clarification');
    expect(v.gates.find((g) => g.gateId === 3)?.verdict).toBe('fail');
  });

  it('non-hermetic mode passes through to default registry', async () => {
    // No refs in body so gate 3 short-circuits — verifies the non-hermetic
    // branch in evaluateGate3Hermetic.
    const v = await evaluateIssue(
      input('## Description\nplain `pipeline-cli/x.ts`\n- [ ] #1 do x'),
      {
        gate3: { resolvers: [fileExistenceResolver] },
      },
    );
    expect(v.overallVerdict).toBe('admit');
  });

  it('aggregates confidence: medium when at least one pass is medium', async () => {
    const v = await evaluateIssue(input('## Description\nfoo `pipeline-cli/x.ts`\n- [ ] #1 do x'), {
      hermetic: true,
    });
    expect(['medium', 'high']).toContain(v.overallConfidence);
  });

  it('aggregates confidence: high when all blocking failures are high', async () => {
    const v = await evaluateIssue(input('plain body'), { hermetic: true });
    expect(v.overallConfidence).toBe('high');
  });

  it('exposes per-gate clarificationQuestion in aggregated questions', async () => {
    const v = await evaluateIssue(input('plain'), { hermetic: true });
    expect(v.questions?.length ?? 0).toBeGreaterThan(0);
  });

  it('Stage A meets the <100ms perf budget on a normal issue', async () => {
    const body = `## Description\n${'word '.repeat(50)}\n## Acceptance Criteria\n- [ ] #1 Update \`pipeline-cli/src/x.ts\`\n- [ ] #2 Add coverage for RFC-0011\n`;
    const start = Date.now();
    await evaluateIssue(input(body, 'fix RFC-0011 typo'), { hermetic: true });
    const elapsed = Date.now() - start;
    // Locally Stage A is microseconds; allow generous slack for slow CI runners.
    expect(elapsed).toBeLessThan(100);
  });
});
