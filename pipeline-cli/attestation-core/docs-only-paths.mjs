/**
 * The ONE definition of the docs-only path list (AISDLC-878).
 *
 * Consumers: `scripts/is-docs-only-changeset.mjs` (workflow predicate),
 * `review-scope-core.mjs` (reviewer-set selection) and the `docs` lane of
 * `cli-merge-if-eligible`. Lives in the shipped `attestation-core` directory so
 * the published package and the repo scripts import the same module.
 *
 * Covered prefixes: spec/rfcs/, docs/, backlog/tasks/, backlog/completed/,
 * .ai-sdlc/attestations/<sha>.dsse.json, .ai-sdlc/_decisions/,
 * .ai-sdlc/reviews/<x>.jsonl, .ai-sdlc/transcript-leaves/<x>.jsonl (AISDLC-1116),
 * .ai-sdlc/dispatch/briefs/, .claude/memory/, .github/dependabot.yml,
 * .github/*.md (not subdirectories) and root-level *.md.
 */
export const DOCS_ONLY_PATTERN =
  /^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$|\.ai-sdlc\/_decisions\/|\.ai-sdlc\/reviews\/[^/]+\.jsonl$|\.ai-sdlc\/transcript-leaves\/[^/]+\.jsonl$|\.ai-sdlc\/dispatch\/briefs\/|\.claude\/memory\/|\.github\/dependabot\.yml$|\.github\/[^/]+\.md$|[^/]+\.md$)/;

/**
 * The records-only allowlist (AISDLC-867): paths that carry records (task
 * files, decision events, RFC and spec text), not executable code. Prefix match
 * only, no globbing past the prefix. A consumer must also reject trust-chain
 * paths (`isTrustChainPath` in `review-scope-core.mjs`), for example
 * `spec/schemas/agent-role.schema.json`. `spec/schemas/` is excluded outright:
 * those schemas are compiled into generated runtime validators by `pnpm build`.
 */
export const RECORDS_ONLY_PATTERN = /^(backlog\/|\.ai-sdlc\/_decisions\/|spec\/(?!schemas\/))/;
