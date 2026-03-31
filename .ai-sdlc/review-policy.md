# AI-SDLC Review Policy

This document provides calibration context for the automated review agents.
**You MUST read and apply this policy before analyzing the PR.** False positives
waste developer time and block the pipeline. Only flag issues you are confident
are real problems with a plausible attack vector or correctness impact.

## Golden Rule

**When in doubt, approve with a suggestion — do not request changes.**

Only use `REQUEST_CHANGES` severity (`critical` or `major`) when you can
describe a specific, realistic scenario where the code causes harm. If you
cannot construct a concrete exploit or failure case, downgrade to `minor` or
`suggestion`.

## Threat Model

### Trusted Input Sources (do NOT flag for injection)
- `.ai-sdlc/*.yaml` pipeline configuration files — committed by maintainers, reviewed in PRs
- `orchestrator/src/defaults.ts` constants — hardcoded values, not user-controlled
- Notification templates from `pipeline.yaml` `spec.notifications.templates` — same as above
- Agent role constraints from `agent-role.yaml` — same as above
- Review policy content from `.ai-sdlc/review-policy.md` — this file, committed by maintainers
- `resolveRepoRoot()` output — returns the git working directory, not user-controlled

### Untrusted Input Sources (DO flag for injection)
- Issue titles and bodies from GitHub (user-submitted)
- PR bodies and review comments (could contain adversarial content)
- Slack message content from external users
- CLI arguments from external callers
- Agent output (filesChanged, summary) — LLM-generated, could be manipulated

## Regex Patterns — When to Flag ReDoS

**DO NOT flag these as ReDoS — they are safe:**
- Bounded character classes: `[a-z0-9-]{0,30}` — linear time, no backtracking possible
- Fixed-length quantifiers: `\d{1,15}` — bounded, cannot backtrack
- Character classes without alternation: `[a-zA-Z0-9/_.-]+` — no ambiguity
- `regex.exec()` in a `while` loop with `/g` flag — `lastIndex` advances linearly, this is the standard JS pattern for finding all matches. It is NOT quadratic.
- Any pattern where the character class has no overlapping alternatives
- **Single `.*` wildcard patterns from trusted config** (e.g., `^gh pr merge.*$`) — a pattern with ONE `.*` cannot cause backtracking because there is only one way to match. The pattern `a.*b.*c.*` with MULTIPLE `.*` can theoretically backtrack, but our `blockedActions` patterns are simple globs like `gh pr merge*` that convert to a single `.*`. Do NOT flag these.
- **`CLAUDE_PROJECT_DIR` environment variable** — this is set by Claude Code itself, not by users. It is a trusted source. Do NOT flag `execSync('git rev-parse')` as command injection when the fallback only runs if the env var is unset.

**DO flag these as ReDoS — they are dangerous:**
- Nested quantifiers with alternation: `(a+)+$`, `(a|aa)+`
- Unbounded repetition on overlapping groups: `(\w+\s*)*`
- Patterns where the engine can match the same character via multiple paths
- Multiple overlapping `.*` in a single pattern from untrusted input

**The definitive test:** Can the regex engine take exponentially different paths for the same input? If no, it is safe. A single `.*` has exactly one match path — it is always linear.

## Concurrency and Race Conditions

**DO NOT flag as race conditions:**
- Sequential `await` calls in the same async function — these execute in strict order, period
- In-memory variables within a single function invocation — no concurrent access is possible
- Cloudflare Worker module-level variables — Workers handle one request at a time per isolate
- Two lines of code in the same function body — there is no "window" for another workflow to interfere between sequential statements in a single execution context

**DO flag as race conditions:**
- Shared state across separate GitHub Actions workflow runs
- Multiple workflows writing to the same branch simultaneously
- State that depends on external API calls being atomic (they're not)

## HTML/Template Sanitization

**DO NOT flag as injection vulnerabilities:**
- Template content from `.ai-sdlc/*.yaml` config files (trusted source, reviewed in PRs)
- Markdown content posted to GitHub issue comments — GitHub sanitizes markdown rendering and strips dangerous HTML
- Simple `/<[^>]*>/g` tag stripping on trusted-source config values — this is defense-in-depth, not the primary security boundary

**DO flag as injection vulnerabilities:**
- User-submitted content interpolated into shell commands without escaping
- User-submitted content used in `eval()`, `new Function()`, or `innerHTML`
- Untrusted input used in SQL queries without parameterization

## Testing Standards

### What Requires Test Coverage
- All public functions and their error paths
- Integration points between modules (e.g., cycle detection in fix-ci/fix-review)
- Boundary conditions (thresholds, limits, edge cases)
- New business logic

### What Does NOT Require Test Coverage (DO NOT flag as critical/major)
- **GitHub Actions workflow YAML changes** — these are tested by running the workflow, not by unit tests. A changed `if` condition in a workflow file does not need a unit test. Do not flag this.
- **Thin CLI wrappers** that parse args and call orchestrator functions — tested via the orchestrator tests
- `console.error` logging statements in catch blocks
- Re-exports in `index.ts` barrel files

### Test Replacement vs Test Removal
When a test is removed and replaced with a different test that covers the same code path differently, this is NOT a reduction in coverage. Do not flag test replacements as "removed test coverage" unless the replacement genuinely covers fewer paths.

## Severity Classification

Use these definitions strictly:

- **critical**: Logic error that causes data loss, security breach, or infinite loop in production. You must be able to describe the exact failure scenario.
- **major**: Bug that affects correctness in common code paths, or a security issue with a plausible real-world attack vector. "Theoretically possible" is not sufficient — describe the attack.
- **minor**: Code quality issue that doesn't affect correctness but would improve the code
- **suggestion**: Nice-to-have improvement with no correctness or security impact

**If you cannot describe a concrete failure scenario or attack vector, it is NOT critical or major.**

## Common False Positives — DO NOT FLAG

These patterns have been repeatedly flagged incorrectly. Do not flag them:

1. "ReDoS on bounded character class" — `[a-z0-9-]{0,30}` is safe
2. "Race condition between sequential await calls" — impossible in a single async function
3. "Template injection from config file" — config files are trusted
4. "Empty catch block" with explanatory comment — intentional for best-effort ops
5. "Missing unit test for workflow YAML change" — workflows are tested by running them
6. "Information disclosure in Slack messages" — private channel with trusted devs
7. "Path traversal in resolveRepoRoot()" — returns git working directory, not user-controlled
8. "Unsafe JSON.parse on controlled source" — our own API/CLI output format
9. "`exec()` with `/g` regex in while loop is quadratic" — it is linear, this is the standard JS pattern
10. "Removed test reduces coverage" — when test was replaced, not removed
11. "ReDoS on single `.*` wildcard from trusted config" — `^gh pr merge.*$` has ONE `.*`, cannot backtrack. Only multiple overlapping `.*` from untrusted input is dangerous.
12. "Command injection via CLAUDE_PROJECT_DIR" — this env var is set by Claude Code itself, not user-controlled. The `execSync('git rev-parse')` fallback is a standard git pattern.
13. "Command injection in shell hook via PATTERN" — when PATTERN comes from `.ai-sdlc/agent-role.yaml` (trusted, committed by maintainers). Only flag if pattern comes from untrusted input.
14. "Missing tests for Claude Code hook scripts" — hook scripts are integration-tested by running them manually. They are NOT instrumentable by Vitest. Do NOT flag missing unit tests for `.claude/hooks/` files as critical.
