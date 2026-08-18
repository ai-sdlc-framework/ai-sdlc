/**
 * Gate 7 — No invisible dependencies.
 *
 * Stage A (deterministic, hybrid per RFC §4.4): regex for dependency
 * phrases ("requires X", "depends on X", "after X ships", "blocked by
 * X", "once X lands", "needs X") that are immediately followed by a
 * tracked-work identifier (AISDLC-NN, RFC-NNNN, `#NN`, `org/repo#NN`,
 * markdown URL, or a repo-relative file path). The regex pairs the
 * dependency phrase WITH its tracked-work target, so prose like
 * "X requires Y configuration" or "Statistical drift detection depends
 * on a rolling 30d baseline" does not match — those are procedural /
 * algorithmic prerequisites, not invisible tracked-work dependencies.
 *
 * AISDLC-457 (2026-05-27): regex narrowed from "fires on any dep
 * phrase, passes if a ref is in the same sentence" to "fires only on
 * dep-phrase + tracked-work-id pairs, passes if the captured id is in
 * the references[] list". This eliminates the false-positive flood
 * documented in PR #743 / PR #742 where natural-English uses of
 * "requires" / "depends on" / "needs" were being flagged as missing
 * tracked-work refs.
 *
 * Stage B (Phase 2b) catches "unstated structural assumptions" — this
 * gate's regex side only catches the case where the author *names* a
 * tracked-work dependency in the body but doesn't list it in the
 * `dependencies:` frontmatter.
 *
 * AISDLC-563 (2026-08-18): the gate's comparison logic was always correct
 * (extracts the bare tracked-work id, compares case-insensitively against
 * `input.declaredDependencyRefs` / `input.references`) — the bug was that
 * `refineBacklogTask()` (`../ingress-claude.ts`) never populated either
 * field from the task's `dependencies:` / `references:` frontmatter, so
 * every dep-phrase + id pair in the body was flagged as invisible
 * regardless of what frontmatter actually declared. Reproduced twice
 * (AISDLC-557, AISDLC-561): both were "fixed" only by rewording the
 * sentence, never by adding the (already-present) dependency. See
 * `extractDeclaredDependencyRefs()` below for the frontmatter parser that
 * closes the gap.
 */

import type { GateEvaluation, IssueInput } from '../types.js';

/**
 * Tracked-work identifier shapes recognised as dependency targets.
 * Mirrors the resolver kinds Gate 3 understands.
 */
const TRACKED_WORK_ID =
  // AISDLC-NN(.NN) | RFC-NNNN | (gh)#NN | org/repo#NN | https://… | repo-relative file path
  // (file paths MUST contain at least one slash OR end in a recognised code/spec extension
  // to avoid matching bare version-like tokens — `after 1.2 ships` previously matched `1.2`)
  String.raw`(?:AISDLC-\d+(?:\.\d+)?|RFC-\d{4}|(?:gh)?#\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/[^\s)]+|[\w.-]+\/[\w./-]+\.[a-zA-Z0-9]+|[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|sh|py|go|rs|toml|sql))`;

/**
 * Dependency phrases that can introduce a tracked-work id. Kept narrow
 * — must be at a word boundary and immediately precede the id (with at
 * most a few connector words like "the", "on", or whitespace between).
 *
 * Members:
 *   - requires / required by
 *   - depends on
 *   - blocked by
 *   - after X ships / lands / merges / is done
 *   - once X lands / ships / merges
 *   - needs / needed by
 *   - prerequisite / pre-requisite
 */
const DEP_PHRASE = String.raw`(?:requires|required\s+by|depends\s+on|blocked\s+by|after|once|needs|needed\s+by|prerequisite|pre-?requisite)`;

