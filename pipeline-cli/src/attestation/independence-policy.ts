/**
 * RFC-0046 Phase 4 (AISDLC-591) — `requiredTier` policy + gate-topology-
 * agnostic enforcement.
 *
 * Independence ships opt-in + informational by default (RFC-0046 OQ-5):
 * the `overallIndependenceTier` computed by the verifier (AISDLC-588) is
 * always surfaced, but never blocks a merge/ship unless the adopter opts
 * into a per-repo policy. This module is the SINGLE source of truth for
 * that policy — both `ai-sdlc/pr-ready` (branch-protection repos) and a
 * ship-skill (procedural-gate repos, e.g. local-trades, with no branch
 * protection) invoke the SAME `evaluateIndependencePolicy()` comparison,
 * fed by the SAME `loadIndependencePolicy()` reader. One comparison, two
 * enforcement surfaces — see RFC-0046 §Rollout (OQ-5) + Phase 4.
 *
 * `isolated` is currently UNSATISFIABLE: RFC-0046 Phase 3 (AISDLC-590,
 * self-asserted `provenance.deployment: 'ci'`) was found CRITICAL-forgeable
 * and deferred to RFC-0047, whose re-derivable anchor (verifier-side
 * re-derivation via a CI-only key, AISDLC-593/595/596) is the producer half
 * of the capability. RFC-0047 OQ-5 splits the "producer exists" concern
 * (AISDLC-593/595/596, already merged) from the "policy may REQUIRE it"
 * concern (this module) — {@link isolatedTierAvailable} is the single
 * capability switch AISDLC-597 flips once the verifier is wired to credit
 * `requiredTier: isolated` as satisfiable. Until then, a policy requiring
 * `isolated` always reports `unsatisfiable`, never a false `pass`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** RFC-0046's three independence tiers, weakest to strongest. */
export type IndependenceTier = 'none' | 'attested' | 'isolated';

/** Total order over {@link IndependenceTier} — higher number = stronger claim. */
export const INDEPENDENCE_TIER_ORDER: Record<IndependenceTier, number> = {
  none: 0,
  attested: 1,
  isolated: 2,
};

function isIndependenceTier(value: unknown): value is IndependenceTier {
  return value === 'none' || value === 'attested' || value === 'isolated';
}

/**
 * Capability switch for the `isolated` tier's PRODUCER (RFC-0047).
 *
 * Returns `false` today — `requiredTier: isolated` is unsatisfiable no
 * matter what the envelope claims. AISDLC-597 is the ONLY task authorized
 * to flip this to `true`, once the verifier re-derives the RFC-0047
 * CI-only anchor and can credit `isolated` as a real, non-forgeable claim.
 * Single source of truth: every enforcement surface (CI gate, ship-skill,
 * CLI) calls THIS function rather than re-deriving the answer locally, so
 * flipping it in one place flips it everywhere.
 */
export function isolatedTierAvailable(): boolean {
  return false;
}

/** Per-repo independence policy (`.ai-sdlc/independence-policy.yaml`). */
export interface IndependencePolicy {
  /** Minimum tier the repo requires. Default `'none'` (no enforcement). */
  requiredTier: IndependenceTier;
}

/** Default policy applied when no config file exists — zero behavior change. */
export const DEFAULT_INDEPENDENCE_POLICY: IndependencePolicy = { requiredTier: 'none' };

export interface LoadIndependencePolicyOpts {
  /** Project root. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Override the on-disk path (tests). */
  filePath?: string;
}

/** Resolve the canonical config path: `<repoRoot>/.ai-sdlc/independence-policy.yaml`. */
export function resolveIndependencePolicyPath(opts: LoadIndependencePolicyOpts = {}): string {
  if (opts.filePath) return opts.filePath;
  const repoRoot = opts.repoRoot ?? process.cwd();
  return join(repoRoot, '.ai-sdlc', 'independence-policy.yaml');
}

/**
 * Load the per-repo independence policy. A missing file resolves to
 * {@link DEFAULT_INDEPENDENCE_POLICY} (`requiredTier: none`) — existing
 * adopters see NO behavior change until they opt in (RFC-0046 AC-1).
 *
 * Parsing intentionally uses a tiny line-based reader (mirrors
 * `pipeline-cli/src/dor/dor-config.ts`'s documented rationale) rather than
 * pulling in `js-yaml` for a single flat scalar field:
 *
 * ```yaml
 * requiredTier: attested
 * ```
 *
 * Leading `#` comments and blank lines are ignored. Quoted values
 * (`'attested'` / `"attested"`) are unwrapped. An explicit, non-empty,
 * unrecognized `requiredTier` value throws — a malformed policy file
 * should fail loudly rather than silently downgrade enforcement to `none`.
 */
