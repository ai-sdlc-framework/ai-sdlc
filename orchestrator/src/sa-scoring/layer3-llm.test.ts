import { describe, it, expect } from 'vitest';
import type { DesignIntentDocument } from '@ai-sdlc/reference';
import {
  buildSa1Prompt,
  buildSa2Prompt,
  CI_BOUNDARY_HEADER,
  CONFIDENCE_THRESHOLD,
  extractJson,
  LayerLlmError,
  RecordedLLMClient,
  runLayer3,
  SCOPE_GUIDANCE,
} from './layer3-llm.js';

const API_VERSION = 'ai-sdlc.io/v1alpha1' as const;

function makeDid(): DesignIntentDocument {
  return {
    apiVersion: API_VERSION,
    kind: 'DesignIntentDocument',
    metadata: { name: 'acme-did' },
    spec: {
      stewardship: {
        productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
        designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
      },
      soulPurpose: {
        mission: { value: 'Acme helps small businesses succeed.' },
        designPrinciples: [
          {
            id: 'approachable',
            name: 'Approachable',
            description: 'Forms must feel simple and intuitive.',
            identityClass: 'core',
            measurableSignals: [
              {
                id: 'time-to-value',
                metric: 'secondsToFirstValue',
                threshold: 60,
                operator: 'lte',
              },
            ],
          },
        ],
      },
      designSystemRef: { name: 'acme-ds' },
    },
  };
}

const SUMMARY = '## Deterministic verification\n\n- Hard gated: no\n';

describe('buildSa1Prompt', () => {
  it('includes CI-Boundary header + scope guidance (AC #1)', () => {
    const prompt = buildSa1Prompt({
      issueText: 'add onboarding flow',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
    });
    expect(prompt).toContain(CI_BOUNDARY_HEADER);
    expect(prompt).toContain(SCOPE_GUIDANCE);
    expect(prompt).toContain('# SA-1');
  });

  it('injects preVerifiedSummary verbatim', () => {
    const prompt = buildSa1Prompt({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
    });
    expect(prompt).toContain(SUMMARY);
  });

  it('renders mission in the prompt', () => {
    const prompt = buildSa1Prompt({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
    });
    expect(prompt).toContain('Acme helps small businesses');
  });
});

describe('buildSa2Prompt', () => {
  it('AC #4: does NOT mention tokenCompliance or catalogHealth (Amendment 2)', () => {
    const prompt = buildSa2Prompt({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
    });
    expect(prompt).not.toMatch(/tokenCompliance/i);
    expect(prompt).not.toMatch(/catalogHealth/i);
    // And it must explicitly direct the LLM to ignore those.
    expect(prompt).toMatch(/Ignore DSB-level token compliance/i);
  });

  it('renders design principles with identityClass tag', () => {
    const prompt = buildSa2Prompt({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
    });
    expect(prompt).toContain('Approachable');
    expect(prompt).toContain('[core]');
  });

  it('includes scope guidance (AC #1)', () => {
    const prompt = buildSa2Prompt({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
    });
    expect(prompt).toContain(SCOPE_GUIDANCE);
  });
});

