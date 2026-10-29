# Rollback Runbook — backing out a release, a plugin pin, or a bad commit

Releases are forward-only for `CHANGELOG.md` and git tags. They are not forward-only for what sessions run: that is a version pin, and a pin can point anywhere. A bad plugin release reaches every roster session at the next SessionStart through `ai-sdlc-plugin/hooks/check-plugin-version.js`. [`emergency-bypass.md`](emergency-bypass.md) is for gates, not versions; use this runbook for versions. How a release goes out: [`release-flow.md`](release-flow.md), [`release-and-plugin-reference.md`](release-and-plugin-reference.md).

Target: one person, under ten minutes, without reading the release flow.

| Case                                                          | Symptom                                          | Who may run it                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| A. npm package with a defect                                  | `npm i @ai-sdlc/<pkg>` installs a broken version | Operator only (class (c): npm credentials)                                             |
| B. Plugin manifest version or `runtimeDependencies` pin is bad | Sessions load a broken plugin or dependency      | Pin change PR: any session (class (a)). Anything touching npm or dist-tags: operator |
| C. Merged `main` commit must be reverted                      | A landed PR broke `main`                         | Any session (class (a)), through the normal gate                                       |

## What rollback never touches

- `CHANGELOG.md`: release-please owns it. The bad release stays listed; the fix appears in the next release entry.
- Git tags and GitHub releases: leave them in place.
- Published npm versions: **deprecate, never unpublish.** Unpublishing breaks lockfiles that already resolved the version.
- Git history: never rewrite `main`; no force-push, no hard reset.

## Case A: npm package published with a defect

Pick the last good version `<good>` (the previous entry in `npm view @ai-sdlc/<pkg> versions`) and the bad one `<bad>`.

```bash
# 1. Move the latest dist-tag back to the last good version
npm dist-tag add @ai-sdlc/<pkg>@<good> latest

# 2. Deprecate the bad version (message names the fix path)
npm deprecate @ai-sdlc/<pkg>@<bad> "Defective release; use <good>."
```

Repeat for each affected package (`@ai-sdlc/orchestrator`, `@ai-sdlc/pipeline-cli`, `@ai-sdlc/plugin-mcp-server`).

Verify:

```bash
npm view @ai-sdlc/<pkg> dist-tags.latest      # prints <good>
npm view @ai-sdlc/<pkg>@<bad> deprecated      # prints the message
```

Then do Case B so the plugin stops resolving the bad version, and Case C if the defect is still in `main`.

## Case B: plugin manifest version or `runtimeDependencies` pin points at a bad version

The two manifests must agree: `ai-sdlc-plugin/.claude-plugin/plugin.json` and the copy release-please updates (see the `manifests-agree` check in [`doctor.md`](doctor.md)).

1. Branch from `origin/main` in a worktree.
2. In **both** manifests, set `version` and the `runtimeDependencies` entries (`@ai-sdlc/orchestrator`, `@ai-sdlc/pipeline-cli`, `@ai-sdlc/plugin-mcp-server`) to the last good versions. Keep `@ai-sdlc/plugin-mcp-server` an exact pin; avoid `^0.x` carets (AISDLC-574).
3. Open a PR (`fix: pin plugin to <good> after defective <bad>`). It lands through the normal gate and `ai-sdlc/pr-ready`.

Verify, locally before pushing and again after the PR lands:

```bash
ai-sdlc doctor            # manifests-agree and runtime-deps-pins must pass
ai-sdlc doctor --fix      # only if a check reports mechanical drift, then re-run
```

Sessions pick up the corrected pin at their next SessionStart. A running session keeps the bad plugin until restarted (`cli-hierarchy restart <name>`).

## Case C: a merged `main` commit must be reverted

Always a revert PR through the normal gate. Never a history rewrite.

```bash
git fetch origin main
git switch -c fix/revert-<short-sha> origin/main
git revert <sha>                 # use -m 1 for a merge commit
git push -u origin HEAD:refs/heads/fix/revert-<short-sha>
gh pr create --title "revert: <original subject> (<TASK-ID>)" --body "Reverts <sha>. Why: <failure mode>."
```

Land it only with `cli-merge-if-eligible` (never the raw merge command). Do not edit `CHANGELOG.md` in the revert PR.

Verify: `pnpm build && pnpm test` on the revert branch, and the `main-health-monitor` run after landing is green ([`main-health-monitor.md`](main-health-monitor.md)).

## Automation candidates

Deferred. Once this runbook has been exercised twice, candidates for a `cli-release rollback` command: the dist-tag move plus deprecate (Case A), the two-manifest pin edit (Case B), and the revert PR scaffold (Case C). The operator-only steps stay behind class (c).
