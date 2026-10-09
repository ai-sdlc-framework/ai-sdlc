/**
 * AISDLC-218: Hermetic test asserting the draft-PR step ordering.
 *
 * Problem (pre-AISDLC-218):
 *   The developer subagent opens a regular (non-draft) PR after pushing.
 *   This triggers CI run #1. Reviewers run on the open PR. The attestation
 *   pre-push hook signs the envelope as a chore commit and re-pushes →
 *   CI run #2. Every PR burns ~10-20 min of duplicate CI.
 *
 * Fix (AISDLC-218):
 *   1. Developer opens PR as DRAFT (`gh pr create --draft`).
 *   2. The pipeline pushes the branch.
 *   3. It opens the DRAFT PR (no CI fires — workflows skip drafts).
 *   4. The incremental-review marker is upserted AFTER the PR exists.
 *   5. It calls `gh pr ready <number>` — flips draft→ready_for_review.
 *   6. CI fires exactly ONCE on the fully-signed, reviewer-approved state.
 *
 * AISDLC-762 moved those steps out of the `execute.md` prose and into
 * `pipeline-cli/src/next-step/ship.ts`, so this test enforces the ordering
 * invariant on the code (a behavioural twin lives in `next-step/ship.test.ts`)
 * and keeps `execute.md` honest about the contract it delegates.
 * Mirror pattern: `pipeline-cli/src/cli/bin-invocation.test.ts` (AISDLC-156).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(__filename, '..', '..', '..');
const WORKSPACE_ROOT = resolve(PKG_ROOT, '..');
const EXECUTE_MD = resolve(WORKSPACE_ROOT, 'ai-sdlc-plugin', 'commands', 'execute.md');
const SHIP_TS = resolve(PKG_ROOT, 'src', 'next-step', 'ship.ts');
const DEVELOPER_MD = resolve(WORKSPACE_ROOT, 'ai-sdlc-plugin', 'agents', 'developer.md');
const WORKFLOW_RECS = resolve(PKG_ROOT, 'docs', 'aisdlc-218-workflow-changes.md');

// Each sentinel is a substring of ship.ts. The array order is the required
// execution order — if any sentinel appears before an earlier one, the test fails.
const SENTINELS = [
  {
    key: 'push-branch',
    sentinel: "['push', '-u', 'origin', state.branch]",
    description: 'the branch push (without PR creation)',
  },
  {
    key: 'draft-flag-in-gh-create',
    sentinel: "'--draft'",
    description: 'gh pr create must include --draft (AISDLC-218)',
  },
  {
    key: 'marker-upsert-after-pr',
    sentinel: 'await upsertReviewMarker(',
    description:
      'the marker upsert call must follow PR creation (gh pr comment needs the PR to exist)',
  },
  {
    key: 'flip-to-ready',
    sentinel: "['pr', 'ready', String(prNumber)]",
    description: 'gh pr ready flips draft to ready_for_review as the last step',
  },
] as const;

describe('AISDLC-218: draft-PR flow step ordering (ship.ts invariant)', () => {
  it('ship.ts and execute.md exist at the expected paths', () => {
    expect(existsSync(SHIP_TS), `ship.ts missing at: ${SHIP_TS}`).toBe(true);
    expect(existsSync(EXECUTE_MD), `execute.md missing at: ${EXECUTE_MD}`).toBe(true);
  });

  const code = existsSync(SHIP_TS) ? readFileSync(SHIP_TS, 'utf-8') : '';
  const content = existsSync(EXECUTE_MD) ? readFileSync(EXECUTE_MD, 'utf-8') : '';

  for (const { key, sentinel, description } of SENTINELS) {
    it(`sentinel "${key}" is present — ${description}`, () => {
      expect(code, description).toContain(sentinel);
    });
  }

  it('sentinels appear in the correct order: push → draft-open → marker → gh-pr-ready', () => {
    const positions = SENTINELS.map(({ key, sentinel }) => ({
      key,
      position: code.indexOf(sentinel),
    }));
    for (const { key, position } of positions) {
      expect(position, `Sentinel "${key}" not found in ship.ts`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 0; i < positions.length - 1; i++) {
      const a = positions[i];
      const b = positions[i + 1];
      expect(
        a.position,
        `Step order violation: "${a.key}" (pos ${a.position}) must appear before "${b.key}" (pos ${b.position})`,
      ).toBeLessThan(b.position);
    }
  });

  it('never opens a ready PR: --draft is the only create form and ready is a separate call', () => {
    expect(code).not.toMatch(/'pr',\s*'create',\s*'--title'/);
    expect(code.match(/'pr',\s*'ready'/g)?.length).toBe(1);
  });

  it('execute.md delegates the contract: DRAFT PR, then ready, CI fires once (AISDLC-218)', () => {
    expect(content).toContain('AISDLC-218');
    expect(content).toContain('DRAFT');
    expect(content).toMatch(/flips it ready/);
    expect(content).toMatch(/NOT flipped ready/);
  });
});

describe('AISDLC-218: developer.md draft-PR enforcement', () => {
  it('developer.md exists at the expected path', () => {
    expect(existsSync(DEVELOPER_MD), `developer.md missing at: ${DEVELOPER_MD}`).toBe(true);
  });

  const devContent = existsSync(DEVELOPER_MD) ? readFileSync(DEVELOPER_MD, 'utf-8') : '';

  it('developer.md instructs agents to use --draft when opening PRs', () => {
    expect(devContent, 'developer.md must instruct gh pr create --draft (AISDLC-218)').toContain(
      '--draft',
    );
  });

  it('developer.md Definition of Done mentions --draft requirement', () => {
    // The "Definition of Done" section must reference the draft requirement
    const dodIdx = devContent.indexOf('Definition of Done');
    expect(dodIdx, 'Definition of Done section not found in developer.md').toBeGreaterThanOrEqual(
      0,
    );
    const dodSection = devContent.slice(dodIdx, dodIdx + 1500);
    expect(dodSection, 'Definition of Done section must mention --draft (AISDLC-218)').toContain(
      '--draft',
    );
  });

  it('developer.md references AISDLC-218', () => {
    expect(devContent, 'developer.md must reference AISDLC-218').toContain('AISDLC-218');
  });
});

describe('AISDLC-218: workflow-changes recommendation file', () => {
  it('workflow recommendations file exists at pipeline-cli/docs/aisdlc-218-workflow-changes.md', () => {
    expect(
      existsSync(WORKFLOW_RECS),
      `workflow recommendations file missing at: ${WORKFLOW_RECS}`,
    ).toBe(true);
  });

  const recContent = existsSync(WORKFLOW_RECS) ? readFileSync(WORKFLOW_RECS, 'utf-8') : '';

  // Assert all 8 workflows are audited
  const AUDITED_WORKFLOWS = [
    'ai-sdlc-review.yml',
    'verify-attestation.yml',
    'ai-sdlc-gate.yml',
    'ci.yml',
    'dor-ingress.yml',
    'auto-enable-auto-merge.yml',
    'auto-rebase-open-prs.yml',
  ] as const;

  for (const workflow of AUDITED_WORKFLOWS) {
    it(`workflow "${workflow}" is covered in the recommendations file`, () => {
      expect(recContent, `${workflow} must be audited in aisdlc-218-workflow-changes.md`).toContain(
        workflow,
      );
    });
  }

  it('recommendations file mentions ready_for_review trigger pattern', () => {
    expect(recContent).toContain('ready_for_review');
  });

  it('recommendations file mentions job-level draft guard pattern', () => {
    expect(recContent).toContain('github.event.pull_request.draft == false');
  });
});
