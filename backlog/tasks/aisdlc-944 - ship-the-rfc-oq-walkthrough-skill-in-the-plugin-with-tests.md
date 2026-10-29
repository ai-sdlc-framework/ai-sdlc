---
id: AISDLC-944
title: 'Ship the rfc-oq-walkthrough skill in the plugin, with tests, so adopters get the RFC lifecycle flow'
status: In Progress
assignee: []
created_date: '2026-10-16'
labels:
  - plugin
  - skills
  - rfc-process
dependencies: []
references:
  - ai-sdlc-plugin/skills/decision-rubric/SKILL.md
  - ai-sdlc-plugin/skills/ai-sdlc-governance/SKILL.md
  - spec/rfcs/README.md
  - ai-sdlc-plugin/.claude-plugin/plugin.json
priority: medium
dispatchable: true
---

## Description

The end-to-end RFC open-question walkthrough (worktree, per-OQ rubric, sign-off mechanics, implementation task generation, PR) exists only as a skill in the operator's home directory (`~/.claude/skills/rfc-oq-walkthrough/SKILL.md`). The plugin ships `decision-rubric`, which the walkthrough composes with, but not the walkthrough itself, so adopters get the per-question mechanics and none of the lifecycle around them. The gap analysis (2026-10-16, gap 4) asks to move it into the plugin.

**Five-step review (requirements first).**
1. Requirement questioned: "the walkthrough is operator-specific". It is not; every phase refers to repository conventions the plugin already ships (worktrees, lifecycle states, task generation).
2. Delete: the home-directory copy, once the plugin copy is on `main` (operator action, noted in the PR body).
3. Simplify: copy the skill as-is into `ai-sdlc-plugin/skills/rfc-oq-walkthrough/SKILL.md`; strip anything that names this repository's paths where a generic convention exists.
4. Accelerate: nothing to accelerate.
5. Automate: a `node --test` file under `ai-sdlc-plugin/skills/` that parses every `SKILL.md` frontmatter (name matches directory, description present, under a length cap) and checks that the walkthrough's cross-reference to `decision-rubric` resolves to a shipped skill.

Velocity impact: neutral for this repository; positive for adopters.

## Acceptance Criteria

- [ ] AC-1: `ai-sdlc-plugin/skills/rfc-oq-walkthrough/SKILL.md` exists with frontmatter `name: rfc-oq-walkthrough` and the eight-phase body; repository-specific paths are replaced by the plugin's generic conventions where one exists, and the remaining project-specific statements are marked as such.
- [ ] AC-2: `ai-sdlc-plugin/skills/skills.test.mjs` (`node --test`) validates every skill directory: frontmatter parses, `name` equals the directory name, `description` is non-empty, and every `[[skill-name]]` cross-reference resolves to a sibling skill directory.
- [ ] AC-3: The skill never writes a `Resolution:` marker itself and says so in its text; the Open Questions hard rule (planner command) is restated by pointer, not copied.
- [ ] AC-4: `docs/operations/release-and-plugin-reference.md` lists the three shipped skills.
- [ ] AC-5: `pnpm test` includes the new skills test (wired through the plugin's test script).

## Notes

Origin: playbook gap analysis 2026-10-16 (gap 4). The home-directory original stays until this lands; the PR body reminds the operator to delete it.
