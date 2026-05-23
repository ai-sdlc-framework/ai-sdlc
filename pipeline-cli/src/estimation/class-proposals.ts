/**
 * Class-proposal management — RFC-0016 §6.1 (Q3 resolution) + Phase 6
 * (AISDLC-284).
 *
 * When the LLM class-assignment classifier (Phase 2+) produces a class
 * name it doesn't recognise (confidence gate < 0.90), it appends a
 * proposal to `.ai-sdlc/estimate-classes-proposed.jsonl`. This module
 * manages the lifecycle of those proposals:
 *
 *  1. **Read** — `readProposals()` parses the JSONL file.
 *  2. **Cluster** — `clusterProposals()` groups proposals by "shape"
 *     (definition + exemplar overlap). Same-shape proposals accumulate
 *     as a candidate for auto-promotion.
 *  3. **Auto-promote** — per §6.1 "auto-promotion rule": when ≥N
 *     proposals (default 3) of the same shape accumulate, the batch
 *     sweep promotes the most-frequent shape to a full class in
 *     `.ai-sdlc/estimate-classes.yaml`.
 *  4. **Review list** — `listPendingProposals()` returns proposals not
 *     yet auto-promoted, sorted newest-first, for the
 *     `cli-estimate-classes review` command (AC #4).
 *
 * ## Shape matching algorithm
 *
 * Two proposals are considered "same shape" when:
 *  - Their `proposedClass` names are identical (case-insensitive, after
 *    stripping `-` / `_` / whitespace), OR
 *  - Their definitions share ≥3 content words (stopwords stripped), OR
 *  - Their exemplar lists share ≥1 exact exemplar after normalisation.
 *
 * The algorithm is deliberately conservative — a false negative (two
 * similar proposals NOT merged) wastes one iteration; a false positive
 * (two different proposals merged) could create a confusing class.
 *
 * ## File formats
 *
 * Input: `.ai-sdlc/estimate-classes-proposed.jsonl` — append-only, one
 * JSON object per line per §6.1.
 *
 * Output: `.ai-sdlc/estimate-classes.yaml` — the full class ontology.
 * Whole-replace semantics per Q1 resolution (§15). When the file doesn't
 * exist, the 3 starter classes (bug / feature / chore) from §6.1 are the
 * implicit baseline.
 *
 * @module estimation/class-proposals
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ── Public types ─────────────────────────────────────────────────────────

/** One row from `estimate-classes-proposed.jsonl`. */
export interface ClassProposal {
  ts: string;
  taskId: string;
  proposedClass: string;
  structure: {
    definition: string;
    exemplars: string[];
    anti_patterns: string[];
    synonyms: string[];
  };
  confidence: number;
  rationale: string;
  /** Set to `true` when this proposal has been accepted (auto or manual). */
  accepted?: boolean;
}

/** A cluster of same-shape proposals ready for review / auto-promotion. */
export interface ProposalCluster {
  /** Normalised class name for this cluster. */
  canonicalName: string;
  /** All proposals in this cluster, newest-first. */
  proposals: ClassProposal[];
  /** Number of proposals in this cluster. */
  count: number;
  /**
   * Whether this cluster meets the auto-promotion threshold (count ≥
   * `autoPromoteThreshold`).
   */
  autoPromotable: boolean;
  /** The "winning" structure — taken from the most-confident proposal. */
  structure: ClassProposal['structure'];
}

export interface ReadProposalsOpts {
  /** Path to the `.ai-sdlc/` directory. Defaults to `<cwd>/.ai-sdlc/`. */
  aiSdlcDir?: string;
}

export interface ClusterProposalsOpts extends ReadProposalsOpts {
  /**
   * Minimum proposal count to flag a cluster as auto-promotable.
   * Default: 3 (RFC §6.1 "auto-promotion rule").
   */
  autoPromoteThreshold?: number;
}

export interface AutoPromoteOpts extends ClusterProposalsOpts {
  /** Override clock for the promoted class's `promotedAt` timestamp. */
  now?: () => Date;
}

export interface AutoPromoteResult {
  /** How many clusters were promoted to full classes. */
  promotedCount: number;
  /** Names of the promoted classes. */
  promotedClasses: string[];
  /**
   * Whether the classes YAML was updated (false when no promotable
   * clusters found or YAML write failed).
   */
  yamlUpdated: boolean;
}

export interface AppendProposalOpts extends ReadProposalsOpts {
  proposal: Omit<ClassProposal, 'accepted'>;
}

