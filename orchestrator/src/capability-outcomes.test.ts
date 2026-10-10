/**
 * Capability outcome reporting from the orchestrator seams (RFC-0049 section 9.2):
 * Layer 3 scoring, meta-review and the policy LLM evaluator. Hermetic: temp dirs only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCapabilityState,
  resolveJudgmentConfig,
  type DesignIntentDocument,
} from '@ai-sdlc/reference';
import { createPipelineLLMEvaluator } from './policy-evaluators.js';
import { executeReview } from './review.js';
import { buildOrchestratorJudgmentContext } from './judgment-context.js';
import { scoreSoulAlignment } from './sa-scoring/index.js';
import { FakeDepparseClient } from './sa-scoring/depparse-client.js';
import { RecordedLLMClient } from './sa-scoring/layer3-llm.js';
import type { ReviewAgentRunner } from './runners/review-agent.js';

const ORCHESTRATOR_CAPABILITIES = ['sa.layer3', 'review.meta-review', 'policy.llm-evaluator'];

/** The twelve capabilities of RFC-0049 section 9.1; the pipeline-cli test covers the other nine. */
const PIPELINE_CLI_CAPABILITIES = [
  'classifier.capture-triage',
  'classifier.capture-severity',
  'classifier.pr-comment-is-capture',
  'classifier.dor-answer-is-new-concern',
  'decisions.stage-c-recommendation',
  'decisions.stage-b-signals',
  'dor.stage-b',
  'estimation.class-assignment',
  'estimation.stage-b',
];

let root: string;
let artifacts: string;
let unwritable: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orch-capability-'));
  artifacts = join(root, 'artifacts');
  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'a regular file');
  unwritable = join(blocker, 'artifacts');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function row(id: string, dir = artifacts) {
  const r = readCapabilityState(dir).find((x) => x.id === id);
  if (!r) throw new Error(`unregistered ${id}`);
  return r;
}
const total = (id: string, dir = artifacts) => {
  const { live, shadow, degraded } = row(id, dir).counts;
  return live + shadow + degraded;
};

function fakeRunner(summary: object): ReviewAgentRunner {
  return {
    run: async () => ({ success: true, summary: JSON.stringify(summary) }),
  } as unknown as ReviewAgentRunner;
}

const VERDICT = {
  type: 'critic',
  approved: true,
  findings: [{ severity: 'minor', message: 'x', confidence: 0.6 }],
  summary: 's',
};
const CTX = { issueTitle: 't', issueBody: 'b' };

describe('policy.llm-evaluator', () => {
  it('reports degraded stub-evaluator when the stub is chosen', () => {
    const ev = createPipelineLLMEvaluator({ artifactsDir: artifacts });
    expect(typeof ev.evaluate).toBe('function');
    expect(row('policy.llm-evaluator').lastDegradedReason).toBe('stub-evaluator');
    expect(total('policy.llm-evaluator')).toBe(1);
  });

  it('still returns an evaluator with an unwritable state directory', async () => {
    const ev = createPipelineLLMEvaluator({ artifactsDir: unwritable });
    await expect(ev.evaluate('x', [])).resolves.toEqual([]);
  });
});

describe('review.meta-review', () => {
  it('reports degraded no-meta-review when no meta-review function is supplied', async () => {
    const v = await executeReview(1, 'diff', 'critic', CTX, {
      runner: fakeRunner(VERDICT),
      artifactsDir: artifacts,
    });
    expect(v.approved).toBe(true);
    expect(row('review.meta-review').lastDegradedReason).toBe('no-meta-review');
    expect(total('review.meta-review')).toBe(1);
  });

  it('reports live once when a meta-review function and principles are supplied', async () => {
    await executeReview(1, 'diff', 'critic', CTX, {
      runner: fakeRunner(VERDICT),
      principles: 'be kind',
      metaReviewLLM: async () => JSON.stringify({ keep: true, reason: 'ok' }),
      artifactsDir: artifacts,
    });
    expect(row('review.meta-review').status).toBe('live');
    expect(total('review.meta-review')).toBe(1);
  });

  it('returns the same verdict with an unwritable state directory', async () => {
    const run = (dir: string) =>
      executeReview(1, 'diff', 'critic', CTX, {
        runner: fakeRunner(VERDICT),
        principles: 'p',
        metaReviewLLM: async () => JSON.stringify({ keep: false, reason: 'noise' }),
        artifactsDir: dir,
      });
    expect(await run(unwritable)).toEqual(await run(artifacts));
  });
});