describe('extractJson', () => {
  it('parses raw JSON', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('unwraps fenced JSON code blocks', () => {
    const input = 'Here is the answer:\n```json\n{"a": 2}\n```\n';
    expect(extractJson(input)).toEqual({ a: 2 });
  });

  it('AC #2: rejects malformed JSON with typed error', () => {
    expect(() => extractJson('{not valid}')).toThrow(LayerLlmError);
    try {
      extractJson('{not valid}');
    } catch (err) {
      expect(err).toBeInstanceOf(LayerLlmError);
      expect((err as LayerLlmError).kind).toBe('malformed-json');
    }
  });
});

describe('runLayer3', () => {
  function makeClient(sa1: unknown, sa2: unknown): RecordedLLMClient {
    const client = new RecordedLLMClient();
    client.setResponse('SA-1', JSON.stringify(sa1));
    client.setResponse('SA-2', JSON.stringify(sa2));
    return client;
  }

  it('AC #5: deterministic test uses recorded-fixture client', async () => {
    const llm = makeClient(
      { domainIntent: 0.8, confidence: 0.9, subtleConflicts: [] },
      { principleAlignment: 0.7, confidence: 0.9, subtleDesignConflicts: [] },
    );
    const result = await runLayer3({
      issueText: 'onboarding',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
      llm,
    });
    expect(result.domainIntent).toBe(0.8);
    expect(result.principleAlignment).toBe(0.7);
    expect(result.preVerifiedBoundaryApplied).toBe(true);
    expect(llm.promptLog).toHaveLength(2); // SA-1 + SA-2
  });

  it('AC #3: subtle conflict with confidence=0.4 dropped; 0.5 kept', async () => {
    const llm = makeClient(
      {
        domainIntent: 0.8,
        confidence: 0.9,
        subtleConflicts: [
          { description: 'dropped', severity: 'low', confidence: 0.4 },
          { description: 'kept', severity: 'medium', confidence: 0.5 },
        ],
      },
      { principleAlignment: 0.7, confidence: 0.9, subtleDesignConflicts: [] },
    );
    const result = await runLayer3({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
      llm,
    });
    expect(result.subtleConflicts).toHaveLength(1);
    expect(result.subtleConflicts[0].description).toBe('kept');
    expect(result.suppressedFindings).toBe(1);
  });

  it('suppresses domainIntent to 0 when SA-1 confidence < 0.5', async () => {
    const llm = makeClient(
      { domainIntent: 0.8, confidence: 0.3, subtleConflicts: [] },
      { principleAlignment: 0.7, confidence: 0.9, subtleDesignConflicts: [] },
    );
    const result = await runLayer3({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
      llm,
    });
    expect(result.domainIntent).toBe(0);
    expect(result.domainIntentConfidence).toBe(0.3);
    expect(result.suppressedFindings).toBeGreaterThanOrEqual(1);
  });

  it('suppresses principleAlignment to 0 when SA-2 confidence < 0.5', async () => {
    const llm = makeClient(
      { domainIntent: 0.8, confidence: 0.9, subtleConflicts: [] },
      { principleAlignment: 0.7, confidence: 0.2, subtleDesignConflicts: [] },
    );
    const result = await runLayer3({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
      llm,
    });
    expect(result.principleAlignment).toBe(0);
    expect(result.principleAlignmentConfidence).toBe(0.2);
  });

  it('clamps score values to [0, 1]', async () => {
    const llm = makeClient(
      { domainIntent: 1.5, confidence: 0.9, subtleConflicts: [] },
      { principleAlignment: -0.3, confidence: 0.9, subtleDesignConflicts: [] },
    );
    const result = await runLayer3({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
      llm,
    });
    expect(result.domainIntent).toBe(1);
    expect(result.principleAlignment).toBe(0);
  });

  it('throws LayerLlmError on malformed JSON response (AC #2)', async () => {
    const llm = new RecordedLLMClient();
    llm.setResponse('SA-1', 'NOT JSON AT ALL');
    llm.setResponse('SA-2', JSON.stringify({ principleAlignment: 0.5, confidence: 0.9 }));

    await expect(
      runLayer3({
        issueText: 'x',
        did: makeDid(),
        preVerifiedSummary: SUMMARY,
        llm,
      }),
    ).rejects.toBeInstanceOf(LayerLlmError);
  });

  it('throws LayerLlmError on missing required field', async () => {
    const llm = new RecordedLLMClient();
    llm.setResponse('SA-1', JSON.stringify({ confidence: 0.9 })); // missing domainIntent
    llm.setResponse('SA-2', JSON.stringify({ principleAlignment: 0.5, confidence: 0.9 }));

    await expect(
      runLayer3({
        issueText: 'x',
        did: makeDid(),
        preVerifiedSummary: SUMMARY,
        llm,
      }),
    ).rejects.toMatchObject({ kind: 'missing-field' });
  });

  it('handles fenced JSON in LLM responses', async () => {
    const llm = new RecordedLLMClient();
    llm.setResponse(
      'SA-1',
      '```json\n' +
        JSON.stringify({ domainIntent: 0.9, confidence: 0.95, subtleConflicts: [] }) +
        '\n```',
    );
    llm.setResponse(
      'SA-2',
      JSON.stringify({ principleAlignment: 0.8, confidence: 0.85, subtleDesignConflicts: [] }),
    );
    const result = await runLayer3({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
      llm,
    });
    expect(result.domainIntent).toBe(0.9);
  });
});

describe('CONFIDENCE_THRESHOLD', () => {
  it('is 0.5 per §B.6.1', () => {
    expect(CONFIDENCE_THRESHOLD).toBe(0.5);
  });
});

describe('RecordedLLMClient fallback + error paths', () => {
  it('uses setFallbackResponse when no keyed response matches', async () => {
    const client = new RecordedLLMClient();
    client.setFallbackResponse('{"fallback": true}');
    const out = await client.complete('anything goes');
    expect(out).toBe('{"fallback": true}');
    expect(client.promptLog).toContain('anything goes');
  });

  it('throws when no keyed response and no fallback is configured', async () => {
    const client = new RecordedLLMClient();
    await expect(client.complete('orphan')).rejects.toThrow(
      'RecordedLLMClient: no response configured for this prompt',
    );
    expect(client.promptLog).toEqual(['orphan']);
  });

  it('prefers keyed response over fallback when key is a substring of the prompt', async () => {
    const client = new RecordedLLMClient();
    client.setFallbackResponse('fallback');
    client.setResponse('SA-1', 'keyed');
    expect(await client.complete('SA-1 prompt text')).toBe('keyed');
    expect(await client.complete('SA-X prompt text')).toBe('fallback');
  });
});

describe('SA-1 DID summary — experientialTargets rendering', () => {
  it('includes experiential targets in the prompt and filters out undefined entries', () => {
    const did: DesignIntentDocument = {
      apiVersion: API_VERSION,
      kind: 'DesignIntentDocument',
      metadata: { name: 'acme-did' },
      spec: {
        stewardship: {
          productAuthority: { owner: 'p', approvalRequired: ['p'], scope: ['m'] },
          designAuthority: { owner: 'd', approvalRequired: ['d'], scope: ['dp'] },
        },
        soulPurpose: {
          mission: { value: 'M' },
          designPrinciples: [
            {
              id: 'p',
              name: 'P',
              description: 'd',
              measurableSignals: [{ id: 's', metric: 'm', threshold: 1, operator: 'gte' }],
            },
          ],
        },
        experientialTargets: {
          perceivedComplexity: { target: 'low' },
          emotionalTone: undefined,
        } as unknown as DesignIntentDocument['spec']['experientialTargets'],
        designSystemRef: { name: 'acme-ds' },
      },
    };
    const prompt = buildSa1Prompt({ issueText: 'x', did, preVerifiedSummary: SUMMARY });
    expect(prompt).toContain('Experiential targets');
    expect(prompt).toContain('perceivedComplexity');
    expect(prompt).not.toContain('emotionalTone');
  });
});

describe('parseSa1 / parseSa2 object guards', () => {
  it('throws LayerLlmError with kind=malformed-json when SA-1 response parses to non-object', async () => {
    const client = new RecordedLLMClient();
    client.setResponse('SA-1', '42');
    client.setResponse('SA-2', JSON.stringify({ principleAlignment: 0.5, confidence: 0.9 }));
    await expect(
      runLayer3({ issueText: 'x', did: makeDid(), preVerifiedSummary: SUMMARY, llm: client }),
    ).rejects.toMatchObject({ kind: 'malformed-json' });
  });

  it('throws LayerLlmError with kind=malformed-json when SA-2 response parses to non-object', async () => {
    const client = new RecordedLLMClient();
    client.setResponse('SA-1', JSON.stringify({ domainIntent: 0.5, confidence: 0.9 }));
    client.setResponse('SA-2', 'null');
    await expect(
      runLayer3({ issueText: 'x', did: makeDid(), preVerifiedSummary: SUMMARY, llm: client }),
    ).rejects.toMatchObject({ kind: 'malformed-json' });
  });

  it('treats non-array subtleConflicts/subtleDesignConflicts as undefined (filtered to empty)', async () => {
    const client = new RecordedLLMClient();
    client.setResponse(
      'SA-1',
      JSON.stringify({ domainIntent: 0.8, confidence: 0.9, subtleConflicts: 'not an array' }),
    );
    client.setResponse(
      'SA-2',
      JSON.stringify({
        principleAlignment: 0.8,
        confidence: 0.9,
        subtleDesignConflicts: { not: 'an array' },
      }),
    );
    const result = await runLayer3({
      issueText: 'x',
      did: makeDid(),
      preVerifiedSummary: SUMMARY,
      llm: client,
    });
    expect(result.subtleConflicts).toEqual([]);
    expect(result.subtleDesignConflicts).toEqual([]);
  });
});
