/**
 * RFC-0009 §13 Rule #2 — InterSoulEmbeddingDistanceRule (interface stub).
 *
 * Implements `TessellationRule` for the Tessellation§13RuleRegistry so Rule #2
 * is registerable via `registry.register(rule)` (AISDLC-489, AISDLC-467 AC#3
 * follow-up).
 *
 * Rule #2 (embedding distance between Soul DIDs over time) is **explicitly
 * deferred to RFC-0019** (Embedding Provider Adapter). This class ships as a
 * registered interface stub — it satisfies `TessellationRule`, is registerable,
 * and returns an empty `DriftEvent[]` on every `scan()` call until RFC-0019
 * provides an `embedDocument(text)` callable from the orchestrator.
 *
 * ### Rationale for stub registration
 *
 * Registering the stub now (rather than leaving Rule #2 entirely absent) means:
 * - `registry.getRegisteredRules()` includes `'inter-soul-embedding-distance'`
 *   in the standard 3-rule enumeration, making the §13 rule set queryable/
 *   observable by operator tooling (TUI, Slack digests) without an RFC-0019 gap.
 * - The RFC-0019 implementation lands by replacing this stub class with the
 *   real embedding-distance implementation — NO registration-site changes needed.
 *
 * ### Upgrading to the real rule
 *
 * Per RFC-0019: replace this stub with the real embedding-distance rule once
 * `embedDocument(text): Promise<number[]>` is callable from the orchestrator.
 * The name `'inter-soul-embedding-distance'` is the stable canonical rule name;
 * do NOT change it when swapping in the real implementation.
 *
 * @see spec/rfcs/RFC-0009-tessellated-design-intent-documents.md §7.2 Rule #2
 * @see spec/rfcs/RFC-0019-embedding-provider-adapter.md (implementation target)
 */

import type {
  TessellationRule,
  DriftEvent,
  DriftSeverity,
  RuleScanTarget,
} from './rule-registry.js';

/**
 * InterSoulEmbeddingDistanceRule — RFC-0009 §13 Rule #2 (deferred stub).
 *
 * Detects embedding distance drift between Soul DIDs over time. Implementation
 * is deferred to RFC-0019; this stub fulfils the `TessellationRule` interface
 * and can be registered in the Tessellation§13RuleRegistry.
 *
 * `scan()` always returns `[]` until the RFC-0019 embedding provider is wired.
 *
 * ### Registration
 *
 * ```ts
 * const registry = createTessellation13Registry();
 * registry.register(new InterSoulEmbeddingDistanceRule());
 * ```
 */
export class InterSoulEmbeddingDistanceRule implements TessellationRule {
  readonly name = 'inter-soul-embedding-distance';
  readonly description =
    'Detects embedding distance drift between Soul DIDs over time (RFC-0009 §7.2 Rule #2, deferred to RFC-0019 — stub returns empty until embedding provider is available)';
  readonly severity: DriftSeverity;

  /**
   * @param severity  Default `'medium'` (reserved for the real implementation;
   *                  configurable now so adopters can set it before RFC-0019 ships).
   */
  constructor(severity: DriftSeverity = 'medium') {
    this.severity = severity;
  }

  scan(_target: RuleScanTarget): DriftEvent[] {
    // Rule #2 is deferred to RFC-0019. This stub intentionally returns empty.
    // When RFC-0019 lands, replace this body with the real embedding-distance
    // scan logic. The rule name and interface contract are stable.
    return [];
  }
}
