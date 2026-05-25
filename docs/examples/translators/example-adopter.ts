/**
 * BYO Translator Scaffold — RFC-0036 Phase 10 (AISDLC-335 / OQ-6).
 *
 * Reference scaffold for the "bring-your-own translator" pattern that lets
 * adopters feed any non-spec-kit upstream (Linear, Notion, Jira, plain
 * markdown, an internal RFC repo, a custom proposal tracker) into the
 * AI-SDLC spec-kit bridge.
 *
 * Copy this file into your repo as `.ai-sdlc/translators/<adopter>.ts`
 * (the documented BYO path per `.ai-sdlc/adopter-authoring.yaml
 * cross-tool.byoTranslatorPath`), install whatever upstream-specific
 * dependencies you need, then fill the `// TODO:` markers.
 *
 * The translator's only contract is: write a spec-kit-compatible `tasks.md`
 * at a path `cli-import-spec --from <path>` can consume. The bridge handles
 * parsing, DoR Gate, drift detection, and backlog writes from there.
 *
 * The canonical `tasks.md` format and the parser that consumes it live at:
 *   - docs/concepts/adopter-translators.md §2.2 (this repo)
 *   - pipeline-cli/src/import-spec/parser.ts   (the reference reader)
 *
 * This file is intentionally framework-import-free so it compiles in any
 * TypeScript-strict project. Don't add framework imports — adopters copy
 * this verbatim into their own repos.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ─── Types you can shape per upstream ───────────────────────────────────────

/**
 * The shape of one task entry the translator produces. Maps 1:1 to a
 * `### T-NNN — <title>` heading + optional body + `AC:` lines in
 * the output `tasks.md`.
 *
 * Keep the field names stable across translators in your repo — your
 * post-import scripts will thank you.
 */
export interface TranslatedTask {
  /** Stable upstream identifier; will be rendered as `T-<id>`. */
  upstreamId: string;
  /** Short human-readable title; becomes the imported backlog task's title. */
  title: string;
  /** Optional multi-line body; preserved verbatim under `## Description`. */
  body?: string;
  /** Binary-testable acceptance criteria. Empty = DoR Gate 1 will refuse import. */
  acceptanceCriteria: string[];
}

/**
 * One feature's worth of translated tasks. The bridge consumes
 * `<featurePath>/tasks.md`, so the translator writes one of these per
 * upstream "feature" / "epic" / "project".
 */
export interface TranslatedFeature {
  /**
   * Slugified feature identifier; becomes the `.specify/specs/<slug>/`
   * directory name and `specRef.featureId` in the imported backlog task.
   */
  featureSlug: string;
  /** Human-readable feature title; becomes the `tasks.md` H1. */
  featureTitle: string;
  /** Tasks for this feature, in the order they should appear. */
  tasks: TranslatedTask[];
}

// ─── 1. Fetch from your upstream ────────────────────────────────────────────

/**
 * Pull whatever the upstream calls a "ticket" / "issue" / "page" / "row"
 * and return them in a shape your `mapToTask()` can consume.
 *
 * TODO: replace with your upstream's SDK / REST call / file walk.
 *
 * Examples by upstream:
 *   - Linear: GraphQL `query { issues { nodes { ... } } }`
 *   - Notion: `databases.query({ database_id: '...' })`
 *   - Jira:   REST `/rest/api/3/search?jql=project=AUTH AND status=Open`
 *   - Plain markdown: `glob('upstream-specs/**\/*.md')` + frontmatter parse
 */
async function fetchUpstreamRecords(_projectId: string): Promise<unknown[]> {
  // TODO: implement upstream-specific fetch.
  throw new Error('[example-adopter] fetchUpstreamRecords not implemented — see scaffold TODOs');
}

// ─── 2. Map upstream records → TranslatedTask ───────────────────────────────

/**
 * Translate one upstream record into a `TranslatedTask`. This is where the
 * adopter-specific mapping lives — title extraction, body normalisation,
 * AC harvesting from descriptions / checklists / labels / etc.
 *
 * TODO: implement upstream-specific field mapping. Notes:
 *  - Keep `upstreamId` stable across re-runs so the bridge's reconcile loop
 *    (Phase 6) can match re-imports to existing backlog tasks.
 *  - Surface upstream records without clear deliverables as translator
 *    warnings + skip; don't synthesise fake ACs (they fail review).
 *  - Skip archived / cancelled records silently; the reconcile loop marks
 *    previously imported tasks as `superseded` when they disappear here.
 */
function mapToTask(_record: unknown): TranslatedTask | null {
  // TODO: implement upstream-specific mapping.
  throw new Error('[example-adopter] mapToTask not implemented — see scaffold TODOs');
}