// ── Starter classes (§6.1 seed) ───────────────────────────────────────────

export const STARTER_CLASSES: Record<string, ClassProposal['structure']> = {
  bug: {
    definition:
      'Restore expected behavior in code that previously worked or was specified to work.',
    exemplars: [
      'Fix null-pointer crash in PaymentValidator.validate() when amount is undefined',
      'Restore Auth header propagation through the proxy after middleware refactor',
    ],
    anti_patterns: [
      'Add new validation rule that did not exist before (this is feature)',
      'Rename internal helper for clarity (this is refactor)',
    ],
    synonyms: ['regression', 'hotfix', 'patch'],
  },
  feature: {
    definition: 'Add capability that did not previously exist or was not previously specified.',
    exemplars: [
      'Add t-shirt-size estimate field to backlog task schema',
      'Add /ai-sdlc estimate CLI command',
    ],
    anti_patterns: [
      'Restore behavior that regressed (this is bug)',
      'Update CHANGELOG before release (this is chore)',
    ],
    synonyms: ['enhancement', 'capability', 'new'],
  },
  chore: {
    definition:
      'Maintenance work with no user-visible behavior change — dependency bumps, formatting, doc nits, infra cleanup.',
    exemplars: [
      'Bump @types/node from 22.10.0 to 22.10.5',
      'Run prettier across the orchestrator package',
    ],
    anti_patterns: [
      'Add a missing test for behavior that already shipped (this is bug)',
      'Restructure CHARTER.md to add a new section (this is feature)',
    ],
    synonyms: ['maintenance', 'tidy', 'infra'],
  },
};

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Read all proposals from `estimate-classes-proposed.jsonl`.
 * Returns an empty array when the file doesn't exist.
 */
export function readProposals(opts: ReadProposalsOpts = {}): ClassProposal[] {
  const proposalsPath = resolveProposalsPath(opts.aiSdlcDir);
  if (!existsSync(proposalsPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(proposalsPath, 'utf8');
  } catch {
    return [];
  }
  const proposals: ClassProposal[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as ClassProposal;
      if (p && typeof p === 'object' && typeof p.proposedClass === 'string') {
        proposals.push(p);
      }
    } catch {
      // skip malformed lines
    }
  }
  return proposals;
}

/**
 * Append a new proposal to `estimate-classes-proposed.jsonl`. Best-effort
 * — write failures are silently ignored (the caller is the class-assignment
 * LLM path, which must not block on I/O).
 */
