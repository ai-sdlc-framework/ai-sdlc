import type { JudgmentProvider } from './types.js';
import { UnknownJudgmentProviderError } from './errors.js';
import {
  OPENAI_COMPATIBLE_PROVIDER_NAME,
  createOpenAICompatibleProvider,
} from './openai-compatible-provider.js';

const PROVIDERS = new Map<string, JudgmentProvider>();

/**
 * Builds a provider from the `spec.providerOptions.<name>` block of the judgment
 * config and the top-level `spec.model`.
 */
export type JudgmentProviderFactory = (
  options: Record<string, unknown>,
  model?: string,
) => JudgmentProvider;

const FACTORIES = new Map<string, JudgmentProviderFactory>([
  [
    OPENAI_COMPATIBLE_PROVIDER_NAME,
    (options, model) => createOpenAICompatibleProvider({ ...(model ? { model } : {}), ...options }),
  ],
]);

/** Register (or replace) a provider under its `name`. */
export function registerJudgmentProvider(provider: JudgmentProvider): void {
  PROVIDERS.set(provider.name, provider);
}

/** Register (or replace) a config-driven provider factory under `name`. */
export function registerJudgmentProviderFactory(
  name: string,
  factory: JudgmentProviderFactory,
): void {
  FACTORIES.set(name, factory);
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

/**
 * Resolve the provider a config selects: a registered instance wins, otherwise a
 * registered factory is built from the config's provider options. Undefined when
 * neither exists.
 */
export function resolveJudgmentProvider(
  name: string,
  providerOptions: Record<string, Record<string, unknown>> = {},
  model?: string,
): JudgmentProvider | undefined {
  const instance = PROVIDERS.get(name);
  if (instance) return instance;
  const factory = FACTORIES.get(name);
  if (!factory) return undefined;
  const options = Object.hasOwn(providerOptions, name) ? providerOptions[name] : {};
  return factory(options, model);
}

export function listJudgmentProviderFactories(): string[] {
  return [...FACTORIES.keys()];
}
