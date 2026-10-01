/**
 * Provider-neutral types for the judgment layer: closed-set questions
 * (choice, score, yes/no) answered with probabilities and no generated text.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** A free-form instruction / option / level description. */
export type Entry = string | JsonObject | JsonValue[] | null;

export type JudgmentQuestion =
  | { type: 'choice'; instructions: Entry; options: Record<string, Entry> }
  | { type: 'score'; instructions: Entry; levels: Entry[] }
  | { type: 'noul'; instructions: Entry; criteria?: { true?: Entry; false?: Entry } };

export type JudgmentAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: number[]; confidence: number }
  | { type: 'noul'; probability: number };

export interface JudgmentRequest {
  /** String, object or array of text the questions are asked about. */
  state: JsonValue;
  /** Ids are for calling code; the wire uses them as map keys. */
  questions: Record<string, JudgmentQuestion>;
  /** Cost-attribution tag, e.g. 'dor.stage-b'. */
  consumerLabel: string;
}

export interface JudgmentResponse {
  answers: Record<string, JudgmentAnswer>;
  /** Versioned model id the provider reports. */
  modelVersion: string;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
}

export interface JudgmentCapabilities {
  maxStateTokens: number;
  maxRequestTokens: number;
  maxChoiceOptions: number;
  maxScoreLevels: number;
  billingModel: 'pay-per-token' | 'subscription' | 'free';
  inputCostPer1MTokens: number;
  outputCostPer1MTokens: number;
  calibratedProbabilities: boolean;
}

export interface JudgmentProvider {
  readonly name: string;
  readonly modelId: string;
  readonly capabilities: JudgmentCapabilities;
  readonly requires: { envVar: string };
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  /** One-way hash of the credential, or null when none is configured. */
  getAccountId(): Promise<string | null>;
  evaluate(req: JudgmentRequest): Promise<JudgmentResponse>;
}
