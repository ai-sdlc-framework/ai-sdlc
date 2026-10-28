---
id: AISDLC-938
title: 'PostToolUse formatter hook: run Prettier on every file an Edit or Write touches'
status: Done
assignee: []
created_date: '2026-10-16'
labels:
  - hooks
  - plugin
  - velocity
dependencies: []
references:
  - ai-sdlc-plugin/.claude-plugin/plugin.json
  - ai-sdlc-plugin/plugin.json
  - ai-sdlc-plugin/hooks/collect-tool-sequence.js
  - ai-sdlc-plugin/hooks/settings-registration.test.mjs
  - .prettierrc.json
  - .prettierignore
priority: high
dispatchable: true
---

## Description

Format drift is a recurring red-CI shape: a developer round ends green locally, then `Lint` or `format:check` fails on one unformatted file (most recently attestation envelopes and generated schema files), and the task burns a resume round for a one-line `pnpm format`. The AI-native SDLC playbook gap analysis (2026-10-16) names a formatter-on-write hook as the cheapest fix: a PostToolUse hook that formats the file the agent just wrote, so the drift never reaches the commit.

**Five-step review (requirements first).**
1. Requirement questioned: "the developer runs `pnpm format:check` before commit" (CLAUDE.md Testing). It is a prose rule; agents forget it and the gate catches it one round late.
2. Delete: nothing to delete; the pre-push check stays as the backstop.
3. Simplify: one hook, one responsibility: after `Edit` or `Write`, run Prettier on that single path when `.prettierignore` does not exclude it and a Prettier config resolves for it.
4. Accelerate: formatting the one touched file takes well under a second; the whole-repo check at push time is unchanged.
5. Automate: register the hook in both plugin manifests (they must agree) as a PostToolUse matcher on `Edit|Write`, synchronous, failing open (a Prettier error is logged, never blocks the tool).

Velocity impact: positive. Removes a whole class of resume rounds; no new prompt text.

## Acceptance Criteria

- [ ] AC-1: A new hook `ai-sdlc-plugin/hooks/format-on-write.js` (plus `.sh` wrapper, matching the existing hook layout) reads the PostToolUse payload, extracts the file path for `Edit` and `Write`, and runs `prettier --write` on it through the repo's installed Prettier (never a global one).
- [ ] AC-2: The hook is a no-op (exit 0, no output) when the path is excluded by `.prettierignore`, when no Prettier config resolves, when Prettier is not installed in the project, or when the file no longer exists.
- [ ] AC-3: A Prettier failure (syntax error in a half-written file) is logged to stderr and the hook still exits 0; it never blocks or rewrites the tool result.
- [ ] AC-4: Both plugin manifests register the hook under PostToolUse with matcher `Edit|Write`; `settings-registration.test.mjs` and the `manifests-agree` doctor check pass.
- [ ] AC-5: `node --test` coverage: formatted file, ignored file, missing config, Prettier error, non-Edit/Write tool event.
- [ ] AC-6: `docs/operations/pre-push-and-ci-reference.md` gains one paragraph naming the hook and the `AI_SDLC_SKIP_FORMAT_ON_WRITE=1` opt-out.

## Notes

Origin: playbook gap analysis 2026-10-16 (gap 7). Keep the hook under 100 lines; it is a wrapper around one Prettier call.
