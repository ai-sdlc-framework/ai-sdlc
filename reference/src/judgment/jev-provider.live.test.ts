/**
 * Live contract test for the Jev adapter: one real request carrying a choice, a
 * score and a noul, parsed through the adapter and compared, field set for field
 * set, with the answers the adapter produces from the recorded fixtures. It detects
 * drift between the fixtures and the live API.
 *
 * Runs only when TYPESAFE_API_KEY is set and AI_SDLC_LIVE_CONTRACT=1; otherwise it
 * is reported as skipped, with the reason in the test name. The key is read by the
 * adapter from the environment and is never printed or asserted on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createJevProvider } from './jev-provider.js';
import type { JudgmentRequest } from './types.js';

const enabled = !!process.env.TYPESAFE_API_KEY && process.env.AI_SDLC_LIVE_CONTRACT === '1';
const SKIP_REASON = 'skipped: set TYPESAFE_API_KEY and AI_SDLC_LIVE_CONTRACT=1 to run';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

const fieldSet = (answer: object): string[] => Object.keys(answer).sort();

const request: JudgmentRequest = {
  state: 'Help! My payouts have been failing for 3 days.',
  consumerLabel: 'live-contract-test',
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this?',
      options: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages', sales: null },
    },
    frustration: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      levels: ['Calm', 'Frustrated', 'Very angry'],
    },
    is_urgent: {
      type: 'noul',
      instructions: 'Does this convey urgency?',
      criteria: { true: 'Explicitly time-sensitive', false: 'No urgency expressed' },
    },
  },
};

/** The adapter's output for each question type, built from the recorded fixtures. */
async function recordedFieldSets(): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const [name, id] of [
    ['choice', 'department'],
    ['score', 'frustration'],
    ['noul', 'is_urgent'],
  ] as const) {
    const provider = createJevProvider({
      apiKey: 'fixture-key',
      fetchImpl: (async () =>
        new Response(JSON.stringify(fixture(`${name}.response`)), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const single: JudgmentRequest = {
      ...request,
      questions: { [id]: request.questions[id] },
    };
    const res = await provider.evaluate(single);
    out[name] = fieldSet(res.answers[id]);
  }
  return out;
}

describe.skipIf(!enabled)(`jev live contract (${enabled ? 'enabled' : SKIP_REASON})`, () => {
  it('parses a live choice, score and noul with the recorded field sets', async () => {
    const recorded = await recordedFieldSets();
    const res = await createJevProvider({ timeoutMs: 30_000 }).evaluate(request);

    expect(fieldSet(res.answers.department)).toEqual(recorded.choice);
    expect(fieldSet(res.answers.frustration)).toEqual(recorded.score);
    expect(fieldSet(res.answers.is_urgent)).toEqual(recorded.noul);
    expect(fieldSet(res.usage)).toEqual(['inputTokens', 'outputTokens']);
    expect(typeof res.modelVersion).toBe('string');
    expect(res.modelVersion.length).toBeGreaterThan(0);
  }, 60_000);
});

// Always runs: the recorded fixtures define the field sets the live response is held to.
describe('jev live contract baseline', () => {
  it('derives the expected field sets from the recorded fixtures', async () => {
    expect(await recordedFieldSets()).toEqual({
      choice: ['choice', 'confidence', 'probabilities', 'type'],
      score: ['confidence', 'probabilities', 'score', 'type'],
      noul: ['probability', 'type'],
    });
  });
});