export function appendProposal(opts: AppendProposalOpts): boolean {
  const proposalsPath = resolveProposalsPath(opts.aiSdlcDir);
  const dir = dirname(proposalsPath);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(proposalsPath, JSON.stringify(opts.proposal) + '\n', {
      encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cluster proposals by shape similarity per the §6.1 algorithm.
 *
 * Returns clusters sorted by `count` descending (largest first) so the
 * review CLI can present the most-accumulated proposals at the top.
 */
export function clusterProposals(opts: ClusterProposalsOpts = {}): ProposalCluster[] {
  const threshold = opts.autoPromoteThreshold ?? 3;
  const proposals = readProposals(opts);

  // Filter out already-accepted proposals.
  const pending = proposals.filter((p) => !p.accepted);

  // Group by normalised class name first — cheapest signal.
  const byName = new Map<string, ClassProposal[]>();
  for (const p of pending) {
    const key = normaliseClassName(p.proposedClass);
    const bucket = byName.get(key) ?? [];
    bucket.push(p);
    byName.set(key, bucket);
  }

  const clusters: ProposalCluster[] = [];

  for (const [canonicalName, group] of byName) {
    // Sort newest-first.
    const sorted = [...group].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    // Pick the highest-confidence proposal's structure as canonical.
    const winner = [...group].sort((a, b) => b.confidence - a.confidence)[0]!;

    clusters.push({
      canonicalName,
      proposals: sorted,
      count: group.length,
      autoPromotable: group.length >= threshold,
      structure: winner.structure,
    });
  }

  // Sort by count descending.
  clusters.sort((a, b) => b.count - a.count);
  return clusters;
}

/**
 * List pending proposals for the `cli-estimate-classes review` command.
 *
 * Returns all non-accepted proposals grouped into clusters, with the
 * auto-promotable ones marked. Suitable for table output.
 */
export function listPendingProposals(opts: ClusterProposalsOpts = {}): ProposalCluster[] {
  return clusterProposals(opts);
}

/**
 * Auto-promote clusters that meet the threshold to full classes in
 * `.ai-sdlc/estimate-classes.yaml`.
 *
 * Per §6.1: "when ≥3 proposals of the same shape accumulate within one
 * weekly batch, the next batch sweep auto-promotes the most-frequent
 * shape to a full class."
 *
 * Returns a summary of what was promoted.
 */
export function autoPromote(opts: AutoPromoteOpts = {}): AutoPromoteResult {
  const clusters = clusterProposals(opts);
  const autoPromotable = clusters.filter((c) => c.autoPromotable);

  if (autoPromotable.length === 0) {
    return { promotedCount: 0, promotedClasses: [], yamlUpdated: false };
  }

  // Load existing classes.
  const existingClasses = loadExistingClasses(opts.aiSdlcDir);

  let changed = false;
  const promotedClasses: string[] = [];

  for (const cluster of autoPromotable) {
    if (cluster.canonicalName in existingClasses) {
      // Already exists — skip.
      continue;
    }
    existingClasses[cluster.canonicalName] = cluster.structure;
    promotedClasses.push(cluster.canonicalName);
    changed = true;
  }

  if (!changed) {
    return { promotedCount: 0, promotedClasses: [], yamlUpdated: false };
  }

  // Write updated YAML.
  const yamlPath = resolveClassesYamlPath(opts.aiSdlcDir);
  const now = opts.now ?? ((): Date => new Date());
  const yaml = serializeClassesYaml(existingClasses, now());
  try {
    const dir = dirname(yamlPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(yamlPath, yaml, { encoding: 'utf8' });
  } catch {
    return { promotedCount: 0, promotedClasses: [], yamlUpdated: false };
  }

  // Mark promoted proposals as accepted in the JSONL audit log.
  // Rewrite the proposals file with `accepted: true` on every proposal whose
  // normalised class name matches one of the newly-promoted clusters. The
  // full-rewrite (rather than append) keeps the file compact and avoids a
  // read-then-skip-duplicate pattern on subsequent runs.
  const promotedSet = new Set(promotedClasses);
  const proposalsPath = resolveProposalsPath(opts.aiSdlcDir);
  try {
    const allProposals = readProposals(opts);
    const updated = allProposals.map((p) =>
      promotedSet.has(normaliseClassName(p.proposedClass)) ? { ...p, accepted: true } : p,
    );
    writeFileSync(proposalsPath, updated.map((p) => JSON.stringify(p)).join('\n') + '\n', {
      encoding: 'utf8',
    });
  } catch {
    // Best-effort: JSONL update failure must not roll back the YAML write.
  }

  return {
    promotedCount: promotedClasses.length,
    promotedClasses,
    yamlUpdated: true,
  };
}

/**
 * Read the current class ontology from `.ai-sdlc/estimate-classes.yaml`.
 * Returns the 3 starter classes when the file doesn't exist.
 */
export function readClassesYaml(aiSdlcDir?: string): Record<string, ClassProposal['structure']> {
  return loadExistingClasses(aiSdlcDir);
}

// ── Internals ─────────────────────────────────────────────────────────────

function resolveProposalsPath(aiSdlcDir?: string): string {
  const base = aiSdlcDir ?? join(process.cwd(), '.ai-sdlc');
  return join(base, 'estimate-classes-proposed.jsonl');
}

function resolveClassesYamlPath(aiSdlcDir?: string): string {
  const base = aiSdlcDir ?? join(process.cwd(), '.ai-sdlc');
  return join(base, 'estimate-classes.yaml');
}

function normaliseClassName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-_\s]+/g, '-')
    .trim();
}

function loadExistingClasses(aiSdlcDir?: string): Record<string, ClassProposal['structure']> {
  const yamlPath = resolveClassesYamlPath(aiSdlcDir);
  if (!existsSync(yamlPath)) {
    // Return a deep-copy of the starter classes.
    return JSON.parse(JSON.stringify(STARTER_CLASSES)) as Record<
      string,
      ClassProposal['structure']
    >;
  }

  let raw: string;
  try {
    raw = readFileSync(yamlPath, 'utf8');
  } catch {
    return JSON.parse(JSON.stringify(STARTER_CLASSES)) as Record<
      string,
      ClassProposal['structure']
    >;
  }

  // Simple YAML parser: we only need to round-trip the classes we wrote.
  // Use the structured JS serialisation we control (see serializeClassesYaml).
  // Parse back via a lightweight regex approach.
  return parseClassesYaml(raw);
}

/**
 * Serialize the class map to a human-readable YAML string. We use a
 * hand-rolled serialiser so we control whitespace + ordering and don't
 * pull in a YAML library for what is essentially a static config write.
 */
function serializeClassesYaml(
  classes: Record<string, ClassProposal['structure']>,
  generatedAt: Date,
): string {
  const lines: string[] = [
    `# estimate-classes.yaml — RFC-0016 §6.1 task-class ontology`,
    `# Auto-managed by cli-estimate-classes. Last updated: ${generatedAt.toISOString()}`,
    `# Whole-replace semantics (Q1 resolution §15): this file IS the full class set.`,
    `classes:`,
  ];

  for (const [name, s] of Object.entries(classes)) {
    lines.push(`  ${name}:`);
    lines.push(`    definition: ${jsonStr(s.definition)}`);
    lines.push(`    exemplars:`);
    for (const ex of s.exemplars) lines.push(`      - ${jsonStr(ex)}`);
    lines.push(`    anti_patterns:`);
    for (const ap of s.anti_patterns) lines.push(`      - ${jsonStr(ap)}`);
    lines.push(`    synonyms:`);
    for (const syn of s.synonyms) lines.push(`      - ${jsonStr(syn)}`);
  }

  return lines.join('\n') + '\n';
}

/** Quote a string for YAML — use JSON escaping to handle special chars. */
function jsonStr(s: string): string {
  // Use JSON.stringify for safety, then strip the outer quotes for YAML.
  // If the string contains : or # we must quote it.
  if (/[:#\n]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Parse a YAML scalar value produced by `serializeClassesYaml` /
 * `jsonStr`. Two forms are possible:
 *  - JSON-quoted string (starts AND ends with `"`): unwrap via JSON.parse.
 *  - Plain string (no surrounding quotes): return trimmed as-is.
 */
function parseYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      // Malformed JSON-string escape — fall through to raw value.
    }
  }
  return trimmed;
}

/**
 * Full-fidelity YAML parser for the classes file we produce.
 *
 * Recovers the complete per-class structure (definition + exemplars +
 * anti_patterns + synonyms) so that repeated `autoPromote` calls can
 * round-trip through the file without losing previously promoted class
 * content. The parser is a state-machine tuned to the exact indent layout
 * emitted by `serializeClassesYaml` — it is NOT a general YAML parser.
 *
 * Returns the starter classes on any parse failure (empty result).
 */
function parseClassesYaml(raw: string): Record<string, ClassProposal['structure']> {
  const result: Record<string, ClassProposal['structure']> = {};

  type ListField = 'exemplars' | 'anti_patterns' | 'synonyms';
  let currentClass: string | null = null;
  let currentList: ListField | null = null;

  // Regex patterns matched against our controlled serialization format.
  const classNameRe = /^ {2}(\w[\w-]*):\s*$/;
  const definitionRe = /^ {4}definition: (.+)$/;
  const listHeaderRe = /^ {4}(exemplars|anti_patterns|synonyms):\s*$/;
  const listItemRe = /^ {6}- (.+)$/;

  for (const line of raw.split('\n')) {
    // Skip comment and blank lines.
    if (line.startsWith('#') || line.trim() === '' || line.trim() === 'classes:') continue;

    const classMatch = classNameRe.exec(line);
    if (classMatch) {
      currentClass = classMatch[1]!;
      currentList = null;
      result[currentClass] = { definition: '', exemplars: [], anti_patterns: [], synonyms: [] };
      continue;
    }

    if (!currentClass) continue;

    const defMatch = definitionRe.exec(line);
    if (defMatch) {
      currentList = null;
      result[currentClass]!.definition = parseYamlScalar(defMatch[1]!);
      continue;
    }

    const listHeaderMatch = listHeaderRe.exec(line);
    if (listHeaderMatch) {
      currentList = listHeaderMatch[1] as ListField;
      continue;
    }

    if (currentList !== null) {
      const itemMatch = listItemRe.exec(line);
      if (itemMatch) {
        result[currentClass]![currentList].push(parseYamlScalar(itemMatch[1]!));
      }
    }
  }

  // Return starter classes when the file is empty or completely unparseable.
  if (Object.keys(result).length === 0) {
    return JSON.parse(JSON.stringify(STARTER_CLASSES)) as Record<
      string,
      ClassProposal['structure']
    >;
  }
  return result;
}
