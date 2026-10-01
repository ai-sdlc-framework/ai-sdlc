export type JudgmentProviderErrorKind =
  | 'auth'
  | 'validation'
  | 'rate-limited'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'bad-response';

export class JudgmentProviderError extends Error {
  readonly kind: JudgmentProviderErrorKind;
  readonly status?: number;

  constructor(kind: JudgmentProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'JudgmentProviderError';
    this.kind = kind;
    this.status = status;
  }
}

export class UnknownJudgmentProviderError extends Error {
  readonly providerName: string;
  readonly known: string[];

  constructor(providerName: string, known: string[]) {
    super(
      `Unknown judgment provider '${providerName}'. Registered providers: ${
        known.length > 0 ? known.join(', ') : '(none)'
      }`,
    );
    this.name = 'UnknownJudgmentProviderError';
    this.providerName = providerName;
    this.known = known;
  }
}
