export type ReviewScopeClassification = 'test-only' | 'docs-adjacent' | 'full';
export const TRUST_CHAIN_PATH_PREFIXES: readonly string[];
export const TEST_ONLY_PATTERNS: readonly RegExp[];
export const DOCS_ONLY_PATTERN: RegExp;
export function classifyReviewScope(paths: readonly string[]): {
  classification: ReviewScopeClassification;
  reason: string;
};
export function parseSecurityReviewAlways(yaml: string | null | undefined): boolean;
export function reviewerSetKindFor(
  classification: ReviewScopeClassification,
  opts?: { securityAlways?: boolean },
): 'correctness-only' | 'full';
export function checkReviewerCoverage(
  reviewerNames: readonly string[],
  classification: ReviewScopeClassification,
  opts?: { securityAlways?: boolean },
): { ok: boolean; missing: string[] };