export function loadIndependencePolicy(opts: LoadIndependencePolicyOpts = {}): IndependencePolicy {
  const filePath = resolveIndependencePolicyPath(opts);
  if (!existsSync(filePath)) return { ...DEFAULT_INDEPENDENCE_POLICY };
  const raw = readFileSync(filePath, 'utf-8');
  return parseIndependencePolicyYaml(raw, filePath);
}

/**
 * Parse the flat `requiredTier: <tier>` policy YAML. Exported so tests can
 * drive the parser without touching the filesystem.
 */
export function parseIndependencePolicyYaml(
  yaml: string,
  sourcePath = '<inline>',
): IndependencePolicy {
  let requiredTier: IndependenceTier | undefined;
  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key !== 'requiredTier') continue;
    const value = stripQuotes(line.slice(colonIdx + 1).trim());
    if (!isIndependenceTier(value)) {
      throw new Error(
        `${sourcePath}: invalid requiredTier ${JSON.stringify(value)} — must be one of 'none', 'attested', 'isolated'`,
      );
    }
    requiredTier = value;
  }
  return { requiredTier: requiredTier ?? DEFAULT_INDEPENDENCE_POLICY.requiredTier };
}

function stripQuotes(raw: string): string {
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return raw;
}

/** Outcome of comparing a policy's `requiredTier` against an envelope's tier. */
export type IndependencePolicyOutcomeStatus = 'pass' | 'shortfall' | 'unsatisfiable';

export interface IndependencePolicyOutcome {
  status: IndependencePolicyOutcomeStatus;
  requiredTier: IndependenceTier;
  overallIndependenceTier: IndependenceTier;
  /** Human-readable summary — safe to surface in PR/CI output verbatim. */
  message: string;
}

export interface EvaluateIndependencePolicyParams {
  requiredTier: IndependenceTier;
  /** The envelope's weakest-link `overallIndependenceTier` (AISDLC-588). */
  overallIndependenceTier: IndependenceTier;
}

/**
 * The ONE comparison both enforcement surfaces call (RFC-0046 §Rollout).
 *
 * - `requiredTier: 'none'` always `pass`es — informational only, matching
 *   the AC-1/AC-3 "no behavior change by default, but still surfaced" contract.
 * - `requiredTier: 'isolated'` is `unsatisfiable` while
 *   {@link isolatedTierAvailable} returns `false`, REGARDLESS of what the
 *   envelope claims — a forged/legacy `isolated` claim must never be
 *   credited as satisfying an unsatisfiable policy.
 * - Otherwise, `overallIndependenceTier` must be `>=` `requiredTier` on the
 *   {@link INDEPENDENCE_TIER_ORDER} total order, else `shortfall`.
 */
export function evaluateIndependencePolicy(
  params: EvaluateIndependencePolicyParams,
): IndependencePolicyOutcome {
  const { requiredTier, overallIndependenceTier } = params;

  // AISDLC-591 security review (defense-in-depth): FAIL CLOSED on any unrecognized
  // tier value. `INDEPENDENCE_TIER_ORDER[unknown]` is `undefined` and `undefined <
  // n` is `false`, which would otherwise silently fall through to `pass` (fail
  // open). Not reachable via the verifier (which enum-validates
  // overallIndependenceTier), but this function is the single source of truth the
  // future ship-skill also calls with less-validated input — validate both inputs.
  if (
    INDEPENDENCE_TIER_ORDER[requiredTier] === undefined ||
    INDEPENDENCE_TIER_ORDER[overallIndependenceTier] === undefined
  ) {
    return {
      status: 'shortfall',
      requiredTier,
      overallIndependenceTier,
      message: `independence policy: unrecognized tier value (requiredTier='${requiredTier}', overallIndependenceTier='${overallIndependenceTier}') — failing closed`,
    };
  }

  if (requiredTier === 'isolated' && !isolatedTierAvailable()) {
    return {
      status: 'unsatisfiable',
      requiredTier,
      overallIndependenceTier,
      message:
        "requiredTier: 'isolated' is not yet available — the isolated-tier producer capability " +
        'is not yet wired into policy enforcement (see RFC-0047 / AISDLC-597). ' +
        "Set requiredTier to 'none' or 'attested' until AISDLC-597 ships.",
    };
  }

  if (requiredTier === 'none') {
    return {
      status: 'pass',
      requiredTier,
      overallIndependenceTier,
      message: `independence tier '${overallIndependenceTier}' (informational — requiredTier: none)`,
    };
  }

  if (INDEPENDENCE_TIER_ORDER[overallIndependenceTier] < INDEPENDENCE_TIER_ORDER[requiredTier]) {
    return {
      status: 'shortfall',
      requiredTier,
      overallIndependenceTier,
      message: `independence policy shortfall: requiredTier='${requiredTier}' but overallIndependenceTier='${overallIndependenceTier}'`,
    };
  }

  return {
    status: 'pass',
    requiredTier,
    overallIndependenceTier,
    message: `independence tier '${overallIndependenceTier}' satisfies requiredTier '${requiredTier}'`,
  };
}
