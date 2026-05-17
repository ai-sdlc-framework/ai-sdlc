---
id: AISDLC-351
title: 'fix(pipeline-cli): parseClaudeOutput strips markdown code fences (reviewer subagents wrap JSON in ```json fences)'
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - critical-bug
  - autonomous-pipeline
  - parser
dependencies:
  - AISDLC-349
priority: critical
references:
  - pipeline-cli/src/runtime/shell-claude-p-spawner.ts
  - pipeline-cli/src/steps/09-iterate.ts
---

## Bug

When `cli-orchestrator tick --spawner claude` invokes reviewer subagents via `claude -p --agent <reviewer> --output-format json`, the `result` field of the JSON envelope contains MARKDOWN-WRAPPED JSON:

```
"result": "```json\n{\"approved\": true, \"findings\": [], \"summary\": \"...\"}\n```"
```

`parseClaudeOutput` tries `JSON.parse(result)` which fails (input starts with `\`\`\`json\n`), returns the raw string. `coerceReviewerVerdict` (`pipeline-cli/src/steps/09-iterate.ts:176`) checks `typeof parsed !== 'object'` and synthesizes a `critical: returned no parseable verdict (status=success)` placeholder finding. Result: PRs auto-marked CHANGES_REQUESTED with synthetic critical findings even when reviewers actually approved.

Observed 2026-05-17 after AISDLC-349 shipped `--spawner claude`. Verdicts for PRs #511 (AISDLC-288), #512 (AISDLC-286), #514 (AISDLC-282) all hit this. PR #511's reviewers happened to return raw JSON (no fences) so it worked — luck of the draw.

## Acceptance criteria

- [ ] **`parseClaudeOutput` in `pipeline-cli/src/runtime/shell-claude-p-spawner.ts` strips markdown code fences** before `JSON.parse(result)`. Handle:
  - `\`\`\`json\n{...}\n\`\`\`` (with language tag)
  - `\`\`\`\n{...}\n\`\`\`` (no language tag)
  - JSON embedded in narrative text — extract the first balanced `{...}` substring
- [ ] **Test coverage**:
  - Direct test: `parseClaudeOutput` handles all 3 fence variants
  - Round-trip test: feed `claude -p --output-format json` actual output (fixture) through the parser, assert it returns the inner verdict object
- [ ] **Fence-stripping is defensive — don't fail if input is already raw JSON**: existing 3324 passing tests must still pass

## Out of scope

- Changing reviewer agent prompts to NOT use fences (already asks for raw JSON; LLMs ignore)
- Codex spawner (uses different parser path)

## Source

Operator debugging session 2026-05-17 after autonomous tick produced 3 DRAFT PRs (#511 #512 #514) with synthetic critical verdicts. Direct claude -p repro confirmed: `claude -p --agent code-reviewer --output-format json "..."` returns `"result":"\`\`\`json\n{...}\n\`\`\`"`.