/**
 * Combined regex — a dependency phrase followed by short connector
 * words ("the", "ships", "lands", "merges", "is done", "to land", a
 * lone article) and then a tracked-work identifier. The id is
 * captured so callers can look it up against the frontmatter
 * `references[]` list.
 *
 * Examples that match (and therefore need a frontmatter dep):
 *   "depends on AISDLC-123"
 *   "requires RFC-0011"
 *   "blocked by #456"
 *   "blocked by org/repo#42"
 *   "after AISDLC-101 ships"
 *   "needs AISDLC-101 finishing"
 *   "once AISDLC-200 lands"
 *
 * Examples that do NOT match (left alone — natural prose):
 *   "X requires Y configuration"
 *   "Statistical drift detection depends on a rolling 30d baseline"
 *   "Promotion to evolving requires RFC amendment"
 *   "depends on the auth rewrite"
 *   "blocked by the search refactor"
 */
const DEP_PHRASE_WITH_REF_RE = new RegExp(
  String.raw`\b${DEP_PHRASE}` +
    // Optional connector words between phrase and id — keep tight:
    // 0-3 short tokens (articles, prepositions, simple gerunds), each
    // separated by whitespace.
    String.raw`(?:\s+(?:the|a|an|on|to|that|completed|done|finished|merged|landed|shipped|landing|shipping|merging|finishing))*\s+` +
    String.raw`(${TRACKED_WORK_ID})`,
  'gi',
);

const TRACKED_WORK_ID_RE = new RegExp(TRACKED_WORK_ID, 'i');

/**
 * Extract the raw string items of a YAML frontmatter list field, in
 * either the inline form (`field: [A, B]`, including empty `field: []`)
 * or the block-list form (`field:\n  - A\n  - B`). No shape filtering —
 * unlike the RFC-only helpers in `upstream-oq-gate.ts`, this accepts
 * ANY item the author wrote (tracked-work ids, file paths, URLs) because
 * Gate 7's dependency phrases can pair with any of those shapes too
 * (e.g. "depends on src/foo.ts shipping first").
 */
/**
 * Strip a trailing YAML comment. Per YAML, a `#` only opens a comment when
 * preceded by whitespace or start-of-line, so `docs/a#b` is left intact.
 *
 * AISDLC-563 review: without this, `- AISDLC-100  # note` folded the comment
 * into the extracted string so it never equalled the bare id from the body,
 * and `dependencies: # note` made the block-list regex miss entirely and
 * return an empty list — each silently reintroducing the exact false-positive
 * class this gate fix exists to remove.
 */
