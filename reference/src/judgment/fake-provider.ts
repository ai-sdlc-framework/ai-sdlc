import { JudgmentProviderError, type JudgmentProviderErrorKind } from './errors.js';
import type {
  JudgmentAnswer,
  JudgmentCapabilities,
  JudgmentProvider,
  JudgmentRequest,
  JudgmentResponse,
} from './types.js';

export type ScriptedAnswer = JudgmentAnswer | ((req: JudgmentRequest) => JudgmentAnswer);

export interface FakeJudgmentProviderOptions {
  name?: string;
  modelId?: string;
  capabilities?: Partial<JudgmentCapabilities>;
  available?: boolean;
}

const DEFAULT_CAPABILITIES: JudgmentCapabilities = {
  maxStateTokens: 32000,
  maxRequestTokens: 64000,
  maxChoiceOptions: 255,
  maxScoreLevels: 10,
  billingModel: 'free',
  inputCostPer1MTokens: 0,
  outputCostPer1MTokens: 0,
  calibratedProbabilities: true,
};

/** In-memory provider for hermetic tests: scripted answers, recorded requests. */
export class FakeJudgmentProvider implements JudgmentProvider {
  readonly name: string;
  readonly modelId: string;
  readonly capabilities: JudgmentCapabilities;
  readonly requires = { envVar: 'FAKE_JUDGMENT_API_KEY' };
  /** Every request received, in order. */
  readonly requests: JudgmentRequest[] = [];

  private readonly scripts = new Map<string, ScriptedAnswer>();
  private failure: JudgmentProviderErrorKind | undefined;
  private readonly available: boolean;

  constructor(opts: FakeJudgmentProviderOptions = {}) {
    this.name = opts.name ?? 'fake';
    this.modelId = opts.modelId ?? 'fake-1';
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...opts.capabilities };
    this.available = opts.available ?? true;
  }

  /** Script the answer for a question id (a value or a function of the request). */
  script(questionId: string, answer: ScriptedAnswer): this {
    this.scripts.set(questionId, answer);
    return this;
  }

  /** Make every following evaluate() throw the given error kind (undefined clears). */
  failWith(kind: JudgmentProviderErrorKind | undefined): this {
    this.failure = kind;
    return this;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    return this.available ? { available: true } : { available: false, reason: 'fake unavailable' };
  }

  async getAccountId(): Promise<string | null> {
    return this.available ? 'fake-account' : null;
  }

  async evaluate(req: JudgmentRequest): Promise<JudgmentResponse> {
    this.requests.push(req);
    if (this.failure) {
      throw new JudgmentProviderError(this.failure, `fake provider failure: ${this.failure}`);
    }
    const answers: Record<string, JudgmentAnswer> = {};
    for (const id of Object.keys(req.questions)) {
      const scripted = this.scripts.get(id);
      if (scripted === undefined) {
        throw new JudgmentProviderError('bad-response', `no scripted answer for question '${id}'`);
      }
      answers[id] = typeof scripted === 'function' ? scripted(req) : scripted;
    }
    return {
      answers,
      modelVersion: this.modelId,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
    };
  }
}
