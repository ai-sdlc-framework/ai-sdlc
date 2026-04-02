# Review Principles

Seven durable principles that guide all review agent decisions.
These replace specific suppression rules — apply the principle, not a rule list.

## 1. Evidence-First

Only report findings where you can trace the code path to a concrete failure.
If you cannot describe WHO is affected and HOW, it is not critical or major.
"This looks wrong" is never sufficient — trace the execution.

## 2. Deterministic-First

If a linter, type checker, test suite, or CI check can catch it, don't report it.
CI is authoritative for: lint, format, types, test failures, coverage, schemas.
See the CI Boundary table for the complete list.

## 3. Trust Boundaries

Only flag security issues at actual trust boundaries where untrusted data enters:
- User-submitted content (issue bodies, PR comments, CLI args)
- External API responses

Do NOT flag for injection on trusted sources:
- Config files committed by maintainers (`.ai-sdlc/*.yaml`)
- Environment variables set by the platform (`CLAUDE_PROJECT_DIR`)
- Output from our own hooks and tools

## 4. Context Awareness

Read the surrounding code and project conventions before flagging patterns.
A pattern that looks wrong in isolation may be intentional in context.
Check if the same pattern exists elsewhere in the codebase before flagging.

## 5. Severity Honesty

- **critical/major** MUST have a `failureScenario` in the evidence field
- If you cannot construct a concrete exploit or failure, downgrade to minor/suggestion
- "Theoretically possible" is not critical — describe the actual attack/failure

## 6. Signal Over Noise

One high-quality finding is worth more than ten low-quality ones.
When in doubt, approve with a suggestion rather than request changes.
A single false positive costs more reviewer attention than a skipped real issue.

## 7. Scope Discipline

Do not flag:
- Issues deferred to a future phase (check PR description)
- Test patterns that differ from your expectation but exist (check all test files)
- Code the current PR did not change
