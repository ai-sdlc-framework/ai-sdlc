/**
 * AISDLC-218: Hermetic test asserting the draft-PR step ordering in
 * `ai-sdlc-plugin/commands/execute.md`.
 *
 * Problem (pre-AISDLC-218):
 *   The developer subagent opens a regular (non-draft) PR after pushing.
 *   This triggers CI run #1. Reviewers run on the open PR. The attestation
 *   pre-push hook signs the envelope as a chore commit and re-pushes →
 *   CI run #2. Every PR burns ~10-20 min of duplicate CI.
 *
 * Fix (AISDLC-218):
 *   1. Developer opens PR as DRAFT (`gh pr create --draft`).
 *   2. `/ai-sdlc execute` Step 11a pushes the branch.
 *   3. Step 11b opens the DRAFT PR (no CI fires — workflows skip drafts).
 *   4. Steps 12-14 run reviewers + attestation sign while still draft.
 *   5. Step 13 calls `gh pr ready <number>` — flips draft→ready_for_review.
 *   6. CI fires exactly ONCE on the fully-signed, reviewer-approved state.
 *
 * This test enforces the ordering invariant by scanning execute.md for the
 * presence and correct relative order of the sentinel strings for each step.
 * Mirror pattern: `pipeline-cli/src/cli/bin-invocation.test.ts` (AISDLC-156).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the execute.md path relative to this test file:
//   <pkg-root>/src/cli/draft-pr-flow.test.ts → <pkg-root>/../../ai-sdlc-plugin/commands/execute.md
const __filename = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(__filename, '..', '..', '..');
const WORKSPACE_ROOT = resolve(PKG_ROOT, '..');
const EXECUTE_MD = resolve(WORKSPACE_ROOT, 'ai-sdlc-plugin', 'commands', 'execute.md');
const DEVELOPER_MD = resolve(WORKSPACE_ROOT, 'ai-sdlc-plugin', 'agents', 'developer.md');
const WORKFLOW_RECS = resolve(PKG_ROOT, 'docs', 'aisdlc-218-workflow-changes.md');

// ── Sentinel strings for the AISDLC-218 step sequence ─────────────────────
//
// Each sentinel is a substring that appears in the corresponding step of
// execute.md. The order of sentinels defines the required ordering — if any
// sentinel appears before an earlier one, the test fails. This is the same
// doc-vs-code invariant technique used in bin-invocation.test.ts (AISDLC-156).

const SENTINELS = [
  {
    key: 'push-branch-step',
    // Step 11a: branch push WITHOUT PR creation
    sentinel: '## Step 11 — Push branch + open as DRAFT PR',
    description: 'Step 11 heading (push + draft PR) must be present in execute.md',
  },
  {
    key: 'push-substep',
    // Step 11a subheading
    sentinel: '### Step 11a — Push branch',
    description: 'Step 11a subheading (push branch) must be present in execute.md',
  },
  {
    key: 'open-draft-pr-substep',
    // Step 11b: `gh pr create --draft` — the key AISDLC-218 change
    sentinel: '### Step 11b — Open as DRAFT PR',
    description: 'Step 11b subheading (open as draft PR) must be present in execute.md',
  },
  {
    key: 'draft-flag-in-gh-create',
    // The `--draft` flag itself in the gh pr create command
    sentinel: 'gh pr create \\\n  --draft',
    description: 'gh pr create must include --draft flag (AISDLC-218)',
  },
  {
    key: 'marker-upsert-substep',
    // Step 11c: incremental-review marker upsert MUST come AFTER Step 11b
    // (PR creation) — code-reviewer flagged the original Step 8.5 placement
    // as a real runtime bug because gh pr comment requires the PR to exist.
    sentinel: '### Step 11c — Update the incremental-review marker',
    description:
      'Step 11c subheading (marker upsert post-PR-creation) must be present in execute.md (AISDLC-218 ordering fix)',
  },
  {
    key: 'flip-to-ready-heading',
    // Step 13 heading: flip draft→ready_for_review
    sentinel: '## Step 13 — Flip DRAFT',
    description: 'Step 13 heading (flip draft to ready) must be present in execute.md',
  },
  {
    key: 'flip-to-ready-command',
    // The actual gh pr ready command in Step 13 code block
    sentinel: 'gh pr ready "$MAIN_PR_NUMBER"',
    description: 'gh pr ready $MAIN_PR_NUMBER must be present in execute.md Step 13',
  },
] as const;

describe('AISDLC-218: draft-PR flow step ordering (execute.md invariant)', () => {
  it('execute.md exists at the expected path', () => {
    expect(existsSync(EXECUTE_MD), `execute.md missing at: ${EXECUTE_MD}`).toBe(true);
  });

  const content = existsSync(EXECUTE_MD) ? readFileSync(EXECUTE_MD, 'utf-8') : '';

  // Assert each sentinel is present
  for (const { key, sentinel, description } of SENTINELS) {
    it(`sentinel "${key}" is present — ${description}`, () => {
      expect(content, description).toContain(sentinel);
    });
  }

  // Assert the sentinels appear in the CORRECT ORDER.
  // If any sentinel appears before an earlier one, the step ordering is wrong.
  it('sentinels appear in the correct order: push → draft-open → gh-pr-ready', () => {
    const positions = SENTINELS.map(({ key, sentinel }) => ({
      key,
      sentinel,
      position: content.indexOf(sentinel),
    }));

    // Every sentinel must be found
    for (const { key, sentinel, position } of positions) {
      expect(
        position,
        `Sentinel "${key}" ("${sentinel.slice(0, 40)}...") not found in execute.md`,
      ).toBeGreaterThanOrEqual(0);
    }

    // Adjacent pairs must be in ascending position order
    for (let i = 0; i < positions.length - 1; i++) {
      const a = positions[i];
      const b = positions[i + 1];
      if (a.position < 0 || b.position < 0) continue; // individual test will catch this
      expect(
        a.position,
        `Step order violation: "${a.key}" (pos ${a.position}) must appear before "${b.key}" (pos ${b.position})`,
      ).toBeLessThan(b.position);
    }
  });

  it('execute.md contains AISDLC-218 rationale block', () => {
    expect(content).toContain('AISDLC-218');
    expect(content).toContain('1 CI run per PR');
  });

  it('execute.md mentions Step 13 as the ready_for_review flip', () => {
    // Step 13 must mention ready_for_review as the CI trigger
    const step13Idx = content.indexOf('## Step 13');
    expect(step13Idx, 'Step 13 heading not found in execute.md').toBeGreaterThanOrEqual(0);

    const step13Body = content.slice(step13Idx, step13Idx + 2000);
    expect(step13Body).toContain('ready_for_review');
    expect(step13Body).toContain('gh pr ready');
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
    'verify-mcp-bundle.yml',
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