// ─── 3. Render TranslatedFeature → tasks.md (canonical v0.8-headings) ───────

/**
 * Render a feature's tasks into a spec-kit-compatible `tasks.md`. The
 * output conforms to the `v0.8-headings` schema documented at
 * `docs/concepts/adopter-translators.md §2.2`.
 *
 * Translators across upstreams should converge on this renderer — keep
 * the output format identical so the bridge's parser path stays simple.
 */
export function renderTasksMarkdown(feature: TranslatedFeature): string {
  const lines: string[] = [];
  lines.push(`# ${feature.featureTitle} — Tasks`);
  lines.push('');
  lines.push(`<!-- Generated by example-adopter translator at ${new Date().toISOString()}. -->`);
  lines.push('<!-- DO NOT EDIT BY HAND — re-run the translator to update. -->');
  lines.push('');
  lines.push('## Tasks');
  lines.push('');

  for (const task of feature.tasks) {
    lines.push(`### T-${task.upstreamId} — ${task.title}`);
    lines.push('');
    if (task.body && task.body.trim().length > 0) {
      lines.push(task.body.trim());
      lines.push('');
    }
    for (const ac of task.acceptanceCriteria) {
      lines.push(`- AC: ${ac}`);
    }
    if (task.acceptanceCriteria.length > 0) {
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── 4. Write tasks.md atomically + idempotently ────────────────────────────

/**
 * Write the rendered `tasks.md` to `<repoRoot>/.specify/specs/<slug>/tasks.md`.
 *
 * Idempotent by construction: writes only when content differs (so file
 * mtime stays stable for unchanged upstreams, which makes downstream
 * `git status` and CI cache layers behave).
 */
export function writeTasksMd(
  repoRoot: string,
  feature: TranslatedFeature,
  content: string,
): { wrote: boolean; path: string } {
  const path = resolve(repoRoot, '.specify', 'specs', feature.featureSlug, 'tasks.md');
  mkdirSync(dirname(path), { recursive: true });

  // Compare-and-skip to keep output idempotent. Adopters who want the
  // mtime to update on every run can delete this guard.
  if (existsSync(path) && readFileSync(path, 'utf8') === content) {
    return { wrote: false, path };
  }

  writeFileSync(path, content, 'utf8');
  return { wrote: true, path };
}

// ─── 5. CLI entry point ─────────────────────────────────────────────────────

interface CliArgs {
  projectId: string | null;
  repoRoot: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { projectId: null, repoRoot: process.cwd(), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--project') args.projectId = argv[++i] ?? null;
    else if (arg === '--repo-root') args.repoRoot = argv[++i] ?? process.cwd();
  }
  return args;
}

function printUsage(): void {
  /* eslint-disable no-console */
  console.log(`example-adopter translator — RFC-0036 Phase 10 scaffold

Usage:
  npx tsx .ai-sdlc/translators/<adopter>.ts --project <id> [--repo-root <path>]

Writes:
  <repo-root>/.specify/specs/<feature-slug>/tasks.md

Then feed to the bridge:
  cli-import-spec --from .specify/specs/<feature-slug>/
  # or, inside Claude Code:
  /ai-sdlc import-spec --from .specify/specs/<feature-slug>/

See docs/concepts/adopter-translators.md for the full BYO translator pattern.
`);
  /* eslint-enable no-console */
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.projectId) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  // 1. Fetch
  const records = await fetchUpstreamRecords(args.projectId);

  // 2. Map
  const tasks: TranslatedTask[] = [];
  for (const record of records) {
    const task = mapToTask(record);
    if (task) tasks.push(task);
  }

  // 3. Group + render. Most translators emit one feature per CLI invocation;
  //    upstreams that bundle multiple features in one project loop this step.
  const feature: TranslatedFeature = {
    featureSlug: args.projectId,
    featureTitle: args.projectId,
    tasks,
  };
  const md = renderTasksMarkdown(feature);

  // 4. Write
  const { wrote, path } = writeTasksMd(args.repoRoot, feature, md);
  /* eslint-disable no-console */
  console.log(`[example-adopter] ${wrote ? 'wrote' : 'unchanged'}: ${path}`);
  console.log(`[example-adopter] feed to bridge: cli-import-spec --from ${dirname(path)}/`);
  /* eslint-enable no-console */
}

// CLI entry — runs on every invocation. The helper exports above
// (`renderTasksMarkdown`, `writeTasksMd`) can still be imported by tests
// because they don't depend on `main()` having executed; `main()`'s guard
// (--help or missing --project prints usage and exits 1 before doing
// anything) keeps accidental imports from reaching the network.
main().catch((err) => {
  /* eslint-disable-next-line no-console */
  console.error(err);
  process.exit(1);
});
