/**
 * Gate 5 — Affected surface is named.
 *
 * Stage A (deterministic, hybrid per RFC §4.4): regex for presence of
 * file paths, route patterns, system identifiers, named components.
 *
 * The Stage A pass condition is "at least one of the following appears
 * somewhere in title or body":
 *   - A backtick-quoted file path (`pipeline-cli/src/foo.ts`)
 *   - A bare repo path with an extension (`spec/rfcs/RFC-0011.md`)
 *   - A route pattern (`/api/...`, `POST /foo/bar`)
 *   - An RFC ID (`RFC-NNNN`) or AISDLC ID (`AISDLC-NN`)
 *   - A named system component (CamelCase identifier, MAYBE — too noisy
 *     by itself; must be combined with another signal)
 *
 * If NO surface signal is present, Stage A fails with the standard
 * "name the affected surface" finding. Stage B (Phase 2b) judges
 * whether the surface is *specific enough*; Stage A only catches the
 * case where it's missing entirely.
 *
 * **Tessellated-platform extension (RFC-0011 Phase 7 / Alex's Addition 2,
 * AISDLC-115.8).** When the issue input carries a {@link ProjectShardManifest}
 * with `shards.length > 1`, Gate 5 ALSO requires the title or body to
 * name one of those shards. Single-shard / absent manifests behave
 * exactly as before — the multi-shard branch is gated on `shards.length > 1`
 * so non-tessellated platforms see no behaviour change. See
 * `gate-5-surface.test.ts` for the explicit regression coverage.
 */

import type { GateEvaluation, IssueInput, ProjectShardManifest } from '../types.js';

const SURFACE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'backtick-path', re: /`([\w./-]+\/[\w./-]+\.[a-zA-Z0-9]+)`/ },
  {
    name: 'backtick-config-file',
    re: /`(?:\.?[\w.-]+\.(?:json|ya?ml|toml|ini|conf|mjs|cjs|js|ts|md|sh|env)|CHANGELOG\.md|README\.md|LICENSE|CODEOWNERS)`/,
  },
  { name: 'bare-path', re: /(?<![\w/])([\w-]+\/[\w./-]+\.[a-zA-Z0-9]{1,8})/ },
  { name: 'route-pattern', re: /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[\w/{}:.-]+/ },
  {
    name: 'api-path',
    re: /(?<![\w/])\/(?:api|v\d+|app|admin|dashboard|auth|users|search|graphql|mcp)\/[\w/{}:.-]+/,
  },
  { name: 'rfc-ref', re: /\bRFC-\d{4}\b/ },
  { name: 'aisdlc-ref', re: /\bAISDLC-\d+(?:\.\d+)?\b/ },
  { name: 'workspace-package', re: /@[\w-]+\/[\w-]+/ },
  { name: 'database-table', re: /\b(?:table|column|schema)\s+`?[a-zA-Z_][\w]*`?\b/i },
  { name: 'github-workflow', re: /\.github\/workflows\/[\w.-]+\.ya?ml/ },
];

export function findSurfaceSignals(text: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SURFACE_PATTERNS) {
    if (re.test(text)) hits.push(name);
  }
  return hits;
}

/**
 * Match a shard identifier against free text. Word-boundary anchored so
 * `admin` doesn't match inside `administrator`, but tolerant of common
 * separators (`-`, `_`, `.`, whitespace) inside the shard id itself.
 *
 * Exported for test coverage of the matcher edge cases.
 */
export function findNamedShards(text: string, shards: readonly string[]): string[] {
  if (shards.length === 0) return [];
  const lowerText = text.toLowerCase();
  const hits: string[] = [];
  for (const shard of shards) {
    const id = shard.trim().toLowerCase();
    if (!id) continue;
    // Escape regex metacharacters in the shard id, then anchor with
    // \b on either side. Using \b means `customer-app` matches in
    // "the customer-app needs..." but not inside `customer-applet`.
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(lowerText)) hits.push(shard);
  }
  return hits;
}

/**
 * Classify a manifest as "tessellated" — i.e. has more than one shard
 * and therefore triggers Gate 5's per-shard naming requirement. Single-
 * shard manifests (and absent manifests) are non-tessellated and skip
 * the extra check, preserving the Phase 6 behaviour exactly.
 */
export function isTessellatedManifest(manifest: ProjectShardManifest | undefined): boolean {
  return Boolean(manifest && manifest.shards.filter((s) => s.trim().length > 0).length > 1);
}

function buildShardClarification(shards: readonly string[], manifestRef?: string): string {
  const list = shards
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => `\`${s}\``)
    .join(', ');
  const refSuffix = manifestRef ? ` (per ${manifestRef})` : '';
  return `This project is tessellated across multiple shards${refSuffix}. Name which shard this issue targets — one of: ${list}.`;
}

export function evaluateGate5(input: IssueInput): GateEvaluation {
  const haystack = `${input.title}\n${input.body}`;
  const signals = findSurfaceSignals(haystack);

  if (signals.length === 0) {
    return {
      gateId: 5,
      verdict: 'fail',
      severity: 'block',
      stage: 'A',
      confidence: 'high',
      finding:
        'No affected-surface signal found in title or body (file path, route, RFC/AISDLC ID, workflow file, or named component).',
      clarificationQuestion:
        'Name the file path, route, RFC ID, workflow file, or specific component this issue changes. "the dashboard" / "search" / "the auth flow" without a concrete reference is too vague.',
    };
  }

  // Tessellated-platform extension (Alex's Addition 2). Only fires when
  // the manifest exists AND has >1 shard — single-shard / non-tessellated
  // projects behave EXACTLY as the surface-signal check above.
  if (isTessellatedManifest(input.shardManifest)) {
    const manifest = input.shardManifest!;
    const namedShards = findNamedShards(haystack, manifest.shards);
    if (namedShards.length === 0) {
      return {
        gateId: 5,
        verdict: 'fail',
        severity: 'block',
        stage: 'A',
        confidence: 'high',
        finding: `Surface signals present (${signals.join(', ')}), but the issue does not identify which tessellated shard it targets.`,
        clarificationQuestion: buildShardClarification(manifest.shards, manifest.manifestRef),
      };
    }
    return {
      gateId: 5,
      verdict: 'pass',
      severity: 'block',
      stage: 'A',
      confidence: 'medium',
      finding: `Stage A surface signals: ${signals.join(', ')}; targets shard(s): ${namedShards.join(', ')}.`,
    };
  }

  // Stage A passes — Stage B (Phase 2b) judges whether the named surface
  // is *specific enough* to be actionable.
  return {
    gateId: 5,
    verdict: 'pass',
    severity: 'block',
    stage: 'A',
    confidence: 'medium',
    finding: `Stage A surface signals: ${signals.join(', ')}.`,
  };
}
