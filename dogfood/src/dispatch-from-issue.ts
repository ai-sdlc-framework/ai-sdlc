/**
 * Adapter — synthesize an inline `TaskSpec` from a GitHub issue.
 *
 * AISDLC-393 — when `/ai-sdlc execute` is called with a GH-issue argument form
 * (bare numeric, `#`-prefixed numeric, or `gh:N`), there is NO backlog task
 * file on disk. The issue itself is the source of truth, and the synthesized
 * spec is fed directly to `executePipeline({ taskSpec, sourceKind: 'gh-issue' })`
 * so the pipeline can skip `findTaskFile`, skip the Step 4 `task_edit`, and
 * skip the Step 10 `task_complete` / file move.
 *
 * The adapter is intentionally thin: gh-fetch + parse + return. It takes an
 * injectable `gh` shell-runner so the hermetic tests in
 * `dispatch-from-issue.test.ts` can script the issue body without a real
 * `gh` binary on PATH.
 *
 * @module dispatch-from-issue
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TaskSpec } from '@ai-sdlc/pipeline-cli';

const execFileAsync = promisify(execFile);

/**
 * Subset of `gh issue view` JSON output we depend on. Unknown keys are ignored.
 */
export interface GhIssueShape {
  number: number;
  title: string;
  body: string;
  state: string;
  labels?: Array<{ name: string }>;
}

/**
 * Result returned by `fetchGhIssueAsTaskSpec`. The synthesized `TaskSpec`
 * (re-using the pipeline-cli `TaskSpec` shape so `executePipeline()` can
 * consume it directly) plus the original `issueNumber` so callers can format
 * the PR title's `(closes #N)` suffix and the PR body's `Closes #N` line
 * without re-parsing the synthetic ID.
 */
export interface FetchGhIssueResult {
  spec: TaskSpec;
  issueNumber: number;
  issueState: string;
}

export interface FetchGhIssueOptions {
  /**
   * Injectable shell-runner for hermetic tests. Receives the argv after the
   * binary name (so a stub doesn't need to deal with the `gh` literal). The
   * stub returns the raw JSON output `gh issue view ... --json ...` would
   * print. The default invokes the real `gh` binary via `child_process.execFile`.
   */
  gh?: (args: string[]) => Promise<string>;
  /**
   * Synthetic-ID prefix. Defaults to `gh-issue-`; the pipeline-cli step
   * branching keys off `sourceKind === 'gh-issue'`, not the ID shape, so
   * this is purely cosmetic in the prompt + logs.
   */
  idPrefix?: string;
}

/**
 * Default `gh` runner — shells out to the real `gh` binary on PATH.
 */
async function defaultGh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args);
  return stdout;
}

/**
 * Extract the `## Acceptance criteria` section from a GitHub issue body. The
 * canonical issue-template shape (per `.github/ISSUE_TEMPLATE/`) is:
 *
 *   ## Acceptance criteria
 *   - [ ] AC text 1
 *   - [ ] AC text 2
 *
 * We accept both `## Acceptance criteria` and `## Acceptance Criteria` and
 * the optional `[ ]` / `[x]` checkbox prefix per CommonMark task-list syntax
 * (matching what `parseTaskFile` in `01-validate.ts` accepts for backlog
 * files). When no section is present, we fall back to a single placeholder
 * AC so the pipeline's Step 1 "at least one AC" check passes — without a
 * placeholder the validator would refuse a perfectly valid issue that
 * skipped the AC section.
 *
 * Exported for unit tests.
 */
export function extractAcceptanceCriteria(body: string): string[] {
  // Locate the section header (case-insensitive, allow optional trailing
  // whitespace + colon). Slice from after the header to the next `## ` or
  // end of body. JavaScript's regex flavour doesn't support `\Z`, so we
  // find the header position, then scan for the next `## ` boundary by
  // hand — this is more robust than a single multi-line regex that has to
  // juggle both the header match and the boundary lookahead.
  const headerRe = /^##\s+Acceptance\s+criteria\s*:?\s*$/im;
  const headerMatch = body.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) return [];
  const afterHeader = body.slice(headerMatch.index + headerMatch[0].length);

  // Stop at the next H2 header. Search starting from a newline so we
  // don't trip on `## ` substrings that occur mid-bullet (rare but safe).
  const nextSectionMatch = afterHeader.match(/\n##\s/);
  const section =
    nextSectionMatch && nextSectionMatch.index !== undefined
      ? afterHeader.slice(0, nextSectionMatch.index)
      : afterHeader;

  const acRe = /^\s*-\s+(?:\[(?: |x|X)\]\s+)?(.+?)\s*$/gm;
  const acs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = acRe.exec(section)) !== null) {
    const text = m[1].trim();
    if (text.length > 0) acs.push(text);
  }
  return acs;
}

