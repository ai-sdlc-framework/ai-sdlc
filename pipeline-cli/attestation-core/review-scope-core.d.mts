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
export function isPathMissingGitError(err: unknown): boolean;
export type ReviewerKind = 'correctness-only' | 'two' | 'three';
export function isSuspectPath(path: unknown): boolean;
export function isTrustChainPath(path: string): boolean;
export function matchTrustChainPaths(paths: readonly string[]): string[];
export function parseReviewerSetConfig(
  yaml: string | null | undefined,
): 'three' | 'code-test-merged' | 'auto' | null;
export function requiredReviewerKind(
  paths: readonly string[] | null | undefined,
  opts?: { securityAlways?: boolean; requireThree?: boolean },
): {
  kind: ReviewerKind;
  classification: ReviewScopeClassification;
  reason: string;
  triggeringPaths: string[];
};
export function checkReviewerKindCoverage(
  reviewerNames: readonly string[],
  kind: ReviewerKind,
  stagedStages?: readonly string[],
): { ok: boolean; missing: string[] };
export function expandStagedCoverage(
  reviewerNames: readonly string[],
  stagedStages?: readonly string[],
): string[];
