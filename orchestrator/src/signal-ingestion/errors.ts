import type { SignalSourceName } from './types.js';

export class UnknownSignalSource extends Error {
  constructor(public readonly source: string) {
    super(`Unknown signal source adapter: ${source}`);
    this.name = 'UnknownSignalSource';
  }
}

export class SignalSourceUnavailable extends Error {
  constructor(
    public readonly source: SignalSourceName,
    message = `Signal source adapter unavailable: ${source}`,
  ) {
    super(message);
    this.name = 'SignalSourceUnavailable';
  }
}

export class AdapterCredentialInvalid extends Error {
  constructor(
    public readonly source: SignalSourceName,
    message = `Signal source adapter credentials invalid: ${source}`,
  ) {
    super(message);
    this.name = 'AdapterCredentialInvalid';
  }
}

export class ManualSignalIncomplete extends Error {
  readonly source = 'signal-source-manual' as const;

  constructor(
    public readonly sourceId?: string,
    message = 'manual signal missing required attestation fields',
  ) {
    super(message);
    this.name = 'ManualSignalIncomplete';
  }
}
