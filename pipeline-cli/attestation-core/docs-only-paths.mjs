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
 * .ai-sdlc/dispatch/briefs/, .claude/memory/, .github/dependabot.yml,
 * .github/*.md (not subdirectories) and root-level *.md.
 */
export const DOCS_ONLY_PATTERN =
  /^(spec\/rfcs\/|docs\/|backlog\/tasks\/|backlog\/completed\/|\.ai-sdlc\/attestations\/[^/]+\.dsse\.json$|\.ai-sdlc\/_decisions\/|\.ai-sdlc\/dispatch\/briefs\/|\.claude\/memory\/|\.github\/dependabot\.yml$|\.github\/[^/]+\.md$|[^/]+\.md$)/;