function stripYamlComment(value: string): string {
  return value.replace(/(^|\s)#.*$/, '$1').trimEnd();
}

export function extractFrontmatterListField(
  frontmatter: string,
  field: 'dependencies' | 'references',
): string[] {
  const items: string[] = [];
  // Inline form: `field: [A, B]` — also matches `field: []` (empty inner
  // capture, filtered out below by the truthy check).
  const inlineMatch = frontmatter.match(new RegExp(`^${field}:\\s*\\[([^\\]]*)\\]`, 'm'));
  if (inlineMatch) {
    const inner = inlineMatch[1] ?? '';
    for (const raw of inner.split(',')) {
      const item = stripYamlComment(raw)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (item) items.push(item);
    }
    return items;
  }
  // Block-list form: `field:\n  - A\n  - B`
  const blockMatch = frontmatter.match(
    new RegExp(`^${field}:[ \\t]*(?:#[^\\n]*)?\\n((?:\\s+-\\s+.+\\n?)*)`, 'm'),
  );
  if (!blockMatch) return items;
  const lines = blockMatch[1]?.split('\n') ?? [];
  for (const line of lines) {
    const item = stripYamlComment(line.replace(/^\s+-\s+/, ''))
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (item) items.push(item);
  }
  return items;
}

/**
 * Extract every tracked-work id / reference declared in a task's
 * `dependencies:` AND `references:` frontmatter lists (AISDLC-563 scope:
 * "compare against BOTH `dependencies:` and `references:`, matching the
 * documented contract"). Feeds `IssueInput.declaredDependencyRefs` — see
 * that field's doc comment in `../types.ts` for why this is kept separate
 * from `IssueInput.references` (Gate 3 reuses the latter for
 * file-existence resolution; mixing tracked-work ids into it would make
 * Gate 3 try to resolve "AISDLC-554" as a file path).
 */
export function extractDeclaredDependencyRefs(frontmatter: string): string[] {
  return [
    ...extractFrontmatterListField(frontmatter, 'dependencies'),
    ...extractFrontmatterListField(frontmatter, 'references'),
  ];
}

/**
 * Returns the offending dependency-phrase + tracked-work-id pairs —
 * pairs where the body names a tracked-work dependency that is NOT
 * listed in the frontmatter `dependencies:` or `references:` list
 * (`input.declaredDependencyRefs`, or the legacy `input.references`
 * caller-supplied override).
 */
export function findInvisibleDependencies(
  input: IssueInput,
): Array<{ phrase: string; sentence: string; ref: string }> {
  const haystack = input.body;
  const sentences = splitIntoSentences(haystack);
  // Normalise the extracted body reference to the bare tracked-work id
  // (already the case — the regex capture group IS the id, never the
  // phrase) and compare, case-insensitively, against BOTH declared-dependency
  // sources: the ad-hoc `input.references` override callers can pass
  // directly (kept for backward compat with existing call sites / tests)
  // and the frontmatter-derived `input.declaredDependencyRefs` that
  // `refineBacklogTask()` now populates (AISDLC-563).
  const explicitRefs = [...(input.references ?? []), ...(input.declaredDependencyRefs ?? [])].map(
    (r) => r.toLowerCase(),
  );

  const out: Array<{ phrase: string; sentence: string; ref: string }> = [];
  for (const sentence of sentences) {
    DEP_PHRASE_WITH_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DEP_PHRASE_WITH_REF_RE.exec(sentence)) !== null) {
      const ref = (m[1] ?? '').trim();
      if (!ref) continue;
      // If the captured tracked-work id appears in the explicit
      // references list (case-insensitive), the dependency is already
      // visible — pass.
      if (explicitRefs.includes(ref.toLowerCase())) continue;
      const phrase = m[0].slice(0, m[0].length - ref.length).trim();
      out.push({
        phrase,
        ref,
        sentence: sentence.trim().slice(0, 200),
      });
    }
  }
  return out;
}

function splitIntoSentences(text: string): string[] {
  // Light-weight sentence split — preserves dep-phrase locality without
  // pulling in a full NLP dependency. Splits on `.`, `?`, `!`, newline,
  // and bullet markers.
  return text
    .split(/(?<=[.?!])\s+|\n+|^[-*]\s+/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function evaluateGate7(input: IssueInput): GateEvaluation {
  const offenders = findInvisibleDependencies(input);
  if (offenders.length === 0) {
    return {
      gateId: 7,
      verdict: 'pass',
      severity: 'block',
      stage: 'A',
      confidence: 'medium',
    };
  }
  const sample = offenders
    .slice(0, 3)
    .map((o) => `'${o.phrase} ${o.ref}' in: "${o.sentence}"`)
    .join(' | ');
  return {
    gateId: 7,
    verdict: 'fail',
    severity: 'block',
    stage: 'A',
    confidence: 'high',
    finding: `${offenders.length} tracked-work dependency reference(s) in body not listed in frontmatter \`dependencies:\`: ${sample}.`,
    clarificationQuestion:
      'Every "requires AISDLC-N / depends on RFC-N / blocked by #N" reference in the body must also appear in the task\'s `dependencies:` frontmatter list (or `references:`).',
  };
}

// Exported for hermetic tests in case future readers want to introspect
// the matcher behaviour without re-running the full gate.
export {
  DEP_PHRASE_WITH_REF_RE as _DEP_PHRASE_WITH_REF_RE,
  TRACKED_WORK_ID_RE as _TRACKED_WORK_ID_RE,
};
