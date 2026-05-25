/**
 * Linear → AI-SDLC Translator — worked example for RFC-0036 Phase 10
 * (AISDLC-335 / OQ-6).
 *
 * Minimal BYO translator demonstrating the pattern documented at
 * `docs/concepts/adopter-translators.md`. Reads a Linear project's
 * issues via the GraphQL API, maps each issue to a `T-NNN` entry,
 * extracts acceptance criteria from the issue description's checklist
 * markers (`- [ ] AC: …` and bare `- AC: …` lines), and writes a
 * spec-kit-compatible `tasks.md` the AI-SDLC spec-kit bridge can
 * consume.
 *
 * To use this in your repo:
 *   1. Copy this file to `.ai-sdlc/translators/linear.ts`.
 *   2. `LINEAR_API_KEY=<your-pat> npx tsx .ai-sdlc/translators/linear.ts \
 *        --project <linear-project-id>`
 *   3. `cli-import-spec --from .specify/specs/<linear-project-slug>/`
 *
 * Notes:
 *   - This example uses `fetch` directly (no `@linear/sdk` dependency) so
 *     it stays copy-pasteable. Real translators commonly add the SDK for
 *     pagination + type generation.
 *   - The mapping is intentionally conservative: AC extraction looks for
 *     `AC:` markers only. Issues without explicit ACs are imported but
 *     will be refused by DoR Gate 1 at import time — that refusal IS the
 *     upstream-clarification feedback loop, not a translator bug.
 *
 * This file is framework-import-free by design — `docs/examples/**` is a
 * documentation surface, not framework code. Adopters copy this verbatim
 * into their own repos.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ─── Linear API types (minimal subset) ──────────────────────────────────────

interface LinearIssue {
  /** Linear's identifier; e.g. "AUTH-42". Used as the `T-<id>` token. */
  identifier: string;
  /** Issue title; becomes the imported task's title. */
  title: string;
  /** Markdown description; the body source. */
  description: string | null;
  /** Issue state (workflow column). Used to skip cancelled / archived issues. */
  state: { name: string; type: string };
}

interface LinearProject {
  id: string;
  name: string;
  slugId: string;
  issues: { nodes: LinearIssue[] };
}

// ─── Translator output types (mirror example-adopter.ts) ────────────────────

interface TranslatedTask {
  upstreamId: string;
  title: string;
  body?: string;
  acceptanceCriteria: string[];
}

interface TranslatedFeature {
  featureSlug: string;
  featureTitle: string;
  tasks: TranslatedTask[];
}

// ─── 1. Fetch issues from Linear ────────────────────────────────────────────

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const PROJECT_QUERY = `
  query Project($projectId: String!) {
    project(id: $projectId) {
      id
      name
      slugId
      issues(first: 250, filter: { state: { type: { neq: "canceled" } } }) {
        nodes {
          identifier
          title
          description
          state { name type }
        }
      }
    }
  }
`;

async function fetchLinearProject(projectId: string, apiKey: string): Promise<LinearProject> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: apiKey,
    },
    body: JSON.stringify({ query: PROJECT_QUERY, variables: { projectId } }),
  });
  if (!res.ok) {
    throw new Error(
      `[linear-translator] Linear API ${res.status} ${res.statusText} for project ${projectId}`,
    );
  }
  const payload = (await res.json()) as {
    data?: { project: LinearProject | null };
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(
      `[linear-translator] GraphQL errors: ${payload.errors.map((e) => e.message).join('; ')}`,
    );
  }
  if (!payload.data?.project) {
    throw new Error(`[linear-translator] project not found: ${projectId}`);
  }
  return payload.data.project;
}

// ─── 2. Map LinearIssue → TranslatedTask ────────────────────────────────────

/**
 * Pull `AC:` lines from the issue description. Recognises both bare
 * (`- AC: …` / `* AC: …`) and checkbox (`- [ ] AC: …`) markers; the
 * second is common when teams use Linear's checklist UI.
 */
function extractAcceptanceCriteria(description: string): string[] {
  const acRe = /^\s*(?:[-*]\s*)?(?:\[[ x]\]\s*)?AC:\s*(.+?)\s*$/i;
  const acs: string[] = [];
  for (const line of description.split('\n')) {
    const m = acRe.exec(line);
    if (m && m[1]) acs.push(m[1]);
  }
  return acs;
}

