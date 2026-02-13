/**
 * Gate enforcement example — programmatic quality gate evaluation.
 *
 * Run: npx tsx docs/examples/gate-enforcement.ts
 */

import {
  QualityGateBuilder,
  enforce,
  evaluateGate,
  type EvaluationContext,
} from '@ai-sdlc/reference';

// Build a quality gate with multiple rules
const gate = new QualityGateBuilder('code-standards')
  .withScope({ authorTypes: ['ai-agent'] })
  .addGate({
    name: 'test-coverage',
    enforcement: 'soft-mandatory',
    rule: { metric: 'line-coverage', operator: '>=', threshold: 80 },
    override: { requiredRole: 'engineering-manager', requiresJustification: true },
  })
  .addGate({
    name: 'security-scan',
    enforcement: 'hard-mandatory',
    rule: { tool: 'semgrep', maxSeverity: 'medium', rulesets: ['owasp-top-10'] },
  })
  .addGate({
    name: 'reviewer-check',
    enforcement: 'advisory',
    rule: { minimumReviewers: 2, aiAuthorRequiresExtraReviewer: true },
  })
  .addGate({
    name: 'doc-update',
    enforcement: 'advisory',
    rule: { changedFilesRequireDocUpdate: true },
  })
  .build();

// ── Scenario 1: All gates pass ────────────────────────────────────────

console.log('=== Scenario 1: All gates pass ===');

const passingCtx: EvaluationContext = {
  authorType: 'ai-agent',
  repository: 'org/my-service',
  metrics: { 'line-coverage': 92 },
  toolResults: { semgrep: { findings: [] } },
  reviewerCount: 3,
  changedFiles: ['src/auth.ts'],
  docFiles: ['docs/auth.md'],
};

const result1 = enforce(gate, passingCtx);
console.log('Allowed:', result1.allowed);
for (const r of result1.results) {
  console.log(`  ${r.gate}: ${r.verdict}${r.message ? ` (${r.message})` : ''}`);
}

// ── Scenario 2: Coverage fails, override applied ──────────────────────

console.log('\n=== Scenario 2: Coverage fails with override ===');

const overrideCtx: EvaluationContext = {
  authorType: 'ai-agent',
  repository: 'org/my-service',
  metrics: { 'line-coverage': 72 }, // Below threshold
  toolResults: { semgrep: { findings: [] } },
  reviewerCount: 3,
  overrideRole: 'engineering-manager',
  overrideJustification: 'Emergency hotfix — coverage will be backfilled',
};

const result2 = enforce(gate, overrideCtx);
console.log('Allowed:', result2.allowed);
for (const r of result2.results) {
  console.log(`  ${r.gate}: ${r.verdict}${r.message ? ` (${r.message})` : ''}`);
}

// ── Scenario 3: Security scan finds critical issue ────────────────────

console.log('\n=== Scenario 3: Security scan fails (hard-mandatory) ===');

const securityFailCtx: EvaluationContext = {
  authorType: 'ai-agent',
  repository: 'org/my-service',
  metrics: { 'line-coverage': 90 },
  toolResults: {
    semgrep: {
      findings: [
        { severity: 'high' as const }, // Exceeds 'medium' max
        { severity: 'low' as const }, // This one is fine
      ],
    },
  },
  reviewerCount: 3,
};

const result3 = enforce(gate, securityFailCtx);
console.log('Allowed:', result3.allowed); // false — hard-mandatory failure
for (const r of result3.results) {
  console.log(`  ${r.gate}: ${r.verdict}${r.message ? ` (${r.message})` : ''}`);
}

// ── Scenario 4: Evaluate a single gate ────────────────────────────────

console.log('\n=== Scenario 4: Single gate evaluation ===');

const singleResult = evaluateGate(
  {
    name: 'coverage-check',
    enforcement: 'soft-mandatory',
    rule: { metric: 'branch-coverage', operator: '>=', threshold: 75 },
  },
  {
    authorType: 'human',
    repository: 'org/repo',
    metrics: { 'branch-coverage': 80 },
  },
);

console.log(`Gate: ${singleResult.gate}, Verdict: ${singleResult.verdict}`);
