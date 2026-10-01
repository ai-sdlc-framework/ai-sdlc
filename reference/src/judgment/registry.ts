import type { JudgmentProvider } from './types.js';
import { UnknownJudgmentProviderError } from './errors.js';

const PROVIDERS = new Map<string, JudgmentProvider>();

/** Register (or replace) a provider under its `name`. */
export function registerJudgmentProvider(provider: JudgmentProvider): void {
  PROVIDERS.set(provider.name, provider);
}

/** Resolve a provider by name; throws UnknownJudgmentProviderError when absent. */
export function getJudgmentProvider(name: string): JudgmentProvider {
  const provider = PROVIDERS.get(name);
  if (!provider) throw new UnknownJudgmentProviderError(name, [...PROVIDERS.keys()]);
  return provider;
}

export function listJudgmentProviders(): string[] {
  return [...PROVIDERS.keys()];
}