/**
 * Strip `AC:` lines from the body so they only appear in the rendered
 * `tasks.md`'s structured AC slot, not twice (in the body and again as
 * ACs).
 */
function stripAcLines(description: string): string {
  const acRe = /^\s*(?:[-*]\s*)?(?:\[[ x]\]\s*)?AC:\s*.+$/i;
  return description
    .split('\n')
    .filter((line) => !acRe.test(line))
    .join('\n')
    .trim();
}

function mapLinearIssueToTask(issue: LinearIssue): TranslatedTask | null {
  // Skip workflow states the team uses for parked / cancelled work.
  if (issue.state.type === 'canceled') return null;

  const description = issue.description ?? '';
  return {
    upstreamId: issue.identifier,
    title: issue.title.trim(),
    body: stripAcLines(description),
    acceptanceCriteria: extractAcceptanceCriteria(description),
  };
}

// ─── 3. Render TranslatedFeature → tasks.md ─────────────────────────────────

export function renderTasksMarkdown(feature: TranslatedFeature): string {
  const lines: string[] = [];
  lines.push(`# ${feature.featureTitle} — Tasks`);
  lines.push('');
  lines.push(`<!-- Generated by linear-translator at ${new Date().toISOString()}. -->`);
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

// ─── 4. Write tasks.md idempotently ─────────────────────────────────────────

function writeTasksMd(
  repoRoot: string,
  feature: TranslatedFeature,
  content: string,
): { wrote: boolean; path: string } {
  const path = resolve(repoRoot, '.specify', 'specs', feature.featureSlug, 'tasks.md');
  mkdirSync(dirname(path), { recursive: true });

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
  console.log(`linear-translator — RFC-0036 Phase 10 worked example

Usage:
  LINEAR_API_KEY=<pat> npx tsx .ai-sdlc/translators/linear.ts \\
    --project <linear-project-id> [--repo-root <path>]

Reads:
  Linear project <id> via GraphQL (issues != canceled)

Writes:
  <repo-root>/.specify/specs/<project-slug>/tasks.md

Then feed to the bridge:
  cli-import-spec --from .specify/specs/<project-slug>/

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

  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) {
    /* eslint-disable-next-line no-console */
    console.error('[linear-translator] LINEAR_API_KEY env var is required');
    process.exit(2);
  }

  // 1. Fetch
  const project = await fetchLinearProject(args.projectId, apiKey);

  // 2. Map
  const tasks: TranslatedTask[] = [];
  for (const issue of project.issues.nodes) {
    const task = mapLinearIssueToTask(issue);
    if (task) tasks.push(task);
  }

  // 3. Render
  const feature: TranslatedFeature = {
    featureSlug: project.slugId,
    featureTitle: project.name,
    tasks,
  };
  const md = renderTasksMarkdown(feature);

  // 4. Write
  const { wrote, path } = writeTasksMd(args.repoRoot, feature, md);
  /* eslint-disable no-console */
  console.log(
    `[linear-translator] ${wrote ? 'wrote' : 'unchanged'}: ${path} (${tasks.length} tasks from ${project.issues.nodes.length} issues)`,
  );
  console.log(`[linear-translator] feed to bridge: cli-import-spec --from ${dirname(path)}/`);
  /* eslint-enable no-console */
}

// CLI entry — runs on every invocation. The helpers exported below
// (`renderTasksMarkdown`, `extractAcceptanceCriteria`, etc.) can still
// be imported by tests; `main()`'s guard (--help or missing --project
// prints usage and exits 1 before doing anything) keeps accidental
// imports from reaching the network.
main().catch((err) => {
  /* eslint-disable-next-line no-console */
  console.error(err);
  process.exit(1);
});

// ─── Exported helpers for tests + reuse ─────────────────────────────────────

export { extractAcceptanceCriteria, mapLinearIssueToTask, stripAcLines, writeTasksMd };
export type { LinearIssue, LinearProject, TranslatedFeature, TranslatedTask };