/**
 * Extract `permittedExternalPaths` from issue labels OR a `permitted-external-paths:`
 * YAML-style block in the body.
 *
 * Label form: `permitted-external-paths:../ai-sdlc-io/` (one path per label;
 * the `permitted-external-paths:` prefix is stripped).
 *
 * Body form: a fenced YAML block named `permitted-external-paths` containing
 * one path per line (with optional leading `-`):
 *
 *   ```permitted-external-paths
 *   ../ai-sdlc-io/
 *   - ../other-sibling/
 *   ```
 *
 * Returns undefined when neither source contributes any path.
 *
 * Exported for unit tests.
 */
export function extractPermittedExternalPaths(
  body: string,
  labels: Array<{ name: string }> = [],
): string[] | undefined {
  const paths = new Set<string>();

  // Label form.
  for (const lbl of labels) {
    const m = lbl.name.match(/^permitted-external-paths:(.+)$/);
    if (m) {
      const p = m[1].trim();
      if (p.length > 0) paths.add(p);
    }
  }

  // Body fenced-block form.
  const blockMatch = body.match(/```permitted-external-paths\s*\n([\s\S]*?)```/);
  if (blockMatch) {
    const lines = blockMatch[1].split('\n');
    for (const line of lines) {
      const cleaned = line.replace(/^\s*-\s*/, '').trim();
      if (cleaned.length > 0) paths.add(cleaned);
    }
  }

  if (paths.size === 0) return undefined;
  return Array.from(paths);
}

/**
 * Fetch a GitHub issue by number and synthesize a `TaskSpec` the pipeline can
 * feed straight into `executePipeline({ taskSpec, sourceKind: 'gh-issue' })`.
 *
 * The returned `spec.id` is synthesized as `${idPrefix}${issueNumber}`
 * (default `gh-issue-${N}`); `spec.filePath` is set to a non-existent sentinel
 * path under `<workDir>/.ai-sdlc/gh-issues/${id}.virtual` — the pipeline's
 * gh-issue branches (Step 1/4/10) never call `readFileSync(filePath)`, so
 * this only shows up in error messages.
 *
 * Refuses (throws) when:
 *   - The issue is not OPEN — re-running `/ai-sdlc execute` on a closed
 *     issue is almost always a typo; surface it instead of silently dispatching.
 *   - The issue body has no `## Acceptance criteria` section AND the title
 *     is empty — without ANY actionable signal we have nothing to feed the
 *     developer prompt.
 */
export async function fetchGhIssueAsTaskSpec(
  issueNumber: number,
  opts: FetchGhIssueOptions = {},
): Promise<FetchGhIssueResult> {
  const gh = opts.gh ?? defaultGh;
  const idPrefix = opts.idPrefix ?? 'gh-issue-';

  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      `fetchGhIssueAsTaskSpec: issueNumber must be a positive integer (got ${issueNumber})`,
    );
  }

  const rawJson = await gh([
    'issue',
    'view',
    String(issueNumber),
    '--json',
    'number,title,body,state,labels',
  ]);

  let issue: GhIssueShape;
  try {
    issue = JSON.parse(rawJson) as GhIssueShape;
  } catch (err) {
    throw new Error(
      `fetchGhIssueAsTaskSpec: gh returned invalid JSON for issue #${issueNumber}: ${
        (err as Error).message
      }`,
    );
  }

  if (typeof issue.number !== 'number' || typeof issue.title !== 'string') {
    throw new Error(
      `fetchGhIssueAsTaskSpec: gh returned malformed payload for issue #${issueNumber} (missing number or title)`,
    );
  }

  if (issue.state !== 'OPEN') {
    throw new Error(
      `fetchGhIssueAsTaskSpec: issue #${issueNumber} is ${issue.state}, not OPEN — refusing to dispatch a closed issue`,
    );
  }

  const title = issue.title.trim();
  if (title.length === 0) {
    throw new Error(
      `fetchGhIssueAsTaskSpec: issue #${issueNumber} has an empty title — nothing to feed the developer prompt`,
    );
  }

  const body = typeof issue.body === 'string' ? issue.body : '';
  const labels = Array.isArray(issue.labels) ? issue.labels : [];

  let acs = extractAcceptanceCriteria(body);
  if (acs.length === 0) {
    // Fallback: a single placeholder so Step 1's "at least one AC" check
    // passes. The developer prompt still shows the full issue body, so the
    // developer subagent has the same signal a backlog task would carry.
    acs = ['Address the issue per the description below.'];
  }

  const permittedExternalPaths = extractPermittedExternalPaths(body, labels);

  const syntheticId = `${idPrefix}${issueNumber}`;

  const spec: TaskSpec = {
    id: syntheticId,
    title,
    status: 'To Do',
    acceptanceCriteria: acs,
    // Initialized as all-unchecked so the stale-Done shape check in Step 1
    // is satisfied. The pipeline does not flip these mid-run.
    acceptanceCriteriaChecked: acs.map(() => false),
    permittedExternalPaths,
    description: body,
    references: undefined,
    rawBody: body,
    // Sentinel virtual path — Step 1/4/10 gh-issue branches never read this
    // file. Surfaced in error messages so operators can see it's synthesized.
    filePath: `<gh-issue:${issueNumber}>`,
  };

  return { spec, issueNumber, issueState: issue.state };
}
