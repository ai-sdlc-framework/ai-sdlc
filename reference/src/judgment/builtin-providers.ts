import { createJevProvider, type JevProviderOptions } from './jev-provider.js';
import { registerJudgmentProvider } from './registry.js';
import type { JudgmentProvider } from './types.js';

export interface BuiltInProviderOptions {
  /** Pinned model from config; becomes the provider's model id. */
  model?: string;
  /** Injectable fetch; tests never touch the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Names of the providers that ship with the framework. */
export const BUILT_IN_JUDGMENT_PROVIDERS = ['jev'] as const;

/** Construct a built-in provider by name, or undefined when the name is not built in. */
export function createBuiltInJudgmentProvider(
  name: string,
  opts: BuiltInProviderOptions = {},
): JudgmentProvider | undefined {
  if (name !== 'jev') return undefined;
  const jev: JevProviderOptions = {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
  return createJevProvider(jev);
}

/** Register the named built-in provider; returns false when the name is not built in. */
export function registerBuiltInJudgmentProvider(
  name: string,
  opts: BuiltInProviderOptions = {},
): boolean {
  const provider = createBuiltInJudgmentProvider(name, opts);
  if (!provider) return false;
  registerJudgmentProvider(provider);
  return true;
}
