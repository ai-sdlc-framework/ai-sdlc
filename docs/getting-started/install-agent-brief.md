# AI-SDLC install: agent brief

Paste everything below the line into Claude Code (or another coding agent) opened in the repository you want to adopt AI-SDLC in. The raw commands are in [onboarding.md](onboarding.md#raw-install-commands).

Stable path: `docs/getting-started/install-agent-brief.md`

---

You are installing AI-SDLC into the git repository in your current directory. Run the steps in order. After each step run its verification; if it fails, apply the recovery listed for it, re-run the verification, and only then continue. Stop and report to me only if a recovery does not work twice.

Prerequisites to check first: `node --version` (20 or newer), `pnpm --version` (9 or newer), `git --version`, `gh auth status` (logged in), `claude --version`. Install or ask me about anything missing. If `~/.ai-sdlc/` already exists, tell me before touching it.

1. Install the CLI. Run `npm install -g @ai-sdlc/orchestrator`. Verify with `ai-sdlc --version`, which must print a version.
2. Install the SDK in this repository. Run `pnpm add @ai-sdlc/reference`. Verify with `pnpm ls @ai-sdlc/reference`, which must list the package.
3. Install the Claude Code plugin. Run `/plugin marketplace add ai-sdlc-framework/ai-sdlc` then `/plugin install ai-sdlc@ai-sdlc`. Verify that `/plugin` lists `ai-sdlc` as enabled and that `/ai-sdlc` commands are available (restart the session if they are not).
4. Scaffold the repository. Run `ai-sdlc init --yes`. Verify with `ai-sdlc health`, which must report all checks passing, and confirm `.ai-sdlc/pipeline.yaml` exists.
5. Run the doctor. Run `/ai-sdlc:doctor`. It must finish with no errors and no unresolved warnings.

Recovery for known failures:

- Partial plugin cache install (plugin listed but commands missing, or files missing under the plugin cache): run `/plugin uninstall ai-sdlc@ai-sdlc`, delete the cached `ai-sdlc` directory under `~/.claude/plugins/` (show me the path before deleting), restart Claude Code, then repeat step 3.
- Missing `@ai-sdlc/reference` (import or "cannot find module" errors, or doctor reports it absent): run `pnpm add @ai-sdlc/reference` in the repository root, confirm it appears in `package.json`, then re-run the failing step.
- Doctor warnings: read each warning, fix the cause it names (usually one of the two failures above, a missing `gh` login, or an uncommitted scaffold), and re-run `/ai-sdlc:doctor` until it is clean. Do not suppress or ignore a warning without telling me why.

When doctor passes, commit the scaffold (the `git add` command init prints under "Next steps", which lists only paths that exist) and report what you installed and the doctor output.