function makeDid(): DesignIntentDocument {
  return {
    apiVersion: 'ai-sdlc.io/v1alpha1',
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: {
          value: 'Help small businesses onboard in under 60 seconds.',
          identityClass: 'core',
        },
        scopeBoundaries: {
          outOfScope: [{ label: 'enterprise SSO', identityClass: 'core', synonyms: ['SAML'] }],
        },
        constraints: [],
        antiPatterns: [],
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Simple, intuitive forms.',
            identityClass: 'core',
            measurableSignals: [],
          },
        ],
      },
      designSystemRef: { name: 'acme-ds' },
      triad: {
        design: { authority: '${operator}' },
        engineering: { authority: '${operator}' },
        product: { authority: '${operator}' },
      },
    },
  };
}

function llmClient(): RecordedLLMClient {
  const client = new RecordedLLMClient();
  client.setResponse(
    'SA-1',
    JSON.stringify({ domainIntent: 0.8, confidence: 0.9, subtleConflicts: [] }),
  );
  client.setResponse(
    'SA-2',
    JSON.stringify({ principleAlignment: 0.7, confidence: 0.9, subtleDesignConflicts: [] }),
  );
  return client;
}

const CLEAN = {
  issueText: 'Simplify small business onboarding.',
  did: makeDid(),
  phase: '2b' as const,
};

describe('sa.layer3', () => {
  it('reports degraded no-client when no Layer 3 client is supplied', async () => {
    const result = await scoreSoulAlignment(CLEAN, {
      depparse: new FakeDepparseClient(),
      artifactsDir: artifacts,
    });
    expect(result.layer3).toBeUndefined();
    const r = row('sa.layer3');
    expect(r.status).toBe('degraded');
    expect(r.lastDegradedReason).toBe('no-client');
    expect(total('sa.layer3')).toBe(1);
  });

  it('reports live once when a client is supplied', async () => {
    const result = await scoreSoulAlignment(CLEAN, {
      depparse: new FakeDepparseClient(),
      llm: llmClient(),
      artifactsDir: artifacts,
    });
    expect(result.layer3).toBeDefined();
    expect(row('sa.layer3').status).toBe('live');
    expect(total('sa.layer3')).toBe(1);
  });

  it('reports nothing when Layer 1 hard-gates (Layer 3 is skipped by design)', async () => {
    const result = await scoreSoulAlignment(
      { ...CLEAN, issueText: 'Add SAML federation for enterprise customers' },
      { depparse: new FakeDepparseClient(), artifactsDir: artifacts },
    );
    expect(result.layer1.hardGated).toBe(true);
    expect(total('sa.layer3')).toBe(0);
  });

  it('returns the same result with an unwritable state directory', async () => {
    const run = (dir: string) =>
      scoreSoulAlignment(CLEAN, { depparse: new FakeDepparseClient(), artifactsDir: dir });
    expect(await run(unwritable)).toEqual(await run(artifacts));
  });
});

describe('judgment context builder', () => {
  it('supplies the capability callback even when the layer is disabled', () => {
    const ctx = buildOrchestratorJudgmentContext({
      artifactsDir: artifacts,
      config: resolveJudgmentConfig({ spec: {} }),
    });
    ctx.onCapabilityOutcome?.({ capabilityId: 'sa.layer3', outcome: 'degraded', reason: 'off' });
    expect(row('sa.layer3').lastDegradedReason).toBe('off');
  });
});

describe('union with pipeline-cli', () => {
  it('the two packages together cover all twelve RFC-0049 capabilities', () => {
    const all = new Set([...ORCHESTRATOR_CAPABILITIES, ...PIPELINE_CLI_CAPABILITIES]);
    expect(all.size).toBe(12);
    const registered = new Set(readCapabilityState(artifacts).map((r) => r.id));
    for (const id of all) expect(registered.has(id)).toBe(true);
  });
});
