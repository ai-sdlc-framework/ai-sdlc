/**
 * Argument-form detection and the remote-sandbox (CCR) guard for
 * `/ai-sdlc execute` (AISDLC-393, AISDLC-442). Ported from the prose shell
 * blocks that used to live in `ai-sdlc-plugin/commands/execute.md`; the regex
 * shapes and the detection order are the contract.
 *
 * @module next-step/args
 */

export type ExecuteArg =
  | { ok: true; form: 'backlog-task'; taskId: string }
  | { ok: true; form: 'gh-issue'; issueNumber: number }
  | { ok: false; reason: string };

const ACCEPTED_FORMS = [
  "  - <prefix>-<number>   e.g. 'AISDLC-393' (backlog task ID)",
  "  - <number> or #<number>   e.g. '612', '#612' (GitHub issue)",
  "  - gh:<number>   e.g. 'gh:612' (explicit GitHub issue routing)",
].join('\n');

/**
 * Classify `$ARGUMENTS`. Precedence: explicit `gh:<n>`, then a prefixed task id
 * (hierarchical sub-ids such as `AISDLC-100.5` allowed), then bare / `#`-prefixed
 * numerics as a GitHub issue. Mirrors `parseExecuteArg` in dogfood.
 */
export function parseExecuteArg(raw: string): ExecuteArg {
  const arg = raw.trim();
  if (arg === '') {
    return { ok: false, reason: `no argument given. Accepted forms:\n${ACCEPTED_FORMS}` };
  }
  let issue: string | null = null;
  const explicit = /^gh:(\d+)$/.exec(arg);
  if (explicit) {
    issue = explicit[1];
  } else if (/^[A-Za-z][A-Za-z0-9]*-\d+(\.\d+)*$/.test(arg)) {
    return { ok: true, form: 'backlog-task', taskId: arg };
  } else {
    const bare = /^#?(\d+)$/.exec(arg);
    if (bare) issue = bare[1];
  }
  if (issue === null) {
    return {
      ok: false,
      reason: `invalid execute argument '${arg}'. Accepted forms:\n${ACCEPTED_FORMS}`,
    };
  }
  const issueNumber = Number(issue);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    return { ok: false, reason: `GitHub issue numbers must be positive (got '${arg}').` };
  }
  return { ok: true, form: 'gh-issue', issueNumber };
}

export interface CcrProbeInput {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  exists: (path: string) => boolean;
}

/**
 * Detect a CCR remote sandbox (AISDLC-442). First match wins:
 *   1. `CLAUDE_CODE_ENV=ccr`
 *   2. `CLAUDE_REMOTE_EXECUTION=1`
 *   3. `CLAUDE_CODE_ENV` set (any value) AND `~/.ai-sdlc/signing-key.pem` absent
 * A missing signing key alone is a setup error, never a refusal. The
 * `AI_SDLC_SKIP_CCR_GUARD=1` override is checked first.
 *
 * Returns the reason string when running in CCR, otherwise `null`.
 */
export function detectCcr(input: CcrProbeInput): string | null {
  const { env } = input;
  if (env.AI_SDLC_SKIP_CCR_GUARD === '1') return null;
  if (env.CLAUDE_CODE_ENV === 'ccr') return 'CLAUDE_CODE_ENV=ccr detected';
  if (env.CLAUDE_REMOTE_EXECUTION === '1') return 'CLAUDE_REMOTE_EXECUTION=1 detected';
  if (
    env.CLAUDE_CODE_ENV !== undefined &&
    env.CLAUDE_CODE_ENV !== '' &&
    !input.exists(`${input.homeDir}/.ai-sdlc/signing-key.pem`)
  ) {
    return 'CLAUDE_CODE_ENV set + ~/.ai-sdlc/signing-key.pem absent (likely managed sandbox)';
  }
  return null;
}

/** Operator-facing refusal text for a CCR sandbox. */
export function ccrRefusalMessage(reason: string): string {
  return [
    `/ai-sdlc execute cannot run in a CCR remote sandbox. (${reason})`,
    '',
    'Remote sandboxes are read-only by design. They lack:',
    '  - ~/.ai-sdlc/signing-key.pem (operator-machine-local, never in CCR)',
    '  - Plugin install (no mcp__plugin_ai-sdlc_ai-sdlc__* tools)',
    '  - Worktree filesystem (sandbox layout differs)',
    '  - Operator filesystem (.ai-sdlc/trusted-reviewers.yaml pubkeys)',
    '',
    'Supported alternatives from a CCR sandbox:',
    '  1. File a backlog task for local pickup: mcp__backlog__task_create (works in CCR)',
    '  2. File a GitHub issue for local pickup: mcp__github__create_issue (works in CCR)',
    'Then run /ai-sdlc execute <task-id> from a LOCAL Claude Code session.',
    '',
    'See: docs/operations/remote-agents-readonly.md',
  ].join('\n');
}
